import type { OsintCase } from "@acompanhe/shared";

/** Lista de casos (doc 13, R9) — componente puro (props). */
export function CaseList({
  cases,
  busy,
  onRun,
}: {
  cases: OsintCase[];
  busy: boolean;
  onRun: (caseId: string) => void;
}) {
  return (
    <>
      <h3 style={styles.h3}>Meus casos</h3>
      {cases.length === 0 && <p style={styles.small}>Nenhum caso ainda.</p>}
      {cases.map((c) => (
        <div key={c.id} style={styles.card}>
          <strong>{c.title}</strong>
          <p style={styles.small}>
            {c.targets.map((t) => `${t.kind}: ${t.value}`).join(" · ")} — {c.status}
          </p>
          <p style={styles.small}>Finalidade declarada: {c.purpose}</p>
          <button style={styles.btn} disabled={busy} onClick={() => onRun(c.id)}>
            Rodar agora
          </button>
        </div>
      ))}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  h3: { fontSize: 15, marginTop: 14 },
  card: { background: "#1e293b", borderRadius: 12, padding: 12, marginBottom: 10 },
  small: { fontSize: 12, color: "#94a3b8", margin: "4px 0" },
  btn: { width: "100%", padding: 10, borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontWeight: 600, marginTop: 6 },
};
