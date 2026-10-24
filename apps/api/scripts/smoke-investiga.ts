/**
 * Smoke E2E do Investiga contra o servidor VIVO (rodar com a API em :3000):
 *   npx tsx apps/api/scripts/smoke-investiga.ts
 * Cobre: initData→JWT → trial (X-Admin-Token) → caso → run (Sherlock REAL)
 * → relatório (LEAD + sha256) → quota.
 */
import { ADMIN_TOKEN, call, login } from "./smoke-lib.js";

async function main() {
  const auth = await login(777001, "Smoke", "smoke_investiga");
  console.log("1) auth:", auth.status, auth.token ? "token ok" : auth.json);
  const H = { authorization: `Bearer ${auth.token}` };

  const trial = await call("POST", "/v1/admin/investiga/trial", { telegramId: "777001" }, { ...H, "x-admin-token": ADMIN_TOKEN });
  console.log("2) trial:", trial.status, JSON.stringify(trial.json));

  const created = await call(
    "POST",
    "/v1/investiga/cases",
    {
      title: "Smoke E2E — octocat",
      targets: [{ kind: "username", value: "octocat" }],
      legalBasis: "execução de contrato (LGPD art. 7º, V)",
      purpose: "smoke end-to-end do motor Sherlock real",
    },
    H,
  );
  console.log("3) caso:", created.status, created.json.case ? (created.json.case as { id: string }).id : created.json);
  const caseId = (created.json.case as { id: string }).id;

  const run = await call("POST", `/v1/investiga/cases/${caseId}/run`, { sites: ["GitHub"] }, H);
  console.log("4) run:", run.status, JSON.stringify(run.json.findings ?? run.json));

  const report = await call("GET", `/v1/investiga/cases/${caseId}/report`, undefined, H);
  const rep = report.json.report as { verdict?: string; integrity?: { sha256?: string }; summary?: unknown };
  console.log("5) relatório:", report.status, "veredicto:", rep.verdict);
  console.log("   sha256:", rep.integrity?.sha256);
  console.log("   summary:", JSON.stringify(rep.summary));

  const quota = await call("GET", "/v1/investiga/quota", undefined, H);
  console.log("6) quota:", quota.status, JSON.stringify(quota.json.window));

  const ok =
    auth.status === 200 &&
    (trial.status === 201 || trial.status === 409) &&
    created.status === 201 &&
    run.status === 200 &&
    report.status === 200 &&
    rep.verdict === "LEAD — verificar manualmente" &&
    quota.status === 200;

  // Endurecimento (plano.md §6.2.1): o smoke só passa com achado REAL —
  // `found` + confiança determinística esperada (ugc/65/média), não só HTTP 200.
  // (Em 23/10/2026 o smoke passou com `unknown` enquanto o Sherlock estava
  // quebrado — este assert impede a repetição.)
  const findings = (run.json.findings as Array<{ status?: string; confidence?: { score?: number; band?: string } }> | undefined) ?? [];
  const found = findings.find((f) => f.status === "found");
  const realFound = Boolean(found && found.confidence?.band === "média" && found.confidence?.score === 65);
  if (!realFound) {
    console.error("ACHADO REAL AUSENTE: esperado ≥1 finding found com conf 65/média; veio:", JSON.stringify(findings));
  }

  console.log(ok && realFound ? "SMOKE OK" : "SMOKE FALHOU");
  process.exit(ok && realFound ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
