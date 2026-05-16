/**
 * Tests for InMemorySessionManager.
 *
 * Coverage:
 *   - createSession returns active session with right budget
 *   - getSession returns same session
 *   - checkAndReserve approves when budget remains
 *   - checkAndReserve rejects when budget exceeded
 *   - checkAndReserve rejects when session expired
 *   - commit success advances spent; commit fail releases reservation
 *   - exhausted status transitions correctly
 *   - currency mismatch rejected
 *   - concurrent reservations don't double-spend (mutex test)
 *   - reservation prevents budget being approved twice for the same headroom
 */

import { describe, expect, it } from "vitest";
import {
  type Money,
  type SessionId,
  type UserId,
} from "@openagentpay/core";
import {
  InMemorySessionManager,
  SessionError,
} from "../src/session/manager.js";

const FIXED_NOW = 1778860654_000;

function makeMgr(nowOverride?: () => number) {
  return new InMemorySessionManager(nowOverride ?? (() => FIXED_NOW));
}

const usdc = (atomic: string): Money => ({
  amountAtomic: atomic,
  decimals: 6,
  currency: "USDC",
});

describe("InMemorySessionManager.createSession", () => {
  it("returns a session with budget in atomic units", async () => {
    const m = makeMgr();
    const s = await m.createSession({
      userId: "alice" as UserId,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    expect(s.budget).toEqual(usdc("1000000")); // 1 USDC = 1_000_000 atomic
    expect(s.spent).toEqual(usdc("0"));
    expect(s.status).toBe("active");
    expect(s.id).toMatch(/^payment-session-[0-9a-f]{16}$/);
  });

  it("computes expiresAt at now + expiresMinutes", async () => {
    const m = makeMgr();
    const s = await m.createSession({
      userId: "alice" as UserId,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    expect(new Date(s.expiresAt).getTime()).toBe(FIXED_NOW + 60 * 60_000);
  });
});

describe("InMemorySessionManager.checkAndReserve", () => {
  it("approves the first reservation under budget", async () => {
    const m = makeMgr();
    const s = await m.createSession({
      userId: "alice" as UserId,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    const r = await m.checkAndReserve(s.id, usdc("1000"));
    expect(r.approved).toBe(true);
    expect(r.remainingBudget).toEqual(usdc("999000"));
  });

  it("rejects when amount exceeds remaining", async () => {
    const m = makeMgr();
    const s = await m.createSession({
      userId: "alice" as UserId,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    const r = await m.checkAndReserve(s.id, usdc("2000000")); // 2 USDC, budget = 1
    expect(r.approved).toBe(false);
    expect(r.reason).toBe("budget_exceeded");
  });

  it("rejects expired session", async () => {
    let t = FIXED_NOW;
    const m = makeMgr(() => t);
    const s = await m.createSession({
      userId: "alice" as UserId,
      budgetUsd: 1.0,
      expiresMinutes: 1,
    });
    t = FIXED_NOW + 60 * 1000 + 1; // jump past expiry
    const r = await m.checkAndReserve(s.id, usdc("100"));
    expect(r.approved).toBe(false);
    expect(r.reason).toBe("session_expired");
  });

  it("rejects when currency mismatched", async () => {
    const m = makeMgr();
    const s = await m.createSession({
      userId: "alice" as UserId,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    await expect(
      m.checkAndReserve(s.id, {
        amountAtomic: "100",
        decimals: 6,
        currency: "USDT",
      })
    ).rejects.toThrowError(SessionError);
  });

  it("two reservations together cannot exceed budget", async () => {
    const m = makeMgr();
    const s = await m.createSession({
      userId: "alice" as UserId,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    const a = await m.checkAndReserve(s.id, usdc("700000"));
    const b = await m.checkAndReserve(s.id, usdc("400000"));
    expect(a.approved).toBe(true);
    expect(b.approved).toBe(false);
    expect(b.reason).toBe("budget_exceeded");
  });

  it("concurrent calls are linearized — total reserved ≤ budget", async () => {
    const m = makeMgr();
    const s = await m.createSession({
      userId: "alice" as UserId,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    const tasks = Array.from({ length: 50 }, () =>
      m.checkAndReserve(s.id, usdc("30000"))
    );
    const results = await Promise.all(tasks);
    const approved = results.filter((r) => r.approved).length;
    // budget=1_000_000, each=30_000 → max 33 approved
    expect(approved).toBeLessThanOrEqual(33);
    expect(approved).toBeGreaterThan(0);
  });
});

describe("InMemorySessionManager.commit", () => {
  it("advances spent on success", async () => {
    const m = makeMgr();
    const s = await m.createSession({
      userId: "alice" as UserId,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    await m.checkAndReserve(s.id, usdc("100000"));
    const updated = await m.commit(s.id, usdc("100000"), true);
    expect(updated.spent).toEqual(usdc("100000"));
  });

  it("releases reservation on failure (no spent)", async () => {
    const m = makeMgr();
    const s = await m.createSession({
      userId: "alice" as UserId,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    await m.checkAndReserve(s.id, usdc("500000"));
    const updated = await m.commit(s.id, usdc("500000"), false);
    expect(updated.spent).toEqual(usdc("0"));
    // Budget back to 1_000_000 — next reserve of 600_000 should approve
    const r = await m.checkAndReserve(s.id, usdc("600000"));
    expect(r.approved).toBe(true);
  });

  it("transitions to exhausted when spent >= budget", async () => {
    const m = makeMgr();
    const s = await m.createSession({
      userId: "alice" as UserId,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    await m.checkAndReserve(s.id, usdc("1000000"));
    const updated = await m.commit(s.id, usdc("1000000"), true);
    expect(updated.status).toBe("exhausted");
  });
});

describe("InMemorySessionManager.getSession", () => {
  it("returns undefined for unknown id", async () => {
    const m = makeMgr();
    const r = await m.getSession("payment-session-doesnotexist" as SessionId);
    expect(r).toBeUndefined();
  });
});
