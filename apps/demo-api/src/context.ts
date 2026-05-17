/**
 * Application context — singleton wiring for the demo API.
 *
 * Reads required env vars (.env.local), constructs:
 *   - HashKeyChainConnector (with private key)
 *   - InMemoryPaymentManager (registers connector)
 *   - Demo user id constant
 *
 * Exposes a singleton via {@link context} for handlers to reuse.
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
//  .env.local loader (zero deps)
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

// Walk up the file tree from cwd to find a folder containing .env.local
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

export function context(): AppContext {
  if (_ctx) return _ctx;
  loadDotenvLocal(findRepoRoot());

  const pk = process.env["HASHKEY_TESTNET_AGENT_PRIVATE_KEY"];
  const tokenAddress = process.env["HASHKEY_USDC_ADDRESS"];
  const rpcUrl = process.env["HASHKEY_RPC_URL"];

  if (!pk) throw new Error("HASHKEY_TESTNET_AGENT_PRIVATE_KEY missing in .env.local");
  if (!tokenAddress) throw new Error("HASHKEY_USDC_ADDRESS missing in .env.local");

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

  _ctx = {
    manager,
    connector,
    sessionManager,
    demoUserId: "demo-user" as UserId,
    tokenAddress,
    tokenDecimals: 6,
  };
  return _ctx;
}

/** Reset for tests. */
export function _resetContext(): void {
  _ctx = null;
}
