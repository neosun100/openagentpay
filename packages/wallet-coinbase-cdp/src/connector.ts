/**
 * CoinbaseCDPConnector — OpenAgentPay WalletConnector for Coinbase CDP V2
 * managed wallets on Base Sepolia testnet (with Circle official USDC).
 *
 * Path-D hybrid: pairs with HashKeyChainConnector to demonstrate that
 * the OpenAgentPay framework supports both Asia (HashKey) and NA (Coinbase)
 * EVM wallets through the same WalletConnector interface.
 *
 * @license Apache-2.0
 */
import { CdpClient } from "@coinbase/cdp-sdk";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type {
  Asset,
  Balance,
  CreateInstrumentInput,
  Instrument,
  InstrumentId,
  PaymentRequest,
  ProtocolId,
  SettlementResult,
  SignAuthorizationInput,
  SignedAuthorization,
  TransactionRef,
  UserId,
  WalletCapabilities,
  WalletConnector,
  WalletProviderId,
} from "@openagentpay/core";
import {
  BASE_SEPOLIA_CHAIN,
  BASE_SEPOLIA_USDC_ADDRESS,
  USDC_DECIMALS,
  USDC_EIP712_DOMAIN,
} from "./chain.js";

// ============================================================================
//  Constants
// ============================================================================
export const WALLET_PROVIDER_ID = "coinbase-cdp" as WalletProviderId;
export const COINBASE_CDP_PROTOCOL: ProtocolId = "x402-v1" as ProtocolId;
const NETWORK_NAME = "base-sepolia";
const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "USDC", decimals: USDC_DECIMALS },
];

const ERC20_BALANCE_OF_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);
const TRANSFER_WITH_AUTH_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

// ============================================================================
//  InstrumentStore
// ============================================================================
export interface InstrumentStore {
  get(userId: UserId): Promise<Instrument | undefined>;
  put(instrument: Instrument): Promise<void>;
  getById(instrumentId: InstrumentId): Promise<Instrument | undefined>;
}

export class MemoryInstrumentStore implements InstrumentStore {
  private byUser = new Map<UserId, Instrument>();
  private byId = new Map<InstrumentId, Instrument>();
  async get(userId: UserId) {
    return this.byUser.get(userId);
  }
  async put(instrument: Instrument) {
    this.byUser.set(instrument.userId, instrument);
    this.byId.set(instrument.id, instrument);
  }
  async getById(id: InstrumentId) {
    return this.byId.get(id);
  }
}

// ============================================================================
//  Config
// ============================================================================
export interface CoinbaseCDPConnectorConfig {
  readonly apiKeyId: string;
  readonly apiKeySecret: string;
  readonly walletSecret: string;
  /** CDP-managed account address (created via cdp.evm.createAccount) */
  readonly agentAddress: Address;
  /** Optional CDP account name (used with cdp.evm.getAccount lookup) */
  readonly agentAccountName?: string;
  /** Demo recipient (merchant) address — defaults to a 0xdEaD test address */
  readonly recipientAddress?: Address;
  /** RPC URL override (defaults to Base Sepolia public RPC) */
  readonly rpcUrl?: string;
  readonly instrumentStore: InstrumentStore;
  /** Override clock — for tests */
  readonly now?: () => number;
}

// ============================================================================
//  CoinbaseCDPConnector
// ============================================================================
export class CoinbaseCDPConnector implements WalletConnector {
  private readonly cdp: CdpClient;
  private readonly publicClient: PublicClient;
  private readonly store: InstrumentStore;
  private readonly now: () => number;
  private readonly recipient: Address;
  private cdpAccount: any; // CDP EvmServerAccount (lazy)

  constructor(private readonly config: CoinbaseCDPConnectorConfig) {
    this.cdp = new CdpClient({
      apiKeyId: config.apiKeyId,
      apiKeySecret: config.apiKeySecret,
      walletSecret: config.walletSecret,
    });
    this.publicClient = createPublicClient({
      chain: BASE_SEPOLIA_CHAIN,
      transport: http(
        config.rpcUrl ?? BASE_SEPOLIA_CHAIN.rpcUrls.default.http[0]
      ),
    }) as PublicClient;
    this.store = config.instrumentStore;
    this.now = config.now ?? (() => Date.now());
    this.recipient =
      config.recipientAddress ??
      ("0x000000000000000000000000000000000000dEaD" as Address);
  }

  /** Lazy-load the CDP-managed account */
  private async ensureAccount() {
    if (this.cdpAccount) return this.cdpAccount;
    if (this.config.agentAccountName) {
      this.cdpAccount = await this.cdp.evm.getAccount({
        name: this.config.agentAccountName,
      });
    } else {
      this.cdpAccount = await this.cdp.evm.getAccount({
        address: this.config.agentAddress,
      });
    }
    return this.cdpAccount;
  }

  // ----------- WalletConnector interface -----------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Coinbase CDP (Custodial)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [COINBASE_CDP_PROTOCOL],
      requiresUserApproval: false, // CDP is managed — no UI prompt per call
      settlesOnChain: true,
      typicalLatencyMs: 4000, // empirical: ~4s on Base Sepolia
      features: {
        managedWallet: true,
        gasIncluded: true, // CDP pays gas from same account
        sandboxAvailable: true,
        circleUSDC: true, // production-grade USDC, not mock
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    const existing = await this.store.get(input.userId);
    if (existing) return existing;

    const id = `payment-instrument-coinbase-cdp-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.config.agentAddress,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        chainId: BASE_SEPOLIA_CHAIN.id,
        chainName: NETWORK_NAME,
        tokenAddress: BASE_SEPOLIA_USDC_ADDRESS,
        explorer: BASE_SEPOLIA_CHAIN.blockExplorers?.default?.url,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const raw = (await (this.publicClient as any).readContract({
      address: BASE_SEPOLIA_USDC_ADDRESS,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [inst.publicHandle as Address],
    })) as bigint;

    return {
      instrumentId: inst.id,
      asset: { symbol: "USDC", decimals: USDC_DECIMALS },
      money: {
        amountAtomic: raw.toString(),
        decimals: USDC_DECIMALS,
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== COINBASE_CDP_PROTOCOL) {
      throw new Error(
        `CoinbaseCDPConnector only supports ${COINBASE_CDP_PROTOCOL}, got ${input.request.protocol}`
      );
    }

    const account = await this.ensureAccount();
    const inst = await this.requireInstrument(input.instrumentId);
    if (inst.publicHandle !== account.address) {
      throw new Error(
        `Instrument publicHandle ${inst.publicHandle} does not match CDP account ${account.address}`
      );
    }

    const valueAtomic = BigInt(input.request.amount.amountAtomic);
    const validAfter = BigInt(input.request.validAfter);
    const validBefore = BigInt(input.request.validBefore);

    const typedData = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      domain: USDC_EIP712_DOMAIN,
      primaryType: "TransferWithAuthorization" as const,
      message: {
        from: account.address as Address,
        to: input.request.recipient as Address,
        value: valueAtomic,
        validAfter,
        validBefore,
        nonce: input.request.nonce as Hex,
      },
    };

    // CDP signs (private key never leaves CDP TEE)
    const signature: string = await account.signTypedData(typedData);

    // Parse v/r/s for on-chain submission
    const sig = signature.slice(2);
    const r = ("0x" + sig.slice(0, 64)) as Hex;
    const s = ("0x" + sig.slice(64, 128)) as Hex;
    const v = parseInt(sig.slice(128, 130), 16);

    return {
      request: input.request,
      signer: account.address,
      signature,
      extra: {
        chainId: BASE_SEPOLIA_CHAIN.id,
        verifyingContract: BASE_SEPOLIA_USDC_ADDRESS,
        v,
        r,
        s,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const account = await this.ensureAccount();
    const v = signed.extra?.["v"] as number | undefined;
    const r = signed.extra?.["r"] as Hex | undefined;
    const s = signed.extra?.["s"] as Hex | undefined;

    if (v == null || !r || !s) {
      return {
        success: false,
        network: NETWORK_NAME,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing v/r/s in signed.extra",
      };
    }

    try {
      const data = encodeFunctionData({
        abi: TRANSFER_WITH_AUTH_ABI,
        functionName: "transferWithAuthorization",
        args: [
          signed.signer as Address,
          signed.request.recipient as Address,
          BigInt(signed.request.amount.amountAtomic),
          BigInt(signed.request.validAfter),
          BigInt(signed.request.validBefore),
          signed.request.nonce as Hex,
          v,
          r,
          s,
        ],
      });

      const sendResult = await account.sendTransaction({
        network: NETWORK_NAME,
        transaction: {
          to: BASE_SEPOLIA_USDC_ADDRESS,
          data,
          value: BigInt(0),
        },
      });

      const txHash = sendResult.transactionHash as Hex;
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      if (receipt.status !== "success") {
        return {
          success: false,
          transactionRef: txHash as TransactionRef,
          network: NETWORK_NAME,
          settledAt: nowIso(this.now()),
          errorCode: "rpc_error",
          errorMessage: `Tx reverted at block ${receipt.blockNumber}`,
          raw: receipt,
        };
      }

      return {
        success: true,
        transactionRef: txHash as TransactionRef,
        network: NETWORK_NAME,
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        raw: {
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
        },
      };
    } catch (err) {
      return {
        success: false,
        network: NETWORK_NAME,
        settledAt: nowIso(this.now()),
        errorCode: "rpc_error",
        errorMessage: err instanceof Error ? err.message : String(err),
        raw: err,
      };
    }
  }

  // ----------- Public helpers -----------

  get agentAddress(): Address {
    return this.config.agentAddress;
  }

  generateNonce(): Hex {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return ("0x" +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")) as Hex;
  }

  // ----------- Internals -----------

  private async requireInstrument(id: InstrumentId): Promise<Instrument> {
    const i = await this.store.getById(id);
    if (!i) throw new Error(`Instrument not found: ${id}`);
    return i;
  }
}

function nowIso(t: number): string {
  return new Date(t).toISOString();
}
