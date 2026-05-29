/**
 * MetaMask Wallet Connector
 * ==========================
 *
 * EIP-1193 Provider-based connector — works with MetaMask, Rabby, Rainbow,
 * Coinbase Wallet (extension), and any browser wallet that exposes
 * `window.ethereum` (or any object with the EIP-1193 `request({method, params})`
 * surface).
 *
 * Settles via x402 protocol (EIP-712 + EIP-3009) like wallet-hashkey, but
 * the user holds the keys in their browser extension — no Secrets Manager.
 *
 * Provider injection: pass any object satisfying `Eip1193Provider` to the
 * constructor. In a browser, you'd pass `window.ethereum`. In tests, you
 * pass an in-memory mock. This keeps the package isomorphic.
 *
 * @license Apache-2.0
 */

import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
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
import {
  createPublicClient,
  custom,
  http,
  parseSignature,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "metamask" as WalletProviderId;
export const METAMASK_PROTOCOL = "x402-v1" as ProtocolId;

// EIP-3009 ERC20 minimal ABI subset (matches wallet-hashkey)
const EIP3009_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

// ============================================================================
//  EIP-1193 minimal interface
// ============================================================================

export interface Eip1193Provider {
  request(args: {
    readonly method: string;
    readonly params?: readonly unknown[] | Record<string, unknown>;
  }): Promise<unknown>;
}

// ============================================================================
//  Configuration
// ============================================================================

export interface MetamaskConnectorConfig {
  /** EIP-1193 provider (window.ethereum / Rabby / Rainbow / mock for tests). */
  readonly provider: Eip1193Provider;
  /** Token contract — Circle USDC on Base / Ethereum / etc. */
  readonly tokenAddress: Address;
  /** Chain definition (viem Chain object). */
  readonly chain: Chain;
  /** RPC URL (used for read-only calls — balanceOf, etc.). */
  readonly rpcUrl?: string;
  /** Storage adapter — DynamoDB in production, in-memory in tests. */
  readonly instrumentStore: InstrumentStore;
  /** Override clock for tests. */
  readonly now?: () => number;
  /** EIP-712 token contract version — Circle USDC uses "2". */
  readonly tokenContractVersion?: string;
  /** Optional: cached account address (skip eth_requestAccounts). */
  readonly cachedAccount?: Address;
}

export interface InstrumentStore {
  get(userId: UserId): Promise<Instrument | undefined>;
  put(instrument: Instrument): Promise<void>;
  getById(id: InstrumentId): Promise<Instrument | undefined>;
}

export class MemoryInstrumentStore implements InstrumentStore {
  private byUser = new Map<string, Instrument>();
  private byId = new Map<string, Instrument>();
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
//  Connector
// ============================================================================

const SUPPORTED_ASSETS: readonly Asset[] = [{ symbol: "USDC", decimals: 6 }];

export class MetamaskConnector implements WalletConnector {
  private readonly publicClient: PublicClient;
  private readonly provider: Eip1193Provider;
  private readonly chain: Chain;
  private readonly tokenAddress: Address;
  private readonly tokenContractVersion: string;
  private readonly store: InstrumentStore;
  private readonly now: () => number;
  private cachedAddress: Address | null;

  constructor(private readonly config: MetamaskConnectorConfig) {
    this.provider = config.provider;
    this.chain = config.chain;
    this.tokenAddress = config.tokenAddress;
    this.tokenContractVersion = config.tokenContractVersion ?? "2";
    this.store = config.instrumentStore;
    this.now = config.now ?? Date.now;
    this.cachedAddress = config.cachedAccount ?? null;
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: config.rpcUrl
        ? http(config.rpcUrl)
        : custom(this.provider as any),
    }) as PublicClient;
  }

  // ---- Capabilities --------------------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "MetaMask (EIP-1193)",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [METAMASK_PROTOCOL],
      requiresUserApproval: true, // browser wallets prompt per signature
      settlesOnChain: true,
      typicalLatencyMs: 8000, // user has to click confirm
      features: {
        selfCustodial: true,
        browserExtension: true,
        userSignsEachTx: true,
      },
    };
  }

  // ---- Account discovery ---------------------------------------------------

  /**
   * Resolve the active wallet address. Calls eth_requestAccounts the first
   * time (which prompts the user to connect in MetaMask) and caches.
   */
  async resolveAddress(): Promise<Address> {
    if (this.cachedAddress) return this.cachedAddress;
    const accounts = (await this.provider.request({
      method: "eth_requestAccounts",
    })) as string[];
    if (!accounts || accounts.length === 0) {
      throw new Error("MetaMask returned no accounts");
    }
    this.cachedAddress = accounts[0]! as Address;
    return this.cachedAddress;
  }

  // ---- WalletConnector contract -------------------------------------------

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    const existing = await this.store.get(input.userId);
    if (existing) return existing;
    const address = await this.resolveAddress();
    const id = `payment-instrument-metamask-${input.userId}` as InstrumentId;
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: address,
      createdAt: nowIso(this.now()),
      providerMetadata: {
        chainId: this.chain.id,
        chainName: this.chain.name,
        tokenAddress: this.tokenAddress,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const inst = await this.requireInstrument(instrumentId);
    const decimals = (await this.publicClient.readContract({
      address: this.tokenAddress,
      abi: EIP3009_ABI,
      functionName: "decimals",
    })) as number;
    const balance = (await this.publicClient.readContract({
      address: this.tokenAddress,
      abi: EIP3009_ABI,
      functionName: "balanceOf",
      args: [inst.publicHandle as Address],
    })) as bigint;
    return {
      instrumentId: inst.id,
      asset: { symbol: "USDC", decimals: Number(decimals) },
      money: {
        amountAtomic: balance.toString(),
        decimals: Number(decimals),
        currency: "USDC",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== METAMASK_PROTOCOL) {
      throw new Error(
        `MetamaskConnector only supports ${METAMASK_PROTOCOL}, got ${input.request.protocol}`
      );
    }
    const inst = await this.requireInstrument(input.instrumentId);
    const from = inst.publicHandle as Address;

    // Read token name on-chain (Circle USDC = "USDC")
    const tokenName = (await this.publicClient.readContract({
      address: this.tokenAddress,
      abi: EIP3009_ABI,
      functionName: "name",
    })) as string;

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
      domain: {
        name: tokenName,
        version: this.tokenContractVersion,
        chainId: this.chain.id,
        verifyingContract: this.tokenAddress,
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from,
        to: input.request.recipient as Address,
        value: input.request.amount.amountAtomic,
        validAfter: String(input.request.validAfter),
        validBefore: String(input.request.validBefore),
        nonce: ensureHex32(input.request.nonce),
      },
    };

    // EIP-712 signing via EIP-1193 provider
    const signature = (await this.provider.request({
      method: "eth_signTypedData_v4",
      params: [from, JSON.stringify(typedData)],
    })) as Hex;

    const { v, r, s } = parseSignature(signature);
    if (v === undefined) {
      throw new Error("parseSignature returned no v");
    }

    return {
      request: input.request,
      signer: from,
      signature,
      extra: {
        chainId: this.chain.id,
        verifyingContract: this.tokenAddress,
        v: Number(v),
        r,
        s,
      },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const v = e["v"] as number | undefined;
    const r = e["r"] as Hex | undefined;
    const s = e["s"] as Hex | undefined;
    if (v == null || !r || !s) {
      return {
        success: false,
        network: this.chain.name,
        settledAt: nowIso(this.now()),
        errorCode: "signature_invalid",
        errorMessage: "Missing v/r/s in signed.extra",
      };
    }

    try {
      // Submit via the EIP-1193 provider (eth_sendTransaction).
      // Note: in browser-mode the user pays gas; alternatively a facilitator
      // can broadcast (provide a separate WalletClient as the broadcaster).
      const account = (signed.signer ?? (await this.resolveAddress())) as Address;
      const data = encodeTransferWithAuth({
        from: signed.signer as Address,
        to: signed.request.recipient as Address,
        value: BigInt(signed.request.amount.amountAtomic),
        validAfter: BigInt(signed.request.validAfter),
        validBefore: BigInt(signed.request.validBefore),
        nonce: ensureHex32(signed.request.nonce),
        v,
        r,
        s,
      });
      const txHash = (await this.provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: account,
            to: this.tokenAddress,
            data,
            value: "0x0",
          },
        ],
      })) as Hex;

      // Wait for receipt
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
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
          explorerUrl: this.chain.blockExplorers?.default?.url
            ? `${this.chain.blockExplorers.default.url}/tx/${txHash}`
            : undefined,
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

  // ---- Helpers -------------------------------------------------------------

  generateNonce(): Hex {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return ("0x" +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")) as Hex;
  }

  private async requireInstrument(id: InstrumentId): Promise<Instrument> {
    const i = await this.store.getById(id);
    if (!i) throw new Error(`Instrument not found: ${id}`);
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
  if (v.length < 66) v = "0x" + v.slice(2).padStart(64, "0");
  else if (v.length > 66) v = "0x" + v.slice(2).slice(0, 64);
  return v as Hex;
}

/**
 * Encode transferWithAuthorization calldata. Pure function — no provider
 * needed. Mirrors viem's encodeFunctionData for the fixed ABI.
 */
function encodeTransferWithAuth(args: {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
}): Hex {
  // Function selector for transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
  // keccak256 selector = 0xe3ee160e (Circle USDC standard)
  const selector = "0xe3ee160e";
  const padHex = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
  return (selector +
    padHex(args.from.toLowerCase()) +
    padHex(args.to.toLowerCase()) +
    padHex(args.value.toString(16)) +
    padHex(args.validAfter.toString(16)) +
    padHex(args.validBefore.toString(16)) +
    args.nonce.replace(/^0x/, "") +
    padHex(args.v.toString(16)) +
    args.r.replace(/^0x/, "") +
    args.s.replace(/^0x/, "")) as Hex;
}
