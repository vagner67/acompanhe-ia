/**
 * Concursos — testes (plano.md §3). Fixtures = CAPTURAS REAIS do DOU de
 * 23/10/2026:
 *  - dou-capture.json          leiturajornal DO1 (308 itens reais; 40 no fixture) — 0 positivos (atos normativos)
 *  - dou-busca-capture.json    busca difusa "concurso público" DO3 — 1 positivo real ("EDITAL IRD/ANSN nº 1/2026" = processo de seleção)
 *  - dou-busca-exata-capture.json busca EXATA "concurso público" DO3 — 18/20 positivos reais
 * Nenhum padrão de classificador foi inventado: os regex partem do RF-D01
 * (v1 doc 01) + variantes observadas NAS capturas (comentadas nos asserts).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { signInitData } from "../src/security/telegram-initdata.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";
import {
  classifyStatus,
  contestIdentity,
  detectBanca,
  douSourceUrl,
  extractJsonArray,
  isContestItem,
  mapDouItem,
  type DouItemRaw,
} from "../src/concursos/dou.js";
import {
  InMemoryContestStore,
  inscricaoAlert,
  makeConcursosService,
} from "../src/concursos/service.js";
import { PrismaContestStore } from "../src/concursos/service.js";
import { createDb } from "@acompanhe/db";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (f: string): DouItemRaw[] =>
  (JSON.parse(readFileSync(join(dir, f), "utf8")) as { jsonArray: DouItemRaw[] }).jsonArray;

const do1 = load("dou-capture.json");
const busca = load("dou-busca-capture.json");
const exata = load("dou-busca-exata-capture.json");

function htmlWrap(items: DouItemRaw[]): string {
  // envelope HTML do portal (formato real do embed); conteúdo = captura real
  return `<html><body><script id="params" type="application/json">{"jsonArray":${JSON.stringify(items)}}</script></body></html>`;
}

function fetchHtml(body: string): typeof fetch {
  return (async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
}

describe("RF-D01 — classificador sobre dados REAIS (23/10/2026)", () => {
  it("busca exata: 18 de 20 são concursos de verdade", () => {
    const pos = exata.filter(isContestItem);
    expect(pos).toHaveLength(18);
    // exemplos reais positivos
    expect(exata.filter(isContestItem).map((i) => i.title)).toEqual(
      expect.arrayContaining(["EDITAL DE CONVOCAÇÃO N° 6/2026", "EDITAL Nº 13/2026"]),
    );
  });

  it("busca difusa: só 1 positivo — e é o IRD/ANSN ('processo de seleção')", () => {
    const pos = busca.filter(isContestItem);
    expect(pos).toHaveLength(1);
    expect(pos[0]!.title).toBe("EDITAL IRD/ANSN Nº 1/2026");
    expect(pos[0]!.content).toContain("processo de seleção"); // variante real que estendeu o regex
  });

  it("DO1 (atos normativos): 0 positivos — 'PAUTA DE JULGAMENTO' não é concurso", () => {
    expect(do1.filter(isContestItem)).toHaveLength(0);
    expect(do1.some((i) => i.title === "PAUTA DE JULGAMENTO")).toBe(true);
  });

  it("aviso de LICITAÇÃO não é concurso (pertence ao módulo de licitações)", () => {
    const aviso = busca.find((i) => i.title === "AVISO DE LICITAÇÃO");
    expect(aviso).toBeDefined();
    expect(isContestItem(aviso!)).toBe(false);
  });
});

describe("RD2 — identidade e retificação", () => {
  it("id por nº do edital nos 3 formatos reais capturados", () => {
    const irdsn = busca.find((i) => i.title.includes("IRD/ANSN"))!;
    const id1 = contestIdentity(irdsn);
    expect(id1.identitySource).toBe("edital");
    expect(id1.numero).toBe("1");

    const conv = exata.find((i) => i.title === "EDITAL DE CONVOCAÇÃO N° 6/2026")!;
    const id2 = contestIdentity(conv);
    expect(id2.identitySource).toBe("edital");
    expect(id2.numero).toBe("6");

    const ed8 = exata.find((i) => i.title === "EDITAL Nº 8, DE 21 DE OUTUBRO DE 2026")!;
    const id3 = contestIdentity(ed8);
    expect(id3.identitySource).toBe("edital");
    expect(id3.numero).toBe("8");
  });

  it("mesmo edital publicado de novo → MESMO externalId (retificação detectada)", async () => {
    const store = new InMemoryContestStore();
    const svc = makeConcursosService({ store, dou: { fetchImpl: fetchHtml(htmlWrap(exata)) } });
    await svc.ingestBusca({ q: "\"concurso público\"", publishFrom: "01/10/2026", publishTo: "22/10/2026" });
    const antes = await svc.list({});
    // re-ingere o MESMO conteúdo → nada muda
    await svc.ingestBusca({ q: "\"concurso público\"", publishFrom: "01/10/2026", publishTo: "22/10/2026" });
    const depois = await svc.list({});
    expect(depois).toHaveLength(antes.length);

    // muda o conteúdo de UM item → vira VERSÃO vinculada (RD2: nunca substitui)
    const posIdx = exata.findIndex(isContestItem);
    const alterado = exata.map((i, idx) =>
      idx === posIdx ? { ...i, content: `${i.content} RETIFICADO PELO DOU` } : i,
    );
    const svc2 = makeConcursosService({ store, dou: { fetchImpl: fetchHtml(htmlWrap(alterado)) } });
    const r = await svc2.ingestBusca({ q: "\"concurso público\"", publishFrom: "01/10/2026", publishTo: "22/10/2026" });
    expect(r.versoes).toBe(1);

    const original = mapDouItem(exata[posIdx]!);
    const t = await svc.timeline(original.externalId);
    expect(t.original?.title).toBe(original.title); // original intacto
    expect(t.versoes).toHaveLength(1);
    expect(t.versoes[0]!.parentVersion).toBe(original.externalId);
    expect(t.versoes[0]!.raw).toHaveProperty("content");
    expect(String((t.versoes[0]!.raw as { content: string }).content)).toContain("RETIFICADO");
  });
});

describe("mapeamento do item real (RD3/RD4)", () => {
  it("mapDouItem: link oficial do DOU (RD4) e dado pendente (RD3)", () => {
    const pos = exata.find(isContestItem)!;
    const d = mapDouItem(pos);
    expect(d.sourceUrl).toBe(douSourceUrl(pos));
    expect(d.sourceUrl).toMatch(/^https:\/\/www\.in\.gov\.br\/pt-br\/materias\//);
    expect(d.fieldStatus).toBe("pendente"); // texto livre nunca vira "validado" sozinho
    expect(d.status).toBe("edital_publicado");
  });

  it("detectBanca nos títulos reais (sem banca → null; nunca inventar)", () => {
    expect(detectBanca("EDITAL DE CONVOCAÇÃO N° 6/2026")).toBeNull();
    expect(detectBanca("Edital FGV nº 12/2026 de concurso público")).toBe("FGV");
    expect(detectBanca("concurso da Cebraspe para o TRT")).toBe("Cebraspe");
  });

  it("extractJsonArray: parseia o embed real e ignora HTML sem jsonArray", () => {
    const items = extractJsonArray(htmlWrap(exata.slice(0, 3)));
    expect(items).toHaveLength(3);
    expect(extractJsonArray("<html>sem embed</html>")).toEqual([]);
    // strings com colchetes não quebram o parse balanceado
    const tricky = htmlWrap([{ ...exata[0]!, content: "texto [com] colchetes ] e aspas \"dentro\"" }]);
    expect(extractJsonArray(tricky)).toHaveLength(1);
  });
});

describe("RF-D07 — alerta de inscrição T-7/T-3/T-1", () => {
  it("janelas corretas; fora da janela → nada", () => {
    const c = { externalId: "contest:x", title: "Edital nº 1/2026", inscricoesTo: "2026-11-10T23:59:59" };
    expect(inscricaoAlert(c, "2026-11-08T12:00:00.000Z")?.dias).toBe(3);
    expect(inscricaoAlert(c, "2026-11-04T12:00:00.000Z")?.dias).toBe(7);
    expect(inscricaoAlert(c, "2026-11-10T08:00:00.000Z")?.dias).toBe(1);
    expect(inscricaoAlert(c, "2026-11-01T12:00:00.000Z")).toBeUndefined(); // T-9
    expect(inscricaoAlert(c, "2026-11-11T12:00:00.000Z")).toBeUndefined(); // já encerrou
    expect(inscricaoAlert({ ...c, inscricoesTo: null as never }, "2026-11-08T12:00:00.000Z")).toBeUndefined();
  });

  it("alertsForUser grava alerta 1× e só para acompanhados", async () => {
    const store = new InMemoryContestStore();
    const svc = makeConcursosService({
      store,
      dou: { fetchImpl: fetchHtml(htmlWrap(exata)) },
      now: () => new Date("2026-11-08T12:00:00.000Z"),
    });
    // prazo JÁ presente no texto da captura (como todo edital real de concurso)
    const posIdx = exata.findIndex(isContestItem);
    const comPrazoRaw = exata.map((i, idx) =>
      idx === posIdx ? { ...i, content: `${i.content} Inscrições de 1 de novembro de 2026 a 10 de novembro de 2026.` } : i,
    );
    const svcPrazo = makeConcursosService({
      store,
      dou: { fetchImpl: fetchHtml(htmlWrap(comPrazoRaw)) },
      now: () => new Date("2026-11-08T12:00:00.000Z"),
    });
    await svcPrazo.ingestBusca({ q: "\"concurso público\"", publishFrom: "01/10/2026", publishTo: "22/10/2026" });
    const comPrazo = (await store.listContests({})).find((c) => c.inscricoesTo)!;
    expect(comPrazo.inscricoesTo).toBe("2026-11-10T00:00:00.000Z");

    const a1 = await svcPrazo.alertsForUser("u1", [comPrazo.externalId]);
    expect(a1).toHaveLength(1);
    const again = await svcPrazo.alertsForUser("u1", [comPrazo.externalId]);
    expect(again).toHaveLength(1); // segue o prazo…
    const salvos = await store.listAlerts("u1");
    expect(salvos).toHaveLength(1); // …mas o registro é gravado 1×
    expect(await svcPrazo.alertsForUser("u2", ["inexistente"])).toHaveLength(0);

    // RD2: mudar o PRAZO também é retificação (keyDates no hash) → versão, não update
    const r2 = await store.upsertContest({ ...comPrazo, inscricoesTo: "2026-11-20T02:59:59.000Z" });
    expect(r2.novaVersao).toBe(true);
  });
});

describe("store Prisma (Postgres real) — round-trip e RD2", () => {
  it("upsertContest persiste e versão não sobrescreve o original", async () => {
    const db = createDb(
      process.env.DATABASE_URL_TEST ?? "postgresql://postgres:postgres@127.0.0.1:5432/acompanhe_test",
    );
    await db.contestAlert.deleteMany();
    await db.contest.deleteMany();
    const store = new PrismaContestStore(db);
    const c = mapDouItem(exata.find(isContestItem)!);
    const r1 = await store.upsertContest(c);
    expect(r1.novaVersao).toBe(false);
    const r2 = await store.upsertContest({ ...c, title: `${c.title} — RETIFICADO` });
    expect(r2.novaVersao).toBe(true);
    const original = await store.getContest(c.externalId);
    expect(original?.title).toBe(c.title); // intacto no banco
    const versoes = await store.listVersions(c.externalId);
    expect(versoes).toHaveLength(1);
    await db.$disconnect();
  });
});

describe("HTTP — /api/concursos", () => {
  const BOT = "123456789:TEST_TOKEN_AAA-BBB";

  function makeApp() {
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
      concursos: {
        store: new InMemoryContestStore(),
        dou: { fetchImpl: fetchHtml(htmlWrap(exata)) },
      },
    });
  }

  async function token(app: ReturnType<typeof makeApp>): Promise<string> {
    const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 9, first_name: "C" }) }, BOT);
    const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
    return res.json().token as string;
  }

  it("401 sem Bearer; lista/detalhe/ingesta funcionam com token", async () => {
    const app = makeApp();
    expect((await app.inject({ method: "GET", url: "/api/concursos" })).statusCode).toBe(401);

    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };

    const ing = await app.inject({
      method: "POST",
      url: "/v1/admin/concursos/ingesta",
      headers: { ...H, "x-admin-token": "adm-tok" },
      payload: { tipo: "busca", q: "\"concurso público\"", secao: "do3", publishFrom: "01/10/2026", publishTo: "22/10/2026" },
    });
    expect(ing.statusCode).toBe(200);
    expect(ing.json().concursos).toBe(18); // os 18 positivos reais

    const lista = await app.inject({ method: "GET", url: "/api/concursos", headers: H });
    expect(lista.statusCode).toBe(200);
    expect(lista.json().total).toBeGreaterThanOrEqual(18);

    const one = lista.json().concursos[0];
    const det = await app.inject({ method: "GET", url: `/api/concursos/${encodeURIComponent(one.externalId)}`, headers: H });
    expect(det.statusCode).toBe(200);
    expect(det.json().concurso.externalId).toBe(one.externalId);

    const semToken = await app.inject({ method: "POST", url: "/v1/admin/concursos/ingesta", payload: { tipo: "edicao", data: "22-10-2026", secao: "do1" } });
    expect(semToken.statusCode).toBe(403);
    await app.close();
  });

  it("fonte fora do ar → 502 (nunca 200 com resultado inventado)", async () => {
    const config = loadConfig({
      BOT_TOKEN: BOT,
      JWT_SECRET: "test-secret-0123456789abcdef",
      PUSHINPAY_WEBHOOK_SECRET: "whsec",
      NODE_ENV: "test",
      ADMIN_TOKEN: "adm-tok",
    } as NodeJS.ProcessEnv);
    const app = buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
      concursos: {
        store: new InMemoryContestStore(),
        dou: { fetchImpl: (async () => new Response("erro", { status: 503 })) as typeof fetch, attempts: 1 },
      },
    });
    const r = await app.inject({
      method: "POST",
      url: "/v1/admin/concursos/ingesta",
      headers: { "x-admin-token": "adm-tok" },
      payload: { tipo: "edicao", data: "22-10-2026", secao: "do3" },
    });
    expect(r.statusCode).toBe(502);
    await app.close();
  });
});

describe("regressão E2E 23/10 — retificação não dispara com campos voláteis/ordem de chave", () => {
  it("mesmo conteúdo com score diferente e chaves em outra ordem → 0 versões; texto diferente → 1", async () => {
    const store = new InMemoryContestStore();
    const base = exata.find(isContestItem)!;
    const svc1 = makeConcursosService({ store, dou: { fetchImpl: fetchHtml(htmlWrap([base])) } });
    await svc1.ingestBusca({ q: "x", publishFrom: "01/10/2026", publishTo: "22/10/2026" });

    // score é relevância ES (volátil) + chaves reordenadas (round-trip jsonb)
    const reordered: Record<string, unknown> = {};
    for (const k of Object.keys(base).sort().reverse()) reordered[k] = (base as unknown as Record<string, unknown>)[k];
    const volatile = { ...reordered, score: 123.456 } as unknown as DouItemRaw;
    const svc2 = makeConcursosService({ store, dou: { fetchImpl: fetchHtml(htmlWrap([volatile])) } });
    const r2 = await svc2.ingestBusca({ q: "x", publishFrom: "01/10/2026", publishTo: "22/10/2026" });
    expect(r2.versoes).toBe(0);

    const alterado = { ...base, content: `${base.content} RETIFICADO` } as DouItemRaw;
    const svc3 = makeConcursosService({ store, dou: { fetchImpl: fetchHtml(htmlWrap([alterado])) } });
    const r3 = await svc3.ingestBusca({ q: "x", publishFrom: "01/10/2026", publishTo: "22/10/2026" });
    expect(r3.versoes).toBe(1);
  });
});
