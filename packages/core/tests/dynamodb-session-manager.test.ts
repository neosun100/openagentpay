/**
 * DynamoDBSessionManager unit tests.
 *
 * Coverage:
 *   - createSession (happy path + validation)
 *   - getSession (existing + nonexistent)
 *   - getSession derived status (expired)
 *   - checkAndReserve (happy path + budget exceeded + expired + currency mismatch)
 *   - checkAndReserve retry on ConditionalCheckFailed
 *   - commit (success path: reserved → spent)
 *   - commit (failure path: reserved → released)
 *   - commit retry on ConditionalCheckFailed
 *   - constructor validation
 */

import { describe, expect, it, vi } from "vitest";
import {
  DynamoDBSessionManager,
  type DynamoDBDocClientLike,
  type SessionCommandFactories,
} from "../src/session/dynamodb-manager.js";
import type { SessionId, UserId, Money } from "../src/types.js";

// In-memory DynamoDB-like store for tests
class FakeDynamoStore {
  items = new Map<string, Record<string, any>>();
  conditionalFailures = 0; // injectable to simulate races

  async send(cmd: any): Promise<any> {
    if (cmd.__cmdName === "PutCommand") {
      const item = cmd.input.Item as Record<string, any>;
      if (cmd.input.ConditionExpression?.includes("attribute_not_exists(id)")) {
        if (this.items.has(item.id)) {
          throwCCF();
        }
      }
      this.items.set(item.id, { ...item });
      return {};
    }
    if (cmd.__cmdName === "GetCommand") {
      const id = cmd.input.Key.id;
      const item = this.items.get(id);
      return { Item: item ? { ...item } : undefined };
    }
    if (cmd.__cmdName === "UpdateCommand") {
      // Simulate conditional + version-based update
      const id = cmd.input.Key.id;
      const item = this.items.get(id);
      if (!item) {
        // No item → ConditionExpression fails
        throwCCF();
      }
      // Inject failure if asked
      if (this.conditionalFailures > 0) {
        this.conditionalFailures--;
        throwCCF();
      }
      // Verify version
      const expected = cmd.input.ExpressionAttributeValues[":oldVersion"];
      if (item!.version !== expected) {
        throwCCF();
      }
      // Apply UpdateExpression — parse "SET a = :a, b = :b, ..."
      const setClause = (cmd.input.UpdateExpression as string).replace(/^SET\s+/, "");
      for (const part of setClause.split(",")) {
        const [field, valueRef] = part.trim().split("=").map((s) => s.trim());
        const v = cmd.input.ExpressionAttributeValues[valueRef!];
        item![field!] = v;
      }
      return {};
    }
    throw new Error(`unknown cmd: ${cmd.__cmdName}`);
  }
}

function throwCCF(): never {
  const e = new Error("Conditional check failed");
  (e as any).name = "ConditionalCheckFailedException";
  throw e;
}

const TEST_COMMANDS: SessionCommandFactories = {
  Put: (input) => ({ input, __cmdName: "PutCommand" }),
  Get: (input) => ({ input, __cmdName: "GetCommand" }),
  Update: (input) => ({ input, __cmdName: "UpdateCommand" }),
};

function buildManager(opts: { now?: number; newId?: string } = {}) {
  const store = new FakeDynamoStore();
  let nowMs = opts.now ?? Date.parse("2026-05-19T10:00:00.000Z");
  const idCounter = { n: 0 };
  const mgr = new DynamoDBSessionManager({
    tableName: "test-sessions",
    client: store,
    commands: TEST_COMMANDS,
    now: () => nowMs,
    newId: () => {
      idCounter.n++;
      return (opts.newId ?? `payment-session-test-${idCounter.n}`) as SessionId;
    },
  });
  return {
    store,
    mgr,
    advanceTime: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
  };
}

const USER: UserId = "alice" as UserId;

const usdc = (atomic: bigint | number): Money => ({
  amountAtomic: atomic.toString(),
  decimals: 6,
  currency: "USDC",
});

// ============================================================================
//  Constructor
// ============================================================================

describe("DynamoDBSessionManager — constructor", () => {
  it("rejects missing tableName", () => {
    expect(
      () =>
        new DynamoDBSessionManager({
          tableName: "",
          client: { send: async () => ({}) },
          commands: TEST_COMMANDS,
        })
    ).toThrow(/tableName/);
  });

  it("rejects missing client", () => {
    expect(
      () =>
        new DynamoDBSessionManager({
          tableName: "x",
          client: undefined as any,
          commands: TEST_COMMANDS,
        })
    ).toThrow(/client/);
  });
});

// ============================================================================
//  createSession
// ============================================================================

describe("DynamoDBSessionManager — createSession", () => {
  it("creates a session with budget + TTL", async () => {
    const { mgr } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    expect(s.id).toMatch(/^payment-session-/);
    expect(s.userId).toBe(USER);
    expect(s.budget.amountAtomic).toBe("5000000"); // $5 → 5_000_000 atomic
    expect(s.spent.amountAtomic).toBe("0");
    expect(s.status).toBe("active");
  });

  it("rejects negative budget", async () => {
    const { mgr } = buildManager();
    await expect(
      mgr.createSession({ userId: USER, budgetUsd: -1, expiresMinutes: 10 })
    ).rejects.toThrow(/budgetUsd/);
  });

  it("rejects zero expiresMinutes", async () => {
    const { mgr } = buildManager();
    await expect(
      mgr.createSession({ userId: USER, budgetUsd: 5, expiresMinutes: 0 })
    ).rejects.toThrow(/expiresMinutes/);
  });

  it("stores metadata as JSON when present", async () => {
    const { mgr, store } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
      metadata: { team: "research" },
    });
    const stored = store.items.get(s.id);
    expect(stored!.metadata).toBe(JSON.stringify({ team: "research" }));
  });
});

// ============================================================================
//  getSession
// ============================================================================

describe("DynamoDBSessionManager — getSession", () => {
  it("returns undefined for unknown id", async () => {
    const { mgr } = buildManager();
    const s = await mgr.getSession("nonexistent" as SessionId);
    expect(s).toBeUndefined();
  });

  it("retrieves an existing session", async () => {
    const { mgr } = buildManager();
    const created = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    const fetched = await mgr.getSession(created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.userId).toBe(USER);
  });

  it("derives 'expired' status when past expiry time", async () => {
    const { mgr, advanceTime } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 5,
    });
    advanceTime(10 * 60 * 1000); // +10 minutes
    const fetched = await mgr.getSession(s.id);
    expect(fetched?.status).toBe("expired");
  });

  it("deserializes metadata", async () => {
    const { mgr } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
      metadata: { team: "research", env: "prod" },
    });
    const fetched = await mgr.getSession(s.id);
    expect((fetched as any).metadata).toEqual({
      team: "research",
      env: "prod",
    });
  });
});

// ============================================================================
//  checkAndReserve
// ============================================================================

describe("DynamoDBSessionManager — checkAndReserve", () => {
  it("approves first reservation", async () => {
    const { mgr } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    const r = await mgr.checkAndReserve(s.id, usdc(1_000_000)); // $1
    expect(r.approved).toBe(true);
    expect(r.remainingBudget.amountAtomic).toBe("4000000");
  });

  it("approves multiple cumulative reservations", async () => {
    const { mgr } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    const r1 = await mgr.checkAndReserve(s.id, usdc(1_000_000));
    const r2 = await mgr.checkAndReserve(s.id, usdc(2_000_000));
    expect(r1.approved).toBe(true);
    expect(r2.approved).toBe(true);
    expect(r2.remainingBudget.amountAtomic).toBe("2000000");
  });

  it("denies budget_exceeded", async () => {
    const { mgr } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 1,
      expiresMinutes: 30,
    });
    const r = await mgr.checkAndReserve(s.id, usdc(2_000_000)); // $2 > $1
    expect(r.approved).toBe(false);
    expect(r.reason).toBe("budget_exceeded");
  });

  it("denies session_expired", async () => {
    const { mgr, advanceTime } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 5,
    });
    advanceTime(10 * 60 * 1000); // expire
    const r = await mgr.checkAndReserve(s.id, usdc(1_000_000));
    expect(r.approved).toBe(false);
    expect(r.reason).toBe("session_expired");
  });

  it("rejects currency mismatch", async () => {
    const { mgr } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    await expect(
      mgr.checkAndReserve(s.id, {
        amountAtomic: "1000000",
        decimals: 6,
        currency: "USDT",
      })
    ).rejects.toThrow(/currency/i);
  });

  it("throws SessionError when session missing", async () => {
    const { mgr } = buildManager();
    await expect(
      mgr.checkAndReserve("nonexistent" as SessionId, usdc(1_000_000))
    ).rejects.toThrow(/not found/);
  });

  it("retries up to maxRetries on conditional check failure", async () => {
    const { mgr, store } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    store.conditionalFailures = 2; // first 2 attempts will fail; 3rd succeeds
    const r = await mgr.checkAndReserve(s.id, usdc(1_000_000));
    expect(r.approved).toBe(true);
  });

  it("throws after exhausting retries", async () => {
    const { mgr, store } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    store.conditionalFailures = 100;
    await expect(mgr.checkAndReserve(s.id, usdc(1_000_000))).rejects.toThrow(
      /concurrent contention/i
    );
  });
});

// ============================================================================
//  commit
// ============================================================================

describe("DynamoDBSessionManager — commit", () => {
  it("commit(success=true) moves reserved → spent", async () => {
    const { mgr } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    await mgr.checkAndReserve(s.id, usdc(1_000_000));
    const after = await mgr.commit(s.id, usdc(1_000_000), true);
    expect(after.spent.amountAtomic).toBe("1000000");
    expect((after as any).status).toBe("active");
  });

  it("commit(success=false) releases reservation, keeps spent unchanged", async () => {
    const { mgr } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    await mgr.checkAndReserve(s.id, usdc(1_000_000));
    const after = await mgr.commit(s.id, usdc(1_000_000), false);
    expect(after.spent.amountAtomic).toBe("0");
  });

  it("multiple successful commits accumulate spent", async () => {
    const { mgr } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    await mgr.checkAndReserve(s.id, usdc(1_000_000));
    await mgr.commit(s.id, usdc(1_000_000), true);
    await mgr.checkAndReserve(s.id, usdc(2_000_000));
    const after = await mgr.commit(s.id, usdc(2_000_000), true);
    expect(after.spent.amountAtomic).toBe("3000000");
  });

  it("retries on optimistic-lock failure", async () => {
    const { mgr, store } = buildManager();
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    await mgr.checkAndReserve(s.id, usdc(1_000_000));
    store.conditionalFailures = 2;
    const after = await mgr.commit(s.id, usdc(1_000_000), true);
    expect(after.spent.amountAtomic).toBe("1000000");
  });

  it("throws when session missing", async () => {
    const { mgr } = buildManager();
    await expect(
      mgr.commit("nonexistent" as SessionId, usdc(1_000_000), true)
    ).rejects.toThrow(/not found/);
  });
});

// ============================================================================
//  Round-trip: full payment lifecycle
// ============================================================================

describe("DynamoDBSessionManager — full lifecycle round trip", () => {
  it("create → reserve → commit → reserve again → check final state", async () => {
    const { mgr } = buildManager();
    // 1. create $5 session
    const s = await mgr.createSession({
      userId: USER,
      budgetUsd: 5,
      expiresMinutes: 30,
    });
    expect(s.spent.amountAtomic).toBe("0");

    // 2. reserve $2
    const r1 = await mgr.checkAndReserve(s.id, usdc(2_000_000));
    expect(r1.approved).toBe(true);
    expect(r1.remainingBudget.amountAtomic).toBe("3000000");

    // 3. commit success
    await mgr.commit(s.id, usdc(2_000_000), true);
    let fetched = await mgr.getSession(s.id);
    expect(fetched!.spent.amountAtomic).toBe("2000000");

    // 4. reserve $4 — should fail, only $3 left
    const r2 = await mgr.checkAndReserve(s.id, usdc(4_000_000));
    expect(r2.approved).toBe(false);
    expect(r2.reason).toBe("budget_exceeded");

    // 5. reserve $3 — fits exactly
    const r3 = await mgr.checkAndReserve(s.id, usdc(3_000_000));
    expect(r3.approved).toBe(true);

    // 6. commit failure (e.g., chain RPC error) — should release back
    await mgr.commit(s.id, usdc(3_000_000), false);
    fetched = await mgr.getSession(s.id);
    expect(fetched!.spent.amountAtomic).toBe("2000000"); // unchanged
  });
});
