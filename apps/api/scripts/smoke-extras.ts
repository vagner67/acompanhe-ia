/**
 * Smoke dos sinais de demanda (23/10/2026) contra servidor VIVO em :3000.
 *  Cobre: run (Sherlock REAL) → confidence no achado → re-run → alertas
 *  (diff) → relatório c/ inferências → export CSV e PDF reais.
 *  Uso: BOT_TOKEN=... npx tsx apps/api/scripts/smoke-extras.ts
 */
import { ADMIN_TOKEN, API, call, login } from "./smoke-lib.js";

async function main() {
  const auth = await login(888101, "Extras", "smoke_extras");
  const token = auth.token;
  const H = { authorization: `Bearer ${token}` };
  console.log("1) auth:", auth.status, token ? "token ok" : auth.json);

  const trial = await call("POST", "/v1/admin/investiga/trial", { telegramId: "888101" }, {
    ...H,
    "x-admin-token": ADMIN_TOKEN,
  });
  console.log("2) trial:", trial.status);

  const created = await call("POST", "/v1/investiga/cases", {
    title: "Smoke extras",
    targets: [{ kind: "username", value: "octocat" }],
    legalBasis: "execução de contrato (LGPD art. 7º, V)",
    purpose: "smoke dos sinais de demanda",
  }, H);
  const caseId = (created.json.case as { id: string }).id;
  console.log("2) caso:", created.status, caseId);

  const run1 = await call("POST", `/v1/investiga/cases/${caseId}/run`, {}, H);
  const f1 = (run1.json.findings as Array<{ confidence?: { score: number; band: string }; summary?: string }>)[0];
  console.log("3) run1:", run1.status, "confiança:", JSON.stringify(f1?.confidence ?? "AUSENTE"), "| achado:", f1?.summary);

  const run2 = await call("POST", `/v1/investiga/cases/${caseId}/run`, {}, H);
  console.log("4) run2:", run2.status, "alertas:", JSON.stringify(run2.json.alerts));

  const alerts = await call("GET", `/v1/investiga/cases/${caseId}/alerts`, undefined, H);
  console.log("5) alerts:", alerts.status, JSON.stringify(alerts.json));

  const rep = await call("GET", `/v1/investiga/cases/${caseId}/report`, undefined, H);
  const report = rep.json.report as { summary: { inferences: number }; integrity: { sha256: string } };
  console.log("6) report:", rep.status, "inferências:", report.summary.inferences, "sha256:", report.integrity.sha256.slice(0, 16) + "…");

  const csv = await fetch(`${API}/v1/investiga/cases/${caseId}/export.csv`, { headers: H });
  const csvText = await csv.text();
  console.log("7) CSV:", csv.status, csv.headers.get("content-type"), "| bytes:", csvText.length, "| header ok:", csvText.startsWith("case_id,target_kind"));

  const pdf = await fetch(`${API}/v1/investiga/cases/${caseId}/export.pdf`, { headers: H });
  const buf = Buffer.from(await pdf.arrayBuffer());
  console.log("8) PDF:", pdf.status, pdf.headers.get("content-type"), "| bytes:", buf.length, "| %PDF:", buf.subarray(0, 5).toString("latin1"));
}

main().catch((e) => {
  console.error("SMOKE FALHOU:", e);
  process.exit(1);
});
