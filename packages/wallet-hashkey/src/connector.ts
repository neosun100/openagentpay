/**
 * HashKeyChainConnector — implements WalletConnector for self-custodial EVM
 * wallets on HashKey Chain (testnet 133 / mainnet 177).
 *
 * Unlike Coinbase CDP / Stripe Privy (custodial wallets where private keys
 * live in a managed service), this connector is **self-custodial**:
 *   - The agent (or its operator) holds the EOA private key
 *   - In production, the key lives in AWS Secrets Manager + KMS
 *   - The connector loads it just-in-time, signs EIP-712, returns
 *     SignedAuthorization to the orchestrator
 *
 * Settlement model:
 *   - signAuthorization() produces an off-chain EIP-712 signature (no chain I/O)
 *   - settle() broadcasts the signed authorization through a *facilitator*
 *     wallet (which can be the same EOA in demo, or a separate gas-paying
 *     EOA in production)
 *
 * @license Apache-2.0
 */

import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type Money,
  type ProtocolId,
  type SettlementResult,
  type SignAuthorizationInput,
  type SignedAuthorization,
  type TransactionRef,
  type UserId,
  type WalletCapabilities,
  type WalletConnector,
  type WalletProviderId,
} from "@openagentpay/core";
import { type Address, type Hex, type WalletClient } from "viem";
import { type PrivateKeyAccount } from "viem/accounts";

import {
  hashkeyChainTestnet,
  txExplorerUrl,
} from "./chain.js";
import {
  HashKeyChainTokenClient,
  createWalletClientFromPrivateKey,
  generateNonce,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
} from "./token-client.js";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "hashkey-chain" as WalletProviderId;

/** OpenAgentPay uses `x402-v1` as the canonical protocol id for EIP-3009 flows. */
export const HASHKEY_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;

// ============================================================================
//  Configuration
// ============================================================================

export interface HashKeyChainConnectorConfig {
  /**
   * The agent's private key (Hex, 0x-prefixed). In production load from
   * AWS Secrets Manager. In tests / demo accept directly.
   */
  readonly privateKey: Hex;
  /** Token contract address (e.g. our MockUSDC at 0x0685C4...). */
  readonly tokenAddress: Address;
  /** Chain to operate on. Default: HashKey Chain Testnet. */
  readonly chain?: typeof hashkeyChainTestnet;
  /** RPC override (e.g. private node). */
  readonly rpcUrl?: string;
  /**
   * Storage adapter for (userId → Instrument) bindings. In Lambda, back this
   * with DynamoDB. In tests, use {@link MemoryInstrumentStore}.
   */
  readonly instrumentStore: InstrumentStore;
  /**
   * Optional separate facilitator wallet for broadcasting (gas-payer).
   * If omitted, the agent's own wallet pays gas + broadcasts (simplest demo).
   */
  readonly facilitatorPrivateKey?: Hex;
  /** Optional clock — overridable in tests. */
  readonly now?: () => number;
  /** Optional override for token client (for testing). */
  readonly tokenClient?: HashKeyChainTokenClient;
}

// ============================================================================
//  InstrumentStore
// ============================================================================

export interface InstrumentStore {
  get(userId: UserId): Promise<Instrument | undefined>;
  put(instrument: Instrument): Promise<void>;
  getById(instrumentId: InstrumentId): Promise<Instrument | undefined>;
}

export class MemoryInstrumentStore implements InstrumentStore {
  private readonly byUser = new Map<string, Instrument>();
  private readonly byId = new Map<string, Instrument>();
  async get(userId: UserId): Promise<Instrument | undefined> {
    return this.byUser.get(userId);
  }
  async put(instrument: Instrument): Promise<void> {
    this.byUser.set(instrument.userId, instrument);
    this.byId.set(instrument.id, instrument);
  }
  async getById(id: InstrumentId): Promise<Instrument | undefined> {
    return this.byId.get(id);
  }
}

// ============================================================================
//  Connector
// ============================================================================

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "USDC", decimals: 6 },
  { symbol: "USDT", decimals: 6 },
];

export class HashKeyChainConnector implements WalletConnector {
  private readonly tokenClient: HashKeyChainTokenClient;
  private readonly agentAccount: PrivateKeyAccount;
  private readonly agentWallet: WalletClient;
  private readonly facilitatorWallet: WalletClient;
  private readonly facilitatorAccount: PrivateKeyAccount;
  private readonly store: InstrumentStore;
  private readonly chain: typeof hashkeyChainTestnet;
  private readonly now: () => number;

  constructor(private readonly config: HashKeyChainConnectorConfig) {
    this.chain = config.chain ?? hashkeyChainTestnet;
    this.now = config.now ?? Date.now;
    this.store = config.instrumentStore;

    // Agent wallet (signer of EIP-712 transferWithAuthorization)
    const agent = createWalletClientFromPrivateKey(
      config.privateKey,
      this.chain,
      config.rpcUrl
    );
    this.agentWallet = agent.wallet;
    this.agentAccount = agent.account;

    // Facilitator wallet (broadcaster — pays gas; defaults to same as agent)
    if (config.facilitatorPrivateKey) {
      const fac = createWalletClientFromPrivateKey(
        config.facilitatorPrivateKey,
        this.chain,
        config.rpcUrl
      );
      this.facilitatorWallet = fac.wallet;
      this.facilitatorAccount = fac.account;
    } else {
      this.facilitatorWallet = this.agentWallet;
      this.facilitatorAccount = this.agentAccount;
    }

    this.tokenClient =
      config.tokenClient ??
      new HashKeyChainTokenClient({
        tokenAddress: config.tokenAddress,
        chain: this.chain,
        ...(config.rpcUrl !== undefined ? { rpcUrl: config.rpcUrl } : {}),
      });
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "HashKey Chain (Self-Custodial)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [HASHKEY_PROTOCOL],
      requiresUserApproval: false, // private key in Secrets Manager → no UI prompt
      settlesOnChain: true,
      typicalLatencyMs: 3500, // empirical: ~3.5s on HashKey Chain Testnet
      features: {
        gasInNativeToken: true,
        instantFinality: false, // L2-style, ~2-3 sec block time
        sandboxAvailable: true,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    // Idempotent: same userId → same instrument
    const existing = await this.store.get(input.userId);
    if (existing) return existing;

    const id = `payment-instrument-hashkey-${input.userId}` as InstrumentId;
    // For self-custodial wallets, the publicHandle = the EVM address.
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.agentAccount.address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        chainId: this.chain.id,
        tokenAddress: this.tokenClient.tokenAddress,
        explorer: this.chain.blockExplorers?.default?.url,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const instrument = await this.requireInstrument(instrumentId);
    const decimals = await this.tokenClient.getDecimals();
    const balanceWei = await this.tokenClient.getBalance(
      instrument.publicHandle as Address
    );
    return {
      instrumentId: instrument.id,
      asset: { symbol: "USDC", decimals },
      money: {
        amountAtomic: balanceWei.toString(),
        decimals,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Sign an EIP-3009 transferWithAuthorization. Produces a SignedAuthorization
   * compatible with x402 / OAP-CEX. Does NOT broadcast.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== HASHKEY_PROTOCOL) {
      throw new Error(
        `HashKeyChainConnector only supports protocol ${HASHKEY_PROTOCOL}, got ${input.request.protocol}`
      );
    }
    const instrument = await this.requireInstrument(input.instrumentId);
    if (instrument.publicHandle !== this.agentAccount.address) {
      throw new Error(
        `Instrument publicHandle ${instrument.publicHandle} does not match agent wallet ${this.agentAccount.address}`
      );
    }

    // Build EIP-3009 authorization
    const authorization: Eip3009Authorization = {
      from: this.agentAccount.address,
      to: input.request.recipient as Address,
      value: input.request.amount.amountAtomic,
      validAfter: input.request.validAfter,
      validBefore: input.request.validBefore,
      nonce: ensureHex32(input.request.nonce),
    };

    const signed = await this.tokenClient.signTransferAuthorization(
      this.agentAccount,
      authorization
    );

    return {
      request: input.request,
      signer: this.agentAccount.address,
      signature: signed.signature,
      // x402 wire payload (base64-encoded); for a real x402 retry we'd encode it
      // as JSON+base64. For now consumers can pull from `extra.signed`.
      extra: {
        signed,
        chainId: this.chain.id,
        verifyingContract: this.tokenClient.tokenAddress,
      },
    };
  }

  /**
   * Broadcast the signed authorization to the chain. Returns SettlementResult
   * with on-chain tx hash + Blockscout link in `raw`.
   */
  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const wireSigned = signed.extra?.["signed"] as Eip3009SignedAuthorization | undefined;
    if (!wireSigned) {
      return {
        success: false,
        network: this.chain.name,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing signed authorization in signed.extra.signed",
      };
    }
    try {
      const txHash = await this.tokenClient.broadcastSignedAuthorization(
        this.facilitatorWallet,
        wireSigned
      );
      const receipt = await this.tokenClient.waitForReceipt(txHash);
      if (receipt.status !== "success") {
        return {
          success: false,
          transactionRef: txHash as TransactionRef,
          network: this.chain.name,
          settledAt: nowIso(this.now()),
          errorCode: "rpc_error",
          errorMessage: `Tx reverted at block ${receipt.blockNumber}`,
          raw: receipt,
        };
      }
      return {
        success: true,
        transactionRef: txHash as TransactionRef,
        network: this.chain.name,
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        raw: {
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          explorerUrl: txExplorerUrl(this.chain, txHash),
        },
      };
    } catch (err) {
      return {
        success: false,
        network: this.chain.name,
        settledAt: nowIso(this.now()),
        errorCode: "rpc_error",
        errorMessage: err instanceof Error ? err.message : String(err),
        raw: err,
      };
    }
  }

  // ---- Public helpers (useful for demos + tests) --------------------------

  get agentAddress(): Address {
    return this.agentAccount.address;
  }

  get facilitatorAddress(): Address {
    return this.facilitatorAccount.address;
  }

  generateNonce(): Hex {
    return generateNonce();
  }

  // ---- Internals ---------------------------------------------------------

  private async requireInstrument(id: InstrumentId): Promise<Instrument> {
    const i = await this.store.getById(id);
    if (!i) {
      throw new Error(`Instrument not found: ${id}`);
    }
    return i;
  }
}

// ============================================================================
//  Helpers
// ============================================================================

function nowIso(t: number): string {
  return new Date(t).toISOString();
}

function ensureHex32(s: string): Hex {
  let v = s.startsWith("0x") ? s : "0x" + s;
  // Pad / truncate to 32 bytes hex (66 chars including 0x)
  if (v.length < 66) {
    v = "0x" + v.slice(2).padStart(64, "0");
  } else if (v.length > 66) {
    v = "0x" + v.slice(2).slice(0, 64);
  }
  return v as Hex;
}

// Avoid Money/Money-related lint warnings about unused symbol via re-export
export type { Money };
