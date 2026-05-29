/**
 * WalletConnect v2 Connector
 * ===========================
 *
 * Wraps a WalletConnect v2 EthereumProvider as an EIP-1193 surface,
 * which we then funnel into the same MetamaskConnector logic. This is
 * how 200+ mobile wallets (Trust, Rainbow, OKX Wallet mobile, MetaMask
 * mobile, ImToken, BitKeep, ...) all become free at the WalletConnector
 * abstraction.
 *
 * Pattern: WalletConnect EthereumProvider implements EIP-1193 — same
 * `request({method, params})` shape as `window.ethereum`. We just
 * re-export MetamaskConnector with a different walletProvider id and
 * displayName.
 *
 * @license Apache-2.0
 */

import type {
  Asset,
  Balance,
  CreateInstrumentInput,
  Instrument,
  InstrumentId,
  ProtocolId,
  SettlementResult,
  SignAuthorizationInput,
  SignedAuthorization,
  WalletCapabilities,
  WalletConnector,
  WalletProviderId,
} from "@openagentpay/core";
import {
  MetamaskConnector,
  type Eip1193Provider,
  type MetamaskConnectorConfig,
  type InstrumentStore,
  MemoryInstrumentStore,
} from "@openagentpay/wallet-metamask";

// ============================================================================
//  Constants
// ============================================================================

export const WALLET_PROVIDER_ID = "walletconnect" as WalletProviderId;
export const WC_PROTOCOL = "x402-v1" as ProtocolId;

// Re-export so consumers can build a store without separate import
export { MemoryInstrumentStore };
export type { InstrumentStore, Eip1193Provider };

// ============================================================================
//  Configuration
// ============================================================================

export interface WalletConnectConnectorConfig extends Omit<MetamaskConnectorConfig, "provider"> {
  /**
   * WalletConnect v2 EthereumProvider (or compatible EIP-1193 wrapper).
   * Construct outside this package (different SDK versions). Must support:
   *   - request({ method: 'eth_requestAccounts' })
   *   - request({ method: 'eth_signTypedData_v4', params: [from, json] })
   *   - request({ method: 'eth_sendTransaction', params: [...] })
   *
   * Optional `connect()` triggers WC pairing (QR / deep-link); we call it
   * lazily on first use.
   */
  readonly wcProvider: Eip1193Provider & {
    readonly connect?: () => Promise<unknown>;
  };
  /**
   * Optional metadata to surface in capabilities — e.g., the user's chosen
   * peer wallet name ("Rainbow", "Trust").
   */
  readonly peerWalletName?: string;
}

const SUPPORTED_ASSETS: readonly Asset[] = [{ symbol: "USDC", decimals: 6 }];

// ============================================================================
//  Connector — thin wrapper over MetamaskConnector with WC-specific metadata
// ============================================================================

export class WalletConnectConnector implements WalletConnector {
  private readonly inner: MetamaskConnector;
  private readonly peerWalletName: string;
  private readonly providerHasConnect: boolean;
  private connectInvoked = false;

  constructor(private readonly cfg: WalletConnectConnectorConfig) {
    const innerCfg: MetamaskConnectorConfig = {
      provider: cfg.wcProvider,
      tokenAddress: cfg.tokenAddress,
      chain: cfg.chain,
      instrumentStore: cfg.instrumentStore,
      ...(cfg.rpcUrl !== undefined ? { rpcUrl: cfg.rpcUrl } : {}),
      ...(cfg.now !== undefined ? { now: cfg.now } : {}),
      ...(cfg.tokenContractVersion !== undefined
        ? { tokenContractVersion: cfg.tokenContractVersion }
        : {}),
      ...(cfg.cachedAccount !== undefined
        ? { cachedAccount: cfg.cachedAccount }
        : {}),
    };
    this.inner = new MetamaskConnector(innerCfg);
    this.peerWalletName = cfg.peerWalletName ?? "WalletConnect peer";
    this.providerHasConnect = typeof cfg.wcProvider.connect === "function";
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    const inner = this.inner.getCapabilities();
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: `WalletConnect (${this.peerWalletName})`,
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [WC_PROTOCOL],
      requiresUserApproval: true,
      settlesOnChain: true,
      typicalLatencyMs: inner.typicalLatencyMs ?? 12000, // mobile wallets are slower
      features: {
        ...inner.features,
        walletconnect: true,
        protocolVersion: 2,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    await this.ensureConnected();
    const inst = await this.inner.createInstrument(input);
    return {
      ...inst,
      walletProvider: WALLET_PROVIDER_ID,
      providerMetadata: {
        ...(inst.providerMetadata ?? {}),
        peerWallet: this.peerWalletName,
        walletconnectVersion: 2,
      },
    };
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    return this.inner.getBalance(instrumentId);
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    await this.ensureConnected();
    return this.inner.signAuthorization(input);
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    return this.inner.settle(signed);
  }

  // ---- Public helpers ------------------------------------------------------

  generateNonce() {
    return this.inner.generateNonce();
  }

  async resolveAddress() {
    await this.ensureConnected();
    return this.inner.resolveAddress();
  }

  // ---- Internals -----------------------------------------------------------

  /** Lazily call provider.connect() (triggers QR / deep-link) once. */
  private async ensureConnected(): Promise<void> {
    if (this.connectInvoked || !this.providerHasConnect) return;
    this.connectInvoked = true;
    await this.cfg.wcProvider.connect!();
  }
}
