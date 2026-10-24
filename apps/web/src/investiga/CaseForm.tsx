import { useState } from "react";
import type { OsintTarget } from "@acompanhe/shared";

export interface CreateCaseInput {
  title: string;
  targets: OsintTarget[];
  legalBasis: string;
  purpose: string;
}

/** Formulário de novo caso (doc 13, R9) — 1 useState (objeto) + busy de fora. */
export function CaseForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (input: CreateCaseInput) => Promise<void>;
}) {
  const [form, setForm] = useState({
    title: "",
    targetKind: "username" as "username" | "email" | "phone" | "domain",
    targetValue: "",
    legalBasis: "execução de contrato (LGPD art. 7º, V)",
    purpose: "",
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div style={styles.card}>
      <strong>Novo caso</strong>
      <input
        style={styles.input}
        placeholder="Título do caso"
        value={form.title}
        onChange={(e) => set("title", e.target.value)}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <select
          style={styles.input}
          value={form.targetKind}
          onChange={(e) => set("targetKind", e.target.value as typeof form.targetKind)}
        >
          <option value="username">username</option>
          <option value="email">e-mail</option>
          <option value="phone">telefone</option>
          <option value="domain">domínio</option>
        </select>
        <input
          style={styles.input}
          placeholder="valor do alvo"
          value={form.targetValue}
          onChange={(e) => set("targetValue", e.target.value)}
        />
      </div>
      <input
        style={styles.input}
        value={form.legalBasis}
        onChange={(e) => set("legalBasis", e.target.value)}
        placeholder="Base legal (LGPD)"
      />
      <input
        style={styles.input}
        value={form.purpose}
        onChange={(e) => set("purpose", e.target.value)}
        placeholder="Finalidade (por que investigar)"
      />
      <button
        style={styles.btn}
        disabled={busy}
        onClick={() =>
          void onCreate({
            title: form.title || "Caso sem título",
            targets: [{ kind: form.targetKind, value: form.targetValue }],
            legalBasis: form.legalBasis,
            purpose: form.purpose || "verificação passiva de fontes públicas",
          }).then(() => setForm((f) => ({ ...f, title: "", targetValue: "" })))
        }
      >
        Criar caso
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: { background: "#1e293b", borderRadius: 12, padding: 12, marginBottom: 10 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    margin: "4px 0",
    padding: 8,
    borderRadius: 8,
    border: "1px solid #334155",
    background: "#0f172a",
    color: "#e2e8f0",
  },
  btn: { width: "100%", padding: 10, borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontWeight: 600, marginTop: 6 },
};
