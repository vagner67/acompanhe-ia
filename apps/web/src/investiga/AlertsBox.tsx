import type { MonitorAlert } from "@acompanhe/shared";

import { ALERT_LABELS } from "./constants";

/** Alertas de monitoramento (doc 13, R9) — componente puro. */
export function AlertsBox({ alerts }: { alerts: MonitorAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div style={{ ...styles.verdict, borderLeft: "4px solid #f87171" }}>
      <strong style={{ fontSize: 12 }}>Alertas de monitoramento</strong>
      {alerts.map((a) => (
        <div key={a.id} style={{ fontSize: 11, color: "#e2e8f0" }}>
          [{ALERT_LABELS[a.kind] ?? a.kind}] {a.targetKey} — {a.detail}
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  verdict: { padding: "8px 10px", background: "#1c1917", borderRadius: 8, fontSize: 13, margin: "8px 0" },
};
