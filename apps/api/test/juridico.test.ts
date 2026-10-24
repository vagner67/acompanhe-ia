/**
 * Assessoria jurídica — testes (plano.md §4).
 * Fixtures = captura REAL DataJud de 23/10/2026 (tjmt; doc com 94 movimentos;
 * numeroProcesso 0006903-69.2014.8.11.0037). DJEN live-bloqueado (403) → testes
 * de contrato com fetch injetado.
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
import { isValidCnj, parseCnj, formatCnj, cnjDv, aliasFromTribunal } from "../src/juridico/cnj.js";
import { buildSearchQuery, fetchProcessos } from "../src/juridico/datajud.js";
import {
  InMemoryLegalStore,
  makeJuridicoService,
  mapDoc,
  movementDedupeHash,
  isoFromCnj,
  RODAPE_INFORMATIVO,
  SIGILO_MSG,
} from "../src/juridico/service.js";
import type { DatajudDoc } from "../src/juridico/types.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const capture = JSON.parse(readFileSync(join(dir, "datajud-capture.json"), "utf8")) as {
  _capture: { source: string; capturedAt: string };
  envelope: { took: number; total: { value: number; relation: string } };
  hit: DatajudDoc;
};
const REAL = capture.hit;

describe("RF-B01 — número CNJ com DV (Res. 65/2008) — caso REAL da fixture", () => {
  it("0006903-69.2014.8.11.0037 valida; DV=69 bate com o algoritmo", () => {
    expect(REAL.numeroProcesso).toBe("00069036920148110037");
    expect(isValidCnj("0006903-69.2014.8.11.0037")).toBe(true);
    expect(isValidCnj("000690369.2014.8.11.0037")).toBe(true);
    const p = parseCnj("0006903-69.2014.8.11.0037")!;
    expect(formatCnj(p)).toBe("0006903-69.2014.8.11.0037");
    expect(cnjDv({ sequencial: p.sequencial, ano: p.ano, justica: p.justica, tribunal: p.tribunal, origem: p.origem })).toBe("69");
  });

  it("DV trocado reprova; formato inválido reprova", () => {
    expect(isValidCnj("0006903-70.2014.8.11.0037")).toBe(false);
    expect(isValidCnj("0006903-68.2014.8.11.0037")).toBe(false);
    expect(isValidCnj("0006.2014.8.11.0037")).toBe(false);
  });

  it("alias do tribunal: 8.11 → tjmt (verificado vivo); TR desconhecido → null", () => {
    expect(aliasFromTribunal("8", "11")).toBe("tjmt");
    expect(aliasFromTribunal("8", "26")).toBe("tjsp");
    expect(aliasFromTribunal("8", "99")).toBeNull(); // nunca inventar
    expect(aliasFromTribunal("3", "01")).toBeNull();
  });
});

describe("Cliente DataJud (contrato real da captura)", () => {
  it("query dirigida por numeroProcesso (match_all proibido — derruba o cluster)", () => {
    const q = buildSearchQuery({ numeroProcesso: "00069036920148110037" });
    expect(JSON.stringify(q)).toContain('"numeroProcesso":"00069036920148110037"');
    expect(JSON.stringify(q)).not.toContain("match_all");
  });

  it("fetchProcessos parseia o envelope real; 401 é fatal sem retry", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ took: capture.envelope.took, hits: { total: capture.envelope.total, hits: [{ _source: capture.hit }] } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const docs = await fetchProcessos("tjmt", { numeroProcesso: "00069036920148110037" }, { fetchImpl });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.numeroProcesso).toBe("00069036920148110037");
    expect(docs[0]!.movimentos.length).toBe(94); // contagem real da captura

    let calls = 0;
    const f401 = (async () => {
      calls++;
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    await expect(fetchProcessos("tjmt", {}, { fetchImpl: f401, attempts: 3 })).rejects.toThrow(/401/);
    expect(calls).toBe(1); // fatal = sem retry
  });

  it("isoFromCnj: '20140805000000' → ISO (formato real)", () => {
    expect(isoFromCnj(REAL.dataAjuizamento)).toBe("2014-08-05T00:00:00.000Z");
    expect(isoFromCnj("20261023123456")).toBe("2026-10-23T12:34:56.000Z");
  });
});

describe("RB3 — sigilo nunca vaza", () => {
  it("nivelSigilo > 0 → só a frase; movimentos e valores NÃO aparecem", () => {
    const sigiloso: DatajudDoc = { ...REAL, nivelSigilo: 1 };
    const c = mapDoc(sigiloso, "tjmt");
    expect(c.classe).toBe(SIGILO_MSG);
    expect(c.orgaoJulgador).toBe(SIGILO_MSG);
    expect(c.assunto).toBeNull();
    expect(c.valorDaCausa).toBeNull();
    expect(c.ultimoMovimento).toBeNull();
    expect(c.movimentosCount).toBe(0);
    expect(JSON.stringify(c.raw)).not.toContain("movimentos");
  });
});

describe("mapeamento do doc REAL (RF-B03)", () => {
  it("classe, órgão, ajuizamento, status e último movimento vêm do doc real", () => {
    const c = mapDoc(REAL, "tjmt");
    expect(c.numeroProcesso).toBe("00069036920148110037");
    expect(c.classe).toBe(REAL.classe.nome);
    expect(c.orgaoJulgador).toBe(REAL.orgaoJulgador.nome);
    expect(c.dataAjuizamento).toBe("2014-08-05T00:00:00.000Z");
    expect(c.movimentosCount).toBe(94); // bruto; eventos únicos = 86 (RB5)
    expect(c.ultimoMovimento).not.toBeNull();
    expect(c.ultimoMovimento!.dataHora >= REAL.movimentos[0]!.dataHora).toBe(true);
    expect(["ativo", "arquivado", "suspenso", "desconhecido"]).toContain(c.status);
    expect(c.fieldStatus).toBe("pendente");
  });

  it("RB5 — dedupe por hash(numeroProcesso+codigo+dataHora)", () => {
    const mov = REAL.movimentos[0]!;
    expect(movementDedupeHash(REAL.numeroProcesso, mov)).toBe(movementDedupeHash(REAL.numeroProcesso, { ...mov }));
    expect(movementDedupeHash(REAL.numeroProcesso, mov)).not.toBe(
      movementDedupeHash(REAL.numeroProcesso, { ...mov, dataHora: mov.dataHora + "Z" }),
    );
  });
});

describe("RB1/RB2/RB4/RF-B07 — regras de negócio", () => {
  it("RB1 — duplicidade rejeitada com link", async () => {
    const svc = makeJuridicoService({ store: new InMemoryLegalStore() });
    const r1 = await svc.acompanhar("u1", "0006903-69.2014.8.11.0037", "ativo", "tjmt");
    const r2 = await svc.acompanhar("u1", "0006903-69.2014.8.11.0037", "ativo", "tjmt");
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.link).toBe(r1.link);
  });

  it("RB5 — movimento repetido não vira evento novo; RB2 append-only", async () => {
    const store = new InMemoryLegalStore();
    const svc = makeJuridicoService({ store, datajudOpts: {} });
    await svc.acompanhar("u1", "0006903-69.2014.8.11.0037", "ativo", "tjmt");
    const r1 = await svc.sincronizar("u1", "0006903-69.2014.8.11.0037", "tjmt", REAL);
    // ACHADO real da captura: 94 movimentos, 86 únicos — o mov. 581 de
    // 2024-05-28T19:23:05.000Z aparece 9× (lote); RB5 colapsa para 1.
    expect(REAL.movimentos).toHaveLength(94);
    expect(r1.novos).toBe(86);
    const r2 = await svc.sincronizar("u1", "0006903-69.2014.8.11.0037", "tjmt", REAL);
    expect(r2.novos).toBe(0); // dedupe
  });

  it("RB4 — 1 consulta consolidada por usuário-tribunal/6h", async () => {
    let t = new Date("2026-10-23T12:00:00.000Z");
    const svc = makeJuridicoService({ store: new InMemoryLegalStore(), now: () => t });
    expect(await svc.podeConsolidar("u1", "tjmt")).toBe(true);
    t = new Date("2026-10-23T15:00:00.000Z"); // +3h
    expect(await svc.podeConsolidar("u1", "tjmt")).toBe(false);
    expect(await svc.podeConsolidar("u1", "tjrj")).toBe(true); // outro tribunal = outra janela
    t = new Date("2026-10-23T18:30:00.000Z"); // +6h30
    expect(await svc.podeConsolidar("u1", "tjmt")).toBe(true);
  });

  it("RF-B07 — advogado SEM OAB verificada não recebe consulta", async () => {
    const svc = makeJuridicoService({ store: new InMemoryLegalStore(), oabVerified: new Set(["oab:123/sp"]) });
    await expect(svc.solicitarConsulta("u1", null, "Qual o prazo?", "oab:sem-verificacao")).rejects.toThrow(/OAB verificada/);
    const ok = await svc.solicitarConsulta("u1", null, "Qual o prazo?", "oab:123/sp");
    expect(ok.rodape).toBe(RODAPE_INFORMATIVO);
  });

  it("RF-B08 — explicação IA sempre com o rodapé (nunca parecer)", () => {
    const svc = makeJuridicoService({ store: new InMemoryLegalStore() });
    const exp = svc.explicarMovimento("Expedição de Precatório");
    expect(exp).toContain("Expedição de Precatório");
    expect(exp).toContain(RODAPE_INFORMATIVO);
    expect(exp).not.toMatch(/(meu|nosso) parecer/i);
    expect(exp).not.toMatch(/parecer\s*:/i);
    expect(exp.endsWith(`${RODAPE_INFORMATIVO}.`)).toBe(true);
  });
});

describe("HTTP — /api/processos", () => {
  const BOT = "123456789:TEST_TOKEN_AAA-BBB";

  function makeApp() {
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
      juridico: { store: new InMemoryLegalStore(), oabVerified: new Set<string>() },
      osint: { entitlements: ents },
    });
    return { app, ents };
  }

  async function token(app: Awaited<ReturnType<typeof makeApp>>["app"]): Promise<string> {
    const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 9, first_name: "J" }) }, BOT);
    const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
    return res.json().token as string;
  }

  it("paywall v2/08: consultas sem plano Consulta Jurídica → 403 honesto", async () => {
    const { app } = makeApp();
    const t = await token(app);
    const r = await app.inject({ method: "POST", url: "/api/juridico/consultas", headers: { authorization: `Bearer ${t}` }, payload: { question: "Qual o prazo recursal?" } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toContain("Consulta Jurídica");
    await app.close();
  });

  it("401 sem token; CNJ inválido → 422; acompanhar 201; duplicidade 409+link; OAB inválida 403", async () => {
    const { app, ents } = makeApp();
    expect((await app.inject({ method: "GET", url: "/api/processos" })).statusCode).toBe(401);
    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };

    const inv = await app.inject({ method: "POST", url: "/api/processos/0006903-99.2014.8.11.0037/acompanhar", headers: H, payload: {} });
    expect(inv.statusCode).toBe(422); // DV errado

    const ok = await app.inject({ method: "POST", url: "/api/processos/0006903-69.2014.8.11.0037/acompanhar", headers: H, payload: { role: "ativo" } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().alias).toBe("tjmt"); // derivado do TR=11

    const dup = await app.inject({ method: "POST", url: "/api/processos/0006903-69.2014.8.11.0037/acompanhar", headers: H, payload: {} });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().link).toContain("0006903-69.2014.8.11.0037");

    const lista = await app.inject({ method: "GET", url: "/api/processos", headers: H });
    expect(lista.json().processos).toHaveLength(1);

    await ents.grant("9", "juridica"); // plano ativo — gate v2/08 liberado; OAB segue valendo
    const oab = await app.inject({ method: "POST", url: "/api/juridico/consultas", headers: H, payload: { question: "Qual o prazo recursal?", oabUser: "oab:nao-verificada" } });
    expect(oab.statusCode).toBe(403);
    expect(oab.json().error).toContain("OAB");
    await app.close();
  });
});

describe("regressão E2E 23/10 — projeção do caso + rota de detalhe", () => {
  const BOT = "123456789:TEST_TOKEN_AAA-BBB";
  function makeApp2(store: InMemoryLegalStore, datajud: unknown) {
    const config = loadConfig({
      BOT_TOKEN: BOT,
      JWT_SECRET: "test-secret-0123456789abcdef",
      PUSHINPAY_WEBHOOK_SECRET: "whsec",
      NODE_ENV: "test",
      ADMIN_TOKEN: "adm-tok",
    } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
      juridico: { store, datajud: datajud as never },
    });
  }

  it("sincronizar atualiza a projeção (mapDoc) e movimentosCount reflete eventos", async () => {
    const store = new InMemoryLegalStore();
    const doc = (JSON.parse(readFileSync(join(__dirname, "fixtures/datajud-capture.json"), "utf8")) as { hit: never }).hit;
    const svc = makeJuridicoService({ store, datajud: (async () => [doc]) as never });
    await svc.acompanhar("9", "0006903-69.2014.8.11.0037", "outro", "tjmt");
    const r = await svc.sincronizar("9", "0006903-69.2014.8.11.0037", "tjmt");
    expect(r.novos).toBeGreaterThan(0);
    const caso = await store.getCase("9", "0006903-69.2014.8.11.0037");
    expect(caso!.classe).not.toBe("(não consultado)");
    expect(caso!.movimentosCount).toBe(r.novos);
    expect(caso!.ultimoMovimento).not.toBeNull();
  });

  it("GET /api/processos/:cnj devolve caso + movimentos (link do RB1 deixa de ser 404)", async () => {
    const store = new InMemoryLegalStore();
    const doc = (JSON.parse(readFileSync(join(__dirname, "fixtures/datajud-capture.json"), "utf8")) as { hit: never }).hit;
    const app = makeApp2(store, async () => [doc]);
    const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 9, first_name: "C" }) }, BOT);
    const t = (await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } })).json().token as string;
    const H = { authorization: `Bearer ${t}` };
    await app.inject({ method: "POST", url: "/api/processos/0006903-69.2014.8.11.0037/acompanhar", headers: H, payload: {} });
    await app.inject({ method: "POST", url: "/api/processos/0006903-69.2014.8.11.0037/sync", headers: H });
    const det = await app.inject({ method: "GET", url: "/api/processos/0006903-69.2014.8.11.0037", headers: H });
    expect(det.statusCode).toBe(200);
    const body = det.json();
    expect(body.processo.numeroProcesso).toBe("0006903-69.2014.8.11.0037");
    expect(body.movimentos.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/api/processos/0006903-99.2014.8.11.0037", headers: H })).statusCode).toBe(404);
  });
});

describe("regressão E2E 23/10 — RB4 aplicada pela rota", () => {
  it("2ª consulta na mesma janela → consolidado, sem criar consulta nova", async () => {
    const BOT = "123456789:TEST_TOKEN_AAA-BBB";
    const config = loadConfig({ BOT_TOKEN: BOT, JWT_SECRET: "test-secret-0123456789abcdef", PUSHINPAY_WEBHOOK_SECRET: "whsec", NODE_ENV: "test", ADMIN_TOKEN: "adm-tok" } as NodeJS.ProcessEnv);
    const ents = new InMemoryEntitlementsStore();
    const app = buildApp({ config, payments: new InMemoryPaymentStore(), pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"), osint: { entitlements: ents } });
    const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 9, first_name: "C" }) }, BOT);
    const t = (await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } })).json().token as string;
    const H = { authorization: `Bearer ${t}` };
    await ents.grant("9", "juridica"); // gate v2/08 — o teste é da janela RB4, não do paywall
    const p = { question: "Qual o prazo recursal?" };
    const c1 = await app.inject({ method: "POST", url: "/api/juridico/consultas", headers: H, payload: p });
    expect(c1.statusCode).toBe(201);
    const c2 = await app.inject({ method: "POST", url: "/api/juridico/consultas", headers: H, payload: p });
    expect(c2.statusCode).toBe(200);
    expect(c2.json().consolidado).toBe(true);
    const lista = await app.inject({ method: "GET", url: "/api/juridico/consultas", headers: H });
    expect((lista.json().consultas ?? lista.json().advices ?? []).length).toBe(1);
  });
});
