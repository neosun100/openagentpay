import { useState } from "react";
import { ActivityLog } from "./ActivityLog.js";
import { Sidebar } from "./Sidebar.js";
import { RunDemoTab } from "./RunDemoTab.js";
import { HowItWorksTab } from "./HowItWorksTab.js";
import { AiAgentTab } from "./AiAgentTab.js";

type TabId = "run" | "how" | "agent";

export function App() {
  const [tab, setTab] = useState<TabId>("run");
  const [walletProvider, setWalletProvider] = useState("hashkey-chain");

  return (
    <div className="app">
      <header className="banner">
        <div className="title">
          <span style={{ fontSize: 18 }}>🌐</span>
          <h1>OpenAgentPay</h1>
          <span className="live-badge">Live · HashKey Chain Testnet</span>
        </div>
        <div className="switcher">
          <span style={{ fontSize: 12, color: "var(--fg-dim)" }}>
            Demo · 路径 D 混合方案 · {walletProvider}
          </span>
          <a
            href="https://github.com/neosun100/openAgentPay"
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 12 }}
          >
            GitHub →
          </a>
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === "run" ? "active" : ""} onClick={() => setTab("run")}>
          Run Demo
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>4 步链上结算</div>
        </button>
        <button className={tab === "how" ? "active" : ""} onClick={() => setTab("how")}>
          How It Works
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>8 步全链路</div>
        </button>
        <button className={tab === "agent" ? "active" : ""} onClick={() => setTab("agent")}>
          AI Agent
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>Strands 自主付费</div>
        </button>
      </nav>

      <main>
        <Sidebar
          walletProvider={walletProvider}
          chain="HashKey Chain Testnet"
          onWalletChange={setWalletProvider}
        />
        {tab === "run" && <RunDemoTab />}
        {tab === "how" && <HowItWorksTab />}
        {tab === "agent" && <AiAgentTab />}
      </main>

      <ActivityLog />
    </div>
  );
}
