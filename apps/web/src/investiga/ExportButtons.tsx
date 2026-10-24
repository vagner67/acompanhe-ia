import { useState } from "react";

import { investigaExportBlob } from "../api";

/** Export CSV/PDF em 1 clique (doc 13, R9) — dono do download + estado local. */
export function ExportButtons({ token, caseId }: { token: string; caseId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onExport(format: "csv" | "pdf") {
    setBusy(true);
    setError("");
    try {
      const blob = await investigaExportBlob(token, caseId, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `investiga-${caseId}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ display: "flex", gap: 6 }}>
        <button style={{ ...styles.btn, flex: 1 }} disabled={busy} onClick={() => void onExport("csv")}>
          Exportar CSV (máquina)
        </button>
        <button style={{ ...styles.btn, flex: 1 }} disabled={busy} onClick={() => void onExport("pdf")}>
          Exportar PDF (humano)
        </button>
      </div>
      {error && <p style={{ fontSize: 11, color: "#f87171" }}>⚠ {error}</p>}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  btn: { padding: 10, borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontWeight: 600, marginTop: 6 },
};
