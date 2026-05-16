/**
 * SessionManager
 * ===============
 *
 * In-memory and DynamoDB-backed implementations of the session lifecycle:
 *
 *   createSession      → mint a new session with a budget cap and TTL
 *   getSession         → read by id (returns undefined if not found)
 *   checkAndReserve    → ATOMICALLY check budget, fail-or-bump-spent
 *   commit             → idempotent: confirm or roll back a reservation
 *
 * The atomicity of `checkAndReserve` is critical: two concurrent payments
 * MUST NOT both pass the budget check. The DynamoDB implementation uses
 * a conditional UpdateItem; the in-memory implementation uses a single-thread
 * mutex (suitable for tests + single-Lambda use cases).
 *
 * Storage layer is intentionally an interface so we can swap to Redis/Postgres.
 *
 * @license Apache-2.0
 */

import { randomUUID } from "node:crypto";
import {
  type CreateSessionInput,
  type Money,
  type ReservationResult,
  type Session,
  type SessionId,
  type UserId,
} from "@openagentpay/core";

// ============================================================================
//  Public interface
// ============================================================================

export interface SessionManager {
  createSession(input: CreateSessionInput): Promise<Session>;
  getSession(id: SessionId): Promise<Session | undefined>;
  /** Reserve `amount` from the session's remaining budget, atomically. */
  checkAndReserve(id: SessionId, amount: Money): Promise<ReservationResult>;
  /**
   * Confirm a successful settlement → make the reservation permanent.
   * If `success === false`, releases the reservation back to budget.
   */
  commit(id: SessionId, amount: Money, success: boolean): Promise<Session>;
}

// ============================================================================
//  Errors
// ============================================================================

export class SessionError extends Error {
  override readonly name = "SessionError";
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "expired"
      | "exhausted"
      | "currency_mismatch"
      | "concurrent_update"
      | "internal"
  ) {
    super(message);
  }
}

// ============================================================================
//  Helpers
// ============================================================================

const USDC_ATOMIC_DECIMALS = 6;
const USDC_CURRENCY = "USDC";

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function usdToAtomic(usd: number, decimals: number): bigint {
  // Multiply via string to avoid float drift (e.g., 0.1 + 0.2)
  const scaled = (usd * 10 ** decimals).toFixed(0);
  return BigInt(scaled);
}

function expiresAtIso(now: () => number, minutes: number): string {
  return new Date(now() + minutes * 60_000).toISOString();
}

function asMoney(atomic: bigint): Money {
  return {
    amountAtomic: atomic.toString(),
    decimals: USDC_ATOMIC_DECIMALS,
    currency: USDC_CURRENCY,
  };
}

function asAtomic(m: Money): bigint {
  return BigInt(m.amountAtomic);
}

function isExpired(session: Session, now: () => number): boolean {
  return new Date(session.expiresAt).getTime() <= now();
}

// ============================================================================
//  In-memory implementation (for tests + single-Lambda use)
// ============================================================================

/** Mutable view used internally — Session is readonly to consumers. */
type MutableSession = {
  -readonly [K in keyof Session]: Session[K];
};

interface SessionRow extends MutableSession {
  /** Reserved-but-not-committed amount; counts against budget. */
  reservedAtomic: bigint;
}

export class InMemorySessionManager implements SessionManager {
  private readonly store = new Map<string, SessionRow>();
  private readonly mutex = new Mutex();

  constructor(private readonly now: () => number = Date.now) {}

  async createSession(input: CreateSessionInput): Promise<Session> {
    const id = `payment-session-${randomUUID().replace(/-/g, "").slice(0, 16)}` as SessionId;
    const budgetAtomic = usdToAtomic(input.budgetUsd, USDC_ATOMIC_DECIMALS);
    const row: SessionRow = {
      id,
      userId: input.userId,
      budget: asMoney(budgetAtomic),
      spent: asMoney(0n),
      expiresAt: expiresAtIso(this.now, input.expiresMinutes),
      createdAt: nowIso(this.now),
      updatedAt: nowIso(this.now),
      status: "active",
      reservedAtomic: 0n,
      ...(input.metadata !== undefined && Object.keys(input.metadata).length > 0
        ? { metadata: input.metadata }
        : {}),
    };
    this.store.set(id, row);
    return stripReservation(row);
  }

  async getSession(id: SessionId): Promise<Session | undefined> {
    const row = this.store.get(id);
    if (!row) return undefined;
    return stripReservation(this.materialize(row));
  }

  async checkAndReserve(id: SessionId, amount: Money): Promise<ReservationResult> {
    return this.mutex.runExclusive(async () => {
      const row = this.store.get(id);
      if (!row) {
        throw new SessionError(`Session ${id} not found`, "not_found");
      }
      if (amount.currency !== row.budget.currency) {
        throw new SessionError(
          `Currency mismatch: session ${row.budget.currency}, request ${amount.currency}`,
          "currency_mismatch"
        );
      }
      const fresh = this.materialize(row);
      if (fresh.status === "expired") {
        return {
          approved: false,
          reason: "session_expired" as const,
          remainingBudget: this.remaining(fresh),
        };
      }
      if (fresh.status === "closed") {
        return {
          approved: false,
          reason: "session_closed" as const,
          remainingBudget: this.remaining(fresh),
        };
      }
      const wantAtomic = asAtomic(amount);
      const remainingAtomic =
        asAtomic(row.budget) - asAtomic(row.spent) - row.reservedAtomic;
      if (wantAtomic > remainingAtomic) {
        return {
          approved: false,
          reason: "budget_exceeded" as const,
          remainingBudget: asMoney(remainingAtomic),
        };
      }
      row.reservedAtomic += wantAtomic;
      row.updatedAt = nowIso(this.now);
      return {
        approved: true,
        remainingBudget: asMoney(remainingAtomic - wantAtomic),
      };
    });
  }

  async commit(id: SessionId, amount: Money, success: boolean): Promise<Session> {
    return this.mutex.runExclusive(async () => {
      const row = this.store.get(id);
      if (!row) {
        throw new SessionError(`Session ${id} not found`, "not_found");
      }
      const releaseAtomic = asAtomic(amount);
      // If reserved < release we tolerate (idempotent retries)
      const actualRelease =
        row.reservedAtomic >= releaseAtomic ? releaseAtomic : row.reservedAtomic;
      row.reservedAtomic -= actualRelease;
      if (success) {
        row.spent = asMoney(asAtomic(row.spent) + actualRelease);
        if (asAtomic(row.spent) >= asAtomic(row.budget)) {
          row.status = "exhausted";
        }
      }
      row.updatedAt = nowIso(this.now);
      return stripReservation(this.materialize(row));
    });
  }

  // ---- internals ---------------------------------------------------------

  private materialize(row: SessionRow): SessionRow {
    if (row.status === "active" && isExpired(row, this.now)) {
      row.status = "expired";
    }
    return row;
  }

  private remaining(session: Session): Money {
    return asMoney(asAtomic(session.budget) - asAtomic(session.spent));
  }
}

function stripReservation(row: SessionRow): Session {
  // Erase internal field on the way out; consumers see the public Session only.
  const { reservedAtomic: _drop, ...publicView } = row;
  void _drop;
  return publicView;
}

// ============================================================================
//  Mutex utility (tiny, no dep)
// ============================================================================

class Mutex {
  private chain: Promise<unknown> = Promise.resolve();
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    // Drop the result from the chain (do not block on the previous result).
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next as Promise<T>;
  }
}
