/**
 * Licitação — testes (plano.md §2, aceite por RF). Fixtures = CAPTURA REAL da
 * API do PNCP em 23/10/2026 (`fixtures/pncp-capture.json`) — o shape nunca é
 * inventado. Rede = fetch injetável; nada de chamada HTTP em teste.
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
  contratacoesUrl,
  fetchContratacoesPage,
  fetchSearch,
  iterateContratacoes,
  mapContratacao,
  mapSearchItem,
  pncpTenderId,
  pncpTenderIdFromControle,
  searchUrl,
  withRetry,
  type PncpContratacaoRaw,
} from "../src/licitacoes/pncp.js";
import {
  InMemoryTenderStore,
  makeLicitacoesService,
  matchesFilter,
  prazoAlert,
} from "../src/licitacoes/service.js";

const fixtures = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pncp-capture.json"), "utf8"),
) as {
  publicacao: { data: PncpContratacaoRaw[] };
  atualizacao: { data: PncpContratacaoRaw[] };
  proposta: { data: PncpContratacaoRaw[] };
  search_edital: { items: Array<Record<string, unknown>>; total: number };
};

function fetchFrom(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("RC1 — id estável pncp:{cnpj}:{ano}:{seq}", () => {
  it("a partir dos 3 campos oficiais do path", () => {
    expect(pncpTenderId("83021808000182", 2026, 681)).toBe("pncp:83021808000182:2026:681");
  });

  it("a partir do numeroControlePNCP REAL da captura", () => {
    const controle = fixtures.publicacao.data[0]!.numeroControlePNCP; // 83021808000182-1-000681/2026
    expect(pncpTenderIdFromControle(controle)).toBe("pncp:83021808000182:2026:681");
    expect(pncpTenderIdFromControle("formato-invalido")).toBeUndefined();
  });
});

describe("mapeamento do contrato REAL (captura 23/10/2026)", () => {
  it("mapContratacao: camelCase → modelo normalizado (centavos inteiros)", () => {
    const t = mapContratacao(fixtures.publicacao.data[0]!);
    expect(t.pncpId).toBe("pncp:83021808000182:2026:681");
    expect(t.uf).toBe("SC");
    expect(t.cityIbge).toBe(4204202);
    expect(t.budgetCents).toBe(44_156_004); // 441560.04 reais → centavos
    expect(t.modality).toBe(6);
    expect(t.propostaTo).toBe("2026-11-03T08:55:01");
    // RC4: sem linkSistemaOrigem na captura → sourceUrl null (NUNCA inventar URL)
    expect(t.sourceUrl).toBeNull();
    expect(t.title).toContain("BRITAGEM");
  });

  it("mapSearchItem: snake_case → MESMO modelo (item_url vira link oficial)", () => {
    const t = mapSearchItem(fixtures.search_edital.items[0]! as never);
    expect(t.pncpId).toBe("pncp:18092825000149:2024:21");
    expect(t.uf).toBe("MG");
    expect(t.budgetCents).toBe(67_201_000);
    expect(t.sourceUrl).toBe("https://pncp.gov.br/compras/18092825000149/2024/21");
    // vazio da API ≠ data: propostaTo null (não "")
    expect(t.propostaTo).toBeNull();
    // Elasticsearch devolve "6" como STRING — coerção para Int do DDL
    expect(t.modality).toBe(6);
    // RC5: tipo de documento preservado no raw (edital ≠ ata ≠ contrato ≠ PCA)
    expect((t.raw as { document_type?: string }).document_type).toBe("edital");
  });
});

describe("client PNCP — contrato real verificado em 23/10/2026", () => {
  it("URLs levam os parâmetros OBRIGATÓRIOS descobertos na fonte", () => {
    const u = contratacoesUrl("publicacao", {
      dataInicial: "20261020",
      dataFinal: "20261021",
      codigoModalidadeContratacao: 6,
      tamanhoPagina: 2,
    });
    expect(u).toContain("codigoModalidadeContratacao=6"); // 400 sem ele
    expect(u).toContain("tamanhoPagina=10"); // mínimo 10 (clamp)
    const s = searchUrl({ tiposDocumento: "edital", q: "material" });
    expect(s).toContain("tipos_documento=edital"); // 400 sem ele
  });

  it("envelope de paginação real: paginasRestantes (NÃO existe `last`)", async () => {
    const page = await fetchContratacoesPage("publicacao", {
      dataInicial: "20261020",
      dataFinal: "20261021",
      codigoModalidadeContratacao: 6,
    }, { fetchImpl: fetchFrom(fixtures.publicacao) });
    expect(page.totalPaginas).toBeGreaterThan(0);
    expect(typeof page.paginasRestantes).toBe("number");
    expect(page.data.length).toBeGreaterThan(0);
  });

  it("iterateContratacoes para quando paginasRestantes == 0 (RC3)", async () => {
    const p1 = { ...fixtures.publicacao, data: fixtures.publicacao.data.slice(0, 1), paginasRestantes: 1, totalPaginas: 2, numeroPagina: 1 };
    const p2 = { ...fixtures.publicacao, data: fixtures.publicacao.data.slice(1, 2), paginasRestantes: 0, totalPaginas: 2, numeroPagina: 2 };
    const calls: number[] = [];
    const fetchImpl = (async (_url: string | URL | Request) => {
      calls.push(calls.length);
      return new Response(JSON.stringify(calls.length === 1 ? p1 : p2), { status: 200 });
    }) as typeof fetch;
    const batches: PncpContratacaoRaw[][] = [];
    for await (const batch of iterateContratacoes("publicacao", {
      dataInicial: "20261020",
      dataFinal: "20261021",
      codigoModalidadeContratacao: 6,
    }, { fetchImpl })) batches.push(batch);
    expect(batches).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it("RC2: retry exponencial com jitter em falha transitória; 400 NÃO repete", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const flaky = (async () => {
      n += 1;
      if (n < 3) throw new Error("SSL unexpected eof (comportamento real observado)");
      return new Response(JSON.stringify(fixtures.publicacao), { status: 200 });
    }) as typeof fetch;

    const page = await fetchContratacoesPage("publicacao", {
      dataInicial: "20261020",
      dataFinal: "20261021",
      codigoModalidadeContratacao: 6,
    }, { fetchImpl: flaky, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
    expect(page.data.length).toBeGreaterThan(0);
    expect(n).toBe(3); // 2 falhas + 1 sucesso
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBe(400 + 100); // backoff 400*2^0 + jitter fixo 100

    // erro fatal do contrato (400) — sem retry
    let fatalCalls = 0;
    const fatal = (async () => {
      fatalCalls += 1;
      return new Response(JSON.stringify({ message: "Required request parameter 'codigoModalidadeContratacao'" }), { status: 400 });
    }) as typeof fetch;
    await expect(
      fetchContratacoesPage("publicacao", {
        dataInicial: "20261020",
        dataFinal: "20261021",
        codigoModalidadeContratacao: 6,
      }, { fetchImpl: fatal, sleep: async () => {} }),
    ).rejects.toThrow(/400/);
    expect(fatalCalls).toBe(1);
    // 429 real do PNCP ("Limite de Requisições Excedido", 23/10/2026) —
    // retentável respeitando Retry-After (RC2)
    const sleeps429: number[] = [];
    let c429 = 0;
    const limited = (async () => {
      c429 += 1;
      if (c429 < 2) {
        return new Response("<html>Limite de Requisições Excedido</html>", {
          status: 429,
          headers: { "retry-after": "2" },
        });
      }
      return new Response(JSON.stringify(fixtures.publicacao), { status: 200 });
    }) as typeof fetch;
    const ok429 = await fetchContratacoesPage("publicacao", {
      dataInicial: "20261020",
      dataFinal: "20261021",
      codigoModalidadeContratacao: 6,
    }, { fetchImpl: limited, sleep: async (ms) => void sleeps429.push(ms), random: () => 0 });
    expect(ok429.data.length).toBeGreaterThan(0);
    expect(sleeps429).toEqual([2000]); // Retry-After: 2s preservado

    // withRetry também propaga o erro original quando esgotam as tentativas
    await expect(withRetry(async () => { throw new Error("acabou"); }, { attempts: 2, sleep: async () => {} })).rejects.toThrow("acabou");
  });

  it("fetchSearch exige tipos_documento e devolve {items,total}", async () => {
    const r = await fetchSearch({ tiposDocumento: "edital", q: "material" }, { fetchImpl: fetchFrom(fixtures.search_edital) });
    expect(r.total).toBe(fixtures.search_edital.total);
    expect(r.items.length).toBeGreaterThan(0);
  });
});

describe("serviço — sync upsert (RF-C01), filtros (RF-C02), radar (RF-C03), prazo (RF-C05)", () => {
  it("sync grava por RC1: mesma contratação em 2 páginas NÃO duplica", async () => {
    const store = new InMemoryTenderStore();
    // envelope de 1 página (a captura real tem 324 páginas; o teste fixa o fim)
    const onePage = { ...fixtures.publicacao, paginasRestantes: 0, totalPaginas: 1 };
    const svc = makeLicitacoesService({ store, pncp: { fetchImpl: fetchFrom(onePage) } });
    await svc.sync("publicacao", { dataInicial: "20261020", dataFinal: "20261021", codigoModalidadeContratacao: 6 });
    await svc.sync("publicacao", { dataInicial: "20261020", dataFinal: "20261021", codigoModalidadeContratacao: 6 });
    const all = await svc.list({});
    expect(all).toHaveLength(fixtures.publicacao.data.length); // upsert, não insert
  });

  it("matchesFilter (RF-C02) sobre dado real: SC / palavra / modalidade / valor", async () => {
    const t = mapContratacao(fixtures.publicacao.data[0]!);
    expect(matchesFilter(t, { uf: "SC" })).toBe(true);
    expect(matchesFilter(t, { uf: "MG" })).toBe(false);
    expect(matchesFilter(t, { palavra: "britagem" })).toBe(true); // no objeto real
    expect(matchesFilter(t, { palavra: "hospitalar" })).toBe(false);
    expect(matchesFilter(t, { palavra: "impressos" })).toBe(false); // SC ≠ edital MG; objeto de SC é britagem
    expect(matchesFilter(t, { modality: 6 })).toBe(true);
    expect(matchesFilter(t, { maxCents: 44_000_000 })).toBe(false);
    expect(matchesFilter(t, { minCents: 44_156_004 })).toBe(true);
    expect(matchesFilter(t, { propostaAte: "2026-11-01" })).toBe(false); // propostaTo 11-03
    expect(matchesFilter(t, { propostaAte: "2026-11-05" })).toBe(true);
  });

  it("RF-C03: filtro salvo + edital novo que casa → newMatches registrado", async () => {
    const store = new InMemoryTenderStore();
    const svc = makeLicitacoesService({ store, pncp: { fetchImpl: fetchFrom(fixtures.search_edital) } });
    await svc.saveInterest("u1", "material MG", { uf: "MG", palavra: "impressos" }); // "materiais impressos" está no objeto real
    const r = await svc.search({ tiposDocumento: "edital", q: "material" });
    expect(r.newMatches).toEqual([{ userId: "u1", filterName: "material MG", pncpId: "pncp:18092825000149:2024:21" }]);
    // 2ª busca idempotente (match já gravado não vira duplicata)
    const again = await svc.search({ tiposDocumento: "edital", q: "material" });
    expect(again.newMatches).toEqual([{ userId: "u1", filterName: "material MG", pncpId: "pncp:18092825000149:2024:21" }]);
    const saved = await svc.listSaved("u1");
    expect(saved).toHaveLength(1);
  });

  it("RF-C05: alerta T-3 de encerramento de propostas (janela controlada)", () => {
    const t = mapContratacao(fixtures.proposta.data[0]!); // propostaTo 2026-11-09T23:59:59
    const alerta = prazoAlert(t, "2026-11-07T12:00:00.000Z", 3);
    expect(alerta?.kind).toBe("prazo_proposta");
    expect(alerta?.detail).toContain("faltam");
    expect(prazoAlert(t, "2026-11-05T12:00:00.000Z", 3)).toBeUndefined(); // cedo demais (T-4.5)
    expect(prazoAlert(t, "2026-11-11T12:00:00.000Z", 3)).toBeUndefined(); // já encerrou
  });

  it("alertsForUser: só alerta para match do próprio usuário", async () => {
    const store = new InMemoryTenderStore();
    const svc = makeLicitacoesService({
      store,
      pncp: { fetchImpl: fetchFrom({ items: [], total: 0 }) },
      now: () => new Date("2026-11-07T12:00:00.000Z"),
    });
    const t = mapContratacao(fixtures.proposta.data[0]!);
    await store.upsertTender(t);
    await svc.saveInterest("u1", "abertos", { somenteAbertos: true });
    await svc.search({ tiposDocumento: "edital" }); // roda match (vazio) — interest em u1
    await store.recordMatches(t.pncpId, [{ userId: "u1", filterName: "abertos" }]);
    const a1 = await svc.alertsForUser("u1");
    expect(a1).toHaveLength(1);
    expect(a1[0]!.pncpId).toBe(t.pncpId);
    const a2 = await svc.alertsForUser("u2");
    expect(a2).toHaveLength(0);
  });
});

describe("HTTP — rotas /api/licitacoes (auth + contrato)", () => {
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
      licitacoes: {
        store: new InMemoryTenderStore(),
        pncp: { fetchImpl: fetchFrom(fixtures.search_edital) },
      },
    });
  }

  async function token(app: ReturnType<typeof makeApp>): Promise<string> {
    const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 7, first_name: "T" }) }, BOT);
    const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
    return res.json().token as string;
  }

  it("sem Bearer → 401 em todas as rotas", async () => {
    const app = makeApp();
    for (const url of ["/api/licitacoes", "/api/licitacoes/filtros", "/api/licitacoes/alertas"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
    await app.close();
  });

  it("busca com radar: 200 + newMatches; salvar filtro: 201", async () => {
    const app = makeApp();
    const t = await token(app);
    const save = await app.inject({
      method: "POST",
      url: "/api/licitacoes/filtros",
      headers: { authorization: `Bearer ${t}` },
      payload: { name: "material MG", filter: { uf: "MG", palavra: "impressos" } },
    });
    expect(save.statusCode).toBe(201);

    const busca = await app.inject({
      method: "POST",
      url: "/api/licitacoes/busca",
      headers: { authorization: `Bearer ${t}` },
      payload: { q: "material", tiposDocumento: "edital" },
    });
    expect(busca.statusCode).toBe(200);
    const body = busca.json();
    expect(body.tenders.length).toBeGreaterThan(0);
    expect(body.newMatches).toHaveLength(1);
    // RC4: card com link oficial apenas quando a API o fornece
    expect(body.tenders[0].sourceUrl).toBe("https://pncp.gov.br/compras/18092825000149/2024/21");
    await app.close();
  });

  it("sync admin: exige X-Admin-Token; 502 com fonte fora do ar", async () => {
    const app = makeApp();
    const semToken = await app.inject({
      method: "POST",
      url: "/v1/admin/licitacoes/sync",
      payload: { kind: "publicacao", dataInicial: "20261020", dataFinal: "20261021", codigoModalidadeContratacao: 6 },
    });
    expect(semToken.statusCode).toBe(403);

    const config = loadConfig({
      BOT_TOKEN: BOT,
      JWT_SECRET: "test-secret-0123456789abcdef",
      PUSHINPAY_WEBHOOK_SECRET: "whsec",
      NODE_ENV: "test",
      ADMIN_TOKEN: "adm-tok",
    } as NodeJS.ProcessEnv);
    const app2 = buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
      licitacoes: {
        store: new InMemoryTenderStore(),
        pncp: { fetchImpl: (async () => new Response("erro", { status: 503 })) as typeof fetch, attempts: 1, sleep: async () => {} },
      },
    });
    const erro = await app2.inject({
      method: "POST",
      url: "/v1/admin/licitacoes/sync",
      headers: { "x-admin-token": "adm-tok" },
      payload: { kind: "publicacao", dataInicial: "20261020", dataFinal: "20261021", codigoModalidadeContratacao: 6 },
    });
    expect(erro.statusCode).toBe(502); // nunca 200 com resultado inventado
    await app.close();
    await app2.close();
  });
});
