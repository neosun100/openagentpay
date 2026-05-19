/**
 * Tab 4: Guardrail Dashboard — 7-Layer Spending Controls Visualization
 *
 * Mirrors AgentCore Payments' 7-layer Guardrail design and shows OpenAgentPay's
 * implementation status of each layer in real time. Connects to /api/governance
 * for live policy list + audit log.
 *
 * Sections:
 *   1. 7-Layer status grid    — each layer's state with implementation note
 *   2. Active policies        — what's enforced right now
 *   3. Live audit log         — last 50 events, auto-refreshing
 *   4. Try it                 — buttons to trigger Policy deny + Sanctions match
 */

import { useEffect, useState } from "react";
import { activityLog } from "./api.js";

interface GovernancePayload {
  readonly policies: ReadonlyArray<{ readonly name: string }>;
  readonly compliance: {
    readonly enabled: boolean;
    readonly checker: string;
    readonly listSize?: number;
  };
  readonly auditLog: ReadonlyArray<{
    readonly eventId: string;
    readonly timestamp: string;
    readonly kind: string;
    readonly actor: string;
    readonly result: string;
    readonly walletProvider?: string;
    readonly recipient?: string;
    readonly amountAtomic?: string;
    readonly currency?: string;
    readonly chain?: string;
    readonly txHash?: string;
    readonly reason?: string;
  }>;
  readonly auditCount: number;
}

const LAYERS: ReadonlyArray<{
  readonly num: number;
  readonly title: string;
  readonly subtitle: string;
  readonly impl: string;
  readonly status: "active" | "out-of-scope";
  readonly emoji: string;
}> = [
  {
    num: 1,
    title: "Authorization",
    subtitle: "End user grants Agent access",
    impl: "Out of scope — handled by upstream auth (Cognito / OIDC / SAML)",
    status: "out-of-scope",
    emoji: "🔐",
  },
  {
    num: 2,
    title: "Session",
    subtitle: "Budget cap + TTL",
    impl: "@openagentpay/core SessionManager — maxSpendAmount + expiryMinutes",
    status: "active",
    emoji: "📋",
  },
  {
    num: 3,
    title: "Policy",
    subtitle: "Velocity / amount / merchant rules",
    impl:
      "@openagentpay/governance PolicyEngine — composable rules, first-deny-wins",
    status: "active",
    emoji: "📐",
  },
  {
    num: 4,
    title: "On-chain",
    subtitle: "Immutable record (EIP-3009)",
    impl:
      "Wallet connectors broadcast transferWithAuthorization — block + tx hash anchored",
    status: "active",
    emoji: "⛓️",
  },
  {
    num: 5,
    title: "Compliance",
    subtitle: "Sanctions / OFAC / illicit finance",
    impl:
      "@openagentpay/governance ComplianceChecker — pluggable Static / Chainalysis / TRM",
    status: "active",
    emoji: "🛡️",
  },
  {
    num: 6,
    title: "Identity",
    subtitle: "Secret management",
    impl: "AWS Secrets Manager + KMS — private keys never in Lambda env",
    status: "active",
    emoji: "🔑",
  },
  {
    num: 7,
    title: "Audit",
    subtitle: "Append-only structured log",
    impl:
      "@openagentpay/governance AuditLogger — emits events for every check + outcome",
    status: "active",
    emoji: "📜",
  },
];

export function GuardrailTab({
  walletProvider,
}: {
  readonly walletProvider: string;
}) {
  const [data, setData] = useState<GovernancePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLog, setActionLog] = useState<string[]>([]);

  // Fetch governance state — auto-refresh every 3s
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/governance");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as GovernancePayload;
        if (!cancelled) {
          setData(j);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const appendAction = (msg: string) =>
    setActionLog((l) => [
      `${new Date().toISOString().slice(11, 19)} · ${msg}`,
      ...l,
    ]);

  // Try-it buttons
  const triggerPolicyDeny = async () => {
    appendAction("→ POST /api/pay  amountUsdc=100  (should be denied by amountThreshold)");
    activityLog.push("req", "POST /api/pay amountUsdc=100 (test policy deny)");
    try {
      // Need a session first
      const sRes = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budgetUsd: 200, expiryMinutes: 5 }),
      });
      const session = (await sRes.json()) as { sessionId: string };
      const r = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          amountUsdc: 100,
          walletProvider,
        }),
      });
      const j = (await r.json()) as {
        success: boolean;
        errorCode?: string;
        errorMessage?: string;
      };
      if (j.success) {
        appendAction("⚠️  Unexpectedly succeeded (policy not enforced?)");
      } else {
        appendAction(`✅  DENIED · ${j.errorCode} · ${j.errorMessage}`);
      }
    } catch (e) {
      appendAction(`❌  request failed: ${(e as Error).message}`);
    }
  };

  const triggerSanctionsMatch = async () => {
    appendAction(
      "→ POST /api/pay  recipient=0x8589...fda16 (Tornado Cash, sanctioned)"
    );
    activityLog.push(
      "req",
      "POST /api/pay recipient=0x8589... (test compliance deny)"
    );
    try {
      const sRes = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budgetUsd: 1, expiryMinutes: 5 }),
      });
      const session = (await sRes.json()) as { sessionId: string };
      const r = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          amountUsdc: 0.001,
          recipient: "0x8589427373d6d84e98730d7795d8f6f8731fda16",
          walletProvider,
        }),
      });
      const j = (await r.json()) as {
        success: boolean;
        errorCode?: string;
        errorMessage?: string;
      };
      if (j.success) {
        appendAction("⚠️  Unexpectedly succeeded (compliance not enforced?)");
      } else {
        appendAction(`✅  DENIED · ${j.errorCode ?? "compliance"} · ${j.errorMessage}`);
      }
    } catch (e) {
      appendAction(`❌  request failed: ${(e as Error).message}`);
    }
  };

  return (
    <section className="content guardrail-tab">
      <h2>🛡️ 7-Layer Guardrail Dashboard</h2>
      <p style={{ color: "var(--fg-dim)", marginTop: -6, fontSize: 13 }}>
        OpenAgentPay 借鉴 AWS Bedrock AgentCore Payments 的 7 层安全设计
        （end-user → Agent → on-chain），把每一层做成可插拔的 OSS 组件。
        Layer 3/5/7 由 <code>@openagentpay/governance</code> 提供。
      </p>

      {/* ============ 7 Layer Stack ============ */}
      <div className="layer-stack">
        {LAYERS.map((l) => (
          <div
            key={l.num}
            className={`layer-card layer-${l.status}`}
          >
            <div className="layer-num">L{l.num}</div>
            <div className="layer-emoji">{l.emoji}</div>
            <div className="layer-body">
              <div className="layer-title">
                {l.title}
                {l.status === "active" ? (
                  <span className="layer-badge layer-badge-active">● ACTIVE</span>
                ) : (
                  <span className="layer-badge layer-badge-oos">○ OUT-OF-SCOPE</span>
                )}
              </div>
              <div className="layer-subtitle">{l.subtitle}</div>
              <div className="layer-impl">{l.impl}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ============ Active Policies + Compliance ============ */}
      <div className="card-grid">
        <div className="card">
          <h3>📐 Active Policies (Layer 3)</h3>
          {data ? (
            <ul className="policy-list">
              {data.policies.map((p, i) => (
                <li key={i}>
                  <code>{p.name}</code>
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ color: "var(--fg-dim)" }}>Loading…</div>
          )}
        </div>
        <div className="card">
          <h3>🛡️ Compliance (Layer 5)</h3>
          {data ? (
            <div>
              <div className="row">
                <span className="label">Status</span>
                <span className="value" style={{ color: "var(--green)" }}>
                  {data.compliance.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div className="row">
                <span className="label">Checker</span>
                <span className="value">{data.compliance.checker}</span>
              </div>
              <div className="row">
                <span className="label">List size</span>
                <span className="value">{data.compliance.listSize ?? "?"}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-faint)", marginTop: 8 }}>
                Demo uses static OFAC-style list. Production swaps in
                Chainalysis KYT / TRM Labs / Elliptic via the <code>ComplianceChecker</code>{" "}
                interface.
              </div>
            </div>
          ) : (
            <div style={{ color: "var(--fg-dim)" }}>Loading…</div>
          )}
        </div>
      </div>

      {/* ============ Try it ============ */}
      <h3>🧪 Try It</h3>
      <div className="card">
        <p style={{ fontSize: 13, color: "var(--fg-dim)", marginTop: 0 }}>
          点击下面按钮触发 governance pre-check。两次都应该被拒绝，audit log 中会立刻出现
          deny 事件。
        </p>
        <div className="preset-buttons" style={{ flexWrap: "wrap" }}>
          <button onClick={triggerPolicyDeny}>
            🚫 Test Policy Deny ($100 &gt; cap)
          </button>
          <button onClick={triggerSanctionsMatch}>
            🚫 Test Sanctions Match (Tornado Cash addr)
          </button>
        </div>
        {actionLog.length > 0 && (
          <pre className="action-log">{actionLog.join("\n")}</pre>
        )}
      </div>

      {/* ============ Audit Log ============ */}
      <h3>📜 Live Audit Log (Layer 7)</h3>
      <div className="card">
        {error && (
          <div style={{ color: "var(--red)", fontSize: 12 }}>❌ {error}</div>
        )}
        {data ? (
          <>
            <div style={{ fontSize: 12, color: "var(--fg-dim)", marginBottom: 8 }}>
              {data.auditCount} total events recorded · auto-refresh every 3s ·
              showing last {data.auditLog.length}
            </div>
            <div className="audit-table">
              {data.auditLog.length === 0 ? (
                <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>
                  No events yet. Run a payment in the Run Demo tab or click a
                  button above.
                </div>
              ) : (
                data.auditLog
                  .slice()
                  .reverse()
                  .map((e) => (
                    <div
                      key={e.eventId}
                      className={`audit-row audit-${e.result}`}
                    >
                      <span className="audit-ts">
                        {e.timestamp.slice(11, 19)}
                      </span>
                      <span className="audit-kind">{e.kind}</span>
                      <span className={`audit-result audit-result-${e.result}`}>
                        {e.result}
                      </span>
                      <span className="audit-detail">
                        {e.amountAtomic && (
                          <span title="amount">
                            {(Number(e.amountAtomic) / 1e6).toFixed(4)}{" "}
                            {e.currency ?? "USDC"}
                          </span>
                        )}
                        {e.walletProvider && (
                          <span className="audit-pill" title="wallet">
                            {e.walletProvider}
                          </span>
                        )}
                        {e.txHash && (
                          <span className="audit-tx" title={e.txHash}>
                            tx:{e.txHash.slice(0, 10)}…
                          </span>
                        )}
                        {e.reason && (
                          <span className="audit-reason">{e.reason}</span>
                        )}
                      </span>
                    </div>
                  ))
              )}
            </div>
          </>
        ) : (
          <div style={{ color: "var(--fg-dim)" }}>Loading…</div>
        )}
      </div>
    </section>
  );
}
