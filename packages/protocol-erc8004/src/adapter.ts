/**
 * @openagentpay/protocol-erc8004 — ERC-8004 Trustless Agents Adapter
 * ===================================================================
 *
 * ERC-8004 extends A2A (Agent-to-Agent Protocol) with three on-chain
 * registries for trustless agent discovery + payment:
 *
 *   1. Identity Registry   — persistent agent IDs (DID/ENS-bound)
 *   2. Reputation Registry — generalized feedback layer
 *   3. Validation Registry — verifiable work (re-execution, staking, TEE)
 *
 * In OpenAgentPay this manifests as an authorization layer (similar to AP2):
 * the 402 envelope carries an `erc8004` block referencing on-chain registry
 * IDs; the adapter parses it and forwards a settlement request to whichever
 * inner protocol (x402/cex-pay/...) the merchant accepts.
 *
 * Spec: https://eips.ethereum.org/EIPS/eip-8004
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

export const PROTOCOL_ID = "erc8004-v1" as ProtocolId;
export const X_PAYMENT_ERC8004_HEADER = "X-PAYMENT-ERC8004";

export interface Erc8004IdentityRecord {
  readonly agentId: string;             // DID or ENS name
  readonly chain: string;                // CAIP-2 e.g. "eip155:1"
  readonly identityRegistry: string;     // contract address
  readonly tokenId?: string;             // identity NFT/ERC-1155 id if any
  readonly metadataURI?: string;         // ipfs://… or https://…
}

export interface Erc8004ReputationRecord {
  readonly registry: string;             // contract address
  readonly score?: number;               // 0-100 if scored
  readonly attestations?: number;        // count
  readonly evidenceURI?: string;
}

export interface Erc8004ValidationRecord {
  readonly registry: string;
  readonly model: "re-execution" | "staking" | "tee" | "zkml";
  readonly proof?: string;               // attestation hash
}

export interface Erc8004Block {
  readonly version: 1;
  readonly identity: Erc8004IdentityRecord;
  readonly reputation?: Erc8004ReputationRecord;
  readonly validation?: Erc8004ValidationRecord;
}

export interface Erc8004402Body {
  readonly erc8004: Erc8004Block;
  readonly settlement: {
    readonly protocol: ProtocolId;
    readonly payload: Record<string, unknown>;
  };
  readonly description?: string;
}

export interface Erc8004AdapterConfig {
  /** Optional minimum reputation score (0-100) the agent will accept. */
  readonly minReputation?: number;
  /** Optional allow-list of identity registries. */
  readonly trustedRegistries?: readonly string[];
  readonly now?: () => number;
}

export class Erc8004ProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly minReputation: number;
  private readonly trustedRegistries: ReadonlySet<string> | undefined;
  private readonly now: () => number;

  constructor(cfg: Erc8004AdapterConfig = {}) {
    this.minReputation = cfg.minReputation ?? 0;
    this.trustedRegistries = cfg.trustedRegistries
      ? new Set(cfg.trustedRegistries.map((r) => r.toLowerCase()))
      : undefined;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    const e = body["erc8004"];
    return isObject(e) && (e["version"] === 1 || e["version"] === undefined);
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    const id = body.erc8004.identity;

    if (
      this.trustedRegistries &&
      !this.trustedRegistries.has(id.identityRegistry.toLowerCase())
    ) {
      throw new ProtocolError(
        `ERC-8004 identity registry ${id.identityRegistry} not in trust list`,
        "unsupported_scheme"
      );
    }
    if (this.minReputation > 0) {
      const r = body.erc8004.reputation;
      if (!r || (r.score ?? 0) < this.minReputation) {
        throw new ProtocolError(
          `ERC-8004 reputation ${r?.score ?? 0} below required ${this.minReputation}`,
          "unsupported_scheme"
        );
      }
    }

    const settlement = body.settlement;
    const recipient =
      (settlement.payload["recipient"] as string | undefined) ??
      (settlement.payload["payTo"] as string | undefined) ??
      "";
    if (!recipient) {
      throw new ProtocolError(
        "ERC-8004 settlement.payload missing recipient",
        "missing_field"
      );
    }
    const amount: Money = {
      amountAtomic: (settlement.payload["amount"] as string | undefined) ?? "0",
      decimals: (settlement.payload["decimals"] as number | undefined) ?? 6,
      currency: (settlement.payload["currency"] as string | undefined) ?? "USDC",
    };
    const validBefore =
      (settlement.payload["validBefore"] as number | undefined) ??
      Math.floor(this.now() / 1000) + 600;

    return {
      protocol: settlement.protocol, // SETTLEMENT layer (x402-v1, etc.)
      amount,
      recipient,
      asset: { symbol: amount.currency, decimals: amount.decimals },
      validAfter: 0,
      validBefore,
      nonce:
        (settlement.payload["nonce"] as string | undefined) ?? generateNonce(),
      rawPayload: { erc8004Body: body },
      ...(body.description !== undefined ? { description: body.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError(
        "ERC-8004 retry requires inner signature",
        "missing_field"
      );
    }
    const wire = {
      version: 1,
      settlement: {
        protocol: signed.request.protocol,
        signer: signed.signer,
        signature: signed.signature,
        encoded: signed.encoded ?? null,
      },
    };
    return {
      headers: {
        [X_PAYMENT_ERC8004_HEADER]: Buffer.from(
          JSON.stringify(wire),
          "utf8"
        ).toString("base64url"),
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  private assertBody(body: unknown): Erc8004402Body {
    if (!isObject(body))
      throw new ProtocolError("ERC-8004 body must be object", "malformed");
    const e = body["erc8004"];
    if (!isObject(e))
      throw new ProtocolError("ERC-8004 missing erc8004 block", "missing_field");
    const id = e["identity"];
    if (!isObject(id) || typeof id["agentId"] !== "string") {
      throw new ProtocolError("ERC-8004 missing identity.agentId", "missing_field");
    }
    if (typeof id["identityRegistry"] !== "string") {
      throw new ProtocolError("ERC-8004 missing identity.identityRegistry", "missing_field");
    }
    if (typeof id["chain"] !== "string") {
      throw new ProtocolError("ERC-8004 missing identity.chain (CAIP-2)", "missing_field");
    }
    const settlement = body["settlement"];
    if (!isObject(settlement)) {
      throw new ProtocolError("ERC-8004 missing settlement block", "missing_field");
    }
    if (typeof settlement["protocol"] !== "string") {
      throw new ProtocolError("ERC-8004 settlement.protocol required", "missing_field");
    }
    if (!isObject(settlement["payload"])) {
      throw new ProtocolError("ERC-8004 settlement.payload required", "missing_field");
    }
    return body as unknown as Erc8004402Body;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function generateNonce(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
