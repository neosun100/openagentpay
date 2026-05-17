/**
 * PaymentManager — top-level orchestrator
 * ==========================================
 *
 * Mirrors **AWS Bedrock AgentCore PaymentManager** as the top-level resource
 * that coordinates payment operations:
 *
 *   1. createPaymentSession   — mint a session with budget + TTL
 *   2. createPaymentInstrument — bind a user to a wallet provider
 *   3. processPayment         — execute the full 12-step x402 / OAP-CEX flow
 *
 * Internally composes:
 *   - SessionManager (DDB or in-memory)
 *   - Connector Registry (multiple WalletConnectors by walletProvider)
 *
 * Design principle: **interface alignment with AgentCore Payments** so that
 * a customer using `AgentCorePaymentsPlugin` can drop in `OpenAgentPayPlugin`
 * with only an import change.
 *
 * @license Apache-2.0
 */

import {
  type CreateInstrumentInput,
  type CreateSessionInput,
  type Instrument,
  type InstrumentId,
  type PaymentRequest,
  type Session,
  type SessionId,
  type SettlementResult,
  type SignedAuthorization,
  type UserId,
  type WalletConnector,
  type WalletProviderId,
} from "../types.js";
import {
  InMemorySessionManager,
  type SessionManager,
} from "../session/manager.js";

// ============================================================================
//  Public API surface
// ============================================================================

/**
 * Input to {@link PaymentManager.processPayment}. All required fields:
 *   - sessionId:    the active payment session
 *   - instrumentId: which wallet to pay from
 *   - request:      what to pay (amount, recipient, asset, protocol)
 */
export interface ProcessPaymentInput {
  readonly sessionId: SessionId;
  readonly instrumentId: InstrumentId;
  readonly request: PaymentRequest;
}

/**
 * Output of {@link PaymentManager.processPayment} — wraps the upstream
 * SettlementResult plus session-level state.
 */
export interface ProcessPaymentOutput {
  readonly success: boolean;
  readonly settlement: SettlementResult;
  readonly signed?: SignedAuthorization;
  readonly sessionAfter: Session;
}

/**
 * Top-level orchestrator interface. Implementations:
 *   - InMemoryPaymentManager (this file)
 *   - DynamoDBPaymentManager  (future, in cdk-deploy)
 *   - LambdaPaymentManagerClient (calls a remote Lambda; future)
 */
export interface PaymentManager {
  // ---- Resource creation (mirrors AgentCore Payments names) -----------------

  /** Mint a new session with budget cap + TTL. */
  createPaymentSession(input: CreateSessionInput): Promise<Session>;

  /** Bind a user to a wallet provider. Idempotent. */
  createPaymentInstrument(
    walletProvider: WalletProviderId,
    input: CreateInstrumentInput
  ): Promise<Instrument>;

  /** Read a session by id. */
  getPaymentSession(id: SessionId): Promise<Session | undefined>;

  // ---- Core data plane API -------------------------------------------------

  /**
   * The full 12-step x402 / OAP-CEX flow in one call:
   *   1. validate session + instrument
   *   2. checkAndReserve session budget
   *   3. signAuthorization via connector
   *   4. settle via connector
   *   5. commit/release session reservation
   *   6. return structured result
   *
   * Mirrors AgentCore Payments `ProcessPayment` API.
   */
  processPayment(input: ProcessPaymentInput): Promise<ProcessPaymentOutput>;

  // ---- Connector registry (OpenAgentPay extension) -------------------------

  /** Register a wallet connector. Multiple connectors keyed by walletProvider. */
  registerConnector(connector: WalletConnector): void;

  /** Look up a connector by walletProvider. */
  getConnector(provider: WalletProviderId): WalletConnector | undefined;

  /** List all registered providers. */
  listProviders(): readonly WalletProviderId[];
}

// ============================================================================
//  Errors
// ============================================================================

export class PaymentManagerError extends Error {
  override readonly name = "PaymentManagerError";
  constructor(
    message: string,
    public readonly code:
      | "session_not_found"
      | "instrument_not_found"
      | "connector_not_registered"
      | "session_rejected"
      | "settlement_failed"
      | "internal"
  ) {
    super(message);
  }
}

// ============================================================================
//  In-memory implementation (for tests + local dev + single-Lambda use)
// ============================================================================

export interface InMemoryPaymentManagerConfig {
  /** Custom SessionManager (default: InMemorySessionManager). */
  readonly sessionManager?: SessionManager;
  /** Function to look up an Instrument by id. */
  readonly resolveInstrument: (id: InstrumentId) => Promise<Instrument | undefined>;
}

/**
 * In-memory PaymentManager — useful for tests, single-Lambda deployments, and
 * local demos. Production should use DynamoDBPaymentManager.
 */
export class InMemoryPaymentManager implements PaymentManager {
  private readonly connectors = new Map<string, WalletConnector>();
  private readonly sessionManager: SessionManager;
  private readonly resolveInstrument: (id: InstrumentId) => Promise<Instrument | undefined>;

  constructor(config: InMemoryPaymentManagerConfig) {
    this.sessionManager = config.sessionManager ?? new InMemorySessionManager();
    this.resolveInstrument = config.resolveInstrument;
  }

  // ---- Resource creation ----------------------------------------------------

  async createPaymentSession(input: CreateSessionInput): Promise<Session> {
    return this.sessionManager.createSession(input);
  }

  async createPaymentInstrument(
    walletProvider: WalletProviderId,
    input: CreateInstrumentInput
  ): Promise<Instrument> {
    const connector = this.connectors.get(walletProvider);
    if (!connector) {
      throw new PaymentManagerError(
        `No connector registered for wallet provider: ${walletProvider}`,
        "connector_not_registered"
      );
    }
    return connector.createInstrument(input);
  }

  async getPaymentSession(id: SessionId): Promise<Session | undefined> {
    return this.sessionManager.getSession(id);
  }

  // ---- Connector registry --------------------------------------------------

  registerConnector(connector: WalletConnector): void {
    const caps = connector.getCapabilities();
    this.connectors.set(caps.walletProvider, connector);
  }

  getConnector(provider: WalletProviderId): WalletConnector | undefined {
    return this.connectors.get(provider);
  }

  listProviders(): readonly WalletProviderId[] {
    return Array.from(this.connectors.keys()) as WalletProviderId[];
  }

  // ---- Core data plane: processPayment -------------------------------------

  async processPayment(input: ProcessPaymentInput): Promise<ProcessPaymentOutput> {
    // 1. Resolve session
    const session = await this.sessionManager.getSession(input.sessionId);
    if (!session) {
      throw new PaymentManagerError(
        `Session ${input.sessionId} not found`,
        "session_not_found"
      );
    }

    // 2. Resolve instrument
    const instrument = await this.resolveInstrument(input.instrumentId);
    if (!instrument) {
      throw new PaymentManagerError(
        `Instrument ${input.instrumentId} not found`,
        "instrument_not_found"
      );
    }

    // 3. Resolve connector
    const connector = this.connectors.get(instrument.walletProvider);
    if (!connector) {
      throw new PaymentManagerError(
        `No connector registered for wallet provider: ${instrument.walletProvider}`,
        "connector_not_registered"
      );
    }

    // 4. Reserve budget
    const reservation = await this.sessionManager.checkAndReserve(
      session.id,
      input.request.amount
    );
    if (!reservation.approved) {
      throw new PaymentManagerError(
        `Session reservation rejected: ${reservation.reason}`,
        "session_rejected"
      );
    }

    // 5. Sign + settle
    let signed: SignedAuthorization;
    let settlement: SettlementResult;
    try {
      signed = await connector.signAuthorization({
        instrumentId: instrument.id,
        request: input.request,
        session,
      });
      settlement = await connector.settle(signed);
    } catch (err) {
      // Release reservation on failure
      await this.sessionManager.commit(session.id, input.request.amount, false);
      throw new PaymentManagerError(
        `Settlement failed: ${err instanceof Error ? err.message : String(err)}`,
        "settlement_failed"
      );
    }

    // 6. Commit / release based on result
    const sessionAfter = await this.sessionManager.commit(
      session.id,
      input.request.amount,
      settlement.success
    );

    // Note: signed has `extra` which can have an undefined value. Strip it
    // to avoid TS exactOptionalPropertyTypes complaining about the optional
    // shape difference.
    return {
      success: settlement.success,
      settlement,
      signed,
      sessionAfter,
    };
  }
}

// ============================================================================
//  Helpers — also used by tests
// ============================================================================

/**
 * Create a PaymentManager with an InstrumentStore-backed instrument resolver.
 * This is the most common way to construct one in tests + smoke scripts.
 */
export function createInMemoryPaymentManager(opts: {
  resolveInstrument: (id: InstrumentId) => Promise<Instrument | undefined>;
  sessionManager?: SessionManager;
  connectors?: readonly WalletConnector[];
}): InMemoryPaymentManager {
  const config: InMemoryPaymentManagerConfig =
    opts.sessionManager === undefined
      ? { resolveInstrument: opts.resolveInstrument }
      : { resolveInstrument: opts.resolveInstrument, sessionManager: opts.sessionManager };
  const mgr = new InMemoryPaymentManager(config);
  for (const c of opts.connectors ?? []) {
    mgr.registerConnector(c);
  }
  return mgr;
}

// Type helper used by consumers — exported here so users get a single import path.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _userId_unused: UserId = "alice" as UserId;
