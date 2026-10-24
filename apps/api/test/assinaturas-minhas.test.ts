/**
 * Assinaturas + AnotA (minhas) — contrato das rotas novas (plano §1.0/§1.1).
 * PushinPay é injetado (fake) — o cliente real já tem testes próprios;
 * aqui se prova o FLUXO: checkout → webhook/efeito → SKU + assinatura.
 */
import { describe, expect, it } from "vitest";

import { buildApp, EffectfulPaymentStore } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { InMemoryEntitlementsStore } from "../src/entitlements.js";
import { InMemorySubscriptionsStore } from "../src/assinaturas/service.js";
import { signInitData } from "../src/security/telegram-initdata.js";
import type { CashInInput, CashInResult, PushinpayClient, TransactionView } from "../src/payments/pushinpay.js";

const BOT = "123456789:TEST_TOKEN_AAA-BBB";

function fakePushinpay(): PushinpayClient & { calls: CashInInput[] } {
  const calls: CashInInput[] = [];
  return {
    calls,
    async cashIn(input: CashInInput): Promise<CashInResult> {
      calls.push(input);
      return { id: `TX${calls.length}`, qrCode: "00020126PIX", status: "created", value: input.valueCents };
    },
    async transaction(id: string): Promise<TransactionView | null> {
      return { id, status: "paid", value: 1490 };
    },
  } as unknown as PushinpayClient & { calls: CashInInput[] };
}

function makeApp() {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "adm-tok",
    PUBLIC_BASE_URL: "https://app.example",
  } as NodeJS.ProcessEnv);
  const entitlements = new InMemoryEntitlementsStore();
  const subs = new InMemorySubscriptionsStore();
  const payments = new EffectfulPaymentStore(new InMemoryPaymentStore(), entitlements, subs);
  const pushinpay = fakePushinpay();
  const app = buildApp({ config, payments, pushinpay, osint: { entitlements }, assinaturas: { subs } });
  return { app, payments, entitlements, subs, pushinpay };
}

async function token(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 9, first_name: "A" }) }, BOT);
  return (await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } })).json().token as string;
}

describe("assinaturas — planos/checkout/trial/efeito", () => {
  it("GET /api/planos lista 5 SKUs com preços canônicos", async () => {
    const ctx = makeApp();
    const t = await token(ctx.app);
    const res = await ctx.app.inject({ method: "GET", url: "/api/planos", headers: { authorization: `Bearer ${t}` } });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.planos.length).toBe(5);
    expect(j.planos[0].monthlyCents).toBe(1490); // AnotA R$14,90
    expect(j.trialDias).toBe(7);
    expect(j.trialDisponivel).toBe(true);
  });

  it("checkout → QR PIX; efeito pago concede SKU + assinatura (idempotente)", async () => {
    const ctx = makeApp();
    const t = await token(ctx.app);
    const H = { authorization: `Bearer ${t}` };
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/assinaturas/checkout",
      headers: H,
      payload: { planCode: "anota", period: "monthly", idempotencyKey: "chk-12345678" },
    });
    expect(res.statusCode).toBe(200);
    const co = res.json().checkout;
    expect(co.qrCode.length).toBeGreaterThan(10);
    expect(co.valueCents).toBe(1490);
    expect(ctx.pushinpay.calls[0]!.webhookUrl).toBe("https://app.example/api/webhooks/pushinpay");

    // efeito do webhook (mesmo contrato do PaymentStore)
    await ctx.payments.save({
      providerIdLower: "tx1",
      amountCents: 1490,
      currency: "BRL",
      channel: "pushinpay",
      status: "created",
      refType: "subscription",
      refId: "anota",
      userId: "9",
      createdAt: new Date().toISOString(),
      effectApplied: false,
    });
    expect(await ctx.payments.applyPaidEffect("tx1", new Date().toISOString())).toBe(true);
    expect(await ctx.payments.applyPaidEffect("tx1", new Date().toISOString())).toBe(false); // idempotente
    expect(await ctx.entitlements.isEntitled("9", ["anota"])).toBe(true);
    expect((await ctx.subs.listByUser("9")).length).toBe(1);

    const st = await ctx.app.inject({ method: "GET", url: "/api/assinaturas", headers: H });
    expect(st.json().assinaturas[0].planCode).toBe("anota");
  });

  it("trial 7d concede sku plano:trial e 2ª chamada → 409", async () => {
    const ctx = makeApp();
    const t = await token(ctx.app);
    const H = { authorization: `Bearer ${t}` };
    const r1 = await ctx.app.inject({ method: "POST", url: "/api/assinaturas/trial", headers: H, payload: { planCode: "concurso" } });
    expect(r1.statusCode).toBe(200);
    expect(await ctx.entitlements.isEntitled("9", ["concurso:trial"])).toBe(true);
    const r2 = await ctx.app.inject({ method: "POST", url: "/api/assinaturas/trial", headers: H, payload: { planCode: "concurso" } });
    expect(r2.statusCode).toBe(409);
  });
});

describe("AnotA — notas/gastos/resumo/CSV", () => {
  it("CRUD de notas + fixar + tags", async () => {
    const ctx = makeApp();
    const t = await token(ctx.app);
    const H = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    const c = await ctx.app.inject({ method: "POST", url: "/api/minhas/notas", headers: H, payload: { title: "Compras", body: "arroz feijão", tags: ["casa"] } });
    expect(c.statusCode).toBe(201);
    const id = c.json().nota.id;
    const u = await ctx.app.inject({ method: "PUT", url: `/api/minhas/notas/${id}`, headers: H, payload: { pinned: true } });
    expect(u.json().nota.pinned).toBe(true);
    const l = await ctx.app.inject({ method: "GET", url: "/api/minhas/notas", headers: H });
    expect(l.json().notas.length).toBe(1);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/minhas/notas/${id}`, headers: H })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/minhas/notas", headers: H })).json().notas.length).toBe(0);
  });

  it("gasto: OCR manual honesto (sem provider NÃO inventa texto) + resumo + CSV", async () => {
    const ctx = makeApp();
    const t = await token(ctx.app);
    const H = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    const g = await ctx.app.inject({
      method: "POST",
      url: "/api/minhas/gastos",
      headers: H,
      payload: { amountCents: 5990, category: "mercado", description: "feira", spentAt: "2026-10-05T10:00:00.000Z", photoBase64: "AAAA" },
    });
    expect(g.statusCode).toBe(201);
    expect(g.json().ocr.textoExtraido).toBe(false); // imagem inválida → NENHUM texto inventado
    expect(String(g.json().gasto.ocrEngine ?? "manual")).toMatch(/^(manual|tesseract)/);
    await ctx.app.inject({
      method: "POST",
      url: "/api/minhas/gastos",
      headers: H,
      payload: { amountCents: 1200, category: "transporte", description: "bus", spentAt: "2026-10-06T10:00:00.000Z", ocrText: "R$ 12,00 bus" },
    });
    const resumo = await ctx.app.inject({ method: "GET", url: "/api/minhas/resumo?ym=2026-10", headers: H });
    expect(resumo.json().resumo.totalCents).toBe(7190);
    expect(resumo.json().resumo.porCategoria.length).toBe(2);
    const csv = await ctx.app.inject({ method: "GET", url: "/api/minhas/export.csv", headers: H });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain("gasto");
    expect(csv.headers["content-type"]).toContain("text/csv");
  });

  it("verificação V1: submit → pending; empréstimos minhas + dividas", async () => {
    const ctx = makeApp();
    const t = await token(ctx.app);
    const H = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    const v = await ctx.app.inject({ method: "POST", url: "/api/minhas/verificacao", headers: H, payload: { docTipo: "cnh" } });
    expect(v.statusCode).toBe(201);
    expect(v.json().v1Status).toBe("pending");
    const vg = await ctx.app.inject({ method: "GET", url: "/api/minhas/verificacao", headers: H });
    expect(vg.json().verificacao.docTipo).toBe("cnh");
    const em = await ctx.app.inject({ method: "GET", url: "/api/minhas/emprestimos", headers: H });
    expect(em.json().matches.length).toBe(0);
    const dv = await ctx.app.inject({ method: "GET", url: "/api/minhas/dividas", headers: H });
    expect(dv.json().limiteAtivos).toBe(3);
  });

  it("filtros salvos de licitação e concursos (CRUD por produto)", async () => {
    const ctx = makeApp();
    const t = await token(ctx.app);
    const H = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    const f1 = await ctx.app.inject({ method: "POST", url: "/api/licitacoes/filtros", headers: H, payload: { name: "MT impressos", filter: { uf: "MT", q: "impressos" } } });
    expect(f1.statusCode).toBe(201);
    const f2 = await ctx.app.inject({ method: "POST", url: "/api/concursos/filtros", headers: H, payload: { name: "PF", filter: { banca: "FCC" } } });
    expect(f2.statusCode).toBe(201);
    const l1 = await ctx.app.inject({ method: "GET", url: "/api/licitacoes/filtros", headers: H });
    expect(l1.json().filtros.length).toBe(1);
    const l2 = await ctx.app.inject({ method: "GET", url: "/api/concursos/filtros", headers: H });
    expect(l2.json().filtros.length).toBe(1);
    const del = await ctx.app.inject({ method: "DELETE", url: "/api/licitacoes/filtros/MT%20impressos", headers: H });
    expect(del.statusCode).toBe(200);
  });
});

describe("OCR real (tesseract) — só se o binário existir no host", () => {
  it("extrai texto de PNG gerado (PIL) sem inventar nada", async () => {
    const { detectTesseract } = await import("../src/minhas/ocr.js");
    const ocr = detectTesseract();
    if (!ocr) {
      console.warn("[ocr] tesseract ausente — teste pulado com aviso honesto");
      return;
    }
    const { execSync } = await import("node:child_process");
    const b64 = execSync(
      `python3 -c "from PIL import Image, ImageDraw; import base64,io; im=Image.new('RGB',(420,90),'white'); d=ImageDraw.Draw(im); d.text((12,32),'TOTAL R$ 45,90 MERCADO',fill='black'); b=io.BytesIO(); im.save(b,'PNG'); print(base64.b64encode(b.getvalue()).decode())"`,
    ).toString().trim();
    const r = await ocr.extract(b64);
    expect(r.engine).toBe("tesseract");
    expect(r.text).toBeTruthy();
    expect(r.text).toContain("45");
    expect(r.text).toContain("MERCADO");
  });
});
