/**
 * OFACSdnAutoSyncChecker — fetches the official OFAC SDN list and refreshes
 * an in-memory bloom-set of sanctioned crypto addresses on a configurable
 * interval. Combines convenience of StaticSanctionsChecker with freshness.
 *
 * Source: https://www.treasury.gov/ofac/downloads/sdn.xml
 *
 * For lightweight deployments we accept a pre-parsed JSON feed at:
 *   https://data.sanctions.io/datasets/us_ofac_sdn_v1.json
 * (third-party but well-maintained).
 *
 * @license Apache-2.0
 */

import type { ComplianceChecker, ComplianceCheckResult } from "../compliance.js";

export interface OFACSdnAutoSyncConfig {
  /** URL to fetch sanctioned addresses (newline- or JSON-separated list). */
  readonly feedUrl: string;
  /** Refresh interval in ms. Default 24h. */
  readonly refreshIntervalMs?: number;
  /** fetch override — for tests. */
  readonly fetchFn?: typeof fetch;
  /** Optional manual seed list — used until first refresh succeeds. */
  readonly seed?: ReadonlyArray<string>;
  /** Fail-closed on fetch failure. Default true. */
  readonly failClosed?: boolean;
}

const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Internal: ingest the feed body. We accept either:
 *   - JSON array: ["0xabc...", "0xdef..."]
 *   - Plain text: one address per line, comments allowed (`#`)
 */
function parseFeed(body: string): string[] {
  const trimmed = body.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) {
        return arr
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0);
      }
    } catch {
      // fallthrough to line-by-line
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"))
    .map((s) => s.toLowerCase());
}

export class OFACSdnAutoSyncChecker implements ComplianceChecker {
  readonly name = "OFACSdnAutoSyncChecker";
  private readonly fetchFn: typeof fetch;
  private readonly refreshIntervalMs: number;
  private readonly failClosed: boolean;
  private readonly feedUrl: string;
  private blocked: Set<string>;
  private lastRefreshedAt: number = 0;
  private inflight: Promise<void> | null = null;

  constructor(config: OFACSdnAutoSyncConfig) {
    this.feedUrl = config.feedUrl;
    this.refreshIntervalMs = config.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.failClosed = config.failClosed ?? true;
    const seed = (config.seed ?? []).map((s) => s.toLowerCase());
    this.blocked = new Set(seed);
    // If a seed is provided, treat it as the initial load — defer the
    // first refresh until refreshIntervalMs has elapsed. Without this
    // the very first check() would refresh immediately and overwrite
    // the seed (test fixtures depend on this).
    if (seed.length > 0) {
      this.lastRefreshedAt = Date.now();
    }
  }

  /** Force a sync. Idempotent if already in flight. */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const res = await this.fetchFn(this.feedUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const addrs = parseFeed(text);
        this.blocked = new Set(addrs);
        this.lastRefreshedAt = Date.now();
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Number of sanctioned addresses currently loaded. */
  size(): number {
    return this.blocked.size;
  }

  /** ISO 8601 last successful refresh timestamp, or undefined if never. */
  lastRefreshed(): string | undefined {
    return this.lastRefreshedAt > 0
      ? new Date(this.lastRefreshedAt).toISOString()
      : undefined;
  }

  async check(recipient: string): Promise<ComplianceCheckResult> {
    // Lazy refresh if stale
    const stale = Date.now() - this.lastRefreshedAt > this.refreshIntervalMs;
    if (stale) {
      try {
        await this.refresh();
      } catch (err) {
        if (this.failClosed && this.blocked.size === 0) {
          return {
            cleared: false,
            checkerName: this.name,
            matches: [
              {
                address: recipient,
                source: "ofac-sdn",
                reason: `refresh_failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
        // Else: serve stale data
      }
    }

    if (this.blocked.has(recipient.toLowerCase())) {
      return {
        cleared: false,
        checkerName: this.name,
        matches: [
          {
            address: recipient,
            source: "ofac-sdn",
            reason: "sanctioned_address",
          },
        ],
      };
    }
    return { cleared: true, checkerName: this.name, matches: [] };
  }
}
