import type { InvestigaReport, MonitorAlert, OsintFinding } from "@acompanhe/shared";

import { AlertsBox } from "./AlertsBox";
import { ExportButtons } from "./ExportButtons";
import { BAND_COLORS, STATUS_COLORS, STATUS_LABELS } from "./constants";

/**
 * Relatório do caso (doc 13, R9) — achados com confiança, inferências
 * SEPARADAS (não é dado verificado), alertas, exports e integridade.
 */
export function ReportCard({
  token,
  report,
  alerts,
}: {
  token: string;
  report: InvestigaReport;
  alerts: MonitorAlert[];
}) {
  return (
    <div style={styles.card}>
      <strong>Relatório — {report.generatedAt.slice(0, 10)}</strong>
      <p style={styles.small}>
        {report.summary.found} encontrados · {report.summary.notFound} ausentes ·{" "}
        {report.summary.unknown} inconclusivos · {report.summary.inferences} inferências
      </p>
      <div style={{ ...styles.verdict, borderLeft: "4px solid #fbbf24" }}>{report.verdict}</div>

      <ExportButtons token={token} caseId={report.caseId} />
      <AlertsBox alerts={alerts} />

      {report.findings.map((f: OsintFinding) => (
        <div key={f.id} style={styles.finding}>
          <span style={{ color: STATUS_COLORS[f.status] ?? "#94a3b8", fontWeight: 600 }}>
            [{STATUS_LABELS[f.status] ?? f.status}]
          </span>{" "}
          <span style={{ fontFamily: "monospace", fontSize: 12 }}>{f.sourceId}</span>
          {f.confidence && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 10,
                fontWeight: 700,
                color: BAND_COLORS[f.confidence.band] ?? "#94a3b8",
              }}
              title={`score ${f.confidence.score}/100 · corroborações: ${f.confidence.factors.corroborations} · idade: ${f.confidence.factors.ageDays}d`}
            >
              CONF {f.confidence.score}/100 ({f.confidence.band})
            </span>
          )}
          {f.evidenceUrl && (
            <>
              {" — "}
              <span style={{ fontSize: 11, color: "#38bdf8", wordBreak: "break-all" }}>{f.evidenceUrl}</span>
            </>
          )}
          {f.summary && <div style={{ fontSize: 11, color: "#cbd5e1" }}>{f.summary}</div>}
          <div style={{ fontSize: 10, color: "#64748b" }}>
            coletado em {f.retrievedAt.slice(0, 19).replace("T", " ")} UTC
          </div>
        </div>
      ))}

      {report.inferences.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <strong style={{ fontSize: 12, color: "#c084fc" }}>
            Inferências (motor de correlação — NÃO é dado verificado)
          </strong>
          {report.inferences.map((f: OsintFinding) => (
            <div key={f.id} style={{ ...styles.finding, borderLeft: "3px solid #c084fc", paddingLeft: 8 }}>
              <span style={{ fontSize: 11, color: "#e2e8f0" }}>{f.summary}</span>
              {f.confidence && (
                <div style={{ fontSize: 10, color: "#64748b" }}>
                  CONF {f.confidence.score}/100 ({f.confidence.band}) — verificar manualmente
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p style={{ ...styles.small, fontFamily: "monospace" }}>
        {report.integrity.algorithm}: {report.integrity.sha256}
      </p>
      <ul style={styles.limits}>
        {report.legalNotice.limitations.map((l) => (
          <li key={l} style={styles.small}>
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: { background: "#1e293b", borderRadius: 12, padding: 12, marginBottom: 10 },
  small: { fontSize: 12, color: "#94a3b8", margin: "4px 0" },
  verdict: { padding: "8px 10px", background: "#1c1917", borderRadius: 8, fontSize: 13, margin: "8px 0" },
  finding: { borderTop: "1px solid #334155", padding: "6px 0", fontSize: 12 },
  limits: { paddingLeft: 16 },
};
