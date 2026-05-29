/**
 * ChainalysisKYTChecker — production-grade compliance checker.
 *
 * Wraps Chainalysis KYT (Know Your Transaction) API:
 *   POST https://api.chainalysis.com/api/kyt/v1/users/<userId>/transfers/<recipient>
 *
 * Implementation is HTTP-only — no Chainalysis SDK dependency. Customers who
 * want this checker provide their API key + (optional) custom fetch fn for
 * tests / proxies.
 *
 * Returned `risk` is mapped to ComplianceCheckResult shape:
 *   - "Severe" | "High"     → cleared=false, severe match
 *   - "Medium"              → cleared=false, medium match (configurable)
 *   - "Low" | "No risks"    → cleared=true
 *
 * @license Apache-2.0
 */

import type { ComplianceChecker, ComplianceCheckResult } from "../compliance.js";

export interface ChainalysisKYTConfig {
  /** Chainalysis API key — never log. */
  readonly apiKey: string;
  /** Override base URL — useful for staging / proxy. */
  readonly baseUrl?: string;
  /** Optional fetch implementation (Node 18+ has globalThis.fetch). */
  readonly fetchFn?: typeof fetch;
  /** Request timeout in ms. Default 5_000. */
  readonly timeoutMs?: number;
  /**
   * Risk levels considered "blocked" — default ["Severe", "High"]. Add
   * "Medium" if your jurisdiction requires it.
   */
  readonly blockedRiskLevels?: ReadonlyArray<
    "Severe" | "High" | "Medium" | "Low"
  >;
  /**
   * On API failure, return cleared=false (fail-closed) or cleared=true
   * (fail-open). Default fail-closed for compliance.
   */
  readonly failClosed?: boolean;
}

const DEFAULT_BASE_URL = "https://api.chainalysis.com/api/kyt/v1";
const DEFAULT_TIMEOUT_MS = 5_000;

interface ChainalysisV1WithdrawalAttempt {
  readonly transferReference: string;
  readonly asset: string;
  readonly outputAddress: string;
  readonly assetAmount: number | string;
  readonly transferOutputAt: string;
  readonly direction?: "sent" | "received";
}

export class ChainalysisKYTChecker implements ComplianceChecker {
  readonly name = "ChainalysisKYTChecker";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly blockedRiskLevels: ReadonlySet<string>;
  private readonly failClosed: boolean;

  constructor(private readonly config: ChainalysisKYTConfig) {
    if (!config.apiKey) throw new Error("ChainalysisKYTChecker: apiKey required");
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.blockedRiskLevels = new Set(
      config.blockedRiskLevels ?? ["Severe", "High"]
    );
    this.failClosed = config.failClosed ?? true;
  }

  async check(recipient: string): Promise<ComplianceCheckResult> {
    const userId = "openagentpay-runtime";
    const path = `/users/${encodeURIComponent(userId)}/withdrawal-attempts`;
    const url = `${this.baseUrl}${path}`;

    const attempt: ChainalysisV1WithdrawalAttempt = {
      transferReference: `oap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      asset: "USDC",
      outputAddress: recipient,
      assetAmount: 0, // pre-flight check
      transferOutputAt: new Date().toISOString(),
      direction: "sent",
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Token: this.config.apiKey,
          Accept: "application/json",
        },
        body: JSON.stringify([attempt]),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return this.failResult(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as Array<{
        readonly transferReference?: string;
        readonly riskLevel?: string;
        readonly rating?: string;
        readonly riskReasons?: ReadonlyArray<{ readonly category?: string; readonly value?: string }>;
      }>;
      const first = Array.isArray(json) ? json[0] : undefined;
      const riskLevel = first?.riskLevel ?? first?.rating ?? "Unknown";
      if (this.blockedRiskLevels.has(riskLevel)) {
        return {
          cleared: false,
          checkerName: this.name,
          matches: [
            {
              address: recipient,
              source: "chainalysis-kyt",
              reason: `risk=${riskLevel}`,
            },
          ],
        };
      }
      return { cleared: true, checkerName: this.name, matches: [] };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return this.failResult(reason);
    } finally {
      clearTimeout(timer);
    }
  }

  private failResult(reason: string): ComplianceCheckResult {
    return this.failClosed
      ? {
          cleared: false,
          checkerName: this.name,
          matches: [
            {
              address: "(api-unavailable)",
              source: "chainalysis-kyt",
              reason: `api_error: ${reason}`,
            },
          ],
        }
      : { cleared: true, checkerName: this.name, matches: [] };
  }
}
