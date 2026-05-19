/**
 * Audit — Layer 7 of the Guardrail.
 *
 * Append-only audit log for every governance decision and payment outcome.
 * Designed for SOX / MRM / financial regulator audit requirements.
 *
 * Pluggable sinks:
 *   - InMemoryAuditSink   (demo / tests — keeps last N events)
 *   - ConsoleAuditSink    (prints structured JSON to stdout)
 *   - (future) CloudWatchAuditSink, S3AuditSink, OpenSearchAuditSink, SplunkAuditSink
 *
 * Each event carries:
 *   - eventId (uuidv7-style timestamp-ordered)
 *   - timestamp (ISO 8601)
 *   - kind (policy_check / compliance_check / payment_attempt / payment_success / payment_failure)
 *   - actor (userId)
 *   - subject (paymentSession / instrument / recipient)
 *   - decision (allowed/denied + reason)
 *   - context (relevant metadata for forensic reconstruction)
 */

import type { PolicyDecision } from "./policy.js";
import type { ComplianceCheckResult } from "./compliance.js";

export type AuditEventKind =
  | "policy_check"
  | "compliance_check"
  | "payment_attempt"
  | "payment_success"
  | "payment_failure"
  | "session_created"
  | "session_expired";

export interface AuditEvent {
  readonly eventId: string;
  readonly timestamp: string; // ISO 8601
  readonly kind: AuditEventKind;
  readonly actor: string; // userId
  readonly walletProvider?: string;
  readonly sessionId?: string;
  readonly instrumentId?: string;
  readonly recipient?: string;
  readonly amountAtomic?: string;
  readonly currency?: string;
  readonly chain?: string;
  readonly txHash?: string;
  readonly result: "allowed" | "denied" | "succeeded" | "failed" | "info";
  readonly reason?: string;
  readonly policyEvaluations?: ReadonlyArray<PolicyDecision>;
  readonly complianceCheck?: ComplianceCheckResult;
  /** Free-form metadata (e.g., agent reasoning chain). */
  readonly metadata?: Record<string, unknown>;
}

export interface AuditSink {
  emit(event: AuditEvent): Promise<void> | void;
}

// ============================================================================
//  In-memory sink — keeps last N events in a circular buffer
// ============================================================================
export class InMemoryAuditSink implements AuditSink {
  private events: AuditEvent[] = [];

  constructor(private readonly capacity: number = 1000) {}

  emit(event: AuditEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events = this.events.slice(-this.capacity);
    }
  }

  /** Read all events (for diagnostics / UI / tests). */
  readAll(): ReadonlyArray<AuditEvent> {
    return [...this.events];
  }

  /** Filter by kind / actor / result. */
  query(filter: {
    readonly kind?: AuditEventKind;
    readonly actor?: string;
    readonly result?: AuditEvent["result"];
    readonly since?: string; // ISO date
  }): ReadonlyArray<AuditEvent> {
    return this.events.filter((e) => {
      if (filter.kind && e.kind !== filter.kind) return false;
      if (filter.actor && e.actor !== filter.actor) return false;
      if (filter.result && e.result !== filter.result) return false;
      if (filter.since && e.timestamp < filter.since) return false;
      return true;
    });
  }

  clear(): void {
    this.events = [];
  }

  size(): number {
    return this.events.length;
  }
}

// ============================================================================
//  Console sink — prints structured JSON, useful in local dev
// ============================================================================
export class ConsoleAuditSink implements AuditSink {
  emit(event: AuditEvent): void {
    // Single-line JSON for easy grep / jq parsing
    console.log("[audit] " + JSON.stringify(event));
  }
}

// ============================================================================
//  AuditLogger — high-level helper that creates events with consistent shape
// ============================================================================
export class AuditLogger {
  constructor(
    private readonly sink: AuditSink,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Generate a new audit event id (timestamp-ordered hex). */
  private newId(): string {
    const t = this.now().toString(16).padStart(12, "0");
    const rand = Math.random().toString(16).slice(2, 10);
    return `audit-${t}-${rand}`;
  }

  async emit(
    partial: Omit<AuditEvent, "eventId" | "timestamp">
  ): Promise<void> {
    const event: AuditEvent = {
      eventId: this.newId(),
      timestamp: new Date(this.now()).toISOString(),
      ...partial,
    };
    await this.sink.emit(event);
  }
}
