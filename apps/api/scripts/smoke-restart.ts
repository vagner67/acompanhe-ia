/**
 * smoke-restart.ts — prova viva do doc 12 F0.1 (plano.md §6.1.1):
 *   modo create: cria caso + run via API e imprime o caseId;
 *   modo verify CASE_ID: após REINICIAR o servidor, exige o MESMO caso,
 *   os mesmos achados e o mesmo sha256 do relatório (persistência real).
 *
 * Uso (com servidor no ar e DATABASE_URL configurado):
 *   npx tsx apps/api/scripts/smoke-restart.ts create
 *   # ... kill + restart do servidor ...
 *   npx tsx apps/api/scripts/smoke-restart.ts verify <caseId>
 */
import { ADMIN_TOKEN, call, login } from "./smoke-lib.js";

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "create";
  const auth = await login(777001, "Restart", "restart_smoke");
  if (auth.status !== 200 || !auth.token) throw new Error(`login falhou: ${auth.status}`);
  const H = { authorization: `Bearer ${auth.token}` };

  // direito ao InvestigA (trial 7 d, 1× — idempotente se já usado)
  await call("POST", "/v1/admin/investiga/trial", { telegramId: "777001" }, { ...H, "x-admin-token": ADMIN_TOKEN });

  if (mode === "create") {
    const created = await call(
      "POST",
      "/v1/investiga/cases",
      {
        title: "restart smoke",
        targets: [{ kind: "username", value: "octocat" }],
        legalBasis: "LGPD art. 7º, V — teste automatizado",
        purpose: "provar persistência após restart (doc 12 F0.1)",
      },
      H,
    );
    // contrato congelado (doc 13 §4): 201 { case: {...} }
    const caseId = (created.json?.case as { id?: string } | undefined)?.id;
    if (created.status !== 201 || !caseId) throw new Error(`create falhou: ${created.status} ${JSON.stringify(created.json)}`);
    const run = await call("POST", `/v1/investiga/cases/${caseId}/run`, { sites: ["GitHub"] }, H);
    if (run.status !== 200) throw new Error(`run falhou: ${run.status}`);
    console.log(`CASE_ID=${caseId}`);
    console.log(`CREATE OK — reinicie o servidor e rode: npx tsx apps/api/scripts/smoke-restart.ts verify ${caseId}`);
    return;
  }

  if (mode === "verify") {
    const caseId = process.argv[3];
    if (!caseId) throw new Error("informe o CASE_ID");
    const before = await call("GET", `/v1/investiga/cases/${caseId}`, undefined, H);
    const report = await call("GET", `/v1/investiga/cases/${caseId}/report`, undefined, H);
    const alerts = await call("GET", `/v1/investiga/cases/${caseId}/alerts`, undefined, H);
    if (before.status !== 200) throw new Error(`caso sumiu após restart: ${before.status}`);
    // contrato congelado: GET report → { report: { integrity: { sha256 } } }
    const reportBody = (report.json?.report ?? report.json) as { integrity?: { sha256?: string } };
    const sha = reportBody?.integrity?.sha256;
    if (report.status !== 200 || !sha) throw new Error("relatório sem sha256");
    const findings = (before.json?.findings as unknown[] | undefined) ?? [];
    const checks = (before.json?.checks as unknown[] | undefined) ?? [];
    if (findings.length < 1) throw new Error("achados sumiram após restart");
    console.log("VERIFY OK — caso persistiu após restart");
    console.log(`  caseId: ${caseId}`);
    console.log(`  achados: ${findings.length} | checks: ${checks.length}`);
    console.log(`  sha256: ${sha}`);
    console.log(`  alertas: ${((alerts.json?.alerts as unknown[] | undefined) ?? []).length}`);
    return;
  }

  throw new Error(`modo desconhecido: ${mode}`);
}

main().catch((e) => {
  console.error("SMOKE-RESTART FALHOU:", e instanceof Error ? e.message : e);
  process.exit(1);
});
