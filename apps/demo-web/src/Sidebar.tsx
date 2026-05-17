import { useEffect, useState } from "react";
import { api, type WalletStatus } from "./api.js";

export interface SidebarProps {
  walletProvider: string;
  chain: string;
  onWalletChange: (v: string) => void;
}

export function Sidebar({ walletProvider, chain, onWalletChange }: SidebarProps) {
  const [wallet, setWallet] = useState<WalletStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .wallet()
      .then(setWallet)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <aside className="sidebar">
      <h3>Wallet Provider</h3>
      <div className="card">
        <select
          value={walletProvider}
          onChange={(e) => onWalletChange(e.target.value)}
          style={{ width: "100%" }}
        >
          <option value="hashkey-chain">HashKey Chain (Self-Custodial)</option>
          <option value="coinbase-cdp" disabled>
            Coinbase CDP (path D — coming)
          </option>
          <option value="stripe-privy" disabled>
            Stripe Privy (path D — coming)
          </option>
          <option value="binance-pay" disabled>
            Binance Pay (OAP-CEX — v0.2)
          </option>
        </select>
        <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 8, lineHeight: 1.5 }}>
          OpenAgentPay 路径 D：当前 demo 走 HashKey 自托管 EVM 钱包；后续接通
          AgentCore Payments 原版作 Coinbase/Stripe 的对照路径。
        </div>
      </div>

      <h3>Network</h3>
      <div className="card">
        <div className="row">
          <span className="label">Chain</span>
          <span className="value">{chain}</span>
        </div>
        <div className="row">
          <span className="label">Chain ID</span>
          <span className="value">133</span>
        </div>
        <div className="row">
          <span className="label">Token</span>
          <span className="value">{wallet?.token ?? "USDC"}</span>
        </div>
      </div>

      <h3>Wallet Status</h3>
      <div className="card">
        {error && <div style={{ color: "var(--red)", fontSize: 12 }}>❌ {error}</div>}
        {!wallet && !error && <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>Loading...</div>}
        {wallet && (
          <>
            <div className="row">
              <span className="label">Address</span>
              <a className="value" href={wallet.addressExplorer} target="_blank" rel="noreferrer">
                {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
              </a>
            </div>
            <div className="row">
              <span className="label">Balance</span>
              <span className="value" style={{ color: "var(--green)", fontWeight: 600 }}>
                {wallet.balance.toFixed(2)} {wallet.token}
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
{`Browser
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
(Chain ID 133)`}
        </pre>
      </div>

      <h3>Reference</h3>
      <div className="card" style={{ fontSize: 11 }}>
        <a href="https://testnet-explorer.hsk.xyz" target="_blank" rel="noreferrer">
          Blockscout Explorer
        </a>
        <br />
        <a href="https://docs.hsk.xyz" target="_blank" rel="noreferrer">
          HashKey Chain Docs
        </a>
        <br />
        <a href="https://github.com/coinbase/x402" target="_blank" rel="noreferrer">
          x402 Protocol
        </a>
      </div>
    </aside>
  );
}
