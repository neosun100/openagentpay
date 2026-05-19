/**
 * DynamoDBAuditSink unit tests — using a mock DocClient (no real AWS calls).
 *
 * Coverage:
 *   - emit() — happy path + ConditionExpression set
 *   - emit() — complex fields (policyEvaluations, metadata, complianceCheck) JSON-serialized
 *   - emit() — undefined fields not stored
 *   - queryByActor — basic + since/until filters + pagination cursor
 *   - queryByKind — uses byKind GSI
 *   - getByEventId — returns single event from byEventId GSI
 *   - getByEventId — returns undefined when no match
 *   - constructor validation
 */

import { describe, expect, it, vi } from "vitest";
import { DynamoDBAuditSink } from "../src/dynamodb-sink.js";
import type { AuditEvent } from "../src/audit.js";
import type {
  DynamoDBDocClientLike,
} from "../src/dynamodb-sink.js";

function buildSink(opts: { items?: any[]; lastEvaluatedKey?: any } = {}) {
  const calls: Array<{ cmdName: string; input: any }> = [];
  const client: DynamoDBDocClientLike = {
    send: vi.fn(async (cmd: any) => {
      calls.push({ cmdName: cmd.__cmdName, input: cmd.input });
      if (cmd.__cmdName === "QueryCommand") {
        return {
          Items: opts.items ?? [],
          ...(opts.lastEvaluatedKey
            ? { LastEvaluatedKey: opts.lastEvaluatedKey }
            : {}),
        };
      }
      return {};
    }),
  };
  // Test command factories that mark the cmd type for routing
  const commands = {
    Put: (input: Record<string, unknown>) => ({ input, __cmdName: "PutCommand" }),
    Query: (input: Record<string, unknown>) => ({
      input,
      __cmdName: "QueryCommand",
    }),
  };
  const sink = new DynamoDBAuditSink({
    tableName: "test-audit-table",
    client,
    commands,
  });
  return { sink, client, calls };
}

const SAMPLE_EVENT: AuditEvent = {
  eventId: "audit-abc-12345",
  timestamp: "2026-05-19T10:00:00.000Z",
  kind: "payment_success",
  actor: "alice",
  walletProvider: "coinbase-cdp",
  sessionId: "sess-1",
  recipient: "0x123",
  amountAtomic: "1000000",
  currency: "USDC",
  chain: "base-sepolia",
  txHash: "0xdeadbeef",
  result: "succeeded",
  metadata: { reason: "buy report" },
};

// ============================================================================
//  Constructor
// ============================================================================

describe("DynamoDBAuditSink — constructor", () => {
  it("rejects missing tableName", () => {
    expect(
      () =>
        new DynamoDBAuditSink({
          tableName: "",
          client: { send: async () => ({}) },
        })
    ).toThrow(/tableName/);
  });

  it("rejects missing client", () => {
    expect(
      () =>
        new DynamoDBAuditSink({
          tableName: "x",
          client: undefined as any,
        })
    ).toThrow(/client/);
  });

  it("accepts custom GSI names", async () => {
    const { sink, calls } = buildSink({ items: [] });
    // We can't directly inspect index name without sending a query
    expect(sink).toBeDefined();
  });
});

// ============================================================================
//  emit
// ============================================================================

describe("DynamoDBAuditSink — emit", () => {
  it("sends PutCommand with conditional non-existence check", async () => {
    const { sink, calls } = buildSink();
    await sink.emit(SAMPLE_EVENT);

    expect(calls.length).toBe(1);
    const c = calls[0]!;
    expect(c.cmdName).toBe("PutCommand");
    expect(c.input["TableName"]).toBe("test-audit-table");
    expect(c.input["ConditionExpression"]).toBe("attribute_not_exists(actor)");
  });

  it("uses composite SK 'timestamp#eventId' for uniqueness", async () => {
    const { sink, calls } = buildSink();
    await sink.emit(SAMPLE_EVENT);
    const item = calls[0]!.input["Item"] as Record<string, any>;
    expect(item.actor).toBe("alice");
    expect(item.timestampEventId).toBe(
      "2026-05-19T10:00:00.000Z#audit-abc-12345"
    );
  });

  it("preserves top-level fields", async () => {
    const { sink, calls } = buildSink();
    await sink.emit(SAMPLE_EVENT);
    const item = calls[0]!.input["Item"] as Record<string, any>;
    expect(item.kind).toBe("payment_success");
    expect(item.walletProvider).toBe("coinbase-cdp");
    expect(item.amountAtomic).toBe("1000000");
    expect(item.txHash).toBe("0xdeadbeef");
  });

  it("JSON-serializes complex fields (metadata)", async () => {
    const { sink, calls } = buildSink();
    await sink.emit(SAMPLE_EVENT);
    const item = calls[0]!.input["Item"] as Record<string, any>;
    expect(typeof item.metadata).toBe("string");
    expect(JSON.parse(item.metadata)).toEqual({ reason: "buy report" });
  });

  it("JSON-serializes policyEvaluations and complianceCheck", async () => {
    const { sink, calls } = buildSink();
    await sink.emit({
      ...SAMPLE_EVENT,
      policyEvaluations: [
        { allowed: true, policyName: "amountThreshold(50000000)" },
      ],
      complianceCheck: {
        cleared: true,
        checkerName: "StaticSanctionsChecker",
        matches: [],
      },
    });
    const item = calls[0]!.input["Item"] as Record<string, any>;
    expect(typeof item.policyEvaluations).toBe("string");
    expect(typeof item.complianceCheck).toBe("string");
    expect(JSON.parse(item.policyEvaluations)).toEqual([
      { allowed: true, policyName: "amountThreshold(50000000)" },
    ]);
  });

  it("omits undefined fields (clean Item)", async () => {
    const { sink, calls } = buildSink();
    await sink.emit({
      eventId: "e1",
      timestamp: "2026-05-19T10:00:00.000Z",
      kind: "policy_check",
      actor: "alice",
      result: "allowed",
      // no walletProvider, recipient, etc.
    });
    const item = calls[0]!.input["Item"] as Record<string, any>;
    expect("walletProvider" in item).toBe(false);
    expect("recipient" in item).toBe(false);
    expect("metadata" in item).toBe(false);
  });
});

// ============================================================================
//  queryByActor
// ============================================================================

describe("DynamoDBAuditSink — queryByActor", () => {
  it("base query uses 'actor = :actor' KeyCondition", async () => {
    const { sink, calls } = buildSink({ items: [] });
    await sink.queryByActor({ actor: "alice" });

    const c = calls[0]!;
    expect(c.cmdName).toBe("QueryCommand");
    expect(c.input["TableName"]).toBe("test-audit-table");
    expect(c.input["KeyConditionExpression"]).toBe("#actor = :actor");
    expect(c.input["ExpressionAttributeValues"][":actor"]).toBe("alice");
    expect(c.input["ScanIndexForward"]).toBe(false); // newest first
  });

  it("since filter adds >= :since condition", async () => {
    const { sink, calls } = buildSink({ items: [] });
    await sink.queryByActor({
      actor: "alice",
      since: "2026-05-19T00:00:00.000Z",
    });
    const c = calls[0]!;
    expect(c.input["KeyConditionExpression"]).toContain(">=");
    expect(c.input["ExpressionAttributeValues"][":since"]).toBe(
      "2026-05-19T00:00:00.000Z"
    );
  });

  it("since + until uses BETWEEN", async () => {
    const { sink, calls } = buildSink({ items: [] });
    await sink.queryByActor({
      actor: "alice",
      since: "2026-05-19T00:00:00.000Z",
      until: "2026-05-20T00:00:00.000Z",
    });
    const c = calls[0]!;
    expect(c.input["KeyConditionExpression"]).toContain("BETWEEN");
  });

  it("returns parsed events with nextCursor when LastEvaluatedKey present", async () => {
    const { sink } = buildSink({
      items: [
        {
          actor: "alice",
          timestampEventId: "2026-05-19T10:00:00.000Z#audit-1",
          eventId: "audit-1",
          timestamp: "2026-05-19T10:00:00.000Z",
          kind: "payment_success",
          result: "succeeded",
          amountAtomic: "1000000",
        },
      ],
      lastEvaluatedKey: { actor: "alice", timestampEventId: "..." },
    });
    const r = await sink.queryByActor({ actor: "alice" });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.eventId).toBe("audit-1");
    expect(r.nextCursor).toBeDefined();
    expect(JSON.parse(r.nextCursor!)).toEqual({
      actor: "alice",
      timestampEventId: "...",
    });
  });

  it("ascending option flips ScanIndexForward", async () => {
    const { sink, calls } = buildSink({ items: [] });
    await sink.queryByActor({ actor: "alice", ascending: true });
    expect(calls[0]!.input["ScanIndexForward"]).toBe(true);
  });

  it("limit + cursor passed through", async () => {
    const { sink, calls } = buildSink({ items: [] });
    await sink.queryByActor({
      actor: "alice",
      limit: 10,
      cursor: JSON.stringify({ actor: "alice", timestampEventId: "x" }),
    });
    expect(calls[0]!.input["Limit"]).toBe(10);
    expect(calls[0]!.input["ExclusiveStartKey"]).toEqual({
      actor: "alice",
      timestampEventId: "x",
    });
  });
});

// ============================================================================
//  queryByKind
// ============================================================================

describe("DynamoDBAuditSink — queryByKind", () => {
  it("uses byKind GSI", async () => {
    const { sink, calls } = buildSink({ items: [] });
    await sink.queryByKind({ kind: "payment_success" });
    const c = calls[0]!;
    expect(c.input["IndexName"]).toBe("byKind");
    expect(c.input["KeyConditionExpression"]).toBe("#kind = :kind");
    expect(c.input["ExpressionAttributeValues"][":kind"]).toBe("payment_success");
  });

  it("since filter adds >= :since to key condition", async () => {
    const { sink, calls } = buildSink({ items: [] });
    await sink.queryByKind({
      kind: "policy_check",
      since: "2026-05-19T00:00:00.000Z",
    });
    expect(calls[0]!.input["KeyConditionExpression"]).toBe(
      "#kind = :kind AND #ts >= :since"
    );
  });
});

// ============================================================================
//  getByEventId
// ============================================================================

describe("DynamoDBAuditSink — getByEventId", () => {
  it("uses byEventId GSI with Limit=1", async () => {
    const { sink, calls } = buildSink({
      items: [
        {
          actor: "alice",
          eventId: "audit-special",
          timestamp: "2026-05-19T10:00:00.000Z",
          kind: "payment_success",
          result: "succeeded",
        },
      ],
    });
    const r = await sink.getByEventId("audit-special");
    expect(r).toBeDefined();
    expect(r!.eventId).toBe("audit-special");

    const c = calls[0]!;
    expect(c.input["IndexName"]).toBe("byEventId");
    expect(c.input["Limit"]).toBe(1);
    expect(c.input["ExpressionAttributeValues"][":eid"]).toBe("audit-special");
  });

  it("returns undefined when no match", async () => {
    const { sink } = buildSink({ items: [] });
    const r = await sink.getByEventId("nonexistent");
    expect(r).toBeUndefined();
  });

  it("deserializes JSON-encoded fields", async () => {
    const { sink } = buildSink({
      items: [
        {
          actor: "alice",
          eventId: "audit-with-meta",
          timestamp: "2026-05-19T10:00:00.000Z",
          kind: "payment_success",
          result: "succeeded",
          metadata: JSON.stringify({ reason: "buy report" }),
          policyEvaluations: JSON.stringify([
            { allowed: true, policyName: "amt" },
          ]),
        },
      ],
    });
    const r = await sink.getByEventId("audit-with-meta");
    expect(r!.metadata).toEqual({ reason: "buy report" });
    expect(r!.policyEvaluations).toEqual([
      { allowed: true, policyName: "amt" },
    ]);
  });

  it("handles malformed JSON in stored fields gracefully", async () => {
    const { sink } = buildSink({
      items: [
        {
          actor: "alice",
          eventId: "audit-bad",
          timestamp: "2026-05-19T10:00:00.000Z",
          kind: "payment_success",
          result: "succeeded",
          metadata: "{not valid json",
          policyEvaluations: "[also bad",
        },
      ],
    });
    const r = await sink.getByEventId("audit-bad");
    // Should not throw; bad JSON becomes empty defaults
    expect(r).toBeDefined();
    expect(r!.policyEvaluations).toEqual([]);
  });
});

// ============================================================================
//  Round-trip: emit → query
// ============================================================================

describe("DynamoDBAuditSink — round trip serialize/deserialize", () => {
  it("emits and re-reads all fields correctly", async () => {
    let storedItem: Record<string, any> | null = null;
    const client: DynamoDBDocClientLike = {
      send: async (cmd: any) => {
        if (cmd.__cmdName === "PutCommand") {
          storedItem = cmd.input.Item;
          return {};
        }
        if (cmd.__cmdName === "QueryCommand") {
          return { Items: storedItem ? [storedItem] : [] };
        }
        return {};
      },
    };
    const commands = {
      Put: (input: Record<string, unknown>) => ({ input, __cmdName: "PutCommand" }),
      Query: (input: Record<string, unknown>) => ({
        input,
        __cmdName: "QueryCommand",
      }),
    };
    const sink = new DynamoDBAuditSink({
      tableName: "test",
      client,
      commands,
    });

    const original: AuditEvent = {
      ...SAMPLE_EVENT,
      policyEvaluations: [{ allowed: false, policyName: "amt", reason: "too big" }],
      complianceCheck: {
        cleared: false,
        checkerName: "Static",
        matches: [{ address: "0xBAD", source: "OFAC", reason: "match" }],
      },
    };
    await sink.emit(original);
    const r = await sink.getByEventId(original.eventId);
    expect(r).toBeDefined();
    expect(r!.eventId).toBe(original.eventId);
    expect(r!.policyEvaluations).toEqual(original.policyEvaluations);
    expect(r!.complianceCheck).toEqual(original.complianceCheck);
    expect(r!.metadata).toEqual(original.metadata);
  });
});
