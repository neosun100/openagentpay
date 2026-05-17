/**
 * Tab 2: How It Works — 8 步全链路图
 *
 * 仿同事 demo 的 How It Works tab，每一步配 OpenAgentPay 的具体说明。
 */

import { useState } from "react";

interface FlowStep {
  num: number;
  title: string;
  short: string;
  detail: string;
}

const STEPS: FlowStep[] = [
  {
    num: 1,
    title: "Agent 发起请求",
    short: "REQUEST",
    detail:
      "AI Agent (Strands + Claude) 在推理循环中决定调用付费工具。请求发送到 AgentCore Runtime，开发者只配置 OpenAgentPayPlugin（与 AgentCorePaymentsPlugin shape 一致）。",
  },
  {
    num: 2,
    title: "工具发现",
    short: "ROUTING",
    detail:
      "AgentCore Gateway 路由 MCP 工具调用。OpenAgentPay 在这一层不做改动——纯复用 AWS 基础设施。",
  },
  {
    num: 3,
    title: "HTTP 402 触发 PaymentManager",
    short: "402",
    detail:
      "付费 endpoint 返回 HTTP 402 + payment payload (amount/recipient/asset/network)。OpenAgentPayPlugin 拦截 402 → 转交 PaymentManager。",
  },
  {
    num: 4,
    title: "PaymentManager 检查预算",
    short: "BUDGET",
    detail:
      "Session.checkAndReserve(amount) 原子操作。budget_exceeded → 硬拒绝。基础设施层确定性执行，不依赖 LLM 判断。",
  },
  {
    num: 5,
    title: "Connector 取凭证",
    short: "CREDS",
    detail:
      "HashKeyChainConnector 从 AWS Secrets Manager + KMS 取出 EVM 私钥。Production 私钥不出 Lambda 执行环境。",
  },
  {
    num: 6,
    title: "EIP-712 签名",
    short: "SIGN",
    detail:
      "构造 EIP-3009 transferWithAuthorization typed data → 私钥本地签名（off-chain，no broadcast）。signature = (v, r, s)。",
  },
  {
    num: 7,
    title: "Facilitator 提交上链",
    short: "PROOF",
    detail:
      "Facilitator EOA 拿签名调 token.transferWithAuthorization() → 链上 ecrecover 验签 → 转账 atomic 完成。Facilitator 付 gas（HSK），Agent 不需要持有 HSK。",
  },
  {
    num: 8,
    title: "Settlement 完成 + 审计",
    short: "DONE",
    detail:
      "tx hash 写入 audit log + 扣减 Session 余额。在 https://testnet-explorer.hsk.xyz/tx/0x... 上 immutable 可查。Agent 收到响应继续推理。",
  },
];

export function HowItWorksTab() {
  const [active, setActive] = useState(1);
  const step = STEPS[active - 1]!;
  return (
    <section className="content">
      <h2>How It Works · 8 步 OpenAgentPay 全链路</h2>
      <p>
        点击任一步骤了解细节。OpenAgentPay 的 8 步与 AWS AgentCore Payments
        the same shape——区别仅在 wallet 层（HashKey 自托管）和链层 (HashKey Chain Testnet)。
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 8 }}>
        <div>
          <div className="flow-grid" style={{ gridTemplateColumns: "1fr" }}>
            {STEPS.map((s) => (
              <div
                key={s.num}
                className={`flow-step ${s.num === active ? "active" : ""}`}
                onClick={() => setActive(s.num)}
              >
                <span className="num-pill">{s.num}</span>
                <h4>{s.title}</h4>
                <p style={{ marginTop: 4, color: "var(--fg-faint)", fontSize: 11, fontFamily: "monospace" }}>
                  {s.short}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--accent)",
              borderRadius: 10,
              padding: 24,
              position: "sticky",
              top: 0,
            }}
          >
            <div style={{ color: "var(--fg-faint)", fontSize: 11, fontFamily: "monospace", marginBottom: 8 }}>
              STEP {step.num} · {step.short}
            </div>
            <h3 style={{ fontSize: 22, marginBottom: 16, color: "var(--accent)" }}>{step.title}</h3>
            <p style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.7 }}>{step.detail}</p>

            {step.num === 6 && (
              <pre style={{ marginTop: 16, fontSize: 11 }}>
{`EIP712Domain(
  string name,
  string version,
  uint256 chainId,
  address verifyingContract
)
TransferWithAuthorization(
  address from,
  address to,
  uint256 value,
  uint256 validAfter,
  uint256 validBefore,
  bytes32 nonce
)`}
              </pre>
            )}
            {step.num === 7 && (
              <pre style={{ marginTop: 16, fontSize: 11 }}>
{`MockUSDC.transferWithAuthorization(
  from, to, value,
  validAfter, validBefore, nonce,
  v, r, s   // EIP-712 sig
);

→ ecrecover(digest, v, r, s) == from
→ balanceOf[from] -= value
→ balanceOf[to]   += value
→ AuthorizationUsed event`}
              </pre>
            )}
            {step.num === 8 && (
              <pre style={{ marginTop: 16, fontSize: 11 }}>
{`Tx hash: 0xff8a175e...51ccbf5
Block:   #27,918,011
Gas:     82,406
Cost:    0.0000000824 HSK

→ Blockscout: https://testnet-explorer.hsk.xyz`}
              </pre>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
