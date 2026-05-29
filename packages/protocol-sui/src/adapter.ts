/**
 * @openagentpay/protocol-sui — Sui Pay Adapter
 * =============================================
 *
 * Sui Pay is a Move-based payment protocol. Recipients are Sui addresses
 * (32-byte hex, 0x-prefixed). Coins are typed objects (e.g.,
 * `0x2::sui::SUI`, `0x...::usdc::USDC`). Payments compose into PTBs
 * (Programmable Transaction Blocks) that wallets sign.
 *
 * Wire format (sui-pay envelope):
 *   {
 *     suiVersion: "1",
 *     recipient: "0x...",
 *     coinType: "0x2::sui::SUI" | "0x...::usdc::USDC",
 *     amountAtomic: "1000000",  // MIST = 1e-9 SUI; USDC = 1e-6
 *     network: "mainnet" | "testnet" | "devnet",
 *     reference?: string,
 *     description?: string
 *   }
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

export const PROTOCOL_ID = "sui-pay-v1" as ProtocolId;
export const X_PAYMENT_SUI_HEADER = "X-PAYMENT-SUI";

const KNOWN_COIN_TYPES: Record<string, { symbol: string; decimals: number }> = {
  "0x2::sui::SUI": { symbol: "SUI", decimals: 9 },
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC": { symbol: "USDC", decimals: 6 },
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN": { symbol: "USDC", decimals: 6 },
};

export interface SuiPay402Body {
  readonly suiVersion: string;
  readonly recipient: string;
  readonly coinType: string;
  readonly amountAtomic: string;
  readonly network: "mainnet" | "testnet" | "devnet" | "localnet";
  readonly reference?: string;
  readonly description?: string;
}

export interface SuiAdapterConfig {
  readonly preferredNetworks?: readonly ("mainnet" | "testnet" | "devnet" | "localnet")[];
  readonly knownCoinTypes?: Record<string, { symbol: string; decimals: number }>;
  readonly now?: () => number;
}

export class SuiPayProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly preferredNetworks: ReadonlySet<string> | undefined;
  private readonly knownCoinTypes: Record<string, { symbol: string; decimals: number }>;
  private readonly now: () => number;

  constructor(cfg: SuiAdapterConfig = {}) {
    this.preferredNetworks = cfg.preferredNetworks ? new Set(cfg.preferredNetworks) : undefined;
    this.knownCoinTypes = cfg.knownCoinTypes ?? KNOWN_COIN_TYPES;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    return typeof body["suiVersion"] === "string" && typeof body["coinType"] === "string";
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    if (this.preferredNetworks && !this.preferredNetworks.has(body.network)) {
      throw new ProtocolError(
        `Sui network '${body.network}' not in preferred set`,
        "unsupported_scheme"
      );
    }
    if (!isLikelySuiAddress(body.recipient)) {
      throw new ProtocolError(`Sui recipient is not a valid 0x-prefixed 32-byte hex: ${body.recipient}`, "malformed");
    }
    const coinMeta = this.knownCoinTypes[body.coinType] ?? { symbol: "COIN", decimals: 9 };
    const amount: Money = {
      amountAtomic: body.amountAtomic,
      decimals: coinMeta.decimals,
      currency: coinMeta.symbol,
    };
    const validBefore = Math.floor(this.now() / 1000) + 600;
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: body.recipient,
      asset: {
        symbol: coinMeta.symbol,
        decimals: coinMeta.decimals,
        contract: body.coinType,
        chain: `sui:${body.network}`,
      },
      validAfter: 0,
      validBefore,
      nonce: body.reference ?? generateNonce(),
      rawPayload: { sui: body },
      ...(body.description !== undefined ? { description: body.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("Sui retry requires tx digest", "missing_field");
    }
    return {
      headers: {
        [X_PAYMENT_SUI_HEADER]: signed.signature, // Sui tx digest (base58)
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  private assertBody(body: unknown): SuiPay402Body {
    if (!isObject(body)) throw new ProtocolError("Sui body must be object", "malformed");
    for (const f of ["suiVersion", "recipient", "coinType", "amountAtomic", "network"] as const) {
      if (typeof body[f] !== "string") {
        throw new ProtocolError(`Sui missing field: ${f}`, "missing_field");
      }
    }
    return body as unknown as SuiPay402Body;
  }
}

function isLikelySuiAddress(s: string): boolean {
  return /^0x[0-9a-f]{1,64}$/i.test(s);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function generateNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
