/**
 * DynamoDBSessionManager — Layer 2 persistent session storage.
 *
 * Lambda runs across multiple warm instances behind API Gateway. The original
 * InMemorySessionManager scoped sessions to a single Lambda execution context,
 * which meant subsequent calls routed to a different warm instance returned
 * "Session not found" 404s.
 *
 * This class persists sessions to DynamoDB with optimistic-locking
 * checkAndReserve / commit semantics, so any Lambda instance can read/write
 * the same session.
 *
 * Table schema (created by CDK):
 *   PK (id)            S = SessionId  (e.g., "payment-session-...")
 *   userId             S
 *   budgetAtomic       S = stringified bigint
 *   decimals           N
 *   currency           S
 *   spentAtomic        S = stringified bigint
 *   reservedAtomic     S = stringified bigint
 *   expiresAt          S = ISO 8601
 *   createdAt          S = ISO 8601
 *   updatedAt          S = ISO 8601
 *   status             S = active | exhausted | expired | closed
 *   version            N = optimistic-lock counter (starts at 0)
 *   ttlEpoch           N = unix seconds when DynamoDB TTL should evict
 *   metadata           S? = JSON-stringified Record<string,string>
 *
 * Concurrency model:
 *   - createSession    PutItem with attribute_not_exists(id)
 *   - getSession       GetItem
 *   - checkAndReserve  read-then-conditional-update (version match)
 *                      retries up to MAX_RETRIES on contention
 *   - commit           same pattern
 *
 * @license Apache-2.0
 */

import {
  SessionError,
  type SessionManager,
} from "./manager.js";
import type {
  CreateSessionInput,
  Money,
  ReservationResult,
  Session,
  SessionId,
  UserId,
} from "../types.js";

const USDC_DECIMALS = 6;
const USDC_CURRENCY = "USDC";
const MAX_RETRIES = 3;

// ============================================================================
//  Pluggable command factories — same pattern as DynamoDBAuditSink.
//  Tests inject mocks; production uses real @aws-sdk/lib-dynamodb classes.
// ============================================================================

export interface DynamoDBDocClientLike {
  send(command: any): Promise<any>;
}

export interface SessionCommandFactories {
  readonly Get: (input: Record<string, unknown>) => unknown;
  readonly Put: (input: Record<string, unknown>) => unknown;
  readonly Update: (input: Record<string, unknown>) => unknown;
}

let _cachedDefaultFactories: SessionCommandFactories | null = null;
async function defaultFactories(): Promise<SessionCommandFactories> {
  if (_cachedDefaultFactories) return _cachedDefaultFactories;
  const mod = (await import("@aws-sdk/lib-dynamodb")) as any;
  _cachedDefaultFactories = {
    Get: (input) => new mod.GetCommand(input),
    Put: (input) => new mod.PutCommand(input),
    Update: (input) => new mod.UpdateCommand(input),
  };
  return _cachedDefaultFactories;
}

// ============================================================================
//  Config
// ============================================================================

export interface DynamoDBSessionManagerConfig {
  readonly tableName: string;
  readonly client: DynamoDBDocClientLike;
  readonly commands?: SessionCommandFactories;
  readonly now?: () => number;
  /** Override id generator — for tests. */
  readonly newId?: () => SessionId;
  /** Number of retry attempts on optimistic-lock failures. Default 3. */
  readonly maxRetries?: number;
}

// ============================================================================
//  Helpers
// ============================================================================

function defaultNewId(): SessionId {
  // Browser/Node 19+ both expose globalThis.crypto.randomUUID
  const uuid = globalThis.crypto.randomUUID();
  return `payment-session-${uuid.replace(/-/g, "").slice(0, 16)}` as SessionId;
}

function nowIso(t: number): string {
  return new Date(t).toISOString();
}

function expiresAtIso(now: () => number, minutes: number): string {
  return new Date(now() + minutes * 60_000).toISOString();
}

function usdToAtomic(usd: number): bigint {
  // Multiply via string to avoid float drift
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
}

function asMoney(atomic: bigint): Money {
  return { amountAtomic: atomic.toString(), decimals: USDC_DECIMALS, currency: USDC_CURRENCY };
}

interface SessionRow {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly budgetAtomic: string;
  readonly decimals: number;
  readonly currency: string;
  readonly spentAtomic: string;
  readonly reservedAtomic: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: "active" | "exhausted" | "expired" | "closed";
  readonly version: number;
  readonly ttlEpoch?: number;
  readonly metadata?: string; // JSON-stringified
}

function rowToSession(row: SessionRow, now: () => number): Session {
  // Lazy materialize — if expired, return derived 'expired' status
  let status = row.status;
  if (status === "active" && new Date(row.expiresAt).getTime() <= now()) {
    status = "expired";
  }
  if (
    status === "active" &&
    BigInt(row.budgetAtomic) - BigInt(row.spentAtomic) - BigInt(row.reservedAtomic) <=
      BigInt(0)
  ) {
    // Spent + reserved >= budget → exhausted. Note: currently this is opportunistic
    // (only flips when read; the next checkAndReserve would still hit the budget guard).
    status = "exhausted";
  }
  const session: any = {
    id: row.id,
    userId: row.userId,
    budget: { amountAtomic: row.budgetAtomic, decimals: row.decimals, currency: row.currency },
    spent: { amountAtomic: row.spentAtomic, decimals: row.decimals, currency: row.currency },
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status,
  };
  if (row.metadata) {
    try {
      session.metadata = JSON.parse(row.metadata);
    } catch {
      // ignore malformed metadata
    }
  }
  return session as Session;
}

function remaining(row: SessionRow): Money {
  const r = BigInt(row.budgetAtomic) - BigInt(row.spentAtomic) - BigInt(row.reservedAtomic);
  return asMoney(r > BigInt(0) ? r : BigInt(0));
}

// ============================================================================
//  DynamoDBSessionManager
// ============================================================================

export class DynamoDBSessionManager implements SessionManager {
  private readonly tableName: string;
  private readonly client: DynamoDBDocClientLike;
  private readonly explicitCommands: SessionCommandFactories | undefined;
  private readonly now: () => number;
  private readonly newId: () => SessionId;
  private readonly maxRetries: number;

  constructor(cfg: DynamoDBSessionManagerConfig) {
    if (!cfg.tableName) throw new Error("tableName is required");
    if (!cfg.client) throw new Error("client is required");
    this.tableName = cfg.tableName;
    this.client = cfg.client;
    this.explicitCommands = cfg.commands;
    this.now = cfg.now ?? (() => Date.now());
    this.newId = cfg.newId ?? defaultNewId;
    this.maxRetries = cfg.maxRetries ?? MAX_RETRIES;
  }

  private async cmds(): Promise<SessionCommandFactories> {
    return this.explicitCommands ?? (await defaultFactories());
  }

  // -------------------------------------------------------------------------
  //  createSession
  // -------------------------------------------------------------------------
  async createSession(input: CreateSessionInput): Promise<Session> {
    if (input.budgetUsd <= 0) {
      throw new SessionError("budgetUsd must be positive", "internal");
    }
    if (input.expiresMinutes <= 0) {
      throw new SessionError("expiresMinutes must be positive", "internal");
    }
    const id = this.newId();
    const budgetAtomic = usdToAtomic(input.budgetUsd);
    const ts = nowIso(this.now());
    const expires = expiresAtIso(this.now, input.expiresMinutes);
    const row: SessionRow = {
      id,
      userId: input.userId,
      budgetAtomic: budgetAtomic.toString(),
      decimals: USDC_DECIMALS,
      currency: USDC_CURRENCY,
      spentAtomic: "0",
      reservedAtomic: "0",
      expiresAt: expires,
      createdAt: ts,
      updatedAt: ts,
      status: "active",
      version: 0,
      // TTL: auto-evict 24h after expiry to keep table size bounded
      ttlEpoch: Math.floor(new Date(expires).getTime() / 1000) + 24 * 3600,
      ...(input.metadata && Object.keys(input.metadata).length > 0
        ? { metadata: JSON.stringify(input.metadata) }
        : {}),
    };
    const item: Record<string, unknown> = { ...row };
    const { Put } = await this.cmds();
    await this.client.send(
      Put({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(id)",
      })
    );
    return rowToSession(row, this.now);
  }

  // -------------------------------------------------------------------------
  //  getSession
  // -------------------------------------------------------------------------
  async getSession(id: SessionId): Promise<Session | undefined> {
    const row = await this.readRow(id);
    if (!row) return undefined;
    return rowToSession(row, this.now);
  }

  // -------------------------------------------------------------------------
  //  checkAndReserve — atomic with optimistic lock + retry
  // -------------------------------------------------------------------------
  async checkAndReserve(id: SessionId, amount: Money): Promise<ReservationResult> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const row = await this.readRow(id);
      if (!row) {
        throw new SessionError(`Session ${id} not found`, "not_found");
      }
      if (amount.currency !== row.currency) {
        throw new SessionError(
          `Currency mismatch: session ${row.currency}, request ${amount.currency}`,
          "currency_mismatch"
        );
      }
      const fresh = rowToSession(row, this.now);
      if (fresh.status === "expired") {
        return {
          approved: false,
          reason: "session_expired",
          remainingBudget: remaining(row),
        };
      }
      if (fresh.status === "closed") {
        return {
          approved: false,
          reason: "session_closed",
          remainingBudget: remaining(row),
        };
      }

      const incoming = BigInt(amount.amountAtomic);
      const newReserved = BigInt(row.reservedAtomic) + incoming;
      const newSpent = BigInt(row.spentAtomic);
      const wouldExceedBudget =
        newSpent + newReserved > BigInt(row.budgetAtomic);
      if (wouldExceedBudget) {
        return {
          approved: false,
          reason: "budget_exceeded",
          remainingBudget: remaining(row),
        };
      }

      // Optimistic update with version match
      try {
        const { Update } = await this.cmds();
        await this.client.send(
          Update({
            TableName: this.tableName,
            Key: { id },
            UpdateExpression:
              "SET reservedAtomic = :newReserved, updatedAt = :ts, version = :nextVersion",
            ConditionExpression: "version = :oldVersion",
            ExpressionAttributeValues: {
              ":newReserved": newReserved.toString(),
              ":ts": nowIso(this.now()),
              ":oldVersion": row.version,
              ":nextVersion": row.version + 1,
            },
          })
        );
        return {
          approved: true,
          remainingBudget: asMoney(
            BigInt(row.budgetAtomic) - newSpent - newReserved
          ),
        };
      } catch (err) {
        if (isConditionalCheckFailed(err)) {
          // Someone else modified — retry
          continue;
        }
        throw err;
      }
    }
    throw new SessionError(
      `Could not reserve after ${this.maxRetries} attempts (concurrent contention)`,
      "concurrent_update"
    );
  }

  // -------------------------------------------------------------------------
  //  commit
  // -------------------------------------------------------------------------
  async commit(id: SessionId, amount: Money, success: boolean): Promise<Session> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const row = await this.readRow(id);
      if (!row) {
        throw new SessionError(`Session ${id} not found`, "not_found");
      }
      const incoming = BigInt(amount.amountAtomic);
      const oldReserved = BigInt(row.reservedAtomic);
      // Decrement reserved (whether success or not)
      const newReserved = oldReserved >= incoming ? oldReserved - incoming : BigInt(0);
      const newSpent = success ? BigInt(row.spentAtomic) + incoming : BigInt(row.spentAtomic);

      try {
        const { Update } = await this.cmds();
        await this.client.send(
          Update({
            TableName: this.tableName,
            Key: { id },
            UpdateExpression:
              "SET reservedAtomic = :newReserved, spentAtomic = :newSpent, updatedAt = :ts, version = :nextVersion",
            ConditionExpression: "version = :oldVersion",
            ExpressionAttributeValues: {
              ":newReserved": newReserved.toString(),
              ":newSpent": newSpent.toString(),
              ":ts": nowIso(this.now()),
              ":oldVersion": row.version,
              ":nextVersion": row.version + 1,
            },
          })
        );
        // Read back fresh state
        const fresh = await this.readRow(id);
        return rowToSession(fresh ?? { ...row, reservedAtomic: newReserved.toString(), spentAtomic: newSpent.toString(), version: row.version + 1 }, this.now);
      } catch (err) {
        if (isConditionalCheckFailed(err)) continue;
        throw err;
      }
    }
    throw new SessionError(
      `Could not commit after ${this.maxRetries} attempts (concurrent contention)`,
      "concurrent_update"
    );
  }

  // -------------------------------------------------------------------------
  //  Internals
  // -------------------------------------------------------------------------
  private async readRow(id: SessionId): Promise<SessionRow | undefined> {
    const { Get } = await this.cmds();
    const r = await this.client.send(
      Get({
        TableName: this.tableName,
        Key: { id },
        ConsistentRead: true, // sessions are read-after-write critical
      })
    );
    if (!r?.Item) return undefined;
    return r.Item as SessionRow;
  }
}

// DynamoDB SDK throws errors with `name = "ConditionalCheckFailedException"`
// on condition mismatch. Detect heuristically.
function isConditionalCheckFailed(err: unknown): boolean {
  const e = err as { name?: string; __type?: string };
  return (
    e?.name === "ConditionalCheckFailedException" ||
    e?.__type === "ConditionalCheckFailedException"
  );
}
