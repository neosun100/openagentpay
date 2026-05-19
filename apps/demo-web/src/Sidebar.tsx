import { useEffect, useState } from "react";
import { api, type WalletStatus, type WalletEntry } from "./api.js";

export interface SidebarProps {
  walletProvider: string;
  onWalletChange: (v: string) => void;
}

export function Sidebar({ walletProvider, onWalletChange }: SidebarProps) {
  const [wallet, setWallet] = useState<WalletStatus | null>(null);
  const [walletList, setWalletList] = useState<WalletEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Fetch list of available wallets on mount
  useEffect(() => {
    api
      .wallets()
      .then((resp) => setWalletList(resp.wallets))
      .catch((e: Error) =>
        console.warn("Failed to fetch wallet list:", e.message)
      );
  }, []);

  // Re-fetch wallet status whenever provider changes
  useEffect(() => {
    setWallet(null);
    setError(null);
    api
      .wallet(walletProvider)
      .then(setWallet)
      .catch((e: Error) => setError(e.message));
  }, [walletProvider]);

  // Determine architecture flow text by provider
  const flowText =
    walletProvider === "coinbase-cdp"
      ? `Browser
   │
   ▼
Express /api/*
   │
   ▼
PaymentManager
   │
   ▼
CoinbaseCDPConnector
   │
   ▼  (CDP SDK)
Coinbase TEE
   │
   ▼
Base Sepolia
(Chain ID 84532)`
      : `Browser
   │
   ▼
Express /api/*
   │
   ▼
PaymentManager
   │
   ▼
HashKeyChainConnector
   │
   ▼
HashKey Chain Testnet
(Chain ID 133)`;

  const isCoinbase = walletProvider === "coinbase-cdp";

  return (
    <aside className="sidebar">
      <h3>Wallet Provider</h3>
      <div className="card">
        <select
          value={walletProvider}
          onChange={(e) => onWalletChange(e.target.value)}
          style={{ width: "100%" }}
        >
          {walletList.length > 0 ? (
            walletList.map((w) => (
              <option key={w.walletProvider} value={w.walletProvider}>
                {w.displayName} · {w.chainName}
              </option>
            ))
          ) : (
            <>
              <option value="hashkey-chain">HashKey Chain (Self-Custodial)</option>
              <option value="coinbase-cdp">Coinbase CDP (Custodial)</option>
            </>
          )}
          <option value="stripe-privy" disabled>
            Stripe Privy (path D — coming)
          </option>
          <option value="binance-pay" disabled>
            Binance Pay (OAP-CEX — v0.2)
          </option>
        </select>
        <div
          style={{
            fontSize: 11,
            color: "var(--fg-dim)",
            marginTop: 8,
            lineHeight: 1.5,
          }}
        >
          OpenAgentPay 路径 D 混合：HashKey Chain（亚洲，MockUSDC）+ Coinbase CDP
          （北美，Circle 官方 USDC on Base Sepolia）—— 共享同一个
          WalletConnector 接口，Framework-agnostic 切换。
        </div>
      </div>

      <h3>Network</h3>
      <div className="card">
        <div className="row">
          <span className="label">Chain</span>
          <span className="value">{wallet?.network ?? "—"}</span>
        </div>
        <div className="row">
          <span className="label">Chain ID</span>
          <span className="value">{wallet?.chainId ?? "—"}</span>
        </div>
        <div className="row">
          <span className="label">Token</span>
          <span className="value">
            {wallet?.tokenLabel ?? wallet?.token ?? "USDC"}
          </span>
        </div>
      </div>

      <h3>Wallet Status</h3>
      <div className="card">
        {error && (
          <div style={{ color: "var(--red)", fontSize: 12 }}>❌ {error}</div>
        )}
        {!wallet && !error && (
          <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>Loading...</div>
        )}
        {wallet && (
          <>
            <div className="row">
              <span className="label">Address</span>
              <a
                className="value"
                href={wallet.addressExplorer}
                target="_blank"
                rel="noreferrer"
              >
                {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
              </a>
            </div>
            <div className="row">
              <span className="label">Balance</span>
              <span
                className="value"
                style={{ color: "var(--green)", fontWeight: 600 }}
              >
                {wallet.balance.toFixed(isCoinbase ? 4 : 2)} {wallet.token}
              </span>
            </div>
            <div className="row">
              <span className="label">Contract</span>
              <a
                className="value"
                href={wallet.tokenExplorer}
                target="_blank"
                rel="noreferrer"
                title={wallet.tokenAddress}
              >
                {wallet.tokenAddress.slice(0, 6)}…{wallet.tokenAddress.slice(-4)}
              </a>
            </div>
            <div className="row">
              <span className="label">Instrument</span>
              <span className="value" style={{ fontSize: 10 }}>
                {wallet.instrumentId.slice(0, 24)}…
              </span>
            </div>
          </>
        )}
      </div>

      <h3>Architecture</h3>
      <div className="card">
        <pre style={{ fontSize: 10, padding: 8, overflow: "hidden" }}>
          {flowText}
        </pre>
      </div>

      <h3>Reference</h3>
      <div className="card" style={{ fontSize: 11 }}>
        {isCoinbase ? (
          <>
            <a
              href="https://sepolia.basescan.org"
              target="_blank"
              rel="noreferrer"
            >
              Basescan Sepolia
            </a>
            <br />
            <a
              href="https://docs.cdp.coinbase.com"
              target="_blank"
              rel="noreferrer"
            >
              Coinbase CDP Docs
            </a>
            <br />
            <a
              href="https://www.circle.com/usdc"
              target="_blank"
              rel="noreferrer"
            >
              Circle USDC
            </a>
          </>
        ) : (
          <>
            <a
              href="https://testnet-explorer.hsk.xyz"
              target="_blank"
              rel="noreferrer"
            >
              Blockscout Explorer
            </a>
            <br />
            <a href="https://docs.hsk.xyz" target="_blank" rel="noreferrer">
              HashKey Chain Docs
            </a>
            <br />
            <a
              href="https://github.com/coinbase/x402"
              target="_blank"
              rel="noreferrer"
            >
              x402 Protocol
            </a>
          </>
        )}
      </div>
    </aside>
  );
}
