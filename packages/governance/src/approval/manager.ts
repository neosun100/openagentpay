/**
 * Approval workflow — Cobo PACT-inspired multi-party approval state machine.
 *
 * For payments above a threshold, mark them "pending_approval", emit an audit
 * event, and gate `processPayment` until N of M approvers sign off.
 *
 * Storage is pluggable (in-memory for tests, DDB in production).
 *
 * @license Apache-2.0
 */

import type { Money, SessionId, UserId, WalletProviderId } from "@openagentpay/core";

// ============================================================================
//  Types
// ============================================================================

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executed";

export interface ApprovalRequest {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly initiator: UserId;
  readonly walletProvider: WalletProviderId;
  readonly recipient: string;
  readonly amount: Money;
  readonly reason: string;
  readonly requiredApprovals: number;
  readonly approverPool: ReadonlyArray<UserId>;
  readonly approvals: ReadonlyArray<ApprovalEvent>;
  readonly rejections: ReadonlyArray<ApprovalEvent>;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ApprovalEvent {
  readonly approver: UserId;
  readonly at: string;
  readonly note?: string;
}

export interface ApprovalStore {
  put(req: ApprovalRequest): Promise<void>;
  get(id: string): Promise<ApprovalRequest | undefined>;
  listPending(initiator?: UserId): Promise<ReadonlyArray<ApprovalRequest>>;
  update(req: ApprovalRequest): Promise<void>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly store = new Map<string, ApprovalRequest>();
  async put(req: ApprovalRequest): Promise<void> {
    this.store.set(req.id, req);
  }
  async get(id: string): Promise<ApprovalRequest | undefined> {
    return this.store.get(id);
  }
  async listPending(
    initiator?: UserId
  ): Promise<ReadonlyArray<ApprovalRequest>> {
    return [...this.store.values()].filter(
      (r) =>
        r.status === "pending" &&
        (initiator === undefined || r.initiator === initiator)
    );
  }
  async update(req: ApprovalRequest): Promise<void> {
    this.store.set(req.id, req);
  }
}

// ============================================================================
//  ApprovalManager
// ============================================================================

export interface ApprovalManagerConfig {
  readonly store: ApprovalStore;
  readonly defaultExpiryMinutes?: number;
  readonly now?: () => number;
}

export class ApprovalManager {
  private readonly defaultExpiryMinutes: number;
  private readonly now: () => number;
  constructor(private readonly config: ApprovalManagerConfig) {
    this.defaultExpiryMinutes = config.defaultExpiryMinutes ?? 60;
    this.now = config.now ?? (() => Date.now());
  }

  async create(input: {
    readonly sessionId: SessionId;
    readonly initiator: UserId;
    readonly walletProvider: WalletProviderId;
    readonly recipient: string;
    readonly amount: Money;
    readonly reason: string;
    readonly requiredApprovals: number;
    readonly approverPool: ReadonlyArray<UserId>;
    readonly expiryMinutes?: number;
  }): Promise<ApprovalRequest> {
    if (input.requiredApprovals < 1) {
      throw new Error("requiredApprovals must be >= 1");
    }
    if (input.approverPool.length < input.requiredApprovals) {
      throw new Error("approverPool smaller than requiredApprovals");
    }
    const id = `approval-${Math.random().toString(36).slice(2, 18)}`;
    const expiresAt = new Date(
      this.now() + (input.expiryMinutes ?? this.defaultExpiryMinutes) * 60_000
    ).toISOString();
    const req: ApprovalRequest = {
      id,
      sessionId: input.sessionId,
      initiator: input.initiator,
      walletProvider: input.walletProvider,
      recipient: input.recipient,
      amount: input.amount,
      reason: input.reason,
      requiredApprovals: input.requiredApprovals,
      approverPool: input.approverPool,
      approvals: [],
      rejections: [],
      status: "pending",
      createdAt: new Date(this.now()).toISOString(),
      expiresAt,
    };
    await this.config.store.put(req);
    return req;
  }

  async approve(id: string, approver: UserId, note?: string): Promise<ApprovalRequest> {
    const req = await this.requirePending(id);
    if (!req.approverPool.includes(approver)) {
      throw new Error(`approver ${approver} not in pool`);
    }
    if (req.approvals.some((e) => e.approver === approver)) {
      // idempotent — already approved
      return req;
    }
    if (req.initiator === approver) {
      throw new Error("self-approval forbidden");
    }
    const newEvt: ApprovalEvent = {
      approver,
      at: new Date(this.now()).toISOString(),
      ...(note !== undefined ? { note } : {}),
    };
    const approvals = [...req.approvals, newEvt];
    let status: ApprovalStatus = req.status;
    if (approvals.length >= req.requiredApprovals) status = "approved";
    const next: ApprovalRequest = { ...req, approvals, status };
    await this.config.store.update(next);
    return next;
  }

  async reject(id: string, approver: UserId, note?: string): Promise<ApprovalRequest> {
    const req = await this.requirePending(id);
    if (!req.approverPool.includes(approver)) {
      throw new Error(`approver ${approver} not in pool`);
    }
    const newEvt: ApprovalEvent = {
      approver,
      at: new Date(this.now()).toISOString(),
      ...(note !== undefined ? { note } : {}),
    };
    const next: ApprovalRequest = {
      ...req,
      rejections: [...req.rejections, newEvt],
      status: "rejected",
    };
    await this.config.store.update(next);
    return next;
  }

  async markExecuted(id: string): Promise<ApprovalRequest> {
    const req = await this.config.store.get(id);
    if (!req) throw new Error(`approval ${id} not found`);
    if (req.status !== "approved") {
      throw new Error(`approval ${id} not in 'approved' state (was ${req.status})`);
    }
    const next: ApprovalRequest = { ...req, status: "executed" };
    await this.config.store.update(next);
    return next;
  }

  /** Sweep — flips pending requests past expiresAt to status=expired. */
  async sweepExpired(): Promise<number> {
    const all = await this.config.store.listPending();
    let n = 0;
    for (const r of all) {
      if (new Date(r.expiresAt).getTime() < this.now()) {
        await this.config.store.update({ ...r, status: "expired" });
        n++;
      }
    }
    return n;
  }

  // -------------------------------------------------------------------------

  private async requirePending(id: string): Promise<ApprovalRequest> {
    const req = await this.config.store.get(id);
    if (!req) throw new Error(`approval ${id} not found`);
    if (req.status !== "pending") {
      throw new Error(`approval ${id} not pending (status=${req.status})`);
    }
    if (new Date(req.expiresAt).getTime() < this.now()) {
      const expired: ApprovalRequest = { ...req, status: "expired" };
      await this.config.store.update(expired);
      throw new Error(`approval ${id} expired`);
    }
    return req;
  }
}
