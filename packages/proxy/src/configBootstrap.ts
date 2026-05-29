/**
 * configBootstrap.ts — wire a runtime from an openagentpay.yaml.
 *
 * Given an `OpenAgentPayConfig`, builds:
 *   - PaymentManager (InMemory) populated with WalletConnectors via dynamic imports
 *   - GovernanceManager wired with Policy + Compliance + Audit per the yaml
 *   - InMemoryTenantStore populated with Tenants from yaml
 *   - apiKeyHashes: a map of hash → tenantId so the cli can print friendly names
 *
 * This is what makes `oap proxy start --config openagentpay.yaml` possible
 * without code: every component is loaded by `module` field at runtime.
 *
 * Wallets / protocols are loaded via `import(decl.module)` — the consumer
 * must have those packages installed in their node_modules. We don't bundle
 * them as direct dependencies (would be 30+ packages); they come from the
 * user's project's package.json.
 *
 * @license Apache-2.0
 */

import {
  type Instrument,
  type InstrumentId,
  type PaymentManager,
  type WalletConnector,
  type WalletProviderId,
  createInMemoryPaymentManager,
} from "@openagentpay/core";
import {
  AuditLogger,
  ConsoleAuditSink,
  GovernanceManager,
  InMemoryAuditSink,
  InMemoryPolicyEngine,
  StaticSanctionsChecker,
  amountThreshold,
  merchantBlacklist,
  merchantWhitelist,
  timeOfDay,
  velocityLimit,
  walletProviderWhitelist,
  type AuditSink,
  type ComplianceChecker,
  type Policy,
} from "@openagentpay/governance";
import type {
  OpenAgentPayConfig,
  PolicyDecl,
} from "@openagentpay/config";

import {
  generateVirtualApiKey,
  hashApiKey,
  InMemoryTenantStore,
  type Tenant,
  type TenantStore,
  type VirtualApiKey,
} from "./tenant.js";

// ============================================================================
//  Public API
// ============================================================================

export interface BootstrapResult {
  readonly paymentManager: PaymentManager;
  readonly governance: GovernanceManager;
  readonly tenantStore: TenantStore;
  /** Plaintext API keys minted for tenants whose `apiKey` was `inline://generate`. */
  readonly mintedKeys: ReadonlyArray<{ readonly tenantId: string; readonly key: VirtualApiKey }>;
  /** Connectors that loaded successfully. */
  readonly loadedWallets: ReadonlyArray<{ readonly provider: string; readonly module: string }>;
  /** Walllets that failed to load (logged, but not fatal). */
  readonly walletErrors: ReadonlyArray<{ readonly provider: string; readonly error: string }>;
}

export interface BootstrapOptions {
  /** Optional resolver for env:// secret refs. Default: process.env. */
  readonly resolveSecret?: (uri: string) => string | undefined;
  /** Override stdout for log output. Default: console.log. */
  readonly log?: (line: string) => void;
}

/**
 * Build a runnable proxy stack from an OpenAgentPayConfig.
 */
export async function bootstrapFromConfig(
  cfg: OpenAgentPayConfig,
  options: BootstrapOptions = {}
): Promise<BootstrapResult> {
  const log = options.log ?? ((s: string) => console.log(s));
  const resolveSecret = options.resolveSecret ?? defaultResolver;

  // ---- 1. Wallet connectors (dynamic import per `module`) -----------------
  const connectors: WalletConnector[] = [];
  const loaded: Array<{ provider: string; module: string }> = [];
  const errors: Array<{ provider: string; error: string }> = [];
  for (const w of cfg.wallets) {
    try {
      const factory = await loadWalletFactory(w.module);
      if (!factory) {
        errors.push({
          provider: w.provider,
          error: `module ${w.module} did not export a recognized factory`,
        });
        continue;
      }
      const resolvedSecrets = resolveSecrets(w.secrets, resolveSecret);
      const connector = await factory({
        provider: w.provider,
        config: w.config,
        secrets: resolvedSecrets,
      });
      connectors.push(connector);
      loaded.push({ provider: w.provider, module: w.module });
      log(`[bootstrap] wallet loaded: ${w.provider} (${w.module})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ provider: w.provider, error: message });
      log(`[bootstrap] wallet FAILED: ${w.provider} → ${message}`);
    }
  }

  // ---- 2. PaymentManager --------------------------------------------------
  const instrumentLookup = new Map<InstrumentId, Instrument>();
  const paymentManager = createInMemoryPaymentManager({
    resolveInstrument: async (id) => instrumentLookup.get(id),
    connectors,
  });
  // Pre-bind a default user instrument per wallet for `oap proxy` simple flows.
  for (const c of connectors) {
    try {
      const inst = await c.createInstrument({ userId: "default-user" as never });
      instrumentLookup.set(inst.id, inst);
    } catch {
      // Some wallets need explicit user creation per-tenant — that's fine.
    }
  }

  // ---- 3. Governance ------------------------------------------------------
  const policyEngine = new InMemoryPolicyEngine();
  for (const p of cfg.governance.policies) {
    const policy = policyFromDecl(p);
    if (policy) policyEngine.use(policy);
  }
  const complianceCheckers: ComplianceChecker[] = [];
  for (const c of cfg.governance.compliance.checkers) {
    if (c.kind === "static-sanctions") {
      complianceCheckers.push(new StaticSanctionsChecker([]));
    }
    // chainalysis-kyt / trm-labs / ofac-sdn — instantiated lazily by the
    // caller; we don't pull cloud SDKs here. The yaml just declares them.
  }
  const auditSinks: AuditSink[] = [];
  for (const s of cfg.governance.audit.sinks) {
    if (s.kind === "console") auditSinks.push(new ConsoleAuditSink());
    else if (s.kind === "in-memory") auditSinks.push(new InMemoryAuditSink(500));
    // dynamodb / s3-worm / opensearch / splunk — declared but require runtime SDKs
  }
  const auditSink = combineSinks(auditSinks);
  const governance = new GovernanceManager({
    policyEngine,
    ...(complianceCheckers[0] !== undefined ? { complianceChecker: complianceCheckers[0] } : {}),
    auditSink,
  });

  // ---- 4. Tenants ---------------------------------------------------------
  const tenantStore = new InMemoryTenantStore();
  const minted: Array<{ tenantId: string; key: VirtualApiKey }> = [];
  for (const t of cfg.tenants) {
    let apiKeyHash: string;
    if (t.apiKey === "inline://generate") {
      const k = generateVirtualApiKey();
      apiKeyHash = k.hash;
      minted.push({ tenantId: t.id, key: k });
    } else {
      const plain = resolveSecret(t.apiKey);
      if (!plain) {
        log(`[bootstrap] tenant ${t.id}: apiKey ref ${t.apiKey} did not resolve — skipping`);
        continue;
      }
      apiKeyHash = hashApiKey(plain);
    }
    const tenant: Tenant = {
      id: t.id,
      name: t.name ?? t.id,
      apiKeyHash,
      allowedWallets: t.allowedWallets,
      allowedProtocols: t.allowedProtocols,
      dailyBudgetUsd: t.dailyBudgetUsd,
      ...(t.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: t.monthlyBudgetUsd } : {}),
      ...(t.requireTwoPersonApprovalAboveUsd !== undefined
        ? { requireTwoPersonApprovalAboveUsd: t.requireTwoPersonApprovalAboveUsd }
        : {}),
      sandboxOnly: t.sandboxOnly,
      metadata: t.metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
    };
    await tenantStore.put(tenant);
  }

  return {
    paymentManager,
    governance,
    tenantStore,
    mintedKeys: minted,
    loadedWallets: loaded,
    walletErrors: errors,
  };
}

// ============================================================================
//  Helpers
// ============================================================================

type WalletFactory = (input: {
  provider: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}) => Promise<WalletConnector>;

/**
 * Try common factory shapes a wallet module might export:
 *   1. `default` (function or class)
 *   2. `createConnector(input)`
 *   3. `Connector` (class — instantiate with the merged config+secrets)
 *
 * Returns undefined if the module doesn't expose anything recognizable.
 */
async function loadWalletFactory(modulePath: string): Promise<WalletFactory | undefined> {
  let mod: any;
  try {
    mod = await import(modulePath);
  } catch (err) {
    throw new Error(
      `import('${modulePath}') failed — is the package installed? (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
  if (typeof mod.createConnector === "function") {
    return async (input) => mod.createConnector(input);
  }
  if (typeof mod.default === "function") {
    // Could be a class or a factory — try call first
    try {
      return async (input) => {
        const out = mod.default({ ...input.config, ...input.secrets });
        return out instanceof Promise ? await out : out;
      };
    } catch {
      // try `new`
      return async (input) =>
        new mod.default({ ...input.config, ...input.secrets });
    }
  }
  return undefined;
}

function resolveSecrets(
  refs: Record<string, string>,
  resolve: (uri: string) => string | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, uri] of Object.entries(refs)) {
    const v = resolve(uri);
    if (v) out[k] = v;
  }
  return out;
}

function defaultResolver(uri: string): string | undefined {
  if (uri.startsWith("env://")) {
    const name = uri.slice("env://".length);
    return process.env[name];
  }
  if (uri.startsWith("inline://")) {
    return uri.slice("inline://".length);
  }
  // file:// / aws-secretsmanager:// / gcp-sm:// — caller must implement
  return undefined;
}

function policyFromDecl(p: PolicyDecl): Policy | undefined {
  switch (p.kind) {
    case "amountThreshold":
      // yaml uses USD; convert to atomic (USDC has 6 decimals)
      return amountThreshold({
        maxAtomic: BigInt(Math.round(p.maxUsd * 1_000_000)).toString(),
      });
    case "velocityLimit": {
      const opts: any = { windowMs: p.windowSeconds * 1000 };
      if (p.maxCount !== undefined) opts.maxCount = p.maxCount;
      if (p.maxAmountUsd !== undefined) {
        opts.maxAmountAtomic = BigInt(
          Math.round(p.maxAmountUsd * 1_000_000)
        ).toString();
      }
      return velocityLimit(opts);
    }
    case "merchantWhitelist":
      return merchantWhitelist(p.addresses);
    case "merchantBlacklist":
      return merchantBlacklist(p.addresses);
    case "walletProviderWhitelist":
      return walletProviderWhitelist(p.providers as WalletProviderId[]);
    case "timeOfDay":
      return timeOfDay({
        startHourUtc: p.startHourUtc,
        endHourUtc: p.endHourUtc,
      });
    default:
      return undefined;
  }
}

/** Compose multiple AuditSinks into one — emits to all in fan-out. */
function combineSinks(sinks: ReadonlyArray<AuditSink>): AuditSink {
  if (sinks.length === 0) return new ConsoleAuditSink();
  if (sinks.length === 1) return sinks[0]!;
  return {
    async emit(event) {
      await Promise.all(
        sinks.map(async (s) => {
          try {
            await s.emit(event);
          } catch {
            /* swallow per-sink failures so one bad sink doesn't poison the rest */
          }
        })
      );
    },
  };
}
