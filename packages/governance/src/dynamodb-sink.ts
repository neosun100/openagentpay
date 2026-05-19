/**
 * DynamoDBAuditSink — production-grade Layer 7 audit log persistence.
 *
 * Persists every AuditEvent into a DynamoDB table designed for:
 *   - Per-actor querying (forensic reconstruction for one user)
 *   - Per-kind querying (e.g., all denied policy_check events)
 *   - Time-range queries (last 24h, last 7d)
 *   - Append-only semantics (no UpdateItem; only PutItem with conditional check)
 *
 * Table schema (created by CDK):
 *   PK (actor)              S   = userId
 *   SK (timestampEventId)   S   = "{ISO8601}#{eventId}" — uniqueness within actor
 *   eventId                 S   = audit-{hex_ts}-{rand}  (also keyed in GSI)
 *   kind                    S   = policy_check / payment_success / ...
 *   result                  S   = allowed / denied / succeeded / failed / info
 *   timestamp               S   = ISO 8601
 *   walletProvider          S?
 *   sessionId               S?
 *   recipient               S?
 *   amountAtomic            S?
 *   currency                S?
 *   chain                   S?
 *   txHash                  S?
 *   reason                  S?
 *   policyEvaluations       S?  (JSON-serialized — DynamoDB doesn't love nested arrays)
 *   complianceCheck         S?  (JSON-serialized)
 *   metadata                S?  (JSON-serialized)
 *
 * GSI byKind:
 *   PK (kind)               S
 *   SK (timestamp)          S
 *
 * GSI byEventId:
 *   PK (eventId)            S    (single-event lookup by id)
 *
 * @license Apache-2.0
 */

import type { AuditEvent, AuditSink } from "./audit.js";

/**
 * Loose interface to allow any DocumentClient-like object.
 * In production: pass a real DynamoDBDocumentClient from @aws-sdk/lib-dynamodb.
 * In tests: pass a mock with the same `send()` signature.
 */
export interface DynamoDBDocClientLike {
  send(command: any): Promise<any>;
}

/**
 * Command factory functions. We accept these as injectable so:
 *   - In production, you pass real SDK PutCommand/QueryCommand classes.
 *     The DynamoDBDocumentClient.send() inspects each command instance for
 *     middleware metadata, so plain objects don't work — must be real classes.
 *   - In tests, you pass simple factories that return plain `{ input }` objects
 *     a mock client can introspect.
 */
export interface CommandFactories {
  /** Equivalent to `new PutCommand(input)` from @aws-sdk/lib-dynamodb. */
  readonly Put: (input: Record<string, unknown>) => unknown;
  /** Equivalent to `new QueryCommand(input)` from @aws-sdk/lib-dynamodb. */
  readonly Query: (input: Record<string, unknown>) => unknown;
}

/**
 * Lazy-loaded default factories that import real SDK classes. We don't want
 * a hard ESM import on `@aws-sdk/lib-dynamodb` because the package is
 * declared as an optional peerDependency.
 */
let _cachedDefaultFactories: CommandFactories | null = null;
async function defaultFactories(): Promise<CommandFactories> {
  if (_cachedDefaultFactories) return _cachedDefaultFactories;
  // Use eval('import') to defer module resolution to runtime — keeps tsc happy
  // when @aws-sdk/lib-dynamodb isn't installed at compile time.
  const mod = (await import("@aws-sdk/lib-dynamodb")) as any;
  _cachedDefaultFactories = {
    Put: (input) => new mod.PutCommand(input),
    Query: (input) => new mod.QueryCommand(input),
  };
  return _cachedDefaultFactories;
}

export interface DynamoDBAuditSinkConfig {
  readonly tableName: string;
  readonly client: DynamoDBDocClientLike;
  /** Optional command factories — for tests. Defaults to real SDK PutCommand/QueryCommand. */
  readonly commands?: CommandFactories;
  /** Optional GSI names — defaults match what CDK creates. */
  readonly byKindIndexName?: string; // default: byKind
  readonly byEventIdIndexName?: string; // default: byEventId
  /** Override clock for tests. */
  readonly now?: () => number;
}

/** Result of querying audit events from DynamoDB. */
export interface AuditQueryResult {
  readonly events: ReadonlyArray<AuditEvent>;
  /** Pagination cursor (DynamoDB LastEvaluatedKey, if any). */
  readonly nextCursor?: string;
}

export class DynamoDBAuditSink implements AuditSink {
  private readonly tableName: string;
  private readonly client: DynamoDBDocClientLike;
  private readonly byKindIndexName: string;
  private readonly byEventIdIndexName: string;
  private readonly explicitCommands: CommandFactories | undefined;

  constructor(cfg: DynamoDBAuditSinkConfig) {
    if (!cfg.tableName) throw new Error("tableName is required");
    if (!cfg.client) throw new Error("client is required");
    this.tableName = cfg.tableName;
    this.client = cfg.client;
    this.byKindIndexName = cfg.byKindIndexName ?? "byKind";
    this.byEventIdIndexName = cfg.byEventIdIndexName ?? "byEventId";
    this.explicitCommands = cfg.commands;
  }

  private async getCommands(): Promise<CommandFactories> {
    return this.explicitCommands ?? (await defaultFactories());
  }

  /** Emit an audit event. Append-only: each event is written once with PK actor + SK timestamp#eventId. */
  async emit(event: AuditEvent): Promise<void> {
    const item = serializeAuditEvent(event);
    const { Put } = await this.getCommands();
    await this.client.send(
      Put({
        TableName: this.tableName,
        Item: item,
        // Conditional write: don't overwrite existing event with same actor+SK
        ConditionExpression: "attribute_not_exists(actor)",
      })
    );
  }

  /**
   * Query events for one actor (userId), optionally filtered by time range.
   * Returns most-recent-first (ScanIndexForward=false) by default.
   */
  async queryByActor(opts: {
    readonly actor: string;
    readonly since?: string; // ISO 8601
    readonly until?: string; // ISO 8601
    readonly limit?: number;
    readonly cursor?: string;
    readonly ascending?: boolean;
  }): Promise<AuditQueryResult> {
    const exprNames: Record<string, string> = { "#actor": "actor" };
    const exprValues: Record<string, unknown> = { ":actor": opts.actor };
    let keyCondition = "#actor = :actor";

    if (opts.since && opts.until) {
      exprNames["#sk"] = "timestampEventId";
      keyCondition = "#actor = :actor AND #sk BETWEEN :since AND :untilHigh";
      exprValues[":since"] = opts.since;
      exprValues[":untilHigh"] = opts.until + "\uffff";
    } else if (opts.since) {
      exprNames["#sk"] = "timestampEventId";
      keyCondition = "#actor = :actor AND #sk >= :since";
      exprValues[":since"] = opts.since;
    } else if (opts.until) {
      exprNames["#sk"] = "timestampEventId";
      keyCondition = "#actor = :actor AND #sk <= :untilHigh";
      exprValues[":untilHigh"] = opts.until + "\uffff";
    }

    const query: Record<string, unknown> = {
      TableName: this.tableName,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ScanIndexForward: opts.ascending ?? false,
    };
    if (opts.limit) query["Limit"] = opts.limit;
    if (opts.cursor) query["ExclusiveStartKey"] = JSON.parse(opts.cursor);

    const { Query } = await this.getCommands();
    const r = await this.client.send(Query(query));
    return parseQueryResult(r);
  }

  /** Query events by kind (uses byKind GSI). Newest-first by default. */
  async queryByKind(opts: {
    readonly kind: string;
    readonly since?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<AuditQueryResult> {
    const exprNames: Record<string, string> = { "#kind": "kind" };
    const exprValues: Record<string, unknown> = { ":kind": opts.kind };
    let keyCondition = "#kind = :kind";

    if (opts.since) {
      exprNames["#ts"] = "timestamp";
      keyCondition = "#kind = :kind AND #ts >= :since";
      exprValues[":since"] = opts.since;
    }

    const query: Record<string, unknown> = {
      TableName: this.tableName,
      IndexName: this.byKindIndexName,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ScanIndexForward: false,
    };
    if (opts.limit) query["Limit"] = opts.limit;
    if (opts.cursor) query["ExclusiveStartKey"] = JSON.parse(opts.cursor);

    const { Query } = await this.getCommands();
    const r = await this.client.send(Query(query));
    return parseQueryResult(r);
  }

  /** Look up a single event by eventId (uses byEventId GSI). */
  async getByEventId(eventId: string): Promise<AuditEvent | undefined> {
    const { Query } = await this.getCommands();
    const r = await this.client.send(
      Query({
        TableName: this.tableName,
        IndexName: this.byEventIdIndexName,
        KeyConditionExpression: "eventId = :eid",
        ExpressionAttributeValues: { ":eid": eventId },
        Limit: 1,
      })
    );
    const items = (r?.Items as ReadonlyArray<Record<string, any>>) ?? [];
    if (items.length === 0) return undefined;
    return deserializeAuditEvent(items[0]!);
  }
}

// ============================================================================
//  Serialization helpers
// ============================================================================

function serializeAuditEvent(e: AuditEvent): Record<string, unknown> {
  const item: Record<string, unknown> = {
    actor: e.actor,
    timestampEventId: `${e.timestamp}#${e.eventId}`,
    eventId: e.eventId,
    timestamp: e.timestamp,
    kind: e.kind,
    result: e.result,
  };
  if (e.walletProvider != null) item["walletProvider"] = e.walletProvider;
  if (e.sessionId != null) item["sessionId"] = e.sessionId;
  if (e.instrumentId != null) item["instrumentId"] = e.instrumentId;
  if (e.recipient != null) item["recipient"] = e.recipient;
  if (e.amountAtomic != null) item["amountAtomic"] = e.amountAtomic;
  if (e.currency != null) item["currency"] = e.currency;
  if (e.chain != null) item["chain"] = e.chain;
  if (e.txHash != null) item["txHash"] = e.txHash;
  if (e.reason != null) item["reason"] = e.reason;
  // Nested fields → JSON-encode for simple DDB storage
  if (e.policyEvaluations != null) {
    item["policyEvaluations"] = JSON.stringify(e.policyEvaluations);
  }
  if (e.complianceCheck != null) {
    item["complianceCheck"] = JSON.stringify(e.complianceCheck);
  }
  if (e.metadata != null) {
    item["metadata"] = JSON.stringify(e.metadata);
  }
  return item;
}

function deserializeAuditEvent(item: Record<string, any>): AuditEvent {
  const out: any = {
    eventId: item["eventId"] ?? "",
    timestamp: item["timestamp"] ?? "",
    kind: item["kind"] ?? "",
    actor: item["actor"] ?? "",
    result: item["result"] ?? "",
  };
  if (item["walletProvider"] != null) out.walletProvider = item["walletProvider"];
  if (item["sessionId"] != null) out.sessionId = item["sessionId"];
  if (item["instrumentId"] != null) out.instrumentId = item["instrumentId"];
  if (item["recipient"] != null) out.recipient = item["recipient"];
  if (item["amountAtomic"] != null) out.amountAtomic = item["amountAtomic"];
  if (item["currency"] != null) out.currency = item["currency"];
  if (item["chain"] != null) out.chain = item["chain"];
  if (item["txHash"] != null) out.txHash = item["txHash"];
  if (item["reason"] != null) out.reason = item["reason"];
  if (item["policyEvaluations"] != null) {
    try {
      out.policyEvaluations = JSON.parse(item["policyEvaluations"]);
    } catch {
      out.policyEvaluations = [];
    }
  }
  if (item["complianceCheck"] != null) {
    try {
      out.complianceCheck = JSON.parse(item["complianceCheck"]);
    } catch {
      // skip malformed
    }
  }
  if (item["metadata"] != null) {
    try {
      out.metadata = JSON.parse(item["metadata"]);
    } catch {
      // skip malformed
    }
  }
  return out as AuditEvent;
}

function parseQueryResult(r: any): AuditQueryResult {
  const items = (r?.Items ?? []) as Record<string, any>[];
  const events = items.map(deserializeAuditEvent);
  if (r?.LastEvaluatedKey) {
    return { events, nextCursor: JSON.stringify(r.LastEvaluatedKey) };
  }
  return { events };
}
