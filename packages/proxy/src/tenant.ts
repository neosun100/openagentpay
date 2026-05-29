/**
 * Multi-tenant abstractions for OpenAgentPay Proxy.
 *
 * Borrowed from LiteLLM Proxy's "virtual key" model:
 *
 *   1. Each Tenant (team / cost-center / agent) gets a virtual API key.
 *   2. The key itself is opaque (`oap_sk_<random>`); we store ONLY its hash.
 *   3. Every request includes `Authorization: Bearer oap_sk_xxx`.
 *   4. The proxy resolves key → Tenant → enforced limits + allowed wallets.
 *
 * Compared to LiteLLM, our tenant model carries payment-specific limits:
 *   - dailyBudgetUsd / monthlyBudgetUsd
 *   - allowedWallets / allowedProtocols
 *   - requireTwoPersonApprovalAboveUsd
 *   - sandbox-only flag (forbids mainnet wallets)
 *
 * @license Apache-2.0
 */

import { createHash, randomBytes } from "node:crypto";

// ============================================================================
//  Types
// ============================================================================

export interface VirtualApiKey {
  /** Opaque key shown ONCE on creation: `oap_sk_<24-char-hex>`. */
  readonly plaintext: string;
  /** sha256 hash stored at rest. */
  readonly hash: string;
  /** Identifier surfaced in logs (first 12 chars of hash). */
  readonly id: string;
}

export interface Tenant {
  /** Stable tenant id — typically slug like "research-agents" or "trading-bots". */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Hash (NOT plaintext) of the virtual API key. */
  readonly apiKeyHash: string;
  /** Whitelist of wallet provider ids this tenant may use. Empty = all allowed. */
  readonly allowedWallets: readonly string[];
  /** Whitelist of protocol ids. Empty = all allowed. */
  readonly allowedProtocols: readonly string[];
  /** Hard daily budget cap in USD. */
  readonly dailyBudgetUsd: number;
  /** Optional monthly budget cap in USD. */
  readonly monthlyBudgetUsd?: number;
  /** Approvals required when a single payment exceeds this USD amount. */
  readonly requireTwoPersonApprovalAboveUsd?: number;
  /** Forbid mainnet wallets — testnet/sandbox only. */
  readonly sandboxOnly?: boolean;
  /** Free-form metadata: cost-center, owner email, slack channel, etc. */
  readonly metadata?: Record<string, string>;
  /** ISO 8601 created-at. */
  readonly createdAt: string;
  /** ISO 8601 updated-at. */
  readonly updatedAt: string;
  /** "active" | "suspended". */
  readonly status: "active" | "suspended";
}

export interface TenantStore {
  /** Resolve by API key hash. Returns undefined if no match. */
  findByApiKeyHash(hash: string): Promise<Tenant | undefined>;
  /** Resolve by id. */
  findById(id: string): Promise<Tenant | undefined>;
  /** Persist. Returns the stored Tenant. */
  put(tenant: Tenant): Promise<Tenant>;
  /** List all tenants. */
  list(): Promise<readonly Tenant[]>;
  /** Suspend (soft-disable) — keeps the row, sets status=suspended. */
  suspend(id: string): Promise<void>;
  /** Permanently delete a tenant. */
  remove(id: string): Promise<void>;
}

// ============================================================================
//  In-memory implementation (for tests / local dev)
// ============================================================================

export class InMemoryTenantStore implements TenantStore {
  private readonly byId = new Map<string, Tenant>();
  private readonly byHash = new Map<string, Tenant>();

  async findByApiKeyHash(hash: string): Promise<Tenant | undefined> {
    return this.byHash.get(hash);
  }

  async findById(id: string): Promise<Tenant | undefined> {
    return this.byId.get(id);
  }

  async put(tenant: Tenant): Promise<Tenant> {
    const existing = this.byId.get(tenant.id);
    if (existing && existing.apiKeyHash !== tenant.apiKeyHash) {
      // API key was rotated — drop the old hash mapping.
      this.byHash.delete(existing.apiKeyHash);
    }
    this.byId.set(tenant.id, tenant);
    this.byHash.set(tenant.apiKeyHash, tenant);
    return tenant;
  }

  async list(): Promise<readonly Tenant[]> {
    return [...this.byId.values()];
  }

  async suspend(id: string): Promise<void> {
    const t = this.byId.get(id);
    if (!t) return;
    const updated: Tenant = { ...t, status: "suspended", updatedAt: nowIso() };
    this.byId.set(id, updated);
    this.byHash.set(t.apiKeyHash, updated);
  }

  async remove(id: string): Promise<void> {
    const t = this.byId.get(id);
    if (!t) return;
    this.byId.delete(id);
    this.byHash.delete(t.apiKeyHash);
  }
}

// ============================================================================
//  Helpers
// ============================================================================

/** Mint a new virtual API key. The plaintext is shown ONCE on creation. */
export function generateVirtualApiKey(): VirtualApiKey {
  const raw = randomBytes(24).toString("hex");
  const plaintext = `oap_sk_${raw}`;
  const hash = hashApiKey(plaintext);
  return { plaintext, hash, id: hash.slice(0, 12) };
}

/** Hash an API key. Use this on every incoming request to look up the tenant. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}
