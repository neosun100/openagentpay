/**
 * ProtocolAdapter conformance tests.
 *
 * USAGE:
 *
 *     import { describe, it, expect, beforeAll } from "vitest";
 *     import { runProtocolConformance } from "@openagentpay/conformance/protocol";
 *
 *     runProtocolConformance(
 *       { describe, it, expect, beforeAll },
 *       { createAdapter: ..., buildValidResponse: ..., ... }
 *     );
 *
 * @license Apache-2.0
 */

import {
  type HttpResponse402,
  type ProtocolAdapter,
  type SignedAuthorization,
} from "@openagentpay/core";
import type { TestRunner } from "./wallet.js";

// ============================================================================
//  Public API
// ============================================================================

export interface ProtocolConformanceFixture {
  createAdapter(): ProtocolAdapter | Promise<ProtocolAdapter>;
  buildValidResponse(): HttpResponse402;
  buildForeignResponse(): HttpResponse402;
  buildSignedAuthorization():
    | SignedAuthorization
    | Promise<SignedAuthorization>;
}

export interface ProtocolConformanceOptions {
  suiteName?: string;
  skipBuildRetry?: boolean;
}

// ============================================================================
//  Main entry point
// ============================================================================

export function runProtocolConformance(
  runner: TestRunner,
  fixture: ProtocolConformanceFixture,
  options: ProtocolConformanceOptions = {}
): void {
  const { describe, it, beforeAll, expect } = runner;
  const suiteName = options.suiteName ?? "ProtocolAdapter conformance";

  describe(suiteName, () => {
    let adapter: ProtocolAdapter;

    beforeAll(async () => {
      adapter = await fixture.createAdapter();
    });

    describe("id", () => {
      it("is a non-empty string", () => {
        expect(typeof adapter.id).toBe("string");
        expect((adapter.id as string).length).toBeGreaterThan(0);
      });

      it("contains no whitespace", () => {
        expect(/\s/.test(adapter.id as string)).toBeFalsy();
      });
    });

    describe("detect()", () => {
      it("returns true for a valid response of this protocol", () => {
        const r = fixture.buildValidResponse();
        expect(adapter.detect(r)).toBeTruthy();
      });

      it("returns false for a foreign protocol's response", () => {
        const r = fixture.buildForeignResponse();
        expect(adapter.detect(r)).toBeFalsy();
      });

      it("returns false (no throw) for non-402 status code", () => {
        const r: HttpResponse402 = {
          statusCode: 200 as 402,
          headers: {},
          body: {},
        };
        expect(adapter.detect(r)).toBeFalsy();
      });

      it("returns boolean (no throw) for empty body", () => {
        const r: HttpResponse402 = {
          statusCode: 402,
          headers: {},
          body: {},
        };
        expect(typeof adapter.detect(r)).toBe("boolean");
      });
    });

    describe("parsePaymentRequired()", () => {
      it("returns a PaymentRequest tagged with this adapter's id", async () => {
        const r = fixture.buildValidResponse();
        const req = await adapter.parsePaymentRequired(r);
        expect(req.protocol).toBe(adapter.id);
      });

      it("populates required fields", async () => {
        const r = fixture.buildValidResponse();
        const req = await adapter.parsePaymentRequired(r);
        expect(typeof req.amount.amountAtomic).toBe("string");
        expect(typeof req.amount.decimals).toBe("number");
        expect(typeof req.amount.currency).toBe("string");
        expect(typeof req.recipient).toBe("string");
        expect(req.recipient.length).toBeGreaterThan(0);
        expect(typeof req.asset.symbol).toBe("string");
        expect(typeof req.nonce).toBe("string");
        expect(req.nonce.length).toBeGreaterThan(0);
      });

      it("validBefore is in the future", async () => {
        const r = fixture.buildValidResponse();
        const req = await adapter.parsePaymentRequired(r);
        const nowSec = Math.floor(Date.now() / 1000);
        expect(req.validBefore).toBeGreaterThan(nowSec - 1);
      });

      it("amountAtomic parses as bigint", async () => {
        const r = fixture.buildValidResponse();
        const req = await adapter.parsePaymentRequired(r);
        const ok = (() => {
          try {
            BigInt(req.amount.amountAtomic);
            return true;
          } catch {
            return false;
          }
        })();
        expect(ok).toBeTruthy();
      });
    });

    describe("buildRetry()", () => {
      it("returns an HttpRetryEnvelope with a headers map", async () => {
        if (options.skipBuildRetry) return;
        const signed = await fixture.buildSignedAuthorization();
        const env = await adapter.buildRetry(signed);
        expect(typeof env.headers).toBe("object");
        expect(env.headers).toBeDefined();
      });

      it("at least one header is set", async () => {
        if (options.skipBuildRetry) return;
        const signed = await fixture.buildSignedAuthorization();
        const env = await adapter.buildRetry(signed);
        expect(Object.keys(env.headers).length).toBeGreaterThan(0);
      });
    });

    describe("error handling", () => {
      it("parsePaymentRequired throws on malformed body", async () => {
        const malformed: HttpResponse402 = {
          statusCode: 402,
          headers: {},
          body: { totally: "bogus" },
        };
        await expect(
          (async () => {
            await adapter.parsePaymentRequired(malformed);
          })()
        ).rejects.toThrow();
      });
    });
  });
}
