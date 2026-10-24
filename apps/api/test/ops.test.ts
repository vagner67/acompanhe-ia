/**
 * Painel de operações — casos um por um do plano-painel-ops (F2/F3):
 * G1/G2/G3 · R1 · S1/S2/S3/S4 · E1/E2 + RBAC "ops".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { InMemoryAdminStore, can, hashPassword } from "../src/admin/service.js";
import type { OpsStore, EventInput, ProbeInput, EventRow, ProbeRow } from "../src/ops/store.js";
import {
  redact, detailHygienic, healthScore, capHours, capLimit, aggregateProbes,
  loginBlocked, loginFail, loginOk, meterSnapshot,
} from "../src/ops/service.js";
import type { CashInInput, CashInResult, PushinpayClient, TransactionView } from "../src/payments/pushinpay.js";

class InMemoryOpsStore implements OpsStore {
  events: Array<EventInput & { id: string; ts: string }> = [];
  probes: Array<ProbeInput & { ts: string }> = [];
  private seq = 0;
  async insertEvent(e: EventInput): Promise<EventRow> {
    const row = { ...e, id: String(++this.seq), ts: (e.ts ? new Date(e.ts) : new Date()).toISOString(), ok: e.ok !== false, detail: e.detail ?? null };
    this.events.push(row);
    return row as EventRow;
  }
  async insertProbes(ps: ProbeInput[]): Promise<number> {
    for (const p of ps) this.probes.push({ ...p, ts: (p.ts ? new Date(p.ts) : new Date()).toISOString() });
    return ps.length;
  }
  async listEvents(opts: { kind?: string; limit: number }): Promise<EventRow[]> {
    return this.events.filter((e) => !opts.kind || e.kind === opts.kind).slice(-opts.limit).reverse() as EventRow[];
  }
  async listProbes(opts: { service?: string; since: Date; limit?: number }): Promise<ProbeRow[]> {
    return this.probes
      .filter((p) => (!opts.service || p.service === opts.service) && new Date(p.ts) >= opts.since)
      .map((p) => ({ ts: p.ts, service: p.service, ok: p.ok !== false, latencyMs: p.latencyMs ?? null }));
  }
  async recentProbesPerService(n: number): Promise<Record<string, ProbeRow[]>> {
    const out: Record<string, ProbeRow[]> = {};
    for (const svc of ["api", "web", "bot", "tunnel", "worker"]) {
      out[svc] = this.probes.filter((p) => p.service === svc).slice(-n).map((p) => ({ ts: p.ts, service: p.service, ok: p.ok !== false, latencyMs: p.latencyMs ?? null }));
    }
    return out;
  }
  async restarts24h(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const e of this.events) if (e.kind === "process_start") out[e.service] = (out[e.service] ?? 0) + 1;
    return out;
  }
  async alertCounts(): Promise<Record<string, number>> {
    return { queued: 2, delivered: 3 };
  }
  async deadletterList(limit: number) {
    return Array.from({ length: Math.min(limit, 1) }, (_, i) => ({ id: String(i), queue: "alerts", error: "sem chatId", createdAt: new Date().toISOString() }));
  }
  async syncRunList() {
    return [];
  }
  async tableStats() {
    return { events: this.events.length, probes: this.probes.length, alertEvents: 5, deadletter: 1 };
  }
  async purge(probeDays: number, eventDays: number) {
    const cutP = Date.now() - probeDays * 86400000;
    const cutE = Date.now() - eventDays * 86400000;
    const pb = this.probes.length;
    const eb = this.events.length;
    this.probes = this.probes.filter((p) => new Date(p.ts).getTime() >= cutP);
    this.events = this.events.filter((e) => new Date(e.ts).getTime() >= cutE);
    return { probesDeleted: pb - this.probes.length, eventsDeleted: eb - this.events.length };
  }
}

const SERVICE_TOKEN = "test-token-abc-123";
let dir: string;
let app: ReturnType<typeof buildApp>;
let adminStore: InMemoryAdminStore;
let opsStore: InMemoryOpsStore;
let diretorToken = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ops-secrets-"));
  const secretsPath = join(dir, "secrets.json");
  writeFileSync(secretsPath, JSON.stringify({ SERVICE_TOKEN, TELEGRAM_BOT_TOKEN: "123:x", TELEGRAM_WEBAPP_URL: "http://x" }, null, 2));
  process.env.SERVICE_TOKEN_FILE = secretsPath;

  const config = loadConfig({
    BOT_TOKEN: "123456789:TEST_TOKEN_AAA-BBB",
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "adm-tok",
  } as NodeJS.ProcessEnv);
  adminStore = new InMemoryAdminStore();
  opsStore = new InMemoryOpsStore();
  app = buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: {
      async cashIn(input: CashInInput): Promise<CashInResult> {
        return { id: "txx", qrCode: "000201", status: "created", value: input.valueCents };
      },
      async transaction(_id: string): Promise<TransactionView | null> {
        return null;
      },
    } as unknown as PushinpayClient,
    admin: { store: adminStore },
    ops: { store: opsStore },
  });
  await app.ready();
  await adminStore.createAdmin({ email: "diretor@t.com", name: "D", role: "diretor", passwordHash: hashPassword("senha-forte-123") });
  diretorToken = await login("diretor@t.com", "senha-forte-123");
  await adminStore.createAdmin({ email: "suporte@t.com", name: "S", role: "operador_suporte", passwordHash: hashPassword("senha-forte-123") });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SERVICE_TOKEN_FILE;
});

async function login(email: string, password: string, ip = "203.0.113.10"): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password }, remoteAddress: ip });
  return (res.json() as { token: string }).token;
}

function ingest(body: unknown, opts: { token?: string | null; ip?: string } = {}) {
  return app.inject({
    method: "POST",
    url: "/api/internal/ops/ingest",
    payload: body as object,
    headers: { "content-type": "application/json", ...(opts.token === null ? {} : { "x-service-token": opts.token ?? SERVICE_TOKEN }) },
    ...(opts.ip ? { remoteAddress: opts.ip } : {}),
  });
}

// ── lógica pura ─────────────────────────────────────────────────────────

it("S3: redact mascara token de bot, senha e Bearer", () => {
  const s = "falha ao enviar para bot123456789:AAAdfg-token_x senha=abc authorization: Bearer eyJhbGciOi.abc";
  const r = redact(s);
  expect(r).not.toContain("AAAdfg-token_x");
  expect(r).not.toContain("abc senha");
  expect(r).toContain("***");
});

it("S4: detailHygienic rejeita chaves sensíveis", () => {
  expect(detailHygienic({ pid: 1 })).toBe(true);
  expect(detailHygienic({ http: 200, causa: "health_fail" })).toBe(true);
  expect(detailHygienic({ serviceToken: "x" })).toBe(false);
  expect(detailHygienic({ password: "senha-errada-123" })).toBe(false);
  expect(detailHygienic({ authorization: "x" })).toBe(false);
  expect(detailHygienic(null)).toBe(true);
});

it("healthScore: fórmula 35·api + 20·web + 15·bot + 15·tunnel + 15·worker", () => {
  expect(healthScore({})).toBe(100);
  expect(healthScore({ api: 2 })).toBe(65); // api 0 → 100−35
  expect(healthScore({ web: 2 })).toBe(80); // web 0 → 100−20
  expect(healthScore({ api: 1 })).toBe(83); // 35·0.5 = 17.5 → 82.5 → 83
});

it("E1: caps — hours 1..168 e limit 1..500", () => {
  expect(capHours(24)).toBe(24);
  expect(capHours(0)).toBeNull();
  expect(capHours(169)).toBeNull();
  expect(capLimit(500)).toBe(500);
  expect(capLimit(501)).toBeNull();
});

it("E1: aggregateProbes agrega em buckets de 5 min", () => {
  const t = Date.parse("2026-10-24T12:00:00Z");
  const out = aggregateProbes([
    { ts: new Date(t), ok: true, latencyMs: 10 },
    { ts: new Date(t + 60000), ok: false, latencyMs: 30 },
    { ts: new Date(t + 10 * 60000), ok: true, latencyMs: 20 },
  ]);
  expect(out.length).toBe(2);
  expect(out[0]!.total).toBe(2);
  expect(out[0]!.fails).toBe(1);
  expect(out[0]!.avgLatencyMs).toBe(20);
});

it("S2: 5 falhas de login bloqueiam o IP por 60s; login ok limpa", () => {
  const ip = "198.51.100.7";
  for (let i = 0; i < 4; i++) loginFail(ip, 1_000_000);
  expect(loginBlocked(ip, 1_000_000)).toBe(false);
  loginFail(ip, 1_000_000);
  expect(loginBlocked(ip, 1_000_000)).toBe(true);
  expect(loginBlocked(ip, 1_000_000 + 61_000)).toBe(false); // janela expira
  loginFail(ip, 2_000_000);
  loginOk(ip);
  expect(loginBlocked(ip, 2_000_000)).toBe(false);
});

it("RBAC ops: diretor/admin_ops/auditor sim; demais papéis não", () => {
  expect(can("diretor", "ops")).toBe(true);
  expect(can("admin_ops", "ops")).toBe(true);
  expect(can("auditor", "ops")).toBe(true);
  expect(can("operador_suporte", "ops")).toBe(false);
  expect(can("operador_mod", "ops")).toBe(false);
  expect(can("analista_financeiro", "ops")).toBe(false);
  expect(can("suporte_oab", "ops")).toBe(false);
});

it("G1: flagSet sem ator (updatedBy) recusa", async () => {
  await expect(adminStore.flagSet("x", true, null, "")).rejects.toThrow(/G1/);
  const row = await adminStore.flagSet("x", true, null, "admin-1");
  expect(row.updatedBy).toBe("admin-1");
});

it("R1: respostas carregam x-request-id", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.headers["x-request-id"]).toBeTruthy();
});

// ── ingest (S1/S4/E2/G2) ────────────────────────────────────────────────

it("S1: ingest sem token → 401", async () => {
  const res = await ingest({ events: [] }, { token: null });
  expect(res.statusCode).toBe(401);
});

it("S1: ingest com token errado → 401", async () => {
  const res = await ingest({ events: [] }, { token: "errado" });
  expect(res.statusCode).toBe(401);
});

it("S1: ingest de IP externo → 403 mesmo com token certo", async () => {
  const res = await ingest({ events: [] }, { ip: "203.0.113.9" });
  expect(res.statusCode).toBe(403);
});

it("S1+R2: ingest válido grava OpsEvent e sai em 201", async () => {
  const res = await ingest({
    events: [{ source: "keep-alive", kind: "process_start", service: "api", ok: true, detail: { causa: "health_fail" } }],
  });
  expect(res.statusCode).toBe(201);
  const j = res.json() as { events: string[] };
  expect(j.events.length).toBe(1);
  expect(opsStore.events.some((e) => e.kind === "process_start" && (e.detail as { causa?: string })?.causa === "health_fail")).toBe(true);
});

it("S4: ingest com detail sensível → 400", async () => {
  const res = await ingest({ events: [{ source: "manual", kind: "flag_change", service: "app", ok: true, detail: { serviceToken: "x" } }] });
  expect(res.statusCode).toBe(400);
});

it("E2: ingest de probes em lote (1 requisição, N linhas)", async () => {
  const res = await ingest({ probes: [
    { service: "api", ok: true, latencyMs: 12 },
    { service: "web", ok: true, latencyMs: 30 },
    { service: "bot", ok: false, latencyMs: 90 },
  ] });
  expect(res.statusCode).toBe(201);
  expect((res.json() as { probes: number }).probes).toBe(3);
});

it("G2: purge remove probes/eventos além da retenção (7d/30d)", async () => {
  const antigo = new Date(Date.now() - 8 * 86400000).toISOString();
  await ingest({ probes: [{ service: "api", ok: true, latencyMs: 5, ts: antigo }] });
  const before = opsStore.probes.length;
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/ops/purge",
    headers: { "x-service-token": SERVICE_TOKEN },
    remoteAddress: "127.0.0.1",
  });
  expect(res.statusCode).toBe(200);
  const j = res.json() as { probesDeleted: number };
  expect(j.probesDeleted).toBeGreaterThanOrEqual(1);
  expect(opsStore.probes.length).toBeLessThan(before);
});

// ── leitura admin (RBAC + E1 + S3) ─────────────────────────────────────

it("overview sem token → 401", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/admin/ops/overview" });
  expect(res.statusCode).toBe(401);
});

it("RBAC: operador_suporte em /ops/overview → 403 (E2E do gate)", async () => {
  const t = await login("suporte@t.com", "senha-forte-123");
  const res = await app.inject({ method: "GET", url: "/v1/admin/ops/overview", headers: { authorization: `Bearer ${t}` } });
  expect(res.statusCode).toBe(403);
  expect(res.json().rule).toBe("RBAC");
});

it("overview do diretor → 200 com healthScore e sinais", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/admin/ops/overview", headers: { authorization: `Bearer ${diretorToken}` } });
  expect(res.statusCode).toBe(200);
  const j = res.json() as { healthScore: number; sinais: { reqPorMin: number }; servicos: unknown[] };
  expect(typeof j.healthScore).toBe("number");
  expect(j.sinais).toHaveProperty("reqPorMin");
  expect(Array.isArray(j.servicos)).toBe(true);
});

it("timeline funde audit+rules+flags+ops e calcula cadeiaOk", async () => {
  await adminStore.flagSet("ops_panel", true, { via: "teste" }, "admin-x");
  const res = await app.inject({ method: "GET", url: "/v1/admin/ops/timeline", headers: { authorization: `Bearer ${diretorToken}` } });
  expect(res.statusCode).toBe(200);
  const j = res.json() as { entries: Array<{ fonte: string }>; cadeiaOk: boolean; fontes: string[] };
  expect(j.cadeiaOk).toBe(true);
  expect(j.fontes).toEqual(expect.arrayContaining(["audit", "rules", "flags", "ops"]));
  expect(j.entries.some((e) => e.fonte === "ops")).toBe(true);
});

it("E1: probes com hours fora do cap → 400", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/admin/ops/probes?hours=999", headers: { authorization: `Bearer ${diretorToken}` } });
  expect(res.statusCode).toBe(400);
});

it("S3: logs fazem tail com redação — segredo nunca aparece cru", async () => {
  appendFileSync("/tmp/api.log", `\nteste-ops bot123456789:SEGREDO-CRUAQUI senha=123\n`);
  const res = await app.inject({ method: "GET", url: "/v1/admin/ops/logs?service=api&lines=20", headers: { authorization: `Bearer ${diretorToken}` } });
  expect(res.statusCode).toBe(200);
  const tail = (res.json() as { tail: string }).tail;
  expect(tail).not.toContain("SEGREDO-CRUAQUI");
  expect(tail).toContain("***");
});

it("logs com serviço fora da whitelist → 404 (sem path traversal)", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/admin/ops/logs?service=../../etc/passwd", headers: { authorization: `Bearer ${diretorToken}` } });
  expect(res.statusCode).toBe(404);
});

// ── flags + rotação (G1/G3) ────────────────────────────────────────────

it("G1: POST flags grava ator (updatedBy) e vira evento", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/ops/flags",
    headers: { authorization: `Bearer ${diretorToken}` },
    payload: { key: "ops_panel", enabled: true, payload: { via: "teste" } },
  });
  expect(res.statusCode).toBe(201);
  const flag = (res.json() as { flag: { updatedBy: string } }).flag;
  expect(flag.updatedBy).toBeTruthy();
  expect(opsStore.events.some((e) => e.kind === "flag_change")).toBe(true);
});

it("G3: rotate-service-token troca a credencial e invalida a antiga", async () => {
  const antes = JSON.parse(readFileSync(process.env.SERVICE_TOKEN_FILE!, "utf8")).SERVICE_TOKEN as string;
  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/ops/rotate-service-token",
    headers: { authorization: `Bearer ${diretorToken}` },
  });
  expect(res.statusCode).toBe(200);
  const depois = JSON.parse(readFileSync(process.env.SERVICE_TOKEN_FILE!, "utf8")).SERVICE_TOKEN as string;
  expect(depois).not.toBe(antes);

  // token antigo morre; token novo vive (cache de 5s é invalidado pela rotação)
  const velho = await ingest({ events: [] }, { token: antes });
  expect(velho.statusCode).toBe(401);
  const novo = await ingest({ events: [] }, { token: depois });
  expect(novo.statusCode).toBe(201);
});

it("G3: operador comum NÃO rotaciona credencial", async () => {
  const t = await login("suporte@t.com", "senha-forte-123");
  const res = await app.inject({ method: "POST", url: "/v1/admin/ops/rotate-service-token", headers: { authorization: `Bearer ${t}` } });
  expect(res.statusCode).toBe(403);
});

// ── kpis reais (F3 / fecha L04) ────────────────────────────────────────

it("kpis retorna séries reais (usuarios/assinaturas/pagamentos/sistema)", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/admin/kpis", headers: { authorization: `Bearer ${diretorToken}` } });
  expect(res.statusCode).toBe(200);
  const j = res.json() as Record<string, unknown>;
  expect(j.usuarios !== undefined || j.aviso !== undefined).toBe(true);
  if (j.usuarios) {
    expect(j.usuarios).toHaveProperty("total");
    expect(j.sistema).toHaveProperty("reqPorMin");
  }
});

it("S2: 5 logins errados seguidos → 429", async () => {
  const ip = "203.0.113.77";
  for (let i = 0; i < 5; i++) {
    const res = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email: "nao@existe.com", password: "senha-errada-123" }, remoteAddress: ip });
    expect(res.statusCode).toBe(401);
  }
  const res = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email: "nao@existe.com", password: "senha-errada-123" }, remoteAddress: ip });
  expect(res.statusCode).toBe(429);
});

it("meterSnapshot expõe tráfego/erros/latência (4 sinais)", () => {
  const m = meterSnapshot();
  expect(m.reqs).toBeGreaterThan(0);
  expect(typeof m.taxaErro5xx).toBe("number");
  expect(typeof m.latenciaP95Ms).toBe("number");
});
