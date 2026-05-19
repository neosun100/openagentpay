#!/usr/bin/env node
/**
 * CDK app entrypoint — wires DemoStack with secrets from .env.local.
 *
 * Reads:
 *   HASHKEY_TESTNET_AGENT_PRIVATE_KEY  (from .env.local at repo root)
 *   HASHKEY_USDC_ADDRESS               (from .env.local at repo root)
 *   HASHKEY_RPC_URL                    (from .env.local at repo root)
 *   CDK_DEFAULT_ACCOUNT, CDK_DEFAULT_REGION  (AWS profile)
 *
 * @license Apache-2.0
 */

import * as cdk from "aws-cdk-lib";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DemoStack } from "../lib/demo-stack.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ----------------------------------------------------------------------------
//  Tiny .env.local loader
// ----------------------------------------------------------------------------
function loadDotenvLocal(rootDir: string): void {
  const envPath = join(rootDir, ".env.local");
  if (!existsSync(envPath)) {
    console.error(`Warning: ${envPath} not found`);
    return;
  }
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

const repoRoot = join(__dirname, "../../..");
loadDotenvLocal(repoRoot);

const pk = process.env.HASHKEY_TESTNET_AGENT_PRIVATE_KEY;
const usdc = process.env.HASHKEY_USDC_ADDRESS;
const rpcUrl = process.env.HASHKEY_RPC_URL;

// Coinbase CDP (optional — if all 4 present, CDP wallet is added to demo)
const cdpApiKeyId = process.env.COINBASE_CDP_API_KEY_ID;
const cdpApiKeySecret = process.env.COINBASE_CDP_API_KEY_SECRET;
const cdpWalletSecret = process.env.COINBASE_CDP_WALLET_SECRET;
const cdpAgentAddress = process.env.COINBASE_CDP_AGENT_ADDRESS;

if (!pk) {
  console.error("❌ HASHKEY_TESTNET_AGENT_PRIVATE_KEY required in .env.local");
  process.exit(2);
}
if (!usdc) {
  console.error("❌ HASHKEY_USDC_ADDRESS required in .env.local");
  process.exit(2);
}

const cdpEnabled =
  cdpApiKeyId && cdpApiKeySecret && cdpWalletSecret && cdpAgentAddress;
if (cdpEnabled) {
  console.log("✓ Coinbase CDP credentials detected — will provision Base Sepolia wallet");
} else {
  console.log("ℹ Coinbase CDP credentials not found — deploying HashKey only");
}

const app = new cdk.App();

new DemoStack(app, "OpenAgentPayDemoStack", {
  hashkeyAgentPrivateKey: pk,
  hashkeyUsdcAddress: usdc,
  ...(rpcUrl ? { hashkeyRpcUrl: rpcUrl } : {}),
  ...(cdpEnabled
    ? {
        coinbaseCdpApiKeyId: cdpApiKeyId,
        coinbaseCdpApiKeySecret: cdpApiKeySecret,
        coinbaseCdpWalletSecret: cdpWalletSecret,
        coinbaseCdpAgentAddress: cdpAgentAddress,
      }
    : {}),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description:
    "OpenAgentPay — Path D Hybrid demo (HashKey Chain + Coinbase CDP, Lambda + CloudFront + S3)",
});

app.synth();
