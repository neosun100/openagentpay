/**
 * @openagentpay/protocol-l402 — Lightning Network L402 (formerly LSAT) Adapter
 * =============================================================================
 *
 * L402 = Lightning + HTTP 402 + Macaroons. Originally from Lightning Labs
 * (Aperture proxy). Bitcoin-native machine payments — agents pay BOLT11
 * invoices in sub-cent amounts.
 *
 * Wire format:
 *   Server returns 402 Payment Required
 *           WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"
 *   Client pays the invoice over Lightning, gets preimage
 *   Client retries with Authorization: L402 <macaroon>:<preimage_hex>
 *
 * Spec: https://docs.lightning.engineering/the-lightning-network/l402
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

export const PROTOCOL_ID = "l402-v1" as ProtocolId;
export const WWW_AUTHENTICATE_SCHEME = "L402";
export const SATOSHIS_PER_BTC = 100_000_000n;

export interface L402Challenge {
  readonly macaroon: string;       // base64-encoded macaroon
  readonly invoice: string;         // BOLT11 invoice
  readonly description?: string;
}

/**
 * Parse the BOLT11 invoice's amount (lightweight — full BOLT11 decoding needs
 * bech32 + crypto). Returns msat (millisatoshi), or 0n for amountless invoices.
 *
 * BOLT11 starts with `lnbc` / `lntb` / `lnbcrt` / `lnsb` followed by amount
 * and multiplier ('m'/'u'/'n'/'p').
 */
export function parseBolt11Amount(invoice: string): bigint {
  const lower = invoice.toLowerCase();
  const prefixMatch = lower.match(/^ln(bc|tb|bcrt|sb)([0-9]+)([munp])?/);
  if (!prefixMatch) {
    throw new ProtocolError(
      `Invalid BOLT11 invoice (no prefix): ${invoice.slice(0, 16)}…`,
      "malformed"
    );
  }
  const numStr = prefixMatch[2];
  const multiplier = prefixMatch[3];
  const value = BigInt(numStr ?? "0");
  if (value === 0n) return 0n;
  switch (multiplier) {
    case "m": return value * 100_000_000n; // milli-BTC
    case "u": return value * 100_000n;     // micro-BTC
    case "n": return value * 100n;         // nano-BTC
    case "p": return value / 10n;          // pico-BTC (rounded)
    case undefined: return value * 100_000_000_000n; // whole BTC
    default: throw new ProtocolError(`Unknown BOLT11 multiplier: ${multiplier}`, "malformed");
  }
}

export interface L402AdapterConfig {
  readonly preferredNetwork?: "bitcoin" | "testnet" | "regtest" | "signet";
  readonly now?: () => number;
}

export class L402ProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly preferredNetwork: "bitcoin" | "testnet" | "regtest" | "signet";
  private readonly now: () => number;

  constructor(cfg: L402AdapterConfig = {}) {
    this.preferredNetwork = cfg.preferredNetwork ?? "bitcoin";
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const auth = response.headers["www-authenticate"];
    if (typeof auth !== "string") return false;
    const lower = auth.trim().toLowerCase();
    return lower.startsWith("l402") || lower.startsWith("lsat");
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const auth = response.headers["www-authenticate"];
    if (typeof auth !== "string") {
      throw new ProtocolError("L402 missing WWW-Authenticate header", "missing_field");
    }
    const challenge = parseL402Challenge(auth);
    const msat = parseBolt11Amount(challenge.invoice);
    const currency = this.preferredNetwork === "bitcoin" ? "BTC" : "tBTC";

    const amount: Money = {
      amountAtomic: msat.toString(),
      decimals: 11, // 1 BTC = 1e11 msat
      currency,
    };

    const validBefore = Math.floor(this.now() / 1000) + 600;
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: "lightning-node",
      asset: { symbol: currency, decimals: 11 },
      validAfter: 0,
      validBefore,
      nonce: challenge.macaroon, // macaroon doubles as nonce
      rawPayload: challenge,
      ...(challenge.description !== undefined ? { description: challenge.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("L402 retry requires preimage in signature field", "missing_field");
    }
    const macaroon = signed.request.nonce;
    const preimage = signed.signature;
    return {
      headers: {
        Authorization: `${WWW_AUTHENTICATE_SCHEME} ${macaroon}:${preimage}`,
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }
}

/**
 * Parse `L402 macaroon="...", invoice="..."` (or legacy LSAT form).
 */
export function parseL402Challenge(headerValue: string): L402Challenge {
  const trimmed = headerValue.trim();
  if (!/^l402\s|^lsat\s/i.test(trimmed)) {
    throw new ProtocolError("WWW-Authenticate not L402/LSAT", "malformed");
  }
  const params = trimmed.replace(/^l402\s|^lsat\s/i, "");
  const fields: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(params)) !== null) {
    fields[m[1]!.toLowerCase()] = m[2]!;
  }
  if (!fields["macaroon"]) {
    throw new ProtocolError("L402 challenge missing macaroon", "missing_field");
  }
  if (!fields["invoice"]) {
    throw new ProtocolError("L402 challenge missing invoice", "missing_field");
  }
  return {
    macaroon: fields["macaroon"]!,
    invoice: fields["invoice"]!,
    ...(fields["description"] !== undefined ? { description: fields["description"]! } : {}),
  };
}
