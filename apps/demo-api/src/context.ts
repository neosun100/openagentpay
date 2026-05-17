/**
 * Application context — singleton wiring for the demo API.
 *
 * Two modes:
 *   1. Local dev: reads .env.local for HASHKEY_TESTNET_AGENT_PRIVATE_KEY (raw)
 *   2. Lambda:    reads HASHKEY_TESTNET_AGENT_PRIVATE_KEY_SECRET_ARN from env
 *                 and fetches the private key from AWS Secrets Manager
 *
 * Constructs:
 *   - HashKeyChainConnector (with private key)
 *   - InMemoryPaymentManager (registers connector)
 *   - Demo user id constant
 *
 * @license Apache-2.0
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  InMemoryPaymentManager,
  InMemorySessionManager,
  type SessionManager,
  type UserId,
} from "@openagentpay/core";
import {
  HashKeyChainConnector,
  HashKeyChainTokenClient,
  MemoryInstrumentStore,
  hashkeyChainTestnet,
} from "@openagentpay/wallet-hashkey";

// ----------------------------------------------------------------------------
//  .env.local loader (zero deps, local dev only)
// ----------------------------------------------------------------------------
function loadDotenvLocal(rootDir: string): void {
  const envPath = join(rootDir, ".env.local");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, ".env.local")) || existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// ----------------------------------------------------------------------------
//  Secrets Manager loader (Lambda only)
// ----------------------------------------------------------------------------
async function loadFromSecretsManager(secretArn: string): Promise<string> {
  // Lazy-import AWS SDK only in Lambda mode (avoid bundling in local dev)
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  const client = new SecretsManagerClient({});
  const cmd = new GetSecretValueCommand({ SecretId: secretArn });
  const resp = await client.send(cmd);
  if (!resp.SecretString) {
    throw new Error(`Secret ${secretArn} has no SecretString`);
  }
  // Secret stored as raw private key string (with or without 0x prefix), or
  // as JSON {"privateKey": "0x..."} for forward-compat
  const raw = resp.SecretString.trim();
  if (raw.startsWith("{")) {
    const obj = JSON.parse(raw) as { privateKey?: string; HASHKEY_TESTNET_AGENT_PRIVATE_KEY?: string };
    return (obj.privateKey ?? obj.HASHKEY_TESTNET_AGENT_PRIVATE_KEY ?? raw).trim();
  }
  return raw;
}

// ----------------------------------------------------------------------------
//  Public context
// ----------------------------------------------------------------------------

export interface AppContext {
  readonly manager: InMemoryPaymentManager;
  readonly connector: HashKeyChainConnector;
  readonly sessionManager: SessionManager;
  readonly demoUserId: UserId;
  readonly tokenAddress: string;
  readonly tokenDecimals: number;
}

let _ctx: AppContext | null = null;
let _ctxPromise: Promise<AppContext> | null = null;

async function _buildContext(): Promise<AppContext> {
  // Prefer Secrets Manager if running in Lambda
  let pk = process.env["HASHKEY_TESTNET_AGENT_PRIVATE_KEY"];
  const secretArn = process.env["HASHKEY_TESTNET_AGENT_PRIVATE_KEY_SECRET_ARN"];
  if (!pk && secretArn) {
    pk = await loadFromSecretsManager(secretArn);
  }
  if (!pk) {
    // Fall back to .env.local
    loadDotenvLocal(findRepoRoot());
    pk = process.env["HASHKEY_TESTNET_AGENT_PRIVATE_KEY"];
  }
  if (!pk) {
    throw new Error(
      "HASHKEY_TESTNET_AGENT_PRIVATE_KEY not found in env, secrets, or .env.local"
    );
  }
  if (!pk.startsWith("0x")) pk = "0x" + pk;

  const tokenAddress = process.env["HASHKEY_USDC_ADDRESS"];
  if (!tokenAddress) throw new Error("HASHKEY_USDC_ADDRESS missing");
  const rpcUrl = process.env["HASHKEY_RPC_URL"];

  const store = new MemoryInstrumentStore();
  const tokenClient = new HashKeyChainTokenClient({
    tokenAddress: tokenAddress as `0x${string}`,
    chain: hashkeyChainTestnet,
    ...(rpcUrl !== undefined ? { rpcUrl } : {}),
  });
  const connector = new HashKeyChainConnector({
    privateKey: pk as `0x${string}`,
    tokenAddress: tokenAddress as `0x${string}`,
    instrumentStore: store,
    tokenClient,
    ...(rpcUrl !== undefined ? { rpcUrl } : {}),
  });

  const sessionManager = new InMemorySessionManager();
  const manager = new InMemoryPaymentManager({
    sessionManager,
    resolveInstrument: async (id) => store.getById(id),
  });
  manager.registerConnector(connector);

  return {
    manager,
    connector,
    sessionManager,
    demoUserId: "demo-user" as UserId,
    tokenAddress,
    tokenDecimals: 6,
  };
}

/**
 * Synchronous accessor (works after first async warmup).
 * In Lambda, the first invocation will take an extra ~200ms to fetch from
 * Secrets Manager; subsequent invocations are warm.
 */
export function context(): AppContext {
  if (_ctx) return _ctx;
  throw new Error(
    "Context not initialized — call ensureContext() first (Lambda) or wait for boot (Express)"
  );
}

/** Async warmup — call once at boot or first request. */
export async function ensureContext(): Promise<AppContext> {
  if (_ctx) return _ctx;
  if (_ctxPromise) return _ctxPromise;
  _ctxPromise = (async () => {
    _ctx = await _buildContext();
    return _ctx;
  })();
  return _ctxPromise;
}

/** Reset for tests. */
export function _resetContext(): void {
  _ctx = null;
  _ctxPromise = null;
}
