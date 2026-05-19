/**
 * Compliance — Layer 5 of the Guardrail.
 *
 * Sanctions / OFAC / illicit finance checks for payment recipients.
 *
 * Built-in:
 *   - StaticSanctionsChecker — match against a static list (good for demo,
 *     for production swap with Chainalysis API or OFAC SDN integration)
 *
 * Future production checkers (extension point):
 *   - ChainalysisChecker (KYT API)
 *   - TRMLabsChecker
 *   - EllipticChecker
 *   - OFAC SDN list parser
 */

// Note: we use plain `string` for addresses here (no viem dependency)
// to keep governance dependency-free across chain types (EVM/Solana/etc).

export interface SanctionsList {
  readonly addresses: ReadonlyArray<string>;
  readonly source: string; // "OFAC SDN" / "Chainalysis" / "manual"
  readonly lastUpdated: string; // ISO 8601
}

export interface ComplianceCheckResult {
  readonly cleared: boolean;
  readonly checkerName: string;
  readonly matches: ReadonlyArray<{
    readonly address: string;
    readonly source: string;
    readonly reason: string;
  }>;
}

export interface ComplianceChecker {
  readonly name: string;
  check(recipient: string): Promise<ComplianceCheckResult>;
}

/**
 * Static sanctions checker — matches against an in-memory list.
 *
 * For demo purposes ships with a few known burn / honeypot addresses.
 * Production deployments should swap this with a live KYT integration.
 */
export class StaticSanctionsChecker implements ComplianceChecker {
  readonly name = "StaticSanctionsChecker";
  private readonly lists: Map<string, SanctionsList> = new Map();
  private readonly index: Map<string, Set<string>> = new Map(); // addr -> {source}

  constructor(initialLists: ReadonlyArray<SanctionsList> = []) {
    for (const list of initialLists) {
      this.addList(list);
    }
  }

  addList(list: SanctionsList): void {
    this.lists.set(list.source, list);
    for (const addr of list.addresses) {
      const lower = addr.toLowerCase();
      if (!this.index.has(lower)) this.index.set(lower, new Set());
      this.index.get(lower)!.add(list.source);
    }
  }

  async check(recipient: string): Promise<ComplianceCheckResult> {
    const lower = recipient.toLowerCase();
    const sources = this.index.get(lower);
    if (sources && sources.size > 0) {
      return {
        cleared: false,
        checkerName: this.name,
        matches: [...sources].map((s) => ({
          address: recipient,
          source: s,
          reason: `recipient on sanctions list: ${s}`,
        })),
      };
    }
    return { cleared: true, checkerName: this.name, matches: [] };
  }

  /** Diagnostic: how many addresses are tracked across all lists. */
  size(): number {
    return this.index.size;
  }
}

/**
 * Demo sanctions list — a few well-known dangerous patterns.
 * NOT a comprehensive list. Use a real KYT provider for production.
 */
export const DEMO_SANCTIONS_LIST: SanctionsList = {
  source: "OpenAgentPay demo list (illustrative only)",
  lastUpdated: new Date().toISOString(),
  addresses: [
    // Tornado Cash router (illustrative — actual OFAC-sanctioned)
    "0x8589427373d6d84e98730d7795d8f6f8731fda16",
    // Lazarus Group example (illustrative)
    "0x7f367cc41522ce07553e823bf3be79a889debe1b",
  ],
};

/**
 * Aggregate multiple checkers — fail-closed: if ANY checker fails, deny.
 */
export class CompositeComplianceChecker implements ComplianceChecker {
  readonly name: string;

  constructor(private readonly checkers: ReadonlyArray<ComplianceChecker>) {
    this.name = `Composite(${checkers.map((c) => c.name).join(",")})`;
  }

  async check(recipient: string): Promise<ComplianceCheckResult> {
    const allMatches: ComplianceCheckResult["matches"][number][] = [];
    let cleared = true;
    for (const c of this.checkers) {
      const r = await c.check(recipient);
      if (!r.cleared) {
        cleared = false;
        for (const m of r.matches) allMatches.push(m);
      }
    }
    return {
      cleared,
      checkerName: this.name,
      matches: allMatches,
    };
  }
}

// type re-exports for typings convenience
// (no Address re-export — governance is chain-agnostic)
