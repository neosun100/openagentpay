/**
 * WalletRouter — automatic dispatch + fallback over multiple WalletConnectors.
 * =============================================================================
 *
 * The LiteLLM Router equivalent for OpenAgentPay. Given a fleet of registered
 * wallets, choose the right one for each payment based on:
 *
 *   - capability filtering (asset / chain / protocol must match the request)
 *   - per-wallet allow / deny lists
 *   - selection strategy (priority / least-cost / least-latency / round-robin / affinity)
 *   - automatic fallback on transient failures (rpc_error / rate_limited)
 *   - retry budget (max attempts across the whole fleet)
 *
 * Together with `ProtocolRouter` (which dispatches over protocols), this lets
 * an agent satisfy a payment request without picking a wallet by hand:
 *
 *     const fleet = new WalletRouter({
 *       connectors: [...],
 *       strategy: "least-cost",
 *       fallback: ["coinbase-cdp", "hashkey-chain", "binance-pay"],
 *     });
 *     const choice = await fleet.choose({ request, instrumentResolver });
 *     const out = await pm.processPayment({
 *       sessionId,
 *       instrumentId: choice.instrumentId,
 *       request,
 *     });
 *
 * Failure handling: choose() never throws — it returns either a `WalletChoice`
 * or a `WalletRoutingFailure` describing every attempted wallet's reason for
 * not being selected. The caller (or the Proxy layer) decides whether to
 * surface that to the agent or fall through.
 *
 * @license Apache-2.0
 */

import type {
  Instrument,
  InstrumentId,
  PaymentRequest,
  WalletCapabilities,
  WalletConnector,
  WalletProviderId,
} from "../types.js";

// ============================================================================
//  Types
// ============================================================================

export type WalletSelectionStrategy =
  /** Use the fallback list order verbatim — first match wins. */
  | "priority"
  /** Prefer wallets with the lowest typicalLatencyMs. */
  | "least-latency"
  /** Prefer CEX wallets (settlesOnChain=false) — they have no gas cost. */
  | "least-cost"
  /** Round-robin across eligible wallets — useful for load balancing. */
  | "round-robin"
  /** Use the same wallet for the same userId every time (sticky). */
  | "user-affinity";

export interface WalletRouterConfig {
  /** Registered connectors. */
  readonly connectors: ReadonlyArray<WalletConnector>;
  /**
   * Wallet provider IDs in fallback order. If empty, all connectors are
   * considered. The strategy then orders within this set.
   */
  readonly fallback?: ReadonlyArray<WalletProviderId>;
  /** Selection strategy. Default "priority". */
  readonly strategy?: WalletSelectionStrategy;
  /** Max wallets to try before giving up. Default 3. */
  readonly maxAttempts?: number;
  /**
   * Optional per-wallet capability overrides — useful to mark a wallet
   * "down" without removing it from `connectors`.
   */
  readonly disabledProviders?: ReadonlyArray<WalletProviderId>;
}

export interface WalletChoice {
  /** The chosen connector. */
  readonly connector: WalletConnector;
  /** The capabilities at choice time. */
  readonly capabilities: WalletCapabilities;
  /** The instrumentId resolved for this connector. */
  readonly instrumentId: InstrumentId;
  /** Ordered list of providers we considered (for diagnostics). */
  readonly considered: ReadonlyArray<WalletProviderId>;
  /** Per-attempt rejection reasons keyed by walletProvider. */
  readonly rejections: Readonly<Record<string, string>>;
  /** Strategy that picked this wallet. */
  readonly strategy: WalletSelectionStrategy;
}

export interface WalletRoutingFailure {
  readonly reason: "no_eligible_wallet" | "no_instrument" | "all_disabled";
  readonly considered: ReadonlyArray<WalletProviderId>;
  readonly rejections: Readonly<Record<string, string>>;
}

export type WalletRoutingResult =
  | ({ readonly ok: true } & WalletChoice)
  | ({ readonly ok: false } & WalletRoutingFailure);

export interface ChooseInput {
  readonly request: PaymentRequest;
  readonly userId?: string;
  /** Resolve a (provider, userId) pair → existing or freshly-created Instrument. */
  readonly instrumentResolver: (
    provider: WalletProviderId,
    connector: WalletConnector
  ) => Promise<Instrument | undefined>;
}

// ============================================================================
//  WalletRouter
// ============================================================================

export class WalletRouter {
  private readonly connectors: ReadonlyMap<WalletProviderId, WalletConnector>;
  private readonly fallback: ReadonlyArray<WalletProviderId>;
  private readonly strategy: WalletSelectionStrategy;
  private readonly disabled: ReadonlySet<WalletProviderId>;
  private readonly maxAttempts: number;
  private rrIndex = 0;
  private readonly affinityCache = new Map<string, WalletProviderId>();

  constructor(config: WalletRouterConfig) {
    if (!Array.isArray(config.connectors) || config.connectors.length === 0) {
      throw new Error("WalletRouter requires at least one connector");
    }
    const map = new Map<WalletProviderId, WalletConnector>();
    for (const c of config.connectors) {
      const caps = c.getCapabilities();
      map.set(caps.walletProvider, c);
    }
    this.connectors = map;
    this.fallback = config.fallback ?? [...map.keys()];
    this.strategy = config.strategy ?? "priority";
    this.disabled = new Set(config.disabledProviders ?? []);
    this.maxAttempts = config.maxAttempts ?? 3;
  }

  // -------------------------------------------------------------------------
  //  list / get — diagnostics
  // -------------------------------------------------------------------------

  list(): ReadonlyArray<WalletProviderId> {
    return [...this.connectors.keys()];
  }

  get(provider: WalletProviderId): WalletConnector | undefined {
    return this.connectors.get(provider);
  }

  // -------------------------------------------------------------------------
  //  choose() — the heart of the router
  // -------------------------------------------------------------------------

  async choose(input: ChooseInput): Promise<WalletRoutingResult> {
    const considered: WalletProviderId[] = [];
    const rejections: Record<string, string> = {};

    // 1. Build the candidate list from the fallback order
    const candidates: WalletProviderId[] = [];
    for (const id of this.fallback) {
      if (!this.connectors.has(id)) {
        rejections[id] = "not_registered";
        continue;
      }
      if (this.disabled.has(id)) {
        rejections[id] = "disabled";
        continue;
      }
      candidates.push(id);
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        reason: "all_disabled",
        considered: [],
        rejections,
      };
    }

    // 2. Filter by capability (must support the request's protocol + asset)
    const eligible: Array<{
      id: WalletProviderId;
      connector: WalletConnector;
      capabilities: WalletCapabilities;
    }> = [];
    for (const id of candidates) {
      considered.push(id);
      const connector = this.connectors.get(id)!;
      const capabilities = connector.getCapabilities();
      const reason = checkEligibility(capabilities, input.request);
      if (reason) {
        rejections[id] = reason;
        continue;
      }
      eligible.push({ id, connector, capabilities });
    }

    if (eligible.length === 0) {
      return {
        ok: false,
        reason: "no_eligible_wallet",
        considered,
        rejections,
      };
    }

    // 3. Apply selection strategy
    const ordered = this.applyStrategy(eligible, input.userId);

    // 4. Walk down the ordered list, resolving instruments. First success wins.
    let attempts = 0;
    for (const candidate of ordered) {
      if (attempts >= this.maxAttempts) {
        rejections[candidate.id] = "max_attempts_exhausted";
        break;
      }
      attempts++;
      try {
        const inst = await input.instrumentResolver(candidate.id, candidate.connector);
        if (!inst) {
          rejections[candidate.id] = "no_instrument";
          continue;
        }
        if (input.userId && this.strategy === "user-affinity") {
          this.affinityCache.set(input.userId, candidate.id);
        }
        return {
          ok: true,
          connector: candidate.connector,
          capabilities: candidate.capabilities,
          instrumentId: inst.id,
          considered,
          rejections,
          strategy: this.strategy,
        };
      } catch (err) {
        rejections[candidate.id] =
          err instanceof Error ? err.message : String(err);
      }
    }

    return {
      ok: false,
      reason: "no_instrument",
      considered,
      rejections,
    };
  }

  // -------------------------------------------------------------------------
  //  Strategy implementations
  // -------------------------------------------------------------------------

  private applyStrategy(
    eligible: ReadonlyArray<{
      id: WalletProviderId;
      connector: WalletConnector;
      capabilities: WalletCapabilities;
    }>,
    userId: string | undefined
  ): ReadonlyArray<{
    id: WalletProviderId;
    connector: WalletConnector;
    capabilities: WalletCapabilities;
  }> {
    switch (this.strategy) {
      case "priority":
        // candidates were already in fallback order
        return eligible;

      case "least-latency": {
        const arr = [...eligible];
        arr.sort(
          (a, b) =>
            (a.capabilities.typicalLatencyMs ?? Number.POSITIVE_INFINITY) -
            (b.capabilities.typicalLatencyMs ?? Number.POSITIVE_INFINITY)
        );
        return arr;
      }

      case "least-cost": {
        // CEX wallets (off-chain) have no gas → preferred for cost
        const arr = [...eligible];
        arr.sort((a, b) => {
          const aCost = a.capabilities.settlesOnChain ? 1 : 0;
          const bCost = b.capabilities.settlesOnChain ? 1 : 0;
          return aCost - bCost;
        });
        return arr;
      }

      case "round-robin": {
        if (eligible.length === 0) return eligible;
        const start = this.rrIndex % eligible.length;
        this.rrIndex = (this.rrIndex + 1) % eligible.length;
        return [...eligible.slice(start), ...eligible.slice(0, start)];
      }

      case "user-affinity": {
        if (!userId) return eligible;
        const sticky = this.affinityCache.get(userId);
        if (!sticky) return eligible;
        const idx = eligible.findIndex((e) => e.id === sticky);
        if (idx <= 0) return eligible;
        return [eligible[idx]!, ...eligible.slice(0, idx), ...eligible.slice(idx + 1)];
      }

      default:
        return eligible;
    }
  }
}

// ============================================================================
//  Eligibility helpers
// ============================================================================

function checkEligibility(
  caps: WalletCapabilities,
  req: PaymentRequest
): string | undefined {
  // Protocol must be supported
  if (!caps.supportedProtocols.includes(req.protocol)) {
    return `protocol_not_supported(${req.protocol} ∉ [${caps.supportedProtocols.join(", ")}])`;
  }
  // Asset symbol must be supported (decimal/contract may differ — capability is symbol-coarse)
  const wantSymbol = req.asset.symbol;
  const supports = caps.supportedAssets.some((a) => a.symbol === wantSymbol);
  if (!supports) {
    return `asset_not_supported(${wantSymbol} ∉ [${caps.supportedAssets.map((a) => a.symbol).join(", ")}])`;
  }
  return undefined;
}
