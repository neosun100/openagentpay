/**
 * API client + activity log singleton.
 * The Activity Log is updated by every API call so the UI can show live trace.
 */

export interface WalletStatus {
  address: string;
  addressExplorer: string;
  network: string;
  chainId: number;
  token: string;
  tokenAddress: string;
  tokenExplorer: string;
  decimals: number;
  balance: number;
  balanceRaw: string;
  instrumentId: string;
  walletProvider: string;
}

export interface CreateSessionResp {
  sessionId: string;
  budgetUsd: number;
  expiryMinutes: number;
  createdAt: string;
  expiresAt: string;
}

export interface SessionStatus {
  sessionId: string;
  status: string;
  budgetAtomic: string;
  spentAtomic: string;
  currency: string;
  decimals: number;
  expiresAt: string;
}

export interface PayResp {
  success: boolean;
  txHash?: string;
  explorerUrl?: string;
  amountUsdc: number;
  amountAtomic: string;
  payer: string;
  recipient: string;
  network: string;
  errorCode?: string;
  errorMessage?: string;
  paymentPayload: {
    chainId: number;
    verifyingContract: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: number;
      validBefore: number;
      nonce: string;
    };
    signature: string;
    v: number;
    r: string;
    s: string;
  };
  verifyResult: { isValid: boolean; payer: string };
  settleResult: {
    success: boolean;
    transaction: string;
    network: string;
    payer: string;
    blockNumber?: string;
    gasUsed?: string;
  };
}

// ----------------------------------------------------------------------------
//  Activity log (in-process singleton, observable)
// ----------------------------------------------------------------------------

export type LogEntryKind = "req" | "res" | "info" | "error";

export interface LogEntry {
  ts: string;
  kind: LogEntryKind;
  msg: string;
}

type Listener = (entries: readonly LogEntry[]) => void;

class ActivityLog {
  private entries: LogEntry[] = [];
  private listeners: Set<Listener> = new Set();

  push(kind: LogEntryKind, msg: string) {
    const ts = new Date().toISOString().split("T")[1]!.replace("Z", "").slice(0, 12);
    this.entries = [...this.entries, { ts, kind, msg }];
    if (this.entries.length > 200) this.entries = this.entries.slice(-200);
    for (const l of this.listeners) l(this.entries);
  }

  clear() {
    this.entries = [];
    for (const l of this.listeners) l(this.entries);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.entries);
    return () => this.listeners.delete(listener);
  }

  snapshot(): readonly LogEntry[] {
    return this.entries;
  }
}

export const activityLog = new ActivityLog();

// ----------------------------------------------------------------------------
//  Fetch helpers
// ----------------------------------------------------------------------------

async function fetchJson<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  activityLog.push("req", `${method} ${path}${body ? " " + summarizeBody(body) : ""}`);
  const start = Date.now();
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      activityLog.push("error", `${method} ${path} → ${res.status} (${ms}ms) ${err.code ?? ""}: ${err.message ?? ""}`);
      throw new Error(err.message ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    activityLog.push("res", `${method} ${path} → ${res.status} (${ms}ms) ${summarizeResp(data)}`);
    return data as T;
  } catch (err) {
    const ms = Date.now() - start;
    activityLog.push("error", `${method} ${path} → ERROR (${ms}ms) ${(err as Error).message}`);
    throw err;
  }
}

function summarizeBody(b: Record<string, unknown>): string {
  return Object.entries(b)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

function summarizeResp(r: unknown): string {
  const o = r as Record<string, unknown>;
  if (typeof o["balance"] === "number") return `balance=${o["balance"]} ${o["token"] ?? ""}`;
  if (typeof o["sessionId"] === "string")
    return `sessionId=${(o["sessionId"] as string).slice(0, 28)}…`;
  if (typeof o["txHash"] === "string")
    return `tx=${(o["txHash"] as string).slice(0, 14)}…`;
  return "";
}

// ----------------------------------------------------------------------------
//  Public API
// ----------------------------------------------------------------------------

export const api = {
  health: () => fetchJson<{ ok: boolean }>("GET", "/api/health"),
  wallet: () => fetchJson<WalletStatus>("GET", "/api/wallet"),
  createSession: (budgetUsd: number, expiryMinutes: number) =>
    fetchJson<CreateSessionResp>("POST", "/api/session", { budgetUsd, expiryMinutes }),
  getSession: (id: string) => fetchJson<SessionStatus>("GET", `/api/session/${id}`),
  pay: (sessionId: string, amountUsdc: number) =>
    fetchJson<PayResp>("POST", "/api/pay", { sessionId, amountUsdc }),
};
