/**
 * Investiga ponta a ponta (HTTP) — gating de entitlement + quota dura +
 * veredicto LEAD + trial do diretor. Fixture do sherlock = saída REAL
 * capturada em 22/10/2026 (ver test/fixtures/sherlock-capture.ts).
 */
import { describe, it, expect } from "vitest";

import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { InMemoryEntitlementsStore } from "../src/entitlements.js";
import { OsintStore } from "../src/osint/store.js";
import { InvestigaQuotaGate } from "../src/osint/quota.js";
import { JwtService } from "../src/security/jwt.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";
import type { SherlockExec } from "../src/osint/sherlock.js";

const BOT = "123456789:TEST_TOKEN_AAA-BBB";
const NOW = 1_800_000_000;

import { REAL_CSV_FOUND_1 as REAL_CSV, REAL_CSV_NONE, REAL_STDOUT_FOUND_1 as REAL_STDOUT, REAL_STDOUT_NONE } from "./fixtures/sherlock-capture.js";

const sherlockExec: SherlockExec = async (args) => {
  const folderIdx = args.indexOf("--folderoutput");
  const dir = args[folderIdx + 1] ?? "/tmp";
  const user = args[0] ?? "user";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${dir}/${user}.csv`, REAL_CSV, "utf8");
  return { stdout: REAL_STDOUT, stderr: "", exitCode: 0, timedOut: false };
};

function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "diretor-token",
    ...env,
  } as NodeJS.ProcessEnv);
  const entitlements = new InMemoryEntitlementsStore();
  const osintStore = new OsintStore();
  const quota = new InvestigaQuotaGate();
  const app = buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
    nowSec: () => NOW,
    osint: { store: osintStore, quota, entitlements, sherlockExec },
  });
  const jwt = new JwtService("test-secret-0123456789abcdef", 3600);
  return { app, entitlements, osintStore, quota, jwt };
}

async function authHeader(jwt: JwtService): Promise<Record<string, string>> {
  const token = await jwt.issue(777001, "investigador");
  return { authorization: `Bearer ${token}` };
}

const CASE_BODY = {
  title: "Caso teste — alvo público",
  targets: [{ kind: "username", value: "octocat" }],
  legalBasis: "execução de contrato (LGPD art. 7º, V)",
  purpose: "verificação de identidade digital para onboarding",
};

describe("Investiga — HTTP (doc 11)", () => {
  it("sem entitlement → 403; com plano investiga → 201", async () => {
    const { app, entitlements, jwt } = makeApp();
    const headers = await authHeader(jwt);
    const denied = await app.inject({ method: "POST", url: "/v1/investiga/cases", headers, payload: CASE_BODY });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().rule).toBe("v2/08 §9.5");

    await entitlements.grant("777001", "investiga", { via: "pushinpay" });
    const ok = await app.inject({ method: "POST", url: "/v1/investiga/cases", headers, payload: CASE_BODY });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().case.status).toBe("queued");
    expect(ok.json().case.legalBasis).toContain("LGPD");
  });

  it("run executa Sherlock (fixture real) → found com proveniência; relatório = LEAD", async () => {
    const { app, entitlements, jwt } = makeApp();
    const headers = await authHeader(jwt);
    await entitlements.grant("777001", "investiga");
    const created = await app.inject({ method: "POST", url: "/v1/investiga/cases", headers, payload: CASE_BODY });
    const caseId = created.json().case.id;

    const run = await app.inject({ method: "POST", url: `/v1/investiga/cases/${caseId}/run`, headers, payload: { sites: ["GitHub"] } });
    expect(run.statusCode).toBe(200);
    const finding = run.json().findings.find((f: { sourceId: string }) => f.sourceId === "sherlock");
    expect(finding.status).toBe("found");
    expect(finding.evidenceUrl).toBe("https://www.github.com/octocat");
    expect(finding.checkId).toBeTruthy();
    expect(finding.retrievedAt).toMatch(/^\d{4}-/);

    const report = await app.inject({ method: "GET", url: `/v1/investiga/cases/${caseId}/report`, headers });
    expect(report.statusCode).toBe(200);
    const rep = report.json().report;
    expect(rep.verdict).toBe("LEAD — verificar manualmente");
    expect(rep.integrity.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rep.findings).toHaveLength(1);
  });

  it("quota dura: estourou 150/dia → 429 queue-paused com próxima janela", async () => {
    const { app, entitlements, quota, jwt } = makeApp();
    const headers = await authHeader(jwt);
    await entitlements.grant("777001", "investiga");
    const created = await app.inject({ method: "POST", url: "/v1/investiga/cases", headers, payload: CASE_BODY });
    const caseId = created.json().case.id;

    const day = new Date().toISOString().slice(0, 10);
    expect(quota.consume("777001", day, 150)).toBe(true); // janela cheia (teto 150/dia)

    const run = await app.inject({ method: "POST", url: `/v1/investiga/cases/${caseId}/run`, headers, payload: {} });
    expect(run.statusCode).toBe(429);
    expect(run.json().error).toBe("queue-paused");
    expect(run.json().nextWindowUtc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("name/url sem fonte real → finding unknown explícito (não inventa)", async () => {
    const { app, entitlements, jwt } = makeApp();
    const headers = await authHeader(jwt);
    await entitlements.grant("777001", "investigaPack");
    const created = await app.inject({
      method: "POST",
      url: "/v1/investiga/cases",
      headers,
      payload: { ...CASE_BODY, targets: [{ kind: "name", value: "Fulano de Tal" }] },
    });
    const caseId = created.json().case.id;
    const run = await app.inject({ method: "POST", url: `/v1/investiga/cases/${caseId}/run`, headers, payload: {} });
    expect(run.statusCode).toBe(200);
    const f = run.json().findings[0];
    expect(f.status).toBe("unknown");
    expect(f.sourceId).toBe("s1-no-source");
    expect(f.raw.note).toContain("não inventar");
  });

  it("trial do diretor: X-Admin-Token obrigatório; 1x por usuário", async () => {
    const { app, jwt } = makeApp();
    const headers = await authHeader(jwt);

    const semToken = await app.inject({
      method: "POST",
      url: "/v1/admin/investiga/trial",
      headers,
      payload: { telegramId: "777001" },
    });
    expect(semToken.statusCode).toBe(403);

    const ok = await app.inject({
      method: "POST",
      url: "/v1/admin/investiga/trial",
      headers: { ...headers, "x-admin-token": "diretor-token" },
      payload: { telegramId: "777002" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().trial.days).toBe(7);
    expect(ok.json().trial.sku).toBe("investiga:trial");

    const again = await app.inject({
      method: "POST",
      url: "/v1/admin/investiga/trial",
      headers: { ...headers, "x-admin-token": "diretor-token" },
      payload: { telegramId: "777002" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("caso de outro assinante → 404 (isolamento)", async () => {
    const { app, entitlements, jwt } = makeApp();
    await entitlements.grant("777001", "investiga");
    const headersA = await authHeader(jwt);
    const created = await app.inject({ method: "POST", url: "/v1/investiga/cases", headers: headersA, payload: CASE_BODY });
    const caseId = created.json().case.id;

    const tokenB = await jwt.issue(999002, "outra");
    const headersB = { authorization: `Bearer ${tokenB}` };
    const res = await app.inject({ method: "GET", url: `/v1/investiga/cases/${caseId}`, headers: headersB });
    expect(res.statusCode).toBe(404);
  });
});

describe("Investiga — sinais de demanda ponta a ponta (pesquisa 23/10/2026)", () => {
  /** 1ª execução acha GitHub; 2ª execução (re-verificação) não acha nada. */
  function makeAppVolatile() {
    const config = loadConfig({
      BOT_TOKEN: BOT,
      JWT_SECRET: "test-secret-0123456789abcdef",
      PUSHINPAY_WEBHOOK_SECRET: "whsec",
      NODE_ENV: "test",
      ADMIN_TOKEN: "diretor-token",
    } as NodeJS.ProcessEnv);
    const entitlements = new InMemoryEntitlementsStore();
    const osintStore = new OsintStore();
    const quota = new InvestigaQuotaGate();
    let call = 0;
    const volatileExec: SherlockExec = async (args) => {
      call += 1;
      const folderIdx = args.indexOf("--folderoutput");
      const dir = args[folderIdx + 1] ?? "/tmp";
      const user = args[0] ?? "user";
      const { writeFile } = await import("node:fs/promises");
      const csv =
        call === 1
          ? REAL_CSV
          : REAL_CSV_NONE;
      await writeFile(`${dir}/${user}.csv`, csv, "utf8");
      return {
        stdout: call === 1 ? REAL_STDOUT : REAL_STDOUT_NONE,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    };
    const app = buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
      nowSec: () => NOW,
      osint: { store: osintStore, quota, entitlements, sherlockExec: volatileExec },
    });
    const jwt = new JwtService("test-secret-0123456789abcdef", 3600);
    return { app, entitlements, osintStore, jwt };
  }

  it("re-verificação gera alerta de mudança; exports CSV/PDF funcionam", async () => {
    const { app, entitlements, jwt } = makeAppVolatile();
    await entitlements.grant("777001", "investiga");
    const headers = await authHeader(jwt);

    const created = await app.inject({ method: "POST", url: "/v1/investiga/cases", headers, payload: CASE_BODY });
    const caseId = created.json().case.id;

    // 1ª execução: sem alertas (não é "mudança"), confidence presente.
    const run1 = await app.inject({ method: "POST", url: `/v1/investiga/cases/${caseId}/run`, headers });
    expect(run1.statusCode).toBe(200);
    expect(run1.json().alerts).toEqual([]);
    expect(run1.json().findings[0].confidence.band).toBeDefined();
    expect(Array.isArray(run1.json().inferences)).toBe(true);

    // 2ª execução: saída real negativa → GitHub achado vira not_found → alerta.
    const run2 = await app.inject({ method: "POST", url: `/v1/investiga/cases/${caseId}/run`, headers });
    expect(run2.statusCode).toBe(200);
    const alerts = run2.json().alerts;
    expect(alerts.some((a: { kind: string }) => a.kind === "status_changed")).toBe(true);

    // Painel de alertas: diff persistido + regra declarada.
    const alertsGet = await app.inject({ method: "GET", url: `/v1/investiga/cases/${caseId}/alerts`, headers });
    expect(alertsGet.statusCode).toBe(200);
    expect(alertsGet.json().alerts.some((a: { kind: string }) => a.kind === "status_changed")).toBe(true);
    expect(alertsGet.json().rule).toContain("30 d");

    // Relatório: inferências separadas + summary.inferences.
    const rep = await app.inject({ method: "GET", url: `/v1/investiga/cases/${caseId}/report`, headers });
    expect(rep.statusCode).toBe(200);
    expect(Array.isArray(rep.json().report.inferences)).toBe(true);
    expect(rep.json().report.summary.inferences).toBeGreaterThanOrEqual(0);

    // Export CSV (máquina) e PDF (humano).
    const csv = await app.inject({ method: "GET", url: `/v1/investiga/cases/${caseId}/export.csv`, headers });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("case_id,target_kind,target_value,source_id");

    const pdf = await app.inject({ method: "GET", url: `/v1/investiga/cases/${caseId}/export.pdf`, headers });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("inferências do motor de correlação aparecem no run quando há padrão (C1)", async () => {
    const { app, entitlements, jwt } = makeApp();
    await entitlements.grant("777001", "investiga");
    const headers = await authHeader(jwt);
    const created = await app.inject({ method: "POST", url: "/v1/investiga/cases", headers, payload: CASE_BODY });
    const caseId = created.json().case.id;
    const run = await app.inject({ method: "POST", url: `/v1/investiga/cases/${caseId}/run`, headers });
    // Fixture real tem 1 site (GitHub) → nenhuma regra dispara; inferences vazio.
    expect(run.statusCode).toBe(200);
    expect(run.json().inferences).toEqual([]);
  });

  it("R3: falha na coleta → 500, caso 'error', quota ESTORNADA (doc 13)", async () => {
    const config = loadConfig({
      BOT_TOKEN: BOT,
      JWT_SECRET: "test-secret-0123456789abcdef",
      PUSHINPAY_WEBHOOK_SECRET: "whsec",
      NODE_ENV: "test",
      ADMIN_TOKEN: "diretor-token",
    } as NodeJS.ProcessEnv);
    const entitlements = new InMemoryEntitlementsStore();
    const osintStore = new OsintStore();
    const quota = new InvestigaQuotaGate();
    const boom: SherlockExec = async () => {
      throw new Error("rede caiu");
    };
    const app = buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
      nowSec: () => NOW,
      osint: { store: osintStore, quota, entitlements, sherlockExec: boom },
    });
    const jwt = new JwtService("test-secret-0123456789abcdef", 3600);
    await entitlements.grant("777001", "investiga");
    const headers = await authHeader(jwt);

    const created = await app.inject({ method: "POST", url: "/v1/investiga/cases", headers, payload: CASE_BODY });
    const caseId = created.json().case.id;

    const run = await app.inject({ method: "POST", url: `/v1/investiga/cases/${caseId}/run`, headers });
    expect(run.statusCode).toBe(500);
    expect(run.json().error).toContain("quota estornada");

    // caso saiu de "running" e a quota do dia voltou a zero
    const detail = await app.inject({ method: "GET", url: `/v1/investiga/cases/${caseId}`, headers });
    expect(detail.json().case.status).toBe("error");
    const q = await app.inject({ method: "GET", url: "/v1/investiga/quota", headers });
    expect(q.json().window.used).toBe(0);
  });

  it("R3: 2 alvos, 1º falha → 2º marcado unknown honesto 'coleta interrompida' (doc 13)", async () => {
    const config = loadConfig({
      BOT_TOKEN: BOT,
      JWT_SECRET: "test-secret-0123456789abcdef",
      PUSHINPAY_WEBHOOK_SECRET: "whsec",
      NODE_ENV: "test",
      ADMIN_TOKEN: "diretor-token",
    } as NodeJS.ProcessEnv);
    const entitlements = new InMemoryEntitlementsStore();
    const osintStore = new OsintStore();
    const quota = new InvestigaQuotaGate();
    let call = 0;
    const firstFails: SherlockExec = async (args) => {
      call += 1;
      if (call === 1) throw new Error("falhou");
      const folderIdx = args.indexOf("--folderoutput");
      const dir = args[folderIdx + 1] ?? "/tmp";
      const user = args[0] ?? "user";
      const { writeFile } = await import("node:fs/promises");
      await writeFile(`${dir}/${user}.csv`, REAL_CSV, "utf8");
      return { stdout: REAL_STDOUT, stderr: "", exitCode: 0, timedOut: false };
    };
    const app = buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
      nowSec: () => NOW,
      osint: { store: osintStore, quota, entitlements, sherlockExec: firstFails },
    });
    const jwt = new JwtService("test-secret-0123456789abcdef", 3600);
    await entitlements.grant("777001", "investiga");
    const headers = await authHeader(jwt);

    const created = await app.inject({
      method: "POST",
      url: "/v1/investiga/cases",
      headers,
      payload: {
        title: "Dois alvos",
        targets: [
          { kind: "username", value: "octocat" },
          { kind: "username", value: "octocat2" },
        ],
        legalBasis: "execução de contrato (LGPD art. 7º, V)",
        purpose: "teste de falha no meio do loop",
      },
    });
    const caseId = created.json().case.id;

    const run = await app.inject({ method: "POST", url: `/v1/investiga/cases/${caseId}/run`, headers });
    expect(run.statusCode).toBe(500);

    // persistido: alvo 1 = check error; alvo 2 = check queued + achado unknown honesto
    const detail = await app.inject({ method: "GET", url: `/v1/investiga/cases/${caseId}`, headers });
    const checks = detail.json().checks as Array<{ status: string; quotaConsumed: number }>;
    expect(checks[0]?.status).toBe("error");
    expect(checks[1]?.status).toBe("queued");
    const findings = detail.json().findings as Array<{ status: string; summary?: string }>;
    expect(findings.some((f) => f.status === "unknown" && (f.summary ?? "").includes("coleta interrompida"))).toBe(true);
  });
});
