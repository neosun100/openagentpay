/**
 * Tab 3: AI Agent — 真 Strands Agent 自主调用付费 API
 *
 * 这一步是为了视觉对照同事 demo 的 AI Agent tab。
 * 我们不接真实 Strands Agent（Phase G+ 才做），但展示同样的工具集 + 模拟一次 Agent 决策：
 *   - "BTC 行情" → 调 free tool (mock)
 *   - "ETH 深度分析" → 真发起一笔 0.001 USDC 上链
 *   - "减半研报" → 真发起一笔 0.005 USDC 上链
 */

import { useState } from "react";
import { api, type CreateSessionResp } from "./api.js";

interface ChatMsg {
  role: "user" | "agent" | "tool";
  content: string;
}

const TOOLS = [
  { name: "get_market_data", price: "free", desc: "实时价格快照（CoinGecko 模拟）" },
  { name: "buy_market_analysis", price: "$0.001", desc: "AI 技术分析（付费 → 链上结算）" },
  { name: "buy_research_report", price: "$0.005", desc: "深度研报（付费 → 链上结算）" },
];

const PRESETS = [
  { label: "仅免费工具：BTC 行情", price: 0 },
  { label: "付费：ETH 深度分析", price: 0.001 },
  { label: "付费：减半研报", price: 0.005 },
];

export function AiAgentTab({ walletProvider }: { walletProvider: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      role: "agent",
      content:
        "👋 你好！我是 OpenAgentPay AI Trading Assistant。告诉我你想了解什么市场信息——我会自己决定是用免费工具就够，还是值得花一点 USDC 请求付费深度分析。",
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<CreateSessionResp | null>(null);

  async function ensureSession(): Promise<CreateSessionResp> {
    if (session) return session;
    const s = await api.createSession(0.1, 15);
    setSession(s);
    return s;
  }

  async function runPreset(label: string, price: number) {
    if (busy) return;
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: label }]);

    try {
      // Agent decides + calls tools
      if (price === 0) {
        // 免费路径
        await sleep(500);
        setMessages((m) => [
          ...m,
          { role: "agent", content: "好的，调用免费工具 `get_market_data(BTC)`（不消耗 USDC）..." },
        ]);
        await sleep(800);
        setMessages((m) => [
          ...m,
          {
            role: "tool",
            content:
              "tool.result: { symbol: BTC, price_usd: 78371, change_24h_pct: 0.4, volume: 19.9B, source: coingecko-mock }",
          },
        ]);
        await sleep(500);
        setMessages((m) => [
          ...m,
          {
            role: "agent",
            content:
              "📊 BTC 当前 **$78,371**（24h +0.4%，成交 $19.9B）。免费工具够用，没动钱包。",
          },
        ]);
      } else {
        // 付费路径
        await sleep(500);
        setMessages((m) => [
          ...m,
          {
            role: "agent",
            content: `这条问题需要付费工具。我先确认 session 预算 → 签名 → 上链结算 ${price} USDC...`,
          },
        ]);
        const s = await ensureSession();
        setMessages((m) => [
          ...m,
          { role: "tool", content: `Session: ${s.sessionId.slice(0, 30)}… budget=$${s.budgetUsd}` },
        ]);

        // 真发起一笔上链
        const result = await api.pay(s.sessionId, price, walletProvider);
        if (result.success) {
          setMessages((m) => [
            ...m,
            {
              role: "tool",
              content: `✅ Settlement on ${result.network ?? "chain"}:\n  tx: ${result.txHash}\n  gas: ${result.settleResult.gasUsed}\n  block: ${result.settleResult.blockNumber}\n  ${result.explorerUrl}`,
            },
          ]);
          await sleep(500);
          setMessages((m) => [
            ...m,
            {
              role: "agent",
              content:
                price === 0.001
                  ? "📈 ETH 当前深度分析：30d 累计 +12%，链上活跃地址增 8%，gas 中位数 18 gwei。技术面破 4-week 阻力，短期看涨。**已扣除 0.001 USDC，链上可查**。"
                  : "📰 比特币 4 周减半研报：减半后矿工成本 +28%，hash rate 创新高，机构持仓占比提升至 13.2%。详细图表已生成。**已扣除 0.005 USDC，链上可查**。",
            },
          ]);
        } else {
          setMessages((m) => [
            ...m,
            {
              role: "tool",
              content: `❌ Settlement failed: ${result.errorCode} ${result.errorMessage}`,
            },
            {
              role: "agent",
              content: `抱歉，付费工具调用失败：${result.errorMessage}。我可以继续用免费工具尝试帮你。`,
            },
          ]);
        }
      }
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "tool", content: `❌ Error: ${(e as Error).message}` },
      ]);
    }
    setBusy(false);
  }

  return (
    <section className="content">
      <h2>AI Trading Assistant</h2>
      <p>
        模拟 Strands Agent + Claude Sonnet 在 AgentCore Runtime 里自主决策、自主付费。
        免费工具直接用，付费工具触发 真实链上结算（按 Wallet Provider 路由）。
      </p>

      <div className="agent-panel">
        <div>
          <h3 style={{ fontSize: 13, marginBottom: 12, color: "var(--fg-dim)" }}>Agent 拥有的工具：</h3>
          <div className="agent-tools">
            {TOOLS.map((t) => (
              <div key={t.name} className="agent-tool">
                <div className="name">{t.name}</div>
                <span className="price">{t.price}</span>
                <div className="desc">{t.desc}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="chat">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <pre style={{ background: "transparent", border: "none", padding: 0, fontSize: "inherit", whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
                {m.content}
              </pre>
            </div>
          ))}
          {busy && <div className="msg agent">⏳ Thinking...</div>}
        </div>

        <div>
          <div className="preset-buttons" style={{ marginBottom: 8 }}>
            {PRESETS.map((p) => (
              <button key={p.label} onClick={() => runPreset(p.label, p.price)} disabled={busy}>
                {p.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>
            💡 点击预设按钮触发 Agent 决策。免费按钮零成本；付费按钮真实在 HashKey Chain 上结算。
            {session && <> · session: <code>{session.sessionId.slice(0, 24)}…</code></>}
          </div>
        </div>
      </div>
    </section>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
