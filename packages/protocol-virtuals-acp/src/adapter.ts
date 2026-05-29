/**
 * @openagentpay/protocol-virtuals-acp — Virtuals ACP (Agent Commerce Protocol)
 * =============================================================================
 *
 * Virtuals Protocol's ACP defines a 4-phase agent-to-agent commerce flow:
 *
 *   1. Request    — agent A requests service from agent B
 *   2. Negotiation — terms / pricing agreed
 *   3. Transaction — payment escrowed on-chain (Base, $VIRTUAL or USDC)
 *   4. Evaluation  — third-party evaluator agent verifies delivery
 *
 * In this adapter, Phase 3 maps to PaymentRequest. The evaluator and
 * negotiation rounds happen out-of-band before the 402 is returned.
 *
 * Spec: https://whitepaper.virtuals.io
 *
 * @license Apache-2.0
 */

import {
  type HttpResponse402,
  type HttpRetryEnvelope,
  type Money,
  type PaymentRequest,
  ProtocolError,
  type ProtocolAdapter,
  type ProtocolId,
  type SignedAuthorization,
} from "@openagentpay/core";

export const PROTOCOL_ID = "virtuals-acp-v1" as ProtocolId;
export const X_PAYMENT_ACP_HEADER = "X-PAYMENT-ACP";

export interface AcpJob {
  readonly id: string;
  readonly requesterAgent: string;
  readonly providerAgent: string;
  readonly evaluatorAgent: string;
  readonly phase: "request" | "negotiation" | "transaction" | "evaluation";
  readonly terms: { readonly description: string; readonly deliverable: string };
  readonly priceAtomic: string;
  readonly currency: string;
  readonly decimals: number;
  readonly escrow: string;            // escrow contract address
  readonly chain: string;              // CAIP-2
}

export interface Acp402Body {
  readonly acpVersion: 1;
  readonly job: AcpJob;
}

export interface AcpAdapterConfig {
  readonly trustedEvaluators?: readonly string[];
  readonly now?: () => number;
}

export class VirtualsAcpProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly trustedEvaluators: ReadonlySet<string> | undefined;
  private readonly now: () => number;

  constructor(cfg: AcpAdapterConfig = {}) {
    this.trustedEvaluators = cfg.trustedEvaluators
      ? new Set(cfg.trustedEvaluators.map((e) => e.toLowerCase()))
      : undefined;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    return body["acpVersion"] === 1 && isObject(body["job"]);
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    const j = body.job;
    if (j.phase !== "transaction") {
      throw new ProtocolError(
        `ACP job phase '${j.phase}' is not actionable; agents only sign during 'transaction' phase`,
        "unsupported_scheme"
      );
    }
    if (
      this.trustedEvaluators &&
      !this.trustedEvaluators.has(j.evaluatorAgent.toLowerCase())
    ) {
      throw new ProtocolError(
        `ACP evaluator ${j.evaluatorAgent} not in trust list`,
        "unsupported_scheme"
      );
    }
    const amount: Money = {
      amountAtomic: j.priceAtomic,
      decimals: j.decimals,
      currency: j.currency,
    };
    const validBefore = Math.floor(this.now() / 1000) + 600;
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: j.escrow, // funds go to escrow contract, not provider directly
      asset: { symbol: j.currency, decimals: j.decimals, chain: j.chain },
      validAfter: 0,
      validBefore,
      nonce: j.id, // job id doubles as idempotency key
      rawPayload: { job: j },
      description: j.terms.description,
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("ACP retry requires signature", "missing_field");
    }
    const wire = {
      acpVersion: 1,
      jobId: signed.request.nonce,
      requester: signed.signer,
      escrow: signed.request.recipient,
      signature: signed.signature,
      encoded: signed.encoded ?? null,
    };
    return {
      headers: {
        [X_PAYMENT_ACP_HEADER]: Buffer.from(JSON.stringify(wire), "utf8").toString("base64url"),
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  private assertBody(body: unknown): Acp402Body {
    if (!isObject(body)) throw new ProtocolError("ACP body must be object", "malformed");
    if (body["acpVersion"] !== 1)
      throw new ProtocolError("ACP version must be 1", "unsupported_version");
    if (!isObject(body["job"]))
      throw new ProtocolError("ACP missing job block", "missing_field");
    const j = body["job"] as Record<string, unknown>;
    for (const f of ["id", "requesterAgent", "providerAgent", "evaluatorAgent", "phase", "priceAtomic", "currency", "decimals", "escrow", "chain"] as const) {
      if (j[f] === undefined) {
        throw new ProtocolError(`ACP job missing field: ${f}`, "missing_field");
      }
    }
    if (!isObject(j["terms"])) {
      throw new ProtocolError("ACP job missing terms", "missing_field");
    }
    return body as unknown as Acp402Body;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
