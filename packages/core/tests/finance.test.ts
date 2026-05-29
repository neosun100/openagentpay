/**
 * Tests for finance/types.ts — Idempotency + FxOracle.
 */

import { describe, it, expect } from "vitest";
import {
  InMemoryIdempotencyStore,
  StaticFxOracle,
  type Money,
} from "../src/index.js";

describe("InMemoryIdempotencyStore", () => {
  it("get returns undefined for unknown keys", async () => {
    const s = new InMemoryIdempotencyStore();
    const e = await s.get("nope");
    expect(e).toBe(undefined);
  });

  it("put then get round-trips", async () => {
    const s = new InMemoryIdempotencyStore();
    const entry = {
      key: "k1",
      seenAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      cachedResult: { ok: true },
    };
    await s.put(entry);
    const got = await s.get("k1");
    expect(got).toEqual(entry);
  });

  it("put twice on same key throws", async () => {
    const s = new InMemoryIdempotencyStore();
    const e = {
      key: "k1",
      seenAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await s.put(e);
    await expect((async () => s.put(e))()).rejects.toThrow();
  });

  it("replace upserts without throwing on duplicate", async () => {
    const s = new InMemoryIdempotencyStore();
    const e = {
      key: "k1",
      seenAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      cachedResult: { v: 1 },
    };
    await s.put(e);
    await s.replace({ ...e, cachedResult: { v: 2 } });
    const got = await s.get("k1");
    expect((got?.cachedResult as { v: number }).v).toBe(2);
  });

  it("expired entries are returned as undefined and evicted", async () => {
    const s = new InMemoryIdempotencyStore();
    const past = new Date(Date.now() - 1_000).toISOString();
    await s.put({
      key: "k1",
      seenAt: past,
      expiresAt: past,
    });
    const got = await s.get("k1");
    expect(got).toBe(undefined);
  });
});

describe("StaticFxOracle", () => {
  const rates = new Map([
    ["USDC:USDT", "1.0001"],
    ["USDT:USDC", "0.9999"],
    ["USDC:USD", "1.00"],
    ["USD:HKD", "7.78"],
  ]);

  it("returns 1 for same currency", async () => {
    const o = new StaticFxOracle(rates);
    const q = await o.quote("USDC", "USDC");
    expect(q.rate).toBe("1");
  });

  it("uses direct rate when present", async () => {
    const o = new StaticFxOracle(rates);
    const q = await o.quote("USDC", "USDT");
    expect(q.rate).toBe("1.0001");
  });

  it("uses inverse rate when direct missing", async () => {
    const partial = new Map([["USDC:USDT", "2"]]);
    const o = new StaticFxOracle(partial);
    const q = await o.quote("USDT", "USDC");
    expect(Number(q.rate)).toBeCloseTo(0.5, 6);
  });

  it("throws on unknown pair", async () => {
    const o = new StaticFxOracle(rates);
    await expect((async () => o.quote("XYZ", "ABC"))()).rejects.toThrow();
  });

  it("convert preserves atomic precision (USDC→USDT same decimals)", async () => {
    const o = new StaticFxOracle(rates);
    const m: Money = {
      amountAtomic: "1000000",
      decimals: 6,
      currency: "USDC",
    };
    const out = await o.convert(m, "USDT", 6);
    expect(out.currency).toBe("USDT");
    expect(out.decimals).toBe(6);
    // 1.0 USDC * 1.0001 = 1.0001 USDT = 1000100 atomic
    expect(out.amountAtomic).toBe("1000100");
  });

  it("convert handles different decimals (USD 2dp → USDC 6dp)", async () => {
    const o = new StaticFxOracle(rates);
    const m: Money = { amountAtomic: "100", decimals: 2, currency: "USD" };
    const out = await o.convert(m, "USDC", 6);
    // $1.00 → 1.00 USDC = 1_000_000 atomic
    expect(out.currency).toBe("USDC");
    expect(out.decimals).toBe(6);
    // The mapping uses USDC:USD direct rate inverse — 1/1.00 = 1
    expect(out.amountAtomic).toBe("1000000");
  });

  it("quote includes source label", async () => {
    const o = new StaticFxOracle(rates, "test-oracle");
    const q = await o.quote("USDC", "USDT");
    expect(q.source).toBe("test-oracle");
  });
});
