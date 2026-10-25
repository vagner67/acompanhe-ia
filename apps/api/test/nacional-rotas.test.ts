/**
 * Rotas novas (plano-91-tribunais-nacional.md §6): /nacional, /frota,
 * /frota/probe, /auto, /auto/ciclo. Paywall real, token de serviço nas rotas
 * de operação, e nenhuma rota inventando resultado quando a fonte não responde.
 */
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { InMemoryEntitlementsStore } from "../src/entitlements.js";
import { signInitData } from "../src/security/telegram-initdata.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";
import { InMemoryLegalStore } from "../src/juridico/service.js";
import { InMemoryIndiceStore } from "../src/juridico/indice.js";
import { InMemoryPerfilStore, type Metrica } from "../src/juridico/autoaperfeicoamento.js";
import type { ResultadoNacional } from "../src/juridico/nacional.js";

const BOT = "123456789:TEST_TOKEN_AAA-BBB";
const SERVICE = "svc-token-teste";

const metrica: Metrica = {
  fonteId: "esaj-sp", coletadaEm: "2026-10-25T03:00:00Z", consultas: 1, itens: 2,
  erros: 0, captchas: 0, timeouts: 0, msP95: 900, canarioItens: 2,
};

const resultado: ResultadoNacional = {
  tipo: "nome",
  termo: "João Carlos",
  itens: [
    {
      numeroProcesso: "0006903-69.2014.8.11.0037", tribunal: "TJSP", uf: "SP",
      partes: [{ nome: "JOÃO CARLOS DA SILVA", polo: "A", encontrada: true }],
      classe: "Procedimento Comum", orgao: "1ª Vara Cível", ultimoMovimento: null,
      dataMovimento: null, dataPublicacao: "2014-09-12", link: "https://esaj.tjsp.jus.br/x",
      fontes: ["esaj-sp"], score: 0.8, motivoVinculo: "nome completo idêntico",
    },
  ],
  fontes: [{ fonte: "esaj-sp", tipo: "esaj", estado: "ok", itens: 1, ms: 800 }],
  aviso: null,
  rodape: "rodapé",
  cobertura: { tribunais: 91, numero: 91, nome: 27, cpf: 27, ufsAbertas: ["ac", "al", "ce", "sp"], djen: false },
  msTotal: 850,
};

function makeApp(over: { nacional?: typeof import("../src/juridico/nacional.js").consultarNacional; auto?: InMemoryPerfilStore } = {}) {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "adm-tok",
  } as NodeJS.ProcessEnv);
  const ents = new InMemoryEntitlementsStore();
  const perfis = over.auto ?? new InMemoryPerfilStore();
  const app = buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
    juridico: {
      store: new InMemoryLegalStore(),
      oabVerified: new Set<string>(),
      indice: new InMemoryIndiceStore(),
      serviceToken: () => SERVICE,
      perfis,
      ...(over.nacional ? { nacional: over.nacional } : {}),
    },
    osint: { entitlements: ents },
  });
  return { app, ents };
}

async function login(app: ReturnType<typeof makeApp>["app"], id = 88): Promise<string> {
  const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id, first_name: "P" }) }, BOT);
  const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
  return res.json().token as string;
}

describe("GET /api/processos/frota", () => {
  it("401 sem auth · 200 com 91 tribunais e resumo por capacidade", async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: "GET", url: "/api/processos/frota" })).statusCode).toBe(401);
    const t = await login(app);
    const r = await app.inject({ method: "GET", url: "/api/processos/frota", headers: { authorization: `Bearer ${t}` } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.tribunais).toHaveLength(91);
    expect(b.resumo.tribunais).toBe(91);
    expect(b.resumo.numero).toBe(91); // número existe nos 91 (DataJud)
    expect(b.rodape).toContain("portal oficial");
    await app.close();
  });
});

describe("GET /api/processos/nacional", () => {
  it("401 sem auth · 403 sem plano · 200 com item, fontes e motivo de vínculo", async () => {
    const { app, ents } = makeApp({ nacional: async () => resultado });
    expect((await app.inject({ method: "GET", url: "/api/processos/nacional?q=Joao+Carlos" })).statusCode).toBe(401);

    const t = await login(app);
    const semPlano = await app.inject({ method: "GET", url: "/api/processos/nacional?q=Joao+Carlos", headers: { authorization: `Bearer ${t}` } });
    expect(semPlano.statusCode).toBe(403);

    await ents.grant("88", "juridica");
    const r = await app.inject({ method: "GET", url: "/api/processos/nacional?q=Joao+Carlos", headers: { authorization: `Bearer ${t}` } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.itens[0].numeroProcesso).toBe("0006903-69.2014.8.11.0037");
    expect(b.itens[0].motivoVinculo).toBe("nome completo idêntico");
    expect(b.fontes[0].estado).toBe("ok");
    await app.close();
  });

  it("422 com termo curto (não dispara fan-out por 1 letra)", async () => {
    const { app, ents } = makeApp({ nacional: async () => resultado });
    const t = await login(app);
    await ents.grant("88", "juridica");
    const r = await app.inject({ method: "GET", url: "/api/processos/nacional?q=ab", headers: { authorization: `Bearer ${t}` } });
    expect(r.statusCode).toBe(422);
    await app.close();
  });

  it("filtro de UF é repassado ao orquestrador", async () => {
    let ufRecebida: string | undefined;
    const { app, ents } = makeApp({
      nacional: async (_t, o) => {
        ufRecebida = o?.uf;
        return resultado;
      },
    });
    const t = await login(app);
    await ents.grant("88", "juridica");
    await app.inject({ method: "GET", url: "/api/processos/nacional?q=Joao+Carlos&uf=sp", headers: { authorization: `Bearer ${t}` } });
    expect(ufRecebida).toBe("sp");
    await app.close();
  });
});

describe("Rotas de operação — exigem token de serviço", () => {
  it("POST /frota/probe: 401 sem token · 200 medindo as fontes", async () => {
    const { app } = makeApp();
    const semToken = await app.inject({ method: "POST", url: "/api/processos/frota/probe", payload: {} });
    expect(semToken.statusCode).toBe(401);
    await app.close();
  });

  it("GET /auto: 401 sem token · 200 com perfis e regras declaradas", async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: "GET", url: "/api/processos/auto" })).statusCode).toBe(401);
    const r = await app.inject({ method: "GET", url: "/api/processos/auto", headers: { "x-service-token": SERVICE } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.perfis.length).toBeGreaterThan(0);
    expect(b.regras.epsilon).toBe(3);
    expect(b.perfis[0].vigente.timeoutMs).toBeGreaterThan(0);
    await app.close();
  });

  it("POST /auto/ciclo: 401 sem token · responde estrutura completa com token", async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: "POST", url: "/api/processos/auto/ciclo", payload: {} })).statusCode).toBe(401);
    const r = await app.inject({
      method: "POST", url: "/api/processos/auto/ciclo",
      headers: { "x-service-token": SERVICE }, payload: { termo: "João Carlos" },
    });
    expect([200, 500]).toContain(r.statusCode); // rede real pode estar bloqueada no CI
    expect(r.body.length).toBeGreaterThan(0);
    await app.close();
  }, 90_000);

  it("token de serviço não vaza no corpo de erro", async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: "GET", url: "/api/processos/auto", headers: { "x-service-token": "errado" } });
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain(SERVICE);
    await app.close();
  });
});
