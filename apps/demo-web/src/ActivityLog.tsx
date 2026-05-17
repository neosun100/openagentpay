import { useEffect, useState } from "react";
import { activityLog, type LogEntry } from "./api.js";

export function ActivityLog() {
  const [entries, setEntries] = useState<readonly LogEntry[]>([]);

  useEffect(() => activityLog.subscribe(setEntries), []);

  return (
    <div className="activity">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
        <strong style={{ color: "var(--fg-dim)", fontSize: 11 }}>
          ▼ Activity Log ({entries.length})
        </strong>
        <button
          onClick={() => activityLog.clear()}
          style={{
            background: "transparent",
            color: "var(--fg-faint)",
            padding: "2px 8px",
            fontSize: 10,
            border: "1px solid var(--border)",
          }}
        >
          clear
        </button>
      </div>
      {entries.length === 0 ? (
        <div style={{ color: "var(--fg-faint)", fontSize: 11, padding: "4px 0" }}>
          (no events yet — tap a button to start)
        </div>
      ) : (
        entries.slice(-30).map((e, i) => (
          <div key={i} className={`log-entry ${e.kind}`}>
            <span className="ts">[{e.ts}]</span>
            <span className="kind">{e.kind}</span>
            <span className="msg">{e.msg}</span>
          </div>
        ))
      )}
    </div>
  );
}
