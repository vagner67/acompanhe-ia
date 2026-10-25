/**
 * Rotas do índice/risco/catálogo (plano-refatoracao §6.1–6.6) — paywall real,
 * token de serviço na ingestão e respostas honestas. Store em memória; o
 * contrato do store Prisma fica em indice-prisma.test.ts.
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
import { InMemoryLegalStore } from "../src/juridico/service.js";
import { InMemoryIndiceStore, chaveDocumento } from "../src/juridico/indice.js";
import { ingerirDaBuscaEsaj } from "../src/juridico/ingestao.js";
import { parseResultadosEsaj } from "../src/juridico/esaj.js";
import type { DatajudDoc } from "../src/juridico/types.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const REAL = (JSON.parse(readFileSync(join(dir, "datajud-capture.json"), "utf8")) as { hit: DatajudDoc }).hit;
const tjal = parseResultadosEsaj(readFileSync(join(dir, "esaj", "tjal-nmparte-positivo.html"), "utf8"), "al", 1);

const BOT = "123456789:TEST_TOKEN_AAA-BBB";
const SERVICE = "svc-token-teste";

function makeApp(deps: { indice?: InMemoryIndiceStore; datajud?: (alias: string, q: { numeroProcesso: string }) => Promise<DatajudDoc[]> } = {}) {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "adm-tok",
  } as NodeJS.ProcessEnv);
  const ents = new InMemoryEntitlementsStore();
  const indice = deps.indice ?? new InMemoryIndiceStore();
  const app = buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
    juridico: {
      store: new InMemoryLegalStore(),
      oabVerified: new Set<string>(),
      indice,
      serviceToken: () => SERVICE,
      ...(deps.datajud ? { datajud: deps.datajud } : {}),
    },
    osint: { entitlements: ents },
  });
  return { app, ents, indice };
}

async function login(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 88, first_name: "P" }) }, BOT);
  const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
  return res.json().token as string;
}

describe("GET /api/processos/fontes — catálogo real", () => {
  it("401 sem auth · 200 com cobertura de 91 tribunais e DJEN marcado indisponível", async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: "GET", url: "/api/processos/fontes" })).statusCode).toBe(401);
    const t = await login(app);
    const r = await app.inject({ method: "GET", url: "/api/processos/fontes", headers: { authorization: `Bearer ${t}` } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.cobertura.numero.tribunais).toBe(91);
    expect(b.cobertura.nome.ufs).toEqual(["ac", "al", "ce", "sp"]);
    expect(b.fontes.find((f: { id: string }) => f.id === "djen").estado).toBe("indisponivel");
    await app.close();
  });
});

describe("GET /api/processos/indice — busca no índice próprio", () => {
  it("403 sem plano · 422 consulta curta · 200 por nome com score e motivo", async () => {
    const indice = new InMemoryIndiceStore();
    await indice.upsertMuitos(ingerirDaBuscaEsaj(tjal.itens.slice(0, 3), "nome", new Date("2026-10-25T00:00:00Z")));
    const { app, ents } = makeApp({ indice });
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    expect((await app.inject({ method: "GET", url: "/api/processos/indice?q=Joao+Carlos", headers: H })).statusCode).toBe(403);
    await ents.grant("88", "juridica");
    expect((await app.inject({ method: "GET", url: "/api/processos/indice?q=ab", headers: H })).statusCode).toBe(422);
    const alvo = tjal.itens[0]!.nomeParte!;
    const r = await app.inject({
      method: "GET",
      url: `/api/processos/indice?q=${encodeURIComponent(alvo)}`,
      headers: H,
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.tipo).toBe("nome");
    expect(b.itens.length).toBeGreaterThan(0);
    expect(b.itens[0].score).toBeGreaterThan(0);
    expect(b.itens[0].motivo).toBe("sem_documento");
    expect(b.itens[0].motivoLegivel).toContain("homônimo");
    expect(b.advertencia).toContain("NOME");
    expect(b.totalNoIndice).toBeGreaterThanOrEqual(3);
    expect(b.facetas.tribunais.length).toBeGreaterThan(0);
    expect(b.rodape).toContain("informativo");
    await app.close();
  });

  it("busca por documento casa o hash e o motivo muda para documento_informado", async () => {
    const indice = new InMemoryIndiceStore();
    await indice.upsertMuitos(ingerirDaBuscaEsaj(tjal.itens.slice(0, 2), "documento", new Date(), "529.982.247-25"));
    const { app, ents } = makeApp({ indice });
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    await ents.grant("88", "juridica");
    const r = await app.inject({ method: "GET", url: "/api/processos/indice?q=529.982.247-25", headers: H });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.tipo).toBe("cpf");
    expect(b.itens[0].motivo).toBe("documento_informado");
    expect(b.itens[0].score).toBe(1);
    expect(b.itens[0].processo.partes[0].documentoHash).toBe(chaveDocumento("52998224725"));
    // nome de outra pessoa não vaza
    const vazio = await app.inject({ method: "GET", url: "/api/processos/indice?q=111.444.777-35", headers: H });
    expect(vazio.json().itens).toEqual([]);
    await app.close();
  });

  it("busca por número devolve o processo com motivo 'numero'", async () => {
    const indice = new InMemoryIndiceStore();
    const { processoDoDatajud } = await import("../src/juridico/indice.js");
    await indice.upsertMuitos([processoDoDatajud(REAL, "tjmt")]);
    const { app, ents } = makeApp({ indice });
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    await ents.grant("88", "juridica");
    const num = REAL.numeroProcesso;
    const fmt = `${num.slice(0, 7)}-${num.slice(7, 9)}.${num.slice(9, 13)}.${num[13]}.${num.slice(14, 16)}.${num.slice(16, 20)}`;
    const r = await app.inject({ method: "GET", url: `/api/processos/indice?q=${fmt}`, headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json().itens[0].motivo).toBe("numero");
    await app.close();
  });
});

describe("POST /api/processos/indice/ingest — ingestão protegida", () => {
  it("401 sem token de serviço · 200 com token grava no índice (DataJud mockado)", async () => {
    const { app, indice } = makeApp({ datajud: async () => [REAL] });
    const numeros = ["0006903-69.2014.8.11.0037"];
    expect((await app.inject({ method: "POST", url: "/api/processos/indice/ingest", payload: { numeros } })).statusCode).toBe(401);
    const r = await app.inject({
      method: "POST",
      url: "/api/processos/indice/ingest",
      headers: { "x-service-token": SERVICE },
      payload: { numeros },
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.gravados).toBe(1);
    expect(b.totalNoIndice).toBe(1);
    expect(await indice.total()).toBe(1);
    await app.close();
  });

  it("422 quando a lista vem vazia ou acima do limite", async () => {
    const { app } = makeApp();
    const vazio = await app.inject({
      method: "POST",
      url: "/api/processos/indice/ingest",
      headers: { "x-service-token": SERVICE },
      payload: { numeros: [] },
    });
    expect(vazio.statusCode).toBe(422);
    const grande = await app.inject({
      method: "POST",
      url: "/api/processos/indice/ingest",
      headers: { "x-service-token": SERVICE },
      payload: { numeros: Array.from({ length: 201 }, (_, i) => `000000${i}-00.2020.8.02.0001`) },
    });
    expect(grande.statusCode).toBe(422);
    await app.close();
  });
});

describe("POST /api/processos/risco — motor determinístico", () => {
  it("403 sem plano · 422 sem entrada · 200 com score e justificativas", async () => {
    const indice = new InMemoryIndiceStore();
    await indice.upsertMuitos(ingerirDaBuscaEsaj(tjal.itens.slice(0, 4), "nome", new Date("2026-10-25T00:00:00Z")));
    const { app, ents } = makeApp({ indice });
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    expect((await app.inject({ method: "POST", url: "/api/processos/risco", payload: { q: "Joao" }, headers: H })).statusCode).toBe(403);
    await ents.grant("88", "juridica");
    expect((await app.inject({ method: "POST", url: "/api/processos/risco", payload: {}, headers: H })).statusCode).toBe(422);
    const alvo = tjal.itens[0]!.nomeParte!;
    const r = await app.inject({ method: "POST", url: "/api/processos/risco", payload: { q: alvo }, headers: H });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(typeof b.criticidade).toBe("number");
    expect(["baixo", "medio", "alto", "critico"]).toContain(b.faixa);
    expect(b.considerados).toBeGreaterThan(0);
    expect(b.versaoRegras).toBe("risco-v1");
    expect(b.rule).toContain("determinístico");
    await app.close();
  });
});
