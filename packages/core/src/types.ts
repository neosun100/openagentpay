/**
 * OpenAgentPay Core Type System
 * ===============================
 *
 * This file defines the canonical interfaces every WalletConnector and ProtocolAdapter
 * must satisfy. Designed to be:
 *
 *   1. Drop-in compatible with AWS Bedrock AgentCore Payments Plugin API shape
 *   2. Wallet-agnostic (Coinbase CDP, Stripe Privy, Binance Pay, OKX, MetaMask, ...)
 *   3. Protocol-agnostic (x402 v1/v2, MPP, AP2, ACP, OAP-CEX, ...)
 *   4. Language-mirrored (Python SDK has identical shape via Protocol/dataclass)
 *
 * Versioning: Public ABI is v0.1.0-alpha. Breaking changes allowed until v1.0.0.
 *
 * @license Apache-2.0
 */

// ============================================================================
//  Branded Identifiers
// ============================================================================

/** A nominal-typed string brand to keep IDs from being mixed up at compile time. */
type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type SessionId = Brand<string, "SessionId">;
export type InstrumentId = Brand<string, "InstrumentId">;
export type WalletProviderId = Brand<string, "WalletProviderId">;
export type ProtocolId = Brand<string, "ProtocolId">;
export type TransactionRef = Brand<string, "TransactionRef">;

// Helpers to mint branded values (use only in trusted code paths).
export const UserId = (s: string): UserId => s as UserId;
export const SessionId = (s: string): SessionId => s as SessionId;
export const InstrumentId = (s: string): InstrumentId => s as InstrumentId;
export const TransactionRef = (s: string): TransactionRef => s as TransactionRef;

// ============================================================================
//  Money / Asset Primitives
// ============================================================================

/**
 * Money is always stored as an integer of the smallest atomic unit + decimals,
 * never as floating point. This avoids classic float-rounding bugs in payments.
 */
export interface Money {
  /** Atomic units as a stringified bigint to preserve precision over JSON. */
  readonly amountAtomic: string;
  /** Decimal places (USDC=6, USDT=6, BTC=8, ETH=18, USD=2). */
  readonly decimals: number;
  /** ISO 4217 currency code or asset symbol (USD, USDC, USDT, ...). */
  readonly currency: string;
}

export interface Asset {
  /** Asset symbol (USDC, USDT, BTC, ...). */
  readonly symbol: string;
  /** Decimals for the smallest unit. */
  readonly decimals: number;
  /** Optional chain identifier when on-chain (CAIP-2 like "eip155:84532"). */
  readonly chain?: string;
  /** Optional ERC-20 / contract address. */
  readonly contract?: string;
}

// ============================================================================
//  Session
// ============================================================================

/**
 * A spending session with a hard budget cap and TTL — enforced in
 * infrastructure (DynamoDB conditional updates), not by the LLM.
 *
 * Mirrors AgentCore Payments PaymentSession. Same field names where possible.
 */
export interface Session {
  readonly id: SessionId;
  readonly userId: UserId;
  /** Total budget for this session (Money is preferred over plain number). */
  readonly budget: Money;
  /** Cumulative committed spend so far. Updated atomically via DDB. */
  readonly spent: Money;
  /** ISO 8601 timestamp when the session expires. */
  readonly expiresAt: string;
  /** ISO 8601 creation time. */
  readonly createdAt: string;
  /** Last update timestamp. */
  readonly updatedAt: string;
  /** Hard state — once "closed" no further reservations allowed. */
  readonly status: "active" | "exhausted" | "expired" | "closed";
  /**
   * Free-form metadata: app id, agent id, team, cost center.
   * SpendGovernor policies can read this.
   */
  readonly metadata?: Record<string, string>;
}

export interface CreateSessionInput {
  readonly userId: UserId;
  readonly budgetUsd: number;
  readonly expiresMinutes: number;
  readonly metadata?: Record<string, string>;
}

export interface ReservationResult {
  readonly approved: boolean;
  readonly reason?: "budget_exceeded" | "session_expired" | "session_closed" | "policy_denied";
  readonly remainingBudget: Money;
}

// ============================================================================
//  Instrument (Wallet Handle)
// ============================================================================

/**
 * An Instrument represents a user's bound wallet/account at a specific provider.
 * Created once per (user, provider) pair. Used by WalletConnector to resolve
 * which underlying wallet to act on for this user.
 *
 * Mirrors AgentCore Payments PaymentInstrument.
 */
export interface Instrument {
  readonly id: InstrumentId;
  readonly userId: UserId;
  readonly walletProvider: WalletProviderId;
  /** Public address (on-chain) OR provider-specific account ID (CEX). */
  readonly publicHandle: string;
  /** ISO 8601 creation time. */
  readonly createdAt: string;
  /** Free-form provider-specific metadata. */
  readonly providerMetadata?: Record<string, unknown>;
}

// ============================================================================
//  Wallet Capabilities
// ============================================================================

/**
 * Self-describing capabilities a WalletConnector reports. Used by the
 * Orchestrator to choose the right wallet for a given PaymentRequest, and by
 * the Plugin Registry to surface compatibility info to users.
 */
export interface WalletCapabilities {
  readonly walletProvider: WalletProviderId;
  /** Display name shown in UIs (e.g., "Binance Pay"). */
  readonly displayName: string;
  /** Asset symbols this wallet can pay in. */
  readonly supportedAssets: readonly Asset[];
  /** Protocol IDs this wallet's signing flow can satisfy. */
  readonly supportedProtocols: readonly ProtocolId[];
  /**
   * Whether a payment requires interactive end-user approval each call
   * (e.g., MetaMask) or runs silently with a stored API key (e.g., Binance Pay).
   */
  readonly requiresUserApproval: boolean;
  /** True if final settlement is on a public blockchain. */
  readonly settlesOnChain: boolean;
  /** Optional advisory: typical settlement latency, e.g., "~2s on Base L2". */
  readonly typicalLatencyMs?: number;
  /** Extra capability flags consumers can branch on. */
  readonly features?: Record<string, boolean | string | number>;
}

// ============================================================================
//  Payment Request / Authorization / Settlement
// ============================================================================

/**
 * A PaymentRequest represents the demand from a 402 endpoint after the
 * ProtocolAdapter has parsed the response. Wallet-agnostic.
 */
export interface PaymentRequest {
  /** Protocol that produced this request (provenance). */
  readonly protocol: ProtocolId;
  /** Amount demanded by the merchant. */
  readonly amount: Money;
  /** Recipient (chain address or provider-specific merchant ID). */
  readonly recipient: string;
  /** Asset specification (symbol + chain + contract). */
  readonly asset: Asset;
  /** Time before which the authorization is invalid (Unix seconds). */
  readonly validAfter: number;
  /** Time after which the authorization is invalid (Unix seconds). */
  readonly validBefore: number;
  /** Random nonce to prevent replay. Hex string. */
  readonly nonce: string;
  /** Original 402 response body — preserved for audit and debugging. */
  readonly rawPayload: unknown;
  /** Description / reason — surfaces in audit log. */
  readonly description?: string;
  /**
   * Optional AP2 mandate envelope. Carried orthogonally to the settlement
   * payload — wallet connectors ignore mandates, ProtocolAdapters validate
   * + log them, ComplianceCheckers may inspect them.
   *
   * Mandates compose with ANY settlement protocol (x402, OAP-CEX, AP2-x402,
   * Solana Pay, ...) — that's the whole point of AP2 being orthogonal.
   */
  readonly mandates?: ReadonlyArray<Mandate>;
}

/**
 * A SignedAuthorization is the wallet-produced cryptographic proof that
 * authorizes the transfer. Format depends on protocol:
 *   - x402: EIP-712 signature over EIP-3009 transferWithAuthorization
 *   - cex-pay: HMAC over CEX-specific payload
 *   - mpp: capability-token JWS
 */
export interface SignedAuthorization {
  readonly request: PaymentRequest;
  /** Wallet's signing entity (address or merchant ID). */
  readonly signer: string;
  /** Opaque signature blob — protocol-specific encoding. */
  readonly signature: string;
  /** Optional encoded form ready to be put on the wire (e.g., base64 X-PAYMENT). */
  readonly encoded?: string;
  /** Free-form additional data the protocol adapter may need at submit time. */
  readonly extra?: Record<string, unknown>;
}

/**
 * Outcome of submitting a SignedAuthorization to the settlement layer
 * (facilitator / CEX backend / chain RPC).
 */
export interface SettlementResult {
  readonly success: boolean;
  /**
   * Provider-or-chain reference for the transaction.
   * On-chain: tx hash. CEX: transactionId. Off-chain: receipt id.
   */
  readonly transactionRef?: TransactionRef;
  /** Network name (base-sepolia, binance-pay-sandbox, ...). */
  readonly network: string;
  /** Settlement timestamp (ISO 8601). */
  readonly settledAt: string;
  /** Final amount actually transferred (may differ from request in edge cases). */
  readonly settledAmount?: Money;
  /** Failure reason when success=false. Stable, machine-readable. */
  readonly errorCode?:
    | "insufficient_funds"
    | "signature_invalid"
    | "nonce_used"
    | "expired_authorization"
    | "rpc_error"
    | "rate_limited"
    | "compliance_blocked"
    | "unknown";
  /** Human-readable message — never depend on this for control flow. */
  readonly errorMessage?: string;
  /** Provider-specific raw response — kept verbatim for forensics. */
  readonly raw?: unknown;
}

// ============================================================================
//  WalletConnector Interface (the core extension point #1)
// ============================================================================

/**
 * Implement this interface to add a new wallet provider.
 * Five methods, no more.
 *
 * Conformance test suite: every implementation must pass
 *   `@openagentpay/conformance/wallet`
 * which tests creation, balance, signing, settlement, capability reporting.
 */
export interface WalletConnector {
  /** Capability self-report — must be a pure getter, no I/O. */
  getCapabilities(): WalletCapabilities;

  /**
   * Create a new payment instrument (wallet handle) for the given user.
   * Idempotent: calling twice for the same userId returns the same instrument.
   */
  createInstrument(input: CreateInstrumentInput): Promise<Instrument>;

  /**
   * Read the live balance of the bound wallet.
   * MUST round-trip to the provider — no caching at this layer.
   */
  getBalance(instrumentId: InstrumentId): Promise<Balance>;

  /**
   * Produce a SignedAuthorization given a PaymentRequest.
   * Implementation responsibility:
   *   - Resolve API key / private key from AgentCore Identity (Secrets Manager)
   *   - Build provider-native signing payload
   *   - Return signed blob ready for settlement
   *
   * MUST NOT actually move funds.
   */
  signAuthorization(input: SignAuthorizationInput): Promise<SignedAuthorization>;

  /**
   * Submit the signed authorization to the settlement layer.
   * Returns success+transactionRef on completion.
   *
   * Implementations should NOT retry internally — that's Orchestrator's job.
   */
  settle(signed: SignedAuthorization): Promise<SettlementResult>;
}

export interface CreateInstrumentInput {
  readonly userId: UserId;
  readonly metadata?: Record<string, string>;
}

export interface Balance {
  readonly instrumentId: InstrumentId;
  readonly asset: Asset;
  readonly money: Money;
  /** Read-through timestamp. */
  readonly fetchedAt: string;
}

export interface SignAuthorizationInput {
  readonly instrumentId: InstrumentId;
  readonly request: PaymentRequest;
  readonly session: Session;
}

// ============================================================================
//  ProtocolAdapter Interface (the core extension point #2)
// ============================================================================

/**
 * Implement this interface to add a new payment protocol (x402 v1/v2, MPP, AP2,
 * ACP, OAP-CEX, ...).
 *
 * Conformance test suite: `@openagentpay/conformance/protocol`
 * which tests parse, build, submit, version negotiation.
 */
export interface ProtocolAdapter {
  /** Stable protocol identifier (e.g., "x402-v1", "x402-v2", "cex-pay-v0.1"). */
  readonly id: ProtocolId;

  /**
   * Detect whether a 402 response was produced by this protocol.
   * Used by the ProtocolRouter to route 402s to the right adapter.
   */
  detect(response: HttpResponse402): boolean;

  /**
   * Parse a 402 response into a PaymentRequest.
   * Throws ProtocolError if malformed.
   */
  parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest>;

  /**
   * Take a SignedAuthorization and produce protocol-specific HTTP retry
   * material (headers + body) to send back to the merchant endpoint.
   */
  buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope>;

  /**
   * Optional: submit to a facilitator/escrow/coordinator if the protocol
   * requires an out-of-band step before retrying the merchant call.
   * Most protocols return undefined here.
   */
  preSubmit?(signed: SignedAuthorization): Promise<SettlementResult | undefined>;
}

export interface HttpResponse402 {
  readonly statusCode: 402;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface HttpRetryEnvelope {
  /** Headers to merge into the retry request (e.g., X-PAYMENT). */
  readonly headers: Readonly<Record<string, string>>;
  /** Optional body override for the retry. */
  readonly body?: unknown;
}

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
  constructor(
    message: string,
    public readonly code:
      | "malformed"
      | "unsupported_version"
      | "unsupported_scheme"
      | "missing_field"
      | "internal"
  ) {
    super(message);
  }
}

// ============================================================================
//  SpendGovernor (orchestrator-side policy gate)
// ============================================================================

/**
 * A pluggable policy hook the Orchestrator consults before signing.
 * Lets companies layer per-team / per-cost-center / KYT rules on top of
 * the basic Session budget cap.
 */
export interface SpendGovernor {
  evaluate(input: SpendEvaluationInput): Promise<SpendEvaluationResult>;
}

export interface SpendEvaluationInput {
  readonly session: Session;
  readonly request: PaymentRequest;
  readonly instrument: Instrument;
}

export interface SpendEvaluationResult {
  readonly allow: boolean;
  /** Stable code clients can switch on. */
  readonly reason?:
    | "budget_exceeded"
    | "team_limit_exceeded"
    | "asset_not_allowed"
    | "recipient_blocked"
    | "kyt_flagged"
    | "approval_required"
    | "policy_denied";
  readonly humanMessage?: string;
}

// ============================================================================
//  Orchestrator-facing aggregate (the Plugin's runtime view)
// ============================================================================

/**
 * The OpenAgentPay runtime config that the Strands Plugin (or any other
 * Agent framework adapter) hands the Orchestrator on each invocation.
 */
export interface OpenAgentPayRuntimeConfig {
  readonly walletProvider: WalletProviderId;
  readonly protocol: ProtocolId;
  readonly instrumentId: InstrumentId;
  readonly sessionId: SessionId;
  readonly userId: UserId;
  /** Fully-qualified Lambda Function URL of the Payment Manager backend. */
  readonly paymentManagerEndpoint: string;
}

// ============================================================================
//  AP2 Mandate Layer (Authorization Envelope)
// ============================================================================
//
//  AP2 (Google Agent Payments Protocol) introduces a *mandate-based* trust
//  model orthogonal to settlement protocols (x402 / OAP-CEX). Mandates are
//  W3C Verifiable Credentials that travel ALONGSIDE a settlement payload:
//
//    ┌─ AP2 Mandate (who/why) ────────┐    ┌─ Settlement (how) ──────┐
//    │  Intent Mandate                │    │  x402 EIP-712 sig       │
//    │  Cart Mandate                  │ +  │  OR OAP-CEX HMAC token  │
//    │  Payment Mandate               │    │  OR Solana Pay tx       │
//    └────────────────────────────────┘    └──────────────────────────┘
//
//  This means OpenAgentPay can carry AP2 mandates as an outer envelope on
//  top of ANY existing wallet/protocol — solving the "compose protocols"
//  problem the user asked about.
//
// ============================================================================

/** AP2 Mandate kind (W3C VC subtype). */
export type MandateKind =
  | "ap2.IntentMandate"     // Initial user intent + constraints
  | "ap2.CartMandate"       // Approved final cart (merchant-signed)
  | "ap2.PaymentMandate";   // Sent to payment network for risk assessment

/**
 * Cryptographic signature attached to a Mandate. Format follows W3C VC
 * Data Integrity (https://www.w3.org/TR/vc-data-integrity/) but we keep
 * the field set minimal so non-VC implementations can also sign.
 */
export interface MandateProof {
  /** Signature suite identifier — e.g., "EcdsaSecp256k1Signature2019", "Ed25519Signature2020", "JsonWebSignature2020". */
  readonly type: string;
  /** ISO 8601 — when the proof was created. */
  readonly created: string;
  /** DID / URI of the signer — e.g., "did:key:z6Mk...", "https://merchant.example/keys/1". */
  readonly verificationMethod: string;
  /** What the proof asserts — typically "assertionMethod" for mandates. */
  readonly proofPurpose: "assertionMethod" | "authentication";
  /** The signature value — base64url or multibase, suite-specific. */
  readonly proofValue: string;
}

/**
 * AP2 Mandate envelope. All three mandate kinds share this top shape;
 * `kind` discriminates the `claims` payload.
 */
export interface Mandate {
  /** W3C VC context — ["https://www.w3.org/ns/credentials/v2"] */
  readonly "@context": readonly string[];
  /** Globally unique mandate id (urn:uuid:... preferred). */
  readonly id: string;
  /** Mandate kind — first element is "VerifiableCredential". */
  readonly type: readonly [string, MandateKind];
  /** Issuer DID/URI — typically the user (Intent), merchant (Cart), or PSP (Payment). */
  readonly issuer: string;
  /** ISO 8601 issuance timestamp. */
  readonly issuanceDate: string;
  /** ISO 8601 expiration — agent + merchant MUST reject if past. */
  readonly expirationDate?: string;
  /** Subject identifier — typically "did:openagent:<userId>" or AID. */
  readonly credentialSubject: {
    readonly id: string;
    readonly mandate: IntentMandateClaims | CartMandateClaims | PaymentMandateClaims;
  };
  /** Cryptographic proof — REQUIRED on all mandates that cross trust boundaries. */
  readonly proof: MandateProof;
}

/**
 * Intent Mandate — user delegates shopping authority to an Agent with constraints.
 * Example: "Buy concert tickets if they drop below $200, max 2 tickets, by 2026-12-31."
 */
export interface IntentMandateClaims {
  readonly kind: "ap2.IntentMandate";
  /** Free-form natural language summary — for human review. */
  readonly description: string;
  /** Maximum total spend across all settlements under this intent (atomic units). */
  readonly maxAmountAtomic: string;
  /** Currency / asset symbol the cap applies to. */
  readonly currency: string;
  /** Decimal places. */
  readonly decimals: number;
  /** Optional merchant whitelist — only these merchants may charge. */
  readonly allowedMerchants?: readonly string[];
  /** Optional product / category constraints. */
  readonly productConstraints?: Record<string, unknown>;
  /** Number of permitted settlements (e.g., 1 for single-purchase, N for subscription). */
  readonly maxUses?: number;
}

/**
 * Cart Mandate — merchant cryptographically commits to a specific cart that
 * matches an Intent Mandate. Includes line items + total + merchant identity.
 */
export interface CartMandateClaims {
  readonly kind: "ap2.CartMandate";
  /** Reference to the Intent Mandate this cart fulfills (id only). */
  readonly intentMandateId: string;
  /** Final total in atomic units. */
  readonly totalAtomic: string;
  readonly currency: string;
  readonly decimals: number;
  /** Line items the merchant commits to deliver. */
  readonly lineItems: ReadonlyArray<{
    readonly sku: string;
    readonly description: string;
    readonly quantity: number;
    readonly unitPriceAtomic: string;
  }>;
  /** Merchant identity (DID or URL). */
  readonly merchant: string;
  /** Optional fulfillment terms. */
  readonly fulfillment?: Record<string, unknown>;
}

/**
 * Payment Mandate — sent to payment network/issuer to signal Agent involvement.
 * Carries the actual settlement instruction the wallet will execute.
 */
export interface PaymentMandateClaims {
  readonly kind: "ap2.PaymentMandate";
  /** References the Cart Mandate being paid. */
  readonly cartMandateId: string;
  /** Settlement protocol used at the wallet/wire layer. */
  readonly settlementProtocol: ProtocolId;
  /** Settlement-specific opaque payload (handed to the settlement adapter). */
  readonly settlementPayload: Record<string, unknown>;
  /** Hint to risk engines: "agent_present" | "agent_not_present". */
  readonly presence: "agent_present" | "agent_not_present" | "user_present";
}

// ============================================================================
//  Observability event shape
// ============================================================================

/**
 * Every payment lifecycle step emits an event matching this shape, fed into
 * CloudWatch Logs (vended) and X-Ray spans (vended). Mirrors AgentCore
 * Observability output so existing dashboards still work.
 */
export interface PaymentEvent {
  readonly type:
    | "session.created"
    | "instrument.created"
    | "402.detected"
    | "request.parsed"
    | "budget.checked"
    | "credentials.loaded"
    | "authorization.signed"
    | "settlement.submitted"
    | "settlement.completed"
    | "settlement.failed"
    | "session.committed"
    | "audit.emitted";
  readonly sessionId?: SessionId;
  readonly userId?: UserId;
  readonly instrumentId?: InstrumentId;
  readonly walletProvider?: WalletProviderId;
  readonly protocol?: ProtocolId;
  readonly transactionRef?: TransactionRef;
  /** Duration since session start (ms). */
  readonly elapsedMs?: number;
  readonly timestamp: string;
  readonly extra?: Record<string, unknown>;
}
