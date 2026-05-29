/**
 * SpendAnalyticsTab — aggregate audit log into per-tenant / per-wallet /
 * per-result KPI cards + a chronological strip.
 *
 * Data source: GET /api/governance/audit (already wired into demo-api).
 *
 * The user picks a time window (last 1h / 24h / 7d) and an optional filter,
 * we re-fetch + re-aggregate. No backend changes needed.
 *
 * @license Apache-2.0
 */

import { useEffect, useMemo, useState } from "react";
import { api, type AuditEventLite } from "./api.js";

type Window = "1h" | "24h" | "7d";

const WINDOWS: ReadonlyArray<{ id: Window; label: string; ms: number }> = [
  { id: "1h", label: "Last hour", ms: 60 * 60_000 },
  { id: "24h", label: "Last 24 hours", ms: 24 * 60 * 60_000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60_000 },
];

interface Aggregate {
  totalEvents: number;
  successfulPayments: number;
  deniedPayments: number;
  totalUsd: number;
  byWallet: Map<string, { count: number; usd: number }>;
  byActor: Map<string, { count: number; usd: number }>;
  byKind: Map<string, number>;
  txHashes: ReadonlyArray<{ ts: string; tx: string; chain: string; usd: number }>;
}

function aggregate(events: ReadonlyArray<AuditEventLite>): Aggregate {
  let successful = 0;
  let denied = 0;
  let totalUsd = 0;
  const byWallet = new Map<string, { count: number; usd: number }>();
  const byActor = new Map<string, { count: number; usd: number }>();
  const byKind = new Map<string, number>();
  const txHashes: Array<{ ts: string; tx: string; chain: string; usd: number }> = [];

  for (const e of events) {
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    if (e.kind === "payment_success") successful++;
    if (e.result === "denied") denied++;

    const usd = atomicToUsd(e.amountAtomic, e.currency);
    if (e.kind === "payment_success") {
      totalUsd += usd;
      if (e.walletProvider) {
        const cur = byWallet.get(e.walletProvider) ?? { count: 0, usd: 0 };
        byWallet.set(e.walletProvider, {
          count: cur.count + 1,
          usd: cur.usd + usd,
        });
      }
      if (e.actor) {
        const cur = byActor.get(e.actor) ?? { count: 0, usd: 0 };
        byActor.set(e.actor, { count: cur.count + 1, usd: cur.usd + usd });
      }
      if (e.txHash) {
        txHashes.push({
          ts: e.timestamp,
          tx: e.txHash,
          chain: e.chain ?? "?",
          usd,
        });
      }
    }
  }
  return {
    totalEvents: events.length,
    successfulPayments: successful,
    deniedPayments: denied,
    totalUsd,
    byWallet,
    byActor,
    byKind,
    txHashes: txHashes.slice(-30).reverse(),
  };
}

/** USDC/USDT have decimals=6 → divide by 1e6. Others fall back to 6. */
function atomicToUsd(atomic: string | undefined, currency: string | undefined): number {
  if (!atomic) return 0;
  try {
    const n = Number(BigInt(atomic));
    const decimals = currency === "USDC" || currency === "USDT" ? 6 : 6;
    return n / Math.pow(10, decimals);
  } catch {
    return 0;
  }
}

export function SpendAnalyticsTab(): JSX.Element {
  const [winId, setWinId] = useState<Window>("24h");
  const [events, setEvents] = useState<ReadonlyArray<AuditEventLite>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"dynamodb" | "in-memory" | undefined>();

  const win = WINDOWS.find((w) => w.id === winId)!;

  async function fetchAudit(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const since = new Date(Date.now() - win.ms).toISOString();
      const r = await api.auditQuery({ since, limit: 200 });
      setEvents(r.events);
      setSource(r.source);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchAudit();
    const id = setInterval(() => void fetchAudit(), 5_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winId]);

  const agg = useMemo(() => aggregate(events), [events]);
  const denyRatePct =
    agg.totalEvents === 0
      ? 0
      : (agg.deniedPayments / agg.totalEvents) * 100;

  return (
    <div className="tab-content tab-spend">
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <h2 style={{ margin: 0 }}>Spend Analytics</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--fg-dim)" }}>
            {source && `· source: ${source}`}
            {loading && " · refreshing…"}
          </span>
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              className={`chip ${
                w.id === winId ? "chip-active" : "chip-available"
              }`}
              onClick={() => setWinId(w.id)}
            >
              {w.label}
            </button>
          ))}
          <button
            className="chip chip-available"
            onClick={() => void fetchAudit()}
            title="Refresh now"
          >
            ↻
          </button>
        </div>
      </header>

      {error && (
        <div
          style={{
            padding: 12,
            border: "1px solid #ff7a7a",
            borderRadius: 6,
            color: "#ff7a7a",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {/* KPI cards */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <KpiCard
          label="Total payments"
          value={agg.successfulPayments.toString()}
          sub={`${agg.totalEvents} audit events`}
        />
        <KpiCard
          label="Total spend"
          value={`$${agg.totalUsd.toFixed(2)}`}
          sub="USDC equivalent"
        />
        <KpiCard
          label="Deny rate"
          value={`${denyRatePct.toFixed(1)}%`}
          sub={`${agg.deniedPayments} denied`}
          tone={denyRatePct > 20 ? "warn" : "ok"}
        />
        <KpiCard
          label="Wallets used"
          value={agg.byWallet.size.toString()}
          sub={`${agg.byActor.size} unique actors`}
        />
      </section>

      {/* By-wallet breakdown */}
      <section style={{ marginBottom: 24 }}>
        <h3 style={{ marginBottom: 8 }}>By wallet</h3>
        {agg.byWallet.size === 0 ? (
          <p style={{ color: "var(--fg-dim)", fontSize: 13 }}>
            No successful payments in the selected window.
          </p>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid var(--bd)" }}>
                <th style={{ textAlign: "left", padding: 8 }}>Wallet</th>
                <th style={{ textAlign: "right", padding: 8 }}>Payments</th>
                <th style={{ textAlign: "right", padding: 8 }}>Total spend</th>
                <th style={{ textAlign: "right", padding: 8 }}>Share</th>
              </tr>
            </thead>
            <tbody>
              {[...agg.byWallet.entries()]
                .sort((a, b) => b[1].usd - a[1].usd)
                .map(([wp, v]) => (
                  <tr
                    key={wp}
                    style={{ borderBottom: "1px dashed var(--bd-faint)" }}
                  >
                    <td style={{ padding: 8 }}>{wp}</td>
                    <td style={{ padding: 8, textAlign: "right" }}>
                      {v.count}
                    </td>
                    <td style={{ padding: 8, textAlign: "right" }}>
                      ${v.usd.toFixed(4)}
                    </td>
                    <td style={{ padding: 8, textAlign: "right" }}>
                      {agg.totalUsd > 0
                        ? `${((v.usd / agg.totalUsd) * 100).toFixed(0)}%`
                        : "—"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      {/* By-actor */}
      <section style={{ marginBottom: 24 }}>
        <h3 style={{ marginBottom: 8 }}>By actor</h3>
        {agg.byActor.size === 0 ? (
          <p style={{ color: "var(--fg-dim)", fontSize: 13 }}>
            No actors yet.
          </p>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid var(--bd)" }}>
                <th style={{ textAlign: "left", padding: 8 }}>Actor</th>
                <th style={{ textAlign: "right", padding: 8 }}>Payments</th>
                <th style={{ textAlign: "right", padding: 8 }}>Total spend</th>
              </tr>
            </thead>
            <tbody>
              {[...agg.byActor.entries()]
                .sort((a, b) => b[1].usd - a[1].usd)
                .map(([actor, v]) => (
                  <tr
                    key={actor}
                    style={{ borderBottom: "1px dashed var(--bd-faint)" }}
                  >
                    <td style={{ padding: 8 }}>{actor}</td>
                    <td style={{ padding: 8, textAlign: "right" }}>
                      {v.count}
                    </td>
                    <td style={{ padding: 8, textAlign: "right" }}>
                      ${v.usd.toFixed(4)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Recent on-chain transactions */}
      <section style={{ marginBottom: 24 }}>
        <h3 style={{ marginBottom: 8 }}>Recent settled transactions</h3>
        {agg.txHashes.length === 0 ? (
          <p style={{ color: "var(--fg-dim)", fontSize: 13 }}>
            No transactions in the selected window.
          </p>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            {agg.txHashes.map((t) => (
              <li
                key={t.tx}
                style={{
                  padding: "6px 8px",
                  borderBottom: "1px dashed var(--bd-faint)",
                  display: "flex",
                  gap: 12,
                }}
              >
                <span style={{ color: "var(--fg-dim)", flex: "0 0 90px" }}>
                  {t.ts.split("T")[1]?.slice(0, 8) ?? t.ts}
                </span>
                <span style={{ flex: "0 0 100px" }}>${t.usd.toFixed(4)}</span>
                <span style={{ flex: "0 0 80px", color: "var(--fg-dim)" }}>
                  {t.chain}
                </span>
                <span style={{ flex: 1 }}>{t.tx.slice(0, 24)}…</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer
        style={{
          fontSize: 11,
          color: "var(--fg-dim)",
          paddingTop: 12,
          borderTop: "1px solid var(--bd-faint)",
        }}
      >
        Auto-refreshes every 5s. Window: {win.label}. Source: {source ?? "—"}.
      </footer>
    </div>
  );
}

interface KpiProps {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly tone?: "ok" | "warn";
}

function KpiCard({ label, value, sub, tone }: KpiProps): JSX.Element {
  const color = tone === "warn" ? "#f4b740" : tone === "ok" ? "#7ab450" : "var(--fg)";
  return (
    <div
      style={{
        padding: 16,
        border: "1px solid var(--bd-faint)",
        borderRadius: 8,
        background: "var(--bg-elev)",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--fg-dim)", marginBottom: 6 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 600,
          fontFamily: "var(--font-mono)",
          color,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
