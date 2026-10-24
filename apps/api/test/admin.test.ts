/**
 * Painel do administrador — RBAC por operador, login, audit hash-chain,
 * rules_config (preços/trial) com rollback, verificação V1 humana (plano §2).
 */
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { InMemoryAdminStore, auditHash, can, hashPassword, verifyPassword } from "../src/admin/service.js";
import { signInitData } from "../src/security/telegram-initdata.js";
import type { CashInInput, CashInResult, PushinpayClient, TransactionView } from "../src/payments/pushinpay.js";

const BOT = "123456789:TEST_TOKEN_AAA-BBB";

function makeApp() {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "adm-tok",
  } as NodeJS.ProcessEnv);
  const adminStore = new InMemoryAdminStore();
  const app = buildApp({
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
  });
  return { app, adminStore };
}

async function login(app: ReturnType<typeof makeApp>["app"], email: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password } });
  return res.json().token as string;
}

async function seedDiretor(store: InMemoryAdminStore): Promise<void> {
  const { ensureDiretor } = await import("../src/admin/service.js");
  await ensureDiretor(store, "senha-do-diretor-123");
}

describe("admin — RBAC por operador", () => {
  it("matriz de permissões: diretor tudo; auditor só leitura; suporte_oab só verificacoes", () => {
    expect(can("diretor", "operadores")).toBe(true);
    expect(can("auditor", "rules")).toBe(true);
    expect(can("auditor", "operadores")).toBe(false);
    expect(can("suporte_oab", "verificacoes")).toBe(true);
    expect(can("suporte_oab", "assinaturas")).toBe(false);
    expect(can("operador_mod", "assinaturas")).toBe(false);
  });

  it("login inválido → 401 + audit; diretor loga e cria operador; operador sem permissão → 403", async () => {
    const { app, adminStore } = makeApp();
    await seedDiretor(adminStore);
    const bad = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email: "diretor@acompanhe.app", password: "errada123" } });
    expect(bad.statusCode).toBe(401);

    const t = await login(app, "diretor@acompanhe.app", "senha-do-diretor-123");
    const H = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    const me = await app.inject({ method: "GET", url: "/v1/admin/auth/me", headers: H });
    expect(me.json().admin.role).toBe("diretor");

    const op = await app.inject({
      method: "POST",
      url: "/v1/admin/operadores",
      headers: H,
      payload: { email: "suporte@acompanhe.app", name: "Suporte", role: "operador_suporte", password: "outra-senha-123" },
    });
    expect(op.statusCode).toBe(201);

    const t2 = await login(app, "suporte@acompanhe.app", "outra-senha-123");
    const H2 = { authorization: `Bearer ${t2}`, "content-type": "application/json" };
    expect((await app.inject({ method: "GET", url: "/v1/admin/operadores", headers: H2 })).statusCode).toBe(403); // sem permissão
    expect((await app.inject({ method: "GET", url: "/v1/admin/verificacoes", headers: H2 })).statusCode).toBe(200); // papel dele
    expect((await app.inject({ method: "GET", url: "/v1/admin/operadores", headers: { authorization: `Bearer ${t}` } })).statusCode).toBe(200);
  });
});

describe("admin — audit hash-chain + rules + verificação", () => {
  it("ações geram cadeia verificável (cadeiaOk=true) e adulteração quebra", async () => {
    const { app, adminStore } = makeApp();
    await seedDiretor(adminStore);
    const t = await login(app, "diretor@acompanhe.app", "senha-do-diretor-123");
    const H = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    await app.inject({ method: "POST", url: "/v1/admin/rules", headers: H, payload: { scope: "plans", key: "anota", valueJson: { monthlyCents: 1990 } } });
    const audit = await app.inject({ method: "GET", url: "/v1/admin/audit", headers: H });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().cadeiaOk).toBe(true);
    expect(audit.json().entries.length).toBeGreaterThanOrEqual(2); // login + rule

    // adulterar 1 entrada na memória → cadeia quebra
    const entry = (await adminStore.auditList(10))[0]!;
    entry.after = { hackeado: true };
    const audit2 = await app.inject({ method: "GET", url: "/v1/admin/audit", headers: H });
    expect(audit2.json().cadeiaOk).toBe(false);
  });

  it("rules: preço do plano definido no painel + rollback restaura", async () => {
    const { app, adminStore } = makeApp();
    await seedDiretor(adminStore);
    const t = await login(app, "diretor@acompanhe.app", "senha-do-diretor-123");
    const H = { authorization: `Bearer ${t}`, "content-type": "application/json" };

    // /api/planos reflete default ANTES da regra
    const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 7, first_name: "U" }) }, BOT);
    const ut = (await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } })).json().token as string;
    const p0 = await app.inject({ method: "GET", url: "/api/planos", headers: { authorization: `Bearer ${ut}` } });
    expect(p0.json().planos[0].monthlyCents).toBe(1490);
    expect(p0.json().planos[0].priceOverridden).toBe(false);

    const r0 = await app.inject({ method: "POST", url: "/v1/admin/rules", headers: H, payload: { scope: "plans", key: "anota", valueJson: { monthlyCents: 1990, yearlyCents: 19900 } } });
    expect(r0.statusCode).toBe(201);
    const r1 = await app.inject({ method: "POST", url: "/v1/admin/rules", headers: H, payload: { scope: "plans", key: "anota", valueJson: { monthlyCents: 2990, yearlyCents: 29900 } } });
    expect(r1.statusCode).toBe(201);
    const p1 = await app.inject({ method: "GET", url: "/api/planos", headers: { authorization: `Bearer ${ut}` } });
    expect(p1.json().planos[0].monthlyCents).toBe(2990); // preço do PAINEL (v2)
    expect(p1.json().planos[0].priceOverridden).toBe(true);

    // trial editável
    await app.inject({ method: "POST", url: "/v1/admin/rules", headers: H, payload: { scope: "trial", key: "days", valueJson: { days: 3 } } });
    const p2 = await app.inject({ method: "GET", url: "/api/planos", headers: { authorization: `Bearer ${ut}` } });
    expect(p2.json().trialDias).toBe(3);

    // rollback do preço (v2 → volta a v1)
    const rb = await app.inject({ method: "POST", url: `/v1/admin/rules/${r1.json().rule.id}/rollback`, headers: H });
    expect(rb.statusCode).toBe(200);
    const p3 = await app.inject({ method: "GET", url: "/api/planos", headers: { authorization: `Bearer ${ut}` } });
    expect(p3.json().planos[0].monthlyCents).toBe(1990); // restaura a v1
  });

  it("verificação V1: usuário submete → diretor aprova → A3 liberado", async () => {
    const { app, adminStore } = makeApp();
    await seedDiretor(adminStore);
    const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 8, first_name: "V" }) }, BOT);
    const ut = (await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } })).json().token as string;
    const HU = { authorization: `Bearer ${ut}`, "content-type": "application/json" };
    await app.inject({ method: "POST", url: "/api/minhas/verificacao", headers: HU, payload: { docTipo: "rg" } });

    const t = await login(app, "diretor@acompanhe.app", "senha-do-diretor-123");
    const H = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    const ok = await app.inject({ method: "POST", url: "/v1/admin/verificacoes/8/aprovar", headers: H });
    expect(ok.statusCode).toBe(200);
    const v = await app.inject({ method: "GET", url: "/api/minhas/verificacao", headers: HU });
    expect(v.json().verificacao.v1Status).toBe("approved");
    expect(v.json().verificacao.approvedAt).toBeTruthy();

    // concessão manual de assinatura pelo painel
    const g = await app.inject({ method: "POST", url: "/v1/admin/assinaturas/conceder", headers: H, payload: { tgUserId: "8", planCode: "juridica", days: 30 } });
    expect(g.statusCode).toBe(200);
    const s = await app.inject({ method: "GET", url: "/api/assinaturas", headers: HU });
    expect(s.json().entitlement.skus).toContain("juridica");
  });
});

describe("utilitários de senha/audit", () => {
  it("hash scrypt: senha errada não passa; auditHash é estável", () => {
    const h = hashPassword("minha-senha-123");
    expect(verifyPassword("minha-senha-123", h)).toBe(true);
    expect(verifyPassword("errada", h)).toBe(false);
    const base = { actorId: "a", actorRole: "diretor", action: "x", target: null, before: null, after: null, ip: null, ts: "2026-10-23T00:00:00.000Z" };
    expect(auditHash("p1", base)).toBe(auditHash("p1", base));
    expect(auditHash("p1", base)).not.toBe(auditHash("p2", base));
  });
});
