import { useCallback, useEffect, useState } from "react";
import {
  investigaAlerts,
  investigaCreateCase,
  investigaListCases,
  investigaQuota,
  investigaReport,
  investigaRunCase,
} from "./api";
import type {
  InvestigaReport,
  MonitorAlert,
  OsintCase,
  QuotaWindow,
} from "@acompanhe/shared";

import { CaseForm, type CreateCaseInput } from "./investiga/CaseForm";
import { CaseList } from "./investiga/CaseList";
import { ReportCard } from "./investiga/ReportCard";

/**
 * Painel do Investiga — composição (doc 13, R9): formulário, lista,
 * relatório e alertas vivem em `investiga/`; aqui só o estado de topo
 * (4 useState) e a orquestração de fetch.
 */
export function InvestigaPanel({ token }: { token: string }) {
  const [view, setView] = useState<{ cases: OsintCase[]; quota: QuotaWindow | null }>({
    cases: [],
    quota: null,
  });
  const [report, setReport] = useState<InvestigaReport | null>(null);
  const [alerts, setAlerts] = useState<MonitorAlert[]>([]);
  const [ui, setUi] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });

  const refresh = useCallback(async () => {
    try {
      const [c, q] = await Promise.all([investigaListCases(token), investigaQuota(token)]);
      setView({ cases: c.cases, quota: q.window });
    } catch (e) {
      setUi((s) => ({ ...s, error: (e as Error).message }));
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onCreate(input: CreateCaseInput) {
    setUi({ busy: true, error: "" });
    try {
      await investigaCreateCase(token, input);
      await refresh();
    } catch (e) {
      setUi((s) => ({ ...s, error: (e as Error).message }));
    } finally {
      setUi((s) => ({ ...s, busy: false }));
    }
  }

  async function onRun(caseId: string) {
    setUi({ busy: true, error: "" });
    try {
      await investigaRunCase(token, caseId);
      const [rep, al] = await Promise.all([
        investigaReport(token, caseId),
        investigaAlerts(token, caseId),
      ]);
      setReport(rep.report);
      setAlerts(al.alerts);
      await refresh();
    } catch (e) {
      setUi((s) => ({ ...s, error: (e as Error).message }));
    } finally {
      setUi((s) => ({ ...s, busy: false }));
    }
  }

  return (
    <section>
      <h2 style={styles.h2}>🔍 Investiga — OSINT avançado</h2>
      <p style={styles.small}>
        {view.quota
          ? `Checks hoje: ${view.quota.used}/${view.quota.limit} · restam ${view.quota.remaining} (janela ${view.quota.day} UTC)`
          : "Carregando quota…"}
      </p>

      <CaseForm busy={ui.busy} onCreate={onCreate} />

      {ui.error && <p style={{ ...styles.small, color: "#f87171" }}>⚠ {ui.error}</p>}

      <CaseList cases={view.cases} busy={ui.busy} onRun={(id) => void onRun(id)} />

      {report && <ReportCard token={token} report={report} alerts={alerts} />}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  h2: { fontSize: 18, marginTop: 20 },
  small: { fontSize: 12, color: "#94a3b8", margin: "4px 0" },
};
