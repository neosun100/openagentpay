/**
 * Tab 1: Run Demo — 4 步手动跑链上结算
 *
 * 仿同事 demo 的 Run Demo tab，但跑在 HashKey Chain Testnet：
 *   Step 1: 查询钱包余额        → GET /api/wallet
 *   Step 2: 创建 Payment Session → POST /api/session
 *   Step 3: 模拟 402 + 签名 + 上链 → POST /api/pay
 *   Step 4: 查询 Session 消费    → GET /api/session/:id
 */

import { useState } from "react";
import { api, type CreateSessionResp, type PayResp, type SessionStatus, type WalletStatus } from "./api.js";

interface StepState {
  status: "idle" | "running" | "success" | "error";
  result?: unknown;
  error?: string;
}

export function RunDemoTab({ walletProvider }: { walletProvider: string }) {
  const [budget, setBudget] = useState(1.0);
  const [expiry, setExpiry] = useState(60);
  const [amount, setAmount] = useState(0.1);

  const [step1, setStep1] = useState<StepState>({ status: "idle" });
  const [step2, setStep2] = useState<StepState>({ status: "idle" });
  const [step3, setStep3] = useState<StepState>({ status: "idle" });
  const [step4, setStep4] = useState<StepState>({ status: "idle" });

  const session = step2.result as CreateSessionResp | undefined;
  const wallet = step1.result as WalletStatus | undefined;
  const pay = step3.result as PayResp | undefined;

  async function runStep1() {
    setStep1({ status: "running" });
    try {
      const r = await api.wallet(walletProvider);
      setStep1({ status: "success", result: r });
    } catch (e) {
      setStep1({ status: "error", error: (e as Error).message });
    }
  }

  async function runStep2() {
    setStep2({ status: "running" });
    try {
      const r = await api.createSession(budget, expiry);
      setStep2({ status: "success", result: r });
    } catch (e) {
      setStep2({ status: "error", error: (e as Error).message });
    }
  }

  async function runStep3() {
    if (!session) return;
    setStep3({ status: "running" });
    try {
      const r = await api.pay(session.sessionId, amount, walletProvider);
      setStep3({ status: r.success ? "success" : "error", result: r, ...(r.success ? {} : { error: r.errorMessage }) });
    } catch (e) {
      setStep3({ status: "error", error: (e as Error).message });
    }
  }

  async function runStep4() {
    if (!session) return;
    setStep4({ status: "running" });
    try {
      const r = await api.getSession(session.sessionId);
      setStep4({ status: "success", result: r });
    } catch (e) {
      setStep4({ status: "error", error: (e as Error).message });
    }
  }

  return (
    <section className="content">
      <h2>Run the demo, step by step</h2>
      <p>
        每一步背后我们的扩展层在 HashKey Chain Testnet 上做了什么 ·
        协议层与 AWS AgentCore Payments / Base Sepolia 路径完全对等。
      </p>

      {/* Step 1 */}
      <div className="step">
        <div className="step-num">1</div>
        <div className="step-body">
          <h3>查询 Agent 钱包余额</h3>
          <p className="step-desc">
            通过 PaymentInstrument 直接读 HashKey Chain 上 USDC 余额（不用连 RPC、不用管私钥）。
          </p>
          <button onClick={runStep1} disabled={step1.status === "running"}>
            {step1.status === "running" ? "Running..." : "Run"}
          </button>
          {step1.status === "success" && wallet && (
            <div className="step-result success">
              <strong>Address:</strong> {wallet.address}
              {"\n"}
              <strong>Balance:</strong> {wallet.balance} {wallet.token}
              {"\n"}
              <strong>Network:</strong> {wallet.network}
              {"\n"}
              <strong>Token:</strong>{" "}
              <a href={wallet.tokenExplorer} target="_blank" rel="noreferrer">
                {wallet.tokenAddress}
              </a>
            </div>
          )}
          {step1.status === "error" && <div className="step-result error">❌ {step1.error}</div>}
        </div>
      </div>

      {/* Step 2 */}
      <div className="step">
        <div className="step-num">2</div>
        <div className="step-body">
          <h3>创建 Payment Session</h3>
          <p className="step-desc">
            设定预算上限 + 过期时间。预算耗尽后 Agent 无法继续支付（防失控）。
          </p>
          <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: "var(--fg-dim)" }}>
              Budget (USD){" "}
              <input
                type="number"
                step="0.1"
                min="0.1"
                max="10"
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
                style={{ width: 80 }}
              />
            </label>
            <label style={{ fontSize: 12, color: "var(--fg-dim)" }}>
              Expiry (min){" "}
              <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
                <option value={15}>15</option>
                <option value={60}>60</option>
                <option value={240}>240</option>
                <option value={480}>480</option>
              </select>
            </label>
          </div>
          <button onClick={runStep2} disabled={step2.status === "running"}>
            {step2.status === "running" ? "Running..." : "Run"}
          </button>
          {step2.status === "success" && session && (
            <div className="step-result success">
              <strong>Session ID:</strong> {session.sessionId}
              {"\n"}
              <strong>Budget:</strong> ${session.budgetUsd.toFixed(2)}
              {"\n"}
              <strong>Expires:</strong> {session.expiresAt}
            </div>
          )}
          {step2.status === "error" && <div className="step-result error">❌ {step2.error}</div>}
        </div>
      </div>

      {/* Step 3 */}
      <div className="step">
        <div className="step-num">3</div>
        <div className="step-body">
          <h3>模拟 402 → EIP-712 签名 → 上链结算</h3>
          <p className="step-desc">
            这是核心步骤：构造 PaymentRequest → checkAndReserve → signAuthorization (EIP-712) →
            settle (broadcast 到 HashKey Chain) → commit。**链上交易 Blockscout 实时可查**。
          </p>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: "var(--fg-dim)" }}>
              Amount (USDC){" "}
              <input
                type="number"
                step="0.001"
                min="0.001"
                max="1"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                style={{ width: 100 }}
              />
            </label>
          </div>
          <button onClick={runStep3} disabled={!session || step3.status === "running"}>
            {step3.status === "running" ? "Settling on-chain (~5s)..." : `Pay ${amount} USDC`}
          </button>
          {step3.status === "success" && pay && (
            <div className="step-result success">
              <strong>✅ Tx:</strong>{" "}
              <a className="tx-link" href={pay.explorerUrl} target="_blank" rel="noreferrer">
                {pay.txHash?.slice(0, 14)}…{pay.txHash?.slice(-12)} ↗
              </a>
              {"\n"}
              <strong>Block:</strong> {pay.settleResult.blockNumber}
              {"  "}
              <strong>Gas:</strong> {pay.settleResult.gasUsed}
              {"\n"}
              <strong>Payer:</strong> {pay.payer}
              {"\n"}
              <strong>Recipient:</strong> {pay.recipient}
              {"\n"}
              <strong>Amount:</strong> {pay.amountUsdc} USDC ({pay.amountAtomic} atomic)
              {"\n\n"}
              <strong>EIP-712 Signature:</strong>
              {"\n  v="}
              {pay.paymentPayload.v}
              {"\n  r="}
              {pay.paymentPayload.r.slice(0, 16)}…
              {"\n  s="}
              {pay.paymentPayload.s.slice(0, 16)}…
              {"\n  nonce="}
              {pay.paymentPayload.authorization.nonce.slice(0, 16)}…
            </div>
          )}
          {step3.status === "error" && <div className="step-result error">❌ {step3.error}</div>}
        </div>
      </div>

      {/* Step 4 */}
      <div className="step">
        <div className="step-num">4</div>
        <div className="step-body">
          <h3>查询 Session 消费记录</h3>
          <p className="step-desc">
            Session 状态 + 累计花费。Session 是 OpenAgentPay 的 spend governor 边界。
          </p>
          <button onClick={runStep4} disabled={!session || step4.status === "running"}>
            {step4.status === "running" ? "Running..." : "Run"}
          </button>
          {step4.status === "success" && step4.result !== undefined && (
            <div className="step-result success">
              {(() => {
                const s = step4.result as SessionStatus;
                return (
                  <>
                    <strong>Session ID:</strong> {s.sessionId}
                    {"\n"}
                    <strong>Status:</strong> {s.status}
                    {"\n"}
                    <strong>Budget:</strong> {Number(s.budgetAtomic) / 10 ** s.decimals} {s.currency}
                    {"\n"}
                    <strong>Spent:</strong> {Number(s.spentAtomic) / 10 ** s.decimals} {s.currency}
                    {"\n"}
                    <strong>Remaining:</strong>{" "}
                    {(Number(s.budgetAtomic) - Number(s.spentAtomic)) / 10 ** s.decimals} {s.currency}
                  </>
                );
              })()}
            </div>
          )}
          {step4.status === "error" && <div className="step-result error">❌ {step4.error}</div>}
        </div>
      </div>
    </section>
  );
}
