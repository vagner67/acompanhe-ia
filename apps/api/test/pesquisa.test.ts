/**
 * Rotas da busca unificada (plano-busca-unificada §3.4/§4) — paywall, detecção
 * honesta (422s) e busca/cruzamento com fontes REAIS mockadas pelas fixtures
 * capturadas (o fetch de rede nunca roda nos testes; o mock serve o HTML real).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { InMemoryEntitlementsStore } from "../src/entitlements.js";
import { signInitData } from "../src/security/telegram-initdata.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";
import { InMemoryLegalStore, mapDoc } from "../src/juridico/service.js";
import type { DatajudDoc } from "../src/juridico/types.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const esajDir = join(dir, "esaj");
const ler = (nome: string) => readFileSync(join(esajDir, nome), "utf8");
const REAL = (JSON.parse(readFileSync(join(dir, "datajud-capture.json"), "utf8")) as { hit: DatajudDoc }).hit;

const BOT = "123456789:TEST_TOKEN_AAA-BBB";

function makeApp(opts: { fetchImpl?: typeof fetch; datajud?: (alias: string, q: { numeroProcesso: string }) => Promise<DatajudDoc[]> } = {}) {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "adm-tok",
  } as NodeJS.ProcessEnv);
  const ents = new InMemoryEntitlementsStore();
  const app = buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
    juridico: {
      store: new InMemoryLegalStore(),
      oabVerified: new Set<string>(),
      ...(opts.datajud ? { datajud: opts.datajud } : {}),
      ...(opts.fetchImpl ? { datajudOpts: { fetchImpl: opts.fetchImpl } } : {}),
    },
    osint: { entitlements: ents },
  });
  return { app, ents };
}

async function login(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 77, first_name: "P" }) }, BOT);
  const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
  return res.json().token as string;
}

/** fetch mockado: serve o HTML REAL capturado conforme URL/valor. */
function fetchDasFixtures(): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (!u.includes("/cpopg/search.do")) return new Response("fora", { status: 404 });
    const valor = decodeURIComponent(u.split("dadosConsulta.valorConsulta=")[1]?.split("&")[0] ?? "").replace(/\+/g, " ").toUpperCase();
    let html: string;
    if (valor.includes("JOAO CARLOS")) html = ler(u.includes("esaj.tjsp") ? "tjsp-nmparte-joao.html" : "tjal-nmparte-positivo.html");
    else if (valor.includes("MARIA")) html = ler("tjal-nmparte-muitos.html");
    else html = ler("tjal-nmparte-vazio.html");
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
}

describe("GET /api/processos/pesquisar — paywall + detecção honesta", () => {
  it("401 sem token · 403 sem plano · 422 q curto · 422 CNJ · 422 CPF inválido", async () => {
    const { app, ents } = makeApp({ fetchImpl: fetchDasFixtures() });
    expect((await app.inject({ method: "GET", url: "/api/processos/pesquisar?q=Joao+Silva" })).statusCode).toBe(401);
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    expect((await app.inject({ method: "GET", url: "/api/processos/pesquisar?q=Joao+Silva", headers: H })).statusCode).toBe(403);
    await ents.grant("77", "juridica");
    expect((await app.inject({ method: "GET", url: "/api/processos/pesquisar?q=ab", headers: H })).statusCode).toBe(422);
    const cnj = await app.inject({ method: "GET", url: "/api/processos/pesquisar?q=0006903-69.2014.8.11.0037", headers: H });
    expect(cnj.statusCode).toBe(422);
    expect(cnj.json().error).toContain("use a busca de processo");
    const cpf = await app.inject({ method: "GET", url: "/api/processos/pesquisar?q=529.982.247-26", headers: H });
    expect(cpf.statusCode).toBe(422);
    expect(cpf.json().error).toContain("verificadores inválidos");
    await app.close();
  });

  it("nome → 200 com itens REAIS das fontes (fixture) + estados por fonte + rodapé de homônimos", async () => {
    const { app, ents } = makeApp({ fetchImpl: fetchDasFixtures() });
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    await ents.grant("77", "juridica");
    const r = await app.inject({ method: "GET", url: "/api/processos/pesquisar?q=Joao+Carlos+da+Silva&uf=todas", headers: H });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.tipo).toBe("nome");
    expect(b.fontes.length).toBe(2); // al + sp verificadas
    expect(b.itens.length).toBeGreaterThan(10);
    expect(b.itens.some((i: { nomeParte: string | null }) => (i.nomeParte ?? "").includes("João Carlos"))).toBe(true);
    expect(b.rodape).toContain("Homônimos");
    expect(b.rodape).toContain("segredo de justiça");
  });

  it("nome comum demais → estado 'multiplos' honesto, sem inventar itens", async () => {
    const { app, ents } = makeApp({ fetchImpl: fetchDasFixtures() });
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    await ents.grant("77", "juridica");
    const r = await app.inject({ method: "GET", url: "/api/processos/pesquisar?q=Maria+da+Silva+Santos&uf=al", headers: H });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.itens).toEqual([]);
    expect(b.fontes[0].estado).toBe("multiplos");
  });

  it("nome de 1 palavra → advertência de homônimos; CPF válido sem registros → vazio honesto", async () => {
    const { app, ents } = makeApp({ fetchImpl: fetchDasFixtures() });
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    await ents.grant("77", "juridica");
    const nome = await app.inject({ method: "GET", url: "/api/processos/pesquisar?q=Madonna", headers: H });
    expect(nome.json().advertencia).toContain("homônimos");
    const cpf = await app.inject({ method: "GET", url: "/api/processos/pesquisar?q=529.982.247-25&uf=al", headers: H });
    expect(cpf.statusCode).toBe(200);
    const b = cpf.json();
    expect(b.tipo).toBe("cpf");
    expect(b.formato).toBe("529.982.247-25");
    expect(b.itens).toEqual([]);
    expect(b.fontes[0].estado).toBe("vazio");
    await app.close();
  });
});

describe("GET /api/processos/detalhes-lote — cruzamento REAL DataJud", () => {
  const CNJ_OK = "0006903-69.2014.8.11.0037";

  it("403 sem plano · 422 CNJ inválido · 200 com dados reais do DataJud e honestidade no lote", async () => {
    const datajud = async () => [REAL];
    const { app, ents } = makeApp({ datajud });
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    expect((await app.inject({ method: "GET", url: `/api/processos/detalhes-lote?cnjs=${CNJ_OK}`, headers: H })).statusCode).toBe(403);
    await ents.grant("77", "juridica");
    expect((await app.inject({ method: "GET", url: "/api/processos/detalhes-lote?cnjs=123", headers: H })).statusCode).toBe(422);
    const r = await app.inject({ method: "GET", url: `/api/processos/detalhes-lote?cnjs=${CNJ_OK}`, headers: H });
    expect(r.statusCode).toBe(200);
    const it0 = r.json().itens[0];
    expect(it0.numeroProcesso).toBe(CNJ_OK);
    const esperado = mapDoc(REAL, "tjmt");
    expect(it0.status).toBe(esperado.status);
    expect(it0.classe).toBe(esperado.classe);
    expect(it0.ultimoMovimento.nome).toBe(esperado.ultimoMovimento!.nome);
    expect(it0.fonte).toBe("datajud-tjmt");
    await app.close();
  });

  it("CNJ de tribunal sem alias → item honesto sem dados (não derruba o lote)", async () => {
    const datajud = async () => [REAL];
    const { app, ents } = makeApp({ datajud });
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    await ents.grant("77", "juridica");
    // justica=9/tribunal=99 não mapeia alias (DV 37 calculado pelo algoritmo oficial)
    const r = await app.inject({ method: "GET", url: "/api/processos/detalhes-lote?cnjs=0006903-37.2014.9.99.0037", headers: H });
    expect(r.statusCode).toBe(200);
    const it0 = r.json().itens[0];
    expect(it0.status).toBeNull();
    expect(it0.classe).toBeNull();
    expect(it0.fonte).toBe("datajud");
    await app.close();
  });
});
