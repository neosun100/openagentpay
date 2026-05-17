/**
 * Tests for HashKey Chain types and helpers.
 *
 * No real network calls — these are pure unit tests for ABI/typehash/chain
 * config alignment. Real-chain integration tests are in `tests/e2e.test.ts`
 * (gated by HASHKEY_TESTNET_AGENT_PRIVATE_KEY env var).
 */

import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import {
  hashkeyChainTestnet,
  hashkeyChainMainnet,
  txExplorerUrl,
  addressExplorerUrl,
  HASHKEY_MAINNET_TOKENS,
  HASHKEY_TESTNET_MOCK_USDC,
} from "../src/chain.js";
import { generateNonce, EIP712_TYPES } from "../src/token-client.js";

describe("hashkeyChain config", () => {
  it("testnet has chainId 133", () => {
    expect(hashkeyChainTestnet.id).toBe(133);
    expect(hashkeyChainTestnet.testnet).toBe(true);
    expect(hashkeyChainTestnet.rpcUrls.default.http[0]).toBe("https://testnet.hsk.xyz");
  });
  it("mainnet has chainId 177", () => {
    expect(hashkeyChainMainnet.id).toBe(177);
    expect(hashkeyChainMainnet.rpcUrls.default.http[0]).toBe("https://mainnet.hsk.xyz");
  });
  it("nativeCurrency is HSK with 18 decimals on both", () => {
    expect(hashkeyChainTestnet.nativeCurrency.symbol).toBe("HSK");
    expect(hashkeyChainTestnet.nativeCurrency.decimals).toBe(18);
    expect(hashkeyChainMainnet.nativeCurrency.symbol).toBe("HSK");
  });
});

describe("explorer URL builders", () => {
  it("txExplorerUrl appends 0x prefix when missing", () => {
    const u = txExplorerUrl(hashkeyChainTestnet, "abc123");
    expect(u).toBe("https://testnet-explorer.hsk.xyz/tx/0xabc123");
  });
  it("txExplorerUrl preserves existing 0x prefix", () => {
    const u = txExplorerUrl(hashkeyChainTestnet, "0xff8a175e");
    expect(u).toBe("https://testnet-explorer.hsk.xyz/tx/0xff8a175e");
  });
  it("addressExplorerUrl produces correct URL", () => {
    const u = addressExplorerUrl(hashkeyChainMainnet, HASHKEY_MAINNET_TOKENS.USDC);
    expect(u).toBe(
      "https://hashkey.blockscout.com/address/0x054ed45810DbBAb8B27668922D110669c9D88D0a"
    );
  });
});

describe("token addresses", () => {
  it("mainnet USDC address is the bridged USDC", () => {
    expect(HASHKEY_MAINNET_TOKENS.USDC).toBe("0x054ed45810DbBAb8B27668922D110669c9D88D0a");
  });
  it("testnet MockUSDC address matches deployed contract", () => {
    expect(HASHKEY_TESTNET_MOCK_USDC).toBe("0x0685C487Df4Cc0723Aa828C299686798294E9803");
  });
});

describe("EIP-712 type definitions", () => {
  it("matches Circle USDC TransferWithAuthorization typehash exactly", () => {
    // Encode the types manually and verify against Circle's published typehash
    const typeStr =
      "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
    const hash = keccak256(toBytes(typeStr));
    expect(hash).toBe("0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267");
  });

  it("EIP712Domain typehash matches the Solidity constant", () => {
    const typeStr =
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
    const hash = keccak256(toBytes(typeStr));
    expect(hash).toBe("0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f");
  });

  it("EIP712_TYPES.TransferWithAuthorization has 6 fields in correct order", () => {
    const fields = EIP712_TYPES.TransferWithAuthorization;
    expect(fields.length).toBe(6);
    expect(fields[0]).toEqual({ name: "from", type: "address" });
    expect(fields[1]).toEqual({ name: "to", type: "address" });
    expect(fields[2]).toEqual({ name: "value", type: "uint256" });
    expect(fields[3]).toEqual({ name: "validAfter", type: "uint256" });
    expect(fields[4]).toEqual({ name: "validBefore", type: "uint256" });
    expect(fields[5]).toEqual({ name: "nonce", type: "bytes32" });
  });
});

describe("generateNonce", () => {
  it("returns 32-byte hex (66 chars including 0x)", () => {
    const n = generateNonce();
    expect(n).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("produces unique values", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
  });
});
