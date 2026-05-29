/**
 * TRMLabsChecker — TRM Labs Risk Score API wrapper.
 *
 * Endpoint:
 *   POST https://api.trmlabs.com/public/v2/screening/addresses
 *
 * Same shape as ChainalysisKYTChecker — HTTP-only, fail-closed by default.
 *
 * @license Apache-2.0
 */

import type { ComplianceChecker, ComplianceCheckResult } from "../compliance.js";

export interface TRMLabsConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  /** TRM risk score [0..10] — block at or above this. Default 7. */
  readonly blockAtOrAbove?: number;
  readonly failClosed?: boolean;
  /** chain hint per request — helps TRM disambiguate (e.g. "ethereum"). */
  readonly chain?: string;
}

const DEFAULT_BASE_URL = "https://api.trmlabs.com/public/v2";
const DEFAULT_TIMEOUT_MS = 5_000;

export class TRMLabsChecker implements ComplianceChecker {
  readonly name = "TRMLabsChecker";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly blockAtOrAbove: number;
  private readonly failClosed: boolean;
  private readonly chain?: string;

  constructor(private readonly config: TRMLabsConfig) {
    if (!config.apiKey) throw new Error("TRMLabsChecker: apiKey required");
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.blockAtOrAbove = config.blockAtOrAbove ?? 7;
    this.failClosed = config.failClosed ?? true;
    if (config.chain !== undefined) this.chain = config.chain;
  }

  async check(recipient: string): Promise<ComplianceCheckResult> {
    const url = `${this.baseUrl}/screening/addresses`;
    const body = [
      {
        address: recipient,
        chain: this.chain ?? "ethereum",
      },
    ];

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(this.config.apiKey + ":").toString("base64")}`,
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) return this.failResult(`HTTP ${res.status}`);
      const json = (await res.json()) as Array<{
        readonly address?: string;
        readonly addressRiskScore?: number;
        readonly addressRiskFactors?: ReadonlyArray<{ readonly riskType?: string }>;
      }>;
      const first = Array.isArray(json) ? json[0] : undefined;
      const score = first?.addressRiskScore ?? 0;
      if (score >= this.blockAtOrAbove) {
        return {
          cleared: false,
          checkerName: this.name,
          matches: [
            {
              address: recipient,
              source: "trm-labs",
              reason: `risk_score=${score} (threshold=${this.blockAtOrAbove})`,
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
              source: "trm-labs",
              reason: `api_error: ${reason}`,
            },
          ],
        }
      : { cleared: true, checkerName: this.name, matches: [] };
  }
}
