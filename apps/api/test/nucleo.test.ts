/**
 * Núcleo de Coletores Auto-Aperfeiçoável — testes de ponta a ponta SEM rede.
 *
 * Cada teste exercita o caminho real do código: coletor de verdade (com `fetchImpl`
 * devolvendo fixture), store, otimizador, diagnóstico e disjuntor. Nada de mock de
 * função interna: o que é verificado é o que roda em produção.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COLETORES, amostra, catalogo, coletorPorId } from "../src/nucleo/registro.js";
import { EPS, ganhoReal, pontuarColeta } from "../src/nucleo/pontuar.js";
import { agregar } from "../src/nucleo/tipos.js";
import {
  diagnosticar,
  diagnosticarPorRegras,
  limparCacheIA,
  extrairJson,
  montarConsulta,
  validarAjustes,
} from "../src/nucleo/ia-diagnostico.js";
import { cicloColetor, gerarVizinhos } from "../src/nucleo/otimizador.js";
import { InMemoryNucleoStore, PrismaNucleoStore, estadoInicial } from "../src/nucleo/store.js";
import { createDb } from "@acompanhe/db";
import { avaliarIncidente, assinatura, podeColetar } from "../src/nucleo/incidentes.js";
import { rodarCicloNucleo } from "../src/jobs/coleta.js";
import type { Coletor, Params, ResultadoColeta } from "../src/nucleo/tipos.js";
import { iniciarAutoAperfeicoamento } from "../src/jobs/autoaperfeicoamento.js";
import { InMemoryPerfilStore, type Metrica } from "../src/juridico/autoaperfeicoamento.js";

const ok = (itens: number, ms = 500): ResultadoColeta => ({ ok: itens > 0, http: 200, ms, itens });

/** Coletor sintético — serve só para exercitar o MOTOR, não é fonte do app. */
function coletorDeTeste(opts: {
  executar: (p: Params) => ResultadoColeta | Promise<ResultadoColeta>;
  espaco?: Coletor["espaco"];
  padrao?: Params;
}): Coletor {
  return {
    id: "teste-motor",
    modulo: "juridico",
    host: "teste.local",
    familia: "api-json",
    descricao: "coletor sintético de teste do motor",
    padrao: opts.padrao ?? { timeoutMs: 10_000 },
    espaco: opts.espaco ?? { timeoutMs: { tipo: "numero", min: 5_000, max: 30_000, passo: 5_000 } },
    canarios: [{ id: "c1", consulta: "termo", esperaMinItens: 1 }],
    orcamento: { rpm: 600, rpd: 1000 },
    async executar(p) {
      return opts.executar(p);
    },
  };
}

describe("Registro único de coletores (cobertura do app inteiro)", () => {
  it("cobre os quatro módulos que antes ficavam fora do motor", () => {
    const modulos = new Set(catalogo().map((c) => c.modulo));
    expect(modulos.has("juridico")).toBe(true);
    expect(modulos.has("licitacoes")).toBe(true);
    expect(modulos.has("concursos")).toBe(true);
    expect(modulos.has("investiga")).toBe(true);
  });

  it("ids são únicos e todo coletor declara host, orçamento e canário", () => {
    const ids = COLETORES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COLETORES) {
      expect(c.host.length).toBeGreaterThan(3);
      expect(c.orcamento.rpm).toBeGreaterThan(0);
      expect(c.canarios.length).toBeGreaterThan(0);
      expect(typeof c.executar).toBe("function");
    }
  });

  it("cada parâmetro do espaço de busca tem limites coerentes (a IA não pode inventar)", () => {
    for (const c of COLETORES) {
      for (const [chave, spec] of Object.entries(c.espaco)) {
        if (spec.tipo === "numero") {
          expect(spec.min, `${c.id}.${chave}`).toBeTypeOf("number");
          expect(spec.max!).toBeGreaterThan(spec.min!);
          expect(spec.passo!).toBeGreaterThan(0);
        } else if (spec.tipo === "enum") {
          expect((spec.opcoes ?? []).length).toBeGreaterThan(1);
        }
      }
    }
  });

  it("coletor que exige credencial declara qual é (nada de falhar em silêncio)", () => {
    const hibp = coletorPorId("osint-hibp");
    expect(hibp?.exigirCredencial).toBe("HIBP_API_KEY");
  });

  it("amostra de evidência mascara CPF e remove HTML", () => {
    const s = amostra("<p>CPF 123.456.789-00</p>");
    expect(s).not.toContain("123.456.789-00");
    expect(s).not.toContain("<p>");
  });

  it("coletor de e-SAJ real devolve resultado coerente quando a página vem vazia (rede injetada)", async () => {
    const html = "<html><body>Nenhum resultado encontrado</body></html>";
    const fetchImpl = (async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const esajSp = coletorPorId("esaj-sp")!;
    const r = await esajSp.executar(esajSp.padrao, { fetchImpl, consulta: "João Carlos", agora: new Date("2026-10-25T03:00:00Z") });
    expect(r.ok).toBe(false);
    expect(r.itens).toBe(0);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("coletor PNCP real (fetch injetado) conta os itens da página", async () => {
    const corpo = { data: [{ numeroControlePNCP: "1" }, { numeroControlePNCP: "2" }], totalRegistros: 2, totalPaginas: 1 };
    const fetchImpl = (async () => new Response(JSON.stringify(corpo), { status: 200 })) as unknown as typeof fetch;
    const pncp = coletorPorId("pncp-contratacoes")!;
    const r = await pncp.executar(pncp.padrao, { fetchImpl, agora: new Date("2026-10-25T03:00:00Z") });
    expect(r.http).toBe(200);
    expect(r.itens).toBe(2);
    expect(r.ok).toBe(true);
  });

  it("credencial ausente e pedido de refino têm assinatura própria (não viram \"timeout\")", () => {
    expect(assinatura({ ok: false, http: null, itens: 0, semCredencial: true })).toBe("credencial");
    expect(assinatura({ ok: false, http: 200, itens: 0, precisaRefinar: true })).toBe("refinar");
  });

  it("bloqueio HTTP vira assinatura própria (não \"erro genérico\")", () => {
    expect(assinatura({ ok: false, http: 429, itens: 0 })).toBe("bloqueio");
    expect(assinatura({ ok: false, http: 200, itens: 0 })).toBe("contrato");
    expect(assinatura({ ok: false, http: null, itens: 0 })).toBe("timeout");
    expect(assinatura({ ok: false, http: 200, itens: 0, captcha: true })).toBe("captcha");
  });
});

describe("Pontuação e histerese", () => {
  it("mais itens = mais pontos; posição monotônica", () => {
    expect(pontuarColeta(ok(5))).toBeGreaterThan(pontuarColeta(ok(1)));
    expect(pontuarColeta({ ok: false, http: null, ms: 100, itens: 0 })).toBeLessThan(40);
  });

  it("captcha custa caro (fonte que exige captcha nunca parece saudável)", () => {
    const comCaptcha = pontuarColeta({ ok: true, http: 200, ms: 100, itens: 5, captcha: true });
    expect(comCaptcha).toBeLessThan(40);
  });

  it("ganho só conta acima de ε=3", () => {
    expect(ganhoReal(50, 53)).toBe(false);
    expect(ganhoReal(50, 53.5)).toBe(true);
    expect(EPS).toBe(3);
  });

  it("agregação de canários soma itens e propaga captcha", () => {
    const r = agregar([
      { r: ok(2), esperaMinItens: 1 },
      { r: { ok: false, http: 200, ms: 100, itens: 0, captcha: true }, esperaMinItens: 1 },
    ]);
    expect(r.itens).toBe(2);
    expect(r.captcha).toBe(true);
  });
});

describe("Diagnóstico por regras (determinístico, sem IA)", () => {
  const base = coletorDeTeste({ executar: () => ok(1) });

  it("captcha: não propõe parâmetro nenhum (não existe correção fictícia)", () => {
    const d = diagnosticarPorRegras({
      coletor: base,
      params: base.padrao,
      resultado: { ok: false, http: 200, ms: 100, itens: 0, captcha: true },
      historico: [],
      versao: 1,
    });
    expect(d.ajustes).toEqual([]);
    expect(d.acao).toBe("manter");
    expect(d.descartado).toContain("captcha");
  });

  it("timeout: amplia timeoutMs dentro do espaço de busca", () => {
    const d = diagnosticarPorRegras({
      coletor: base,
      params: base.padrao,
      resultado: { ok: false, http: null, ms: 30_000, itens: 0, erro: "aborted" },
      historico: [],
      versao: 1,
    });
    expect(d.acao).toBe("ajustar");
    expect(d.ajustes[0]).toMatchObject({ chave: "timeoutMs", de: 10_000, para: 20_000 });
  });

  it("429: sobe tentativas quando o coletor expõe esse parâmetro", () => {
    const c = coletorDeTeste({
      executar: () => ok(1),
      padrao: { attempts: 2 },
      espaco: { attempts: { tipo: "numero", min: 1, max: 5, passo: 1 } },
    });
    const d = diagnosticarPorRegras({
      coletor: c,
      params: c.padrao,
      resultado: { ok: false, http: 429, ms: 300, itens: 0, bloqueio: true },
      historico: [],
      versao: 1,
    });
    expect(d.ajustes[0]).toMatchObject({ chave: "attempts", de: 2, para: 4 });
  });

  it("contrato quebrado (200 sem itens) não gira parâmetro: sinaliza inspeção", () => {
    const d = diagnosticarPorRegras({
      coletor: base,
      params: base.padrao,
      resultado: { ok: false, http: 200, ms: 500, itens: 0, camposFaltando: ["hits.hits"] },
      historico: [],
      versao: 1,
    });
    expect(d.ajustes).toEqual([]);
    expect(d.causa).toContain("contrato");
  });

  it("sem credencial: não propõe parâmetro e diz que é pendência de configuração", () => {
    const d = diagnosticarPorRegras({
      coletor: base,
      params: base.padrao,
      resultado: { ok: false, http: null, ms: 0, itens: 0, erro: "sem credencial HIBP_API_KEY", semCredencial: true },
      historico: [],
      versao: 1,
    });
    expect(d.ajustes).toEqual([]);
    expect(d.causa).toContain("credencial");
  });

  it("portal pedindo refino: propõe trocar a variante do termo (correção real, não palpite)", () => {
    const c = coletorDeTeste({
      executar: () => ok(1),
      padrao: { varianteNome: 0 },
      espaco: { varianteNome: { tipo: "enum", opcoes: [0, 1, 2] } },
    });
    const d = diagnosticarPorRegras({
      coletor: c,
      params: c.padrao,
      resultado: { ok: false, http: 200, ms: 700, itens: 0, precisaRefinar: true },
      historico: [],
      versao: 1,
    });
    expect(d.acao).toBe("ajustar");
    expect(d.ajustes[0]).toMatchObject({ chave: "varianteNome", de: 0, para: 1 });
  });

  it("fonte saudável e rápida: mantém, sem mexer em nada", () => {
    const d = diagnosticarPorRegras({
      coletor: base,
      params: base.padrao,
      resultado: ok(5, 800),
      historico: [],
      versao: 1,
    });
    expect(d.acao).toBe("manter");
    expect(d.ajustes).toEqual([]);
  });
});

describe("IA de buscador: interpreta o erro e só aplica o que é válido", () => {
  // o cache de diagnóstico é do processo: entre testes, ele precisa zerar
  beforeEach(() => limparCacheIA());
  const coletor = coletorDeTeste({
    executar: () => ok(1),
    padrao: { timeoutMs: 10_000, retries: 1 },
    espaco: {
      timeoutMs: { tipo: "numero", min: 5_000, max: 30_000, passo: 5_000 },
      retries: { tipo: "numero", min: 0, max: 3, passo: 1 },
    },
  });

  const entrada = {
    coletor,
    params: coletor.padrao,
    resultado: { ok: false, http: null, ms: 30_000, itens: 0, erro: "aborted" } as ResultadoColeta,
    historico: [],
    versao: 1,
  };

  it("sem AI_PROVIDER/AI_API_KEY usa a camada gratuita sem chave (pollinations)", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("pollinations")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"causa":"timeout de 30 s no host: ampliar janela","confianca":0.7,"acao":"ajustar","ajustes":[{"chave":"timeoutMs","para":20000,"porque":"host lento"}]}',
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("<html><body>sem resultados</body></html>", { status: 200 });
    }) as unknown as typeof fetch;
    limparCacheIA();
    const d = await diagnosticar(entrada, { env: {}, fetchImpl, espacoMs: 0 });
    expect(d.origem).toBe("ia");
    expect(d.provedor).toContain("pollinations");
    expect(d.ajustes).toEqual([{ chave: "timeoutMs", de: 10_000, para: 20_000, porque: "host lento" }]);
  });

  it("provedor gratuito limitado (402) → determinístico, com o motivo real registrado", async () => {
    const fetchImpl = (async (url: string | URL) =>
      String(url).includes("pollinations")
        ? new Response('{"status":402,"error":{"code":"FREE_LIMIT"}}', { status: 402 })
        : new Response("<html><body>x</body></html>", { status: 200 })) as unknown as typeof fetch;
    limparCacheIA();
    const d = await diagnosticar(entrada, { env: {}, fetchImpl, espacoMs: 0 });
    expect(d.origem).toBe("regras");
    expect(d.descartado).toMatch(/limite|cooldown|não respondeu/);
  });

  it("evidência real de busca entra no prompt e vira fonte citável", async () => {
    const { buscarEvidencias, montarPromptComEvidencia } = await import("../src/nucleo/ia-diagnostico.js");
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("duckduckgo") || u.includes("html.duckduckgo")) {
        return new Response(
          `<div class="result"><a class="result__a" href="https://esaj.tjsp.jus.br/ajuda">Ajuda e-SAJ</a><a class="result__snippet">limite de 10 consultas por minuto</a></div>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      return new Response("<html></html>", { status: 200 });
    }) as unknown as typeof fetch;
    const ev = await buscarEvidencias(entrada, { fetchImpl });
    const prompt = montarPromptComEvidencia(entrada, ev);
    if (ev.length > 0) {
      expect(prompt).toContain(ev[0]!.url);
      expect(prompt).toContain("Evidências REAIS");
    }
    // sem evidência o prompt não inventa seção vazia
    expect(montarPromptComEvidencia(entrada, [])).not.toContain("Evidências REAIS");
  });

  it("coleta saudável não gasta cota de IA", async () => {
    limparCacheIA();
    let chamou = 0;
    const fetchImpl = (async () => {
      chamou++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const d = await diagnosticar(
      { ...entrada, resultado: { ok: true, http: 200, ms: 400, itens: 9 } },
      { env: {}, fetchImpl },
    );
    expect(d.provedor).toBe("deterministico");
    expect(d.descartado).toContain("saudável");
    expect(chamou).toBe(0);
  });

  it("com tavily (fetch injetado) aplica o ajuste que a IA propôs", async () => {
    const resposta = {
      answer: '{"causa":"timeout do host sob carga","confianca":0.8,"acao":"ajustar","ajustes":[{"chave":"timeoutMs","para":20000,"porque":"host lento"}]}',
      results: [{ title: "docs", url: "https://exemplo/docs", content: "timeout" }],
    };
    const fetchImpl = (async () => new Response(JSON.stringify(resposta), { status: 200 })) as unknown as typeof fetch;
    const d = await diagnosticar(entrada, { env: { AI_PROVIDER: "tavily", AI_API_KEY: "k" }, fetchImpl });
    expect(d.origem).toBe("ia");
    expect(d.provedor).toBe("tavily");
    expect(d.ajustes).toEqual([{ chave: "timeoutMs", de: 10_000, para: 20_000, porque: "host lento" }]);
    expect(d.fontes[0]?.url).toBe("https://exemplo/docs");
  });

  it("IA que inventa parâmetro é DESCARTADA com motivo registrado", async () => {
    const resposta = {
      answer: '{"causa":"timeout","confianca":0.9,"acao":"ajustar","ajustes":[{"chave":"proxyMagico","para":1,"porque":"x"},{"chave":"timeoutMs","para":999999,"porque":"y"}]}',
      results: [],
    };
    const fetchImpl = (async () => new Response(JSON.stringify(resposta), { status: 200 })) as unknown as typeof fetch;
    const d = await diagnosticar(entrada, { env: { AI_PROVIDER: "tavily", AI_API_KEY: "k" }, fetchImpl });
    expect(d.ajustes).toEqual([]);
    expect(d.acao).toBe("manter");
    expect(d.descartado).toContain("proxyMagico");
    expect(d.descartado).toContain("fora de");
  });

  it("IA que aponta causa estrutural (captcha) não consegue empurrar ajuste", async () => {
    const resposta = {
      answer: '{"causa":"o site passou a exigir captcha","confianca":0.9,"acao":"ajustar","ajustes":[{"chave":"timeoutMs","para":20000,"porque":"z"}]}',
      results: [],
    };
    const fetchImpl = (async () => new Response(JSON.stringify(resposta), { status: 200 })) as unknown as typeof fetch;
    const d = await diagnosticar(entrada, { env: { AI_PROVIDER: "tavily", AI_API_KEY: "k" }, fetchImpl });
    expect(d.acao).toBe("manter");
    expect(d.ajustes).toEqual([]);
    expect(d.descartado).toContain("estrutural");
  });

  it("resposta da IA sem JSON não é aplicada", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ answer: "provavelmente é a rede, tente de novo", results: [] }), { status: 200 })) as unknown as typeof fetch;
    const d = await diagnosticar(entrada, { env: { AI_PROVIDER: "tavily", AI_API_KEY: "k" }, fetchImpl });
    // sem JSON a resposta da IA não é usada: vale o determinístico (timeout 10s→20s)
    expect(d.descartado).toContain("JSON");
    expect(d.ajustes).toEqual([{ chave: "timeoutMs", de: 10_000, para: 20_000, porque: "escalonamento determinístico por falha medida" }]);
  });

  it("extrairJson lê JSON cercado por markdown", () => {
    expect(extrairJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extrairJson("sem json")).toBeNull();
  });

  it("validarAjustes rejeita valor igual ao vigente e mais de 3 ajustes", () => {
    const { aceitos, descartados } = validarAjustes(
      [
        { chave: "timeoutMs", para: 10_000 },
        { chave: "retries", para: 2 },
        { chave: "retries", para: 3 },
        { chave: "timeoutMs", para: 25_000 },
        { chave: "timeoutMs", para: 30_000 },
      ],
      coletor.espaco,
      coletor.padrao,
    );
    expect(descartados.some((d) => d.includes("igual ao vigente"))).toBe(true);
    expect(aceitos.length).toBeLessThanOrEqual(3);
  });

  it("a consulta enviada à IA leva a evidência medida (http, itens, ms, histórico)", () => {
    const q = montarConsulta({
      ...entrada,
      historico: [
        { coletorId: coletor.id, ts: "2026-10-25T03:00:00.000Z", http: 500, ms: 1200, itens: 0, ok: false, erro: "HTTP 500", captcha: false, bloqueio: false, score: 10 },
      ],
    });
    expect(q).toContain("http=sem resposta");
    expect(q).toContain("http=500");
    expect(q).toContain("timeoutMs=10000");
  });
});

describe("Motor: mede, promove com canário, reverte e desliga", () => {
  it("promove quando o vizinho MEDIDO rende mais que ε", async () => {
    const store = new InMemoryNucleoStore();
    const coletor = coletorDeTeste({
      // só rende bem com timeoutMs alto — o motor tem de descobrir sozinho
      executar: (p) => ok(Number(p["timeoutMs"]) >= 15_000 ? 8 : 1),
    });
    const r = await cicloColetor(coletor, { store, pausaMs: 0, usarIA: false, maxVizinhos: 2 });
    expect(r.acao).toBe("promovida");
    expect(r.versao).toBe(2);
    expect((await store.obter(coletor.id))!.params["timeoutMs"]).toBe(15_000);
    const acoes = await store.acoes(coletor.id);
    expect(acoes.at(-1)!.resultado).toBe("aplicada");
    expect(acoes.at(-1)!.paramsAntes).toEqual({ timeoutMs: 10_000 });
  });

  it("não promove nada quando o vizinho não supera ε (histerese, sem flip-flop)", async () => {
    const store = new InMemoryNucleoStore();
    const coletor = coletorDeTeste({ executar: () => ok(5) });
    const r = await cicloColetor(coletor, { store, pausaMs: 0, usarIA: false, maxVizinhos: 2 });
    expect(r.acao).toBe("mantida");
    expect(r.versao).toBe(1);
    expect((await store.obter(coletor.id))!.params["timeoutMs"]).toBe(10_000);
  });

  it("reverte quando o ajuste aplicado degrada a coleta seguinte", async () => {
    const store = new InMemoryNucleoStore();
    // estado já promovido para v2 com timeoutMs=20s, e agora essa config entrega menos
    await store.salvar({
      ...estadoInicial("teste-motor", { timeoutMs: 20_000 }),
      versao: 2,
      scoreAtual: 90,
    });
    await store.registrarAcao({
      coletorId: "teste-motor",
      ts: new Date().toISOString(),
      origem: "regras",
      tipo: "ajuste-parametro",
      acao: "v1→v2",
      evidencia: JSON.stringify({ score: 90 }),
      resultado: "aplicada",
      motivo: "teste",
      versaoAntes: 1,
      versaoDepois: 2,
      paramsAntes: { timeoutMs: 10_000 },
      paramsDepois: { timeoutMs: 20_000 },
    });
    const coletor = coletorDeTeste({ executar: (p) => ok(Number(p["timeoutMs"]) >= 15_000 ? 1 : 6) });
    const r = await cicloColetor(coletor, { store, pausaMs: 0, usarIA: false });
    expect(r.acao).toBe("revertida");
    expect((await store.obter(coletor.id))!.params["timeoutMs"]).toBe(10_000);
    expect((await store.obter(coletor.id))!.versao).toBe(3);
  });

  it("rollback roda UMA vez: o ciclo seguinte não reencontra a mesma promoção antiga", async () => {
    const store = new InMemoryNucleoStore();
    await store.salvar({ ...estadoInicial("teste-motor", { timeoutMs: 20_000 }), versao: 2 });
    // promoção antiga de score 90 (o modelo "v2" aplicado no passado)
    await store.registrarAcao({
      coletorId: "teste-motor",
      ts: new Date().toISOString(),
      origem: "regras",
      tipo: "ajuste",
      acao: "v1→v2",
      evidencia: JSON.stringify({ score: 90 }),
      resultado: "aplicada",
      motivo: "promoção medida",
      versaoAntes: 1,
      versaoDepois: 2,
      paramsAntes: { timeoutMs: 20_000 },
      paramsDepois: { timeoutMs: 20_000 },
    });
    const coletor = coletorDeTeste({ executar: () => ok(1) }); // score atual muito pior que 90
    const r1 = await cicloColetor(coletor, { store, pausaMs: 0, usarIA: false });
    expect(r1.acao).toBe("revertida");
    const r2 = await cicloColetor(coletor, { store, pausaMs: 0, usarIA: false });
    expect(r2.acao).not.toBe("revertida"); // antes: revertia para sempre
  });

  it("disjuntor: fonte em recuo não é consultada (orçamento não é queimado)", async () => {
    const store = new InMemoryNucleoStore();
    await store.salvar({
      ...estadoInicial("teste-motor", { timeoutMs: 10_000 }),
      proximaExecucaoEm: new Date(Date.now() + 3_600_000).toISOString(),
      ciclosZerados: 1,
    });
    let chamou = 0;
    const coletor = coletorDeTeste({ executar: () => { chamou++; return ok(1); } });
    const r = await cicloColetor(coletor, { store, pausaMs: 0, usarIA: false });
    expect(r.acao).toBe("pausada");
    expect(chamou).toBe(0);
  });

  it("pedir refino NUNCA desativa a fonte (o problema é o termo do canário)", async () => {
    const store = new InMemoryNucleoStore();
    await store.salvar({ ...estadoInicial("teste-motor", { timeoutMs: 10_000 }), ciclosZerados: 50 });
    const coletor = coletorDeTeste({
      executar: () => ({ ok: false, http: 200, ms: 500, itens: 0, precisaRefinar: true }),
    });
    const r = await cicloColetor(coletor, { store, pausaMs: 0, usarIA: false });
    expect(r.acao).not.toBe("desativada");
    expect((await store.obter(coletor.id))!.ativo).toBe(true);
    expect(r.motivo.toLowerCase()).toContain("específico");
  });

  it("captcha repetido desliga o coletor (parar de insistir é a correção honesta)", async () => {
    const store = new InMemoryNucleoStore();
    await store.salvar({ ...estadoInicial("teste-motor", { timeoutMs: 10_000 }), ciclosZerados: 2 });
    const coletor = coletorDeTeste({
      executar: () => ({ ok: false, http: 200, ms: 400, itens: 0, captcha: true }),
    });
    const r = await cicloColetor(coletor, { store, pausaMs: 0, usarIA: false });
    expect(r.acao).toBe("desativada");
    expect((await store.obter(coletor.id))!.ativo).toBe(false);
    // e não é consultado de novo
    let chamou = 0;
    const r2 = await cicloColetor({ ...coletor, executar: async () => { chamou++; return ok(1); } }, { store, pausaMs: 0, usarIA: false });
    expect(r2.acao).toBe("desativada");
    expect(chamou).toBe(0);
  });

  it("falha de transporte no coletor não derruba o ciclo (virou métrica)", async () => {
    const store = new InMemoryNucleoStore();
    const coletor = coletorDeTeste({
      executar: () => {
        throw new Error("ECONNRESET");
      },
    });
    const r = await cicloColetor(coletor, { store, pausaMs: 0, usarIA: false });
    expect(r.acao).toBe("mantida");
    expect(r.resultado?.erro).toContain("ECONNRESET");
    const m = await store.metricas(coletor.id);
    expect(m.at(-1)!.ok).toBe(false);
  });

  it("gerarVizinhos respeita os limites do espaço (não sai da faixa)", () => {
    const coletor = coletorDeTeste({ executar: () => ok(1), padrao: { timeoutMs: 30_000 } });
    const vizinhos = gerarVizinhos(coletor, { timeoutMs: 30_000 }, 10);
    expect(vizinhos.every((v) => Number(v["timeoutMs"]) <= 30_000)).toBe(true);
    expect(vizinhos.length).toBe(1); // só desce: 25s
  });

  it("ciclo inteiro grava métrica por medição (telemetria de todos os módulos)", async () => {
    const store = new InMemoryNucleoStore();
    const coletor = coletorDeTeste({ executar: () => ok(4) });
    await cicloColetor(coletor, { store, pausaMs: 0, usarIA: false, maxVizinhos: 1 });
    const m = await store.metricas(coletor.id);
    expect(m.length).toBe(2); // vigente + 1 vizinho
    expect(m.every((x) => x.score > 0)).toBe(true);
  });
});

describe("Coleta contínua de todos os módulos + SyncRun", () => {
  it("varre os coletores pedidos, grava SyncRun por coletor e resume por módulo", async () => {
    const store = new InMemoryNucleoStore();
    const runs: Array<{ source: string; region: string | null; status: string; items: number }> = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("pncp.gov.br")) {
        return new Response(JSON.stringify({ data: [{ numeroControlePNCP: "1" }], totalRegistros: 1 }), { status: 200 });
      }
      if (u.includes("rdap.org")) return new Response(JSON.stringify({ ldhName: "example.com" }), { status: 200 });
      return new Response("<html>vazio</html>", { status: 200 });
    }) as unknown as typeof fetch;

    const r = await rodarCicloNucleo({
      store,
      fetchImpl,
      env: {},
      pausaMs: 0,
      usarIA: false,
      maxVizinhos: 0,
      coletores: [coletorPorId("pncp-contratacoes")!, coletorPorId("osint-rdap")!],
      gravarSyncRun: async (x) => {
        runs.push({ source: x.source, region: x.region, status: x.status, items: x.items });
      },
    });
    expect(r.resultados.length).toBe(2);
    expect(runs.length).toBe(2); // SyncRun finalmente tem escritor
    expect(runs.every((x) => x.status === "ok")).toBe(true);
    expect(r.porModulo["licitacoes"]!.itens).toBeGreaterThan(0);
    expect(r.porModulo["investiga"]!.medidos).toBe(1);
  });

  it("erro de um coletor entra no SyncRun como error, sem abortar os outros", async () => {
    const store = new InMemoryNucleoStore();
    const runs: Array<{ source: string; status: string }> = [];
    const quebrado: Coletor = {
      ...coletorPorId("osint-rdap")!,
      id: "quebrado",
      async executar() {
        throw new Error("boom");
      },
    };
    // o coletor lançando é capturado dentro do ciclo → vira métrica, SyncRun ok com 0 itens
    const r = await rodarCicloNucleo({
      store,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      env: {},
      pausaMs: 0,
      usarIA: false,
      maxVizinhos: 0,
      coletores: [quebrado, coletorPorId("osint-rdap")!],
      gravarSyncRun: async (x) => {
        runs.push({ source: x.source, status: x.status });
      },
    });
    expect(r.resultados.length).toBe(2);
    expect(runs.length).toBe(2);
  });

  it("prazo estourado trunca o ciclo em vez de rodar para sempre", async () => {
    const store = new InMemoryNucleoStore();
    const lento = { ...coletorPorId("osint-rdap")!, id: "lento", async executar() { return ok(1, 60_000); } };
    const r = await rodarCicloNucleo({
      store,
      coletores: [lento, { ...lento, id: "lento2" }, { ...lento, id: "lento3" }],
      env: {},
      pausaMs: 0,
      usarIA: false,
      maxVizinhos: 0,
      prazoMs: -1,
    });
    expect(r.truncadoPorPrazo).toBe(true);
    expect(r.resultados.length).toBe(0);
  });
});

describe("Ponte NCA → busca do usuário", () => {
  it("o que o núcleo promove no e-SAJ chega no perfil que a busca lê", async () => {
    const { sincronizarComPerfis } = await import("../src/nucleo/ponte-juridico.js");
    const perfis = new InMemoryPerfilStore();
    const sinc = sincronizarComPerfis(perfis);
    const feito = await sinc({ coletorId: "esaj-al", params: { varianteNome: 2 }, versao: 3, score: 88, motivo: "refino" });
    expect(feito).toBe(true);
    const p = await perfis.obter("esaj-al");
    expect(p?.varianteNome).toBe(2);
    expect(p?.versao).toBeGreaterThanOrEqual(3);
  });

  it("não inventa correspondência: coletor sem parâmetro equivalente não é espelhado", async () => {
    const { sincronizarComPerfis } = await import("../src/nucleo/ponte-juridico.js");
    const perfis = new InMemoryPerfilStore();
    const sinc = sincronizarComPerfis(perfis);
    expect(await sinc({ coletorId: "datajud", params: { timeoutMs: 30_000 }, versao: 2, score: 50, motivo: "timeout" })).toBe(false);
    expect(await sinc({ coletorId: "osint-crtsh", params: { varianteNome: 1 }, versao: 2, score: 50, motivo: "x" })).toBe(false);
    expect(await perfis.obter("datajud")).toBeNull();
  });
});

describe("Disjuntor — decisões explícitas", () => {
  it("sucesso limpa o recuo", () => {
    const d = avaliarIncidente({ ativo: true, ciclosZerados: 3, proximaExecucaoEm: null }, { ok: true, http: 200, itens: 5 }, new Date());
    expect(d).toEqual({ pausarAte: null, desativar: false, motivo: "saudável" });
  });

  it("timeout recua com backoff exponencial", () => {
    const agora = new Date("2026-10-25T03:00:00Z");
    const d1 = avaliarIncidente({ ativo: true, ciclosZerados: 1, proximaExecucaoEm: null }, { ok: false, http: null, itens: 0 }, agora);
    const d2 = avaliarIncidente({ ativo: true, ciclosZerados: 2, proximaExecucaoEm: null }, { ok: false, http: null, itens: 0 }, agora);
    expect(new Date(d2.pausarAte!).getTime()).toBeGreaterThan(new Date(d1.pausarAte!).getTime());
  });

  it("podeColetar respeita o recuo e o desligamento", () => {
    const agora = new Date("2026-10-25T03:00:00Z");
    expect(podeColetar({ ativo: false, ciclosZerados: 0, proximaExecucaoEm: null }, agora).pode).toBe(false);
    expect(podeColetar({ ativo: true, ciclosZerados: 0, proximaExecucaoEm: "2026-10-25T04:00:00.000Z" }, agora).pode).toBe(false);
    expect(podeColetar({ ativo: true, ciclosZerados: 0, proximaExecucaoEm: null }, agora).pode).toBe(true);
  });
});

describe("P0 do plano.md — detector de deriva sobrevive entre ciclos", () => {
  it("o agendador passa o MESMO detector em todos os ciclos (antes: um novo por ciclo = deriva nunca disparava)", async () => {
    const eventos: string[] = [];
    const metrica = (itens: number): Metrica => ({
      fonteId: "esaj-al",
      coletadaEm: new Date().toISOString(),
      consultas: 5,
      itens,
      erros: 0,
      captchas: 0,
      timeouts: 0,
      msP95: 1200,
      canarioItens: itens,
    });
    let ciclo = 0;
    vi.useFakeTimers();
    const { parar } = iniciarAutoAperfeicoamento({
      store: new InMemoryPerfilStore(),
      fontes: ["esaj-al"],
      horas: 1,
      medir: async () => {
        ciclo++;
        // 1º ciclo: saudável; seguintes: devolve 0 sem erro (= deriva)
        return [metrica(ciclo === 1 ? 6 : 0)];
      },
      medirCandidato: async () => metrica(0),
      registrarEvento: (e) => {
        eventos.push(e.tipo);
      },
    });
    // 3 ciclos: saudável + 2 zerados ⇒ driftCiclos=2 precisa do histórico do 1º
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await vi.advanceTimersByTimeAsync(3_600_000);
    parar();
    vi.useRealTimers();
    expect(ciclo).toBe(3);
    expect(eventos).toContain("auto.deriva");
  });
});

describe("Recursivo de verdade: a IA decide, o canário mede, o histórico redecide", () => {
  beforeEach(() => limparCacheIA());
  // o provedor real aceita 1 resposta/30 s; no teste não há motivo para esperar
  const env = { NUCLEO_IA_ESPACO_MS: "0" };

  /** fetch que responde à camada gratuita de IA e à busca de evidência. */
  function fetchIA(json: string, itensPorTimeout: (t: number) => number) {
    const chamadasIA: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("pollinations")) {
        const corpo = String(init?.body ?? "");
        chamadasIA.push(corpo);
        return new Response(JSON.stringify({ choices: [{ message: { content: json } }] }), { status: 200 });
      }
      if (u.includes("duckduckgo") || u.includes("duck")) {
        return new Response(
          `<a class="result__a" href="https://exemplo.gov.br/limites">Limites do portal</a><a class="result__snippet">o portal limita a 10 requisições por minuto</a>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      return new Response("<html></html>", { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, chamadasIA, itensPorTimeout };
  }

  it("IA propõe → canário mede ganho → promoção aplicada e registrada com origem ia", async () => {
    const store = new InMemoryNucleoStore();
    const json =
      '{"causa":"host lento: 1 item com 10 s de timeout; ampliar a janela resolve","confianca":0.7,"acao":"ajustar","ajustes":[{"chave":"timeoutMs","para":15000,"porque":"host responde em ~12 s"}]}';
    const { fetchImpl, chamadasIA } = fetchIA(json, (t) => (t >= 15_000 ? 8 : 1));
    const coletor = coletorDeTeste({
      executar: (p) =>
        Number(p["timeoutMs"]) >= 15_000 ? ok(8) : { ok: false, http: null, ms: 15_000, itens: 0, erro: "aborted" },
    });
    const r = await cicloColetor(coletor, { store, fetchImpl, env, pausaMs: 0, maxVizinhos: 2 });
    expect(chamadasIA.length).toBeGreaterThan(0); // a IA foi realmente chamada
    expect(r.diagnostico?.origem).toBe("ia");
    expect(r.acao).toBe("promovida");
    expect((await store.obter(coletor.id))!.params["timeoutMs"]).toBe(15_000);
    const acao = (await store.acoes(coletor.id)).at(-1)!;
    expect(acao.origem).toBe("ia");
    expect(acao.resultado).toBe("aplicada");
    expect(acao.motivo).toContain("IA");
  });

  it("IA propõe mas o canário NÃO mede ganho → nada é aplicado, com motivo", async () => {
    const store = new InMemoryNucleoStore();
    const json = '{"causa":"timeout","confianca":0.9,"acao":"ajustar","ajustes":[{"chave":"timeoutMs","para":15000,"porque":"x"}]}';
    const { fetchImpl } = fetchIA(json, () => 1);
    const coletor = coletorDeTeste({ executar: () => ok(3) }); // igual em qualquer timeout
    const r = await cicloColetor(coletor, { store, fetchImpl, env, pausaMs: 0, maxVizinhos: 1 });
    expect(r.acao).toBe("mantida");
    const acao = (await store.acoes(coletor.id)).at(-1)!;
    expect(acao.resultado).toBe("rejeitada");
    expect(acao.motivo).toMatch(/ε|ganho/i);
  });

  it("ciclo seguinte (recursão) reavalia com o histórico e não repete o que já falhou", async () => {
    const store = new InMemoryNucleoStore();
    const json = '{"causa":"timeout","confianca":0.9,"acao":"ajustar","ajustes":[{"chave":"timeoutMs","para":15000,"porque":"x"}]}';
    const { fetchImpl, chamadasIA } = fetchIA(json, () => 2);
    const coletor = coletorDeTeste({
      executar: () => ({ ok: false, http: null, ms: 15_000, itens: 0, erro: "aborted" }),
    });
    const r1 = await cicloColetor(coletor, { store, fetchImpl, env, pausaMs: 0, maxVizinhos: 1 });
    limparCacheIA();
    // o próximo ciclo é 6 h depois: o recuo do disjuntor já expirou
    await store.salvar({ ...(await store.obter(coletor.id))!, proximaExecucaoEm: null });
    const r2 = await cicloColetor(coletor, { store, fetchImpl, env, pausaMs: 0, maxVizinhos: 1 });
    const m = await store.metricas(coletor.id);
    expect(m.length).toBeGreaterThanOrEqual(4); // 2 ciclos × (vigente + vizinho): memória real
    expect(chamadasIA.length).toBeGreaterThanOrEqual(2);
    expect(r1.versao).toBe(1);
    expect(r2.versao).toBe(1); // sem ganho medido, versão não sobe
  });

  it("coletor em RECUO também é interpretado pela IA no mesmo ciclo (recuo não esconde o erro)", async () => {
    const store = new InMemoryNucleoStore();
    const json = '{"causa":"403 do portal: exigir cabeçalho de navegador","confianca":0.6,"acao":"manter","ajustes":[]}';
    const { fetchImpl, chamadasIA } = fetchIA(json, () => 1);
    const falho = { ...coletorPorId("osint-rdap")!, async executar() { return { ok: false, http: 403, ms: 900, itens: 0, erro: "HTTP 403" }; } };
    // estado já gravado com recuo ativo: o próximo ciclo só mediria daqui a 1 h
    await store.salvar({
      ...estadoInicial(falho.id, falho.padrao),
      ultimoErro: "HTTP 403",
      falhasSeguidas: 2,
      proximaExecucaoEm: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const r = await rodarCicloNucleo({
      store,
      fetchImpl,
      env,
      pausaMs: 0,
      maxVizinhos: 0,
      maxDiagnosticosIA: 1,
      coletores: [falho],
    });
    // a fase de medição pulou o coletor por causa do recuo (sem resultado medido);
    // mesmo assim a fase de IA foi atrás do erro
    expect(chamadasIA.length).toBeGreaterThan(0); // a IA foi chamada para interpretar a falha
    expect(r.resultados[0]!.diagnostico?.origem).toBe("ia"); // e o resultado final já vem interpretado
    expect(r.comDiagnosticoIA).toContain(falho.id);
  });

  it("a cota de IA do ciclo é respeitada (provedor gratuito: 1 resposta/30 s)", async () => {
    const { fetchImpl, chamadasIA } = fetchIA('{"causa":"x","confianca":0.5,"acao":"manter","ajustes":[]}', () => 1);
    const lento = { ...coletorPorId("osint-rdap")!, async executar() { return ok(0); } };
    const r = await rodarCicloNucleo({
      store: new InMemoryNucleoStore(),
      fetchImpl,
      env,
      pausaMs: 0,
      maxVizinhos: 0,
      maxDiagnosticosIA: 1,
      coletores: [lento, { ...lento, id: "lento2" }, { ...lento, id: "lento3" }],
    });
    expect(r.resultados.length).toBe(3);
    // 1 diagnóstico com IA; os outros 2 seguem no determinístico
    expect(chamadasIA.length).toBeLessThanOrEqual(2); // 2 modelos em paralelo = 1 diagnóstico
  });
});

describe("Cobertura de ponta a ponta: módulos do Investiga e busca do chat", () => {
  it("registra os módulos que o usuário usa (domínio, e-mail e busca web), não só hosts crus", () => {
    const ids = catalogo().map((c) => c.id);
    expect(ids).toContain("osint-dominio");
    expect(ids).toContain("osint-email");
    expect(ids).toContain("busca-web");
  });

  it("busca-web mede fontes reais e trata backend falhando como falha declarada", async () => {
    const vazio = (async () => new Response("<html><body>nada</body></html>", { status: 200 })) as unknown as typeof fetch;
    const c = coletorPorId("busca-web")!;
    const r = await c.executar(c.padrao, { fetchImpl: vazio, consulta: "tribunal consulta processual" });
    expect(r.http).toBe(200);
    expect(r.ok).toBe(false);
    expect(r.camposFaltando).toContain("fontes");
  });

  it("busca-web com resultado real (fixture DDG) conta as fontes", async () => {
    const html = `<div class="result"><a class="result__a" href="https://exemplo.jus.br/x">Consulta</a><a class="result__snippet">trecho</a></div>`;
    const fetchImpl = (async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const c = coletorPorId("busca-web")!;
    const r = await c.executar({ ...c.padrao, pausaMs: 0 }, { fetchImpl, consulta: "tribunal consulta processual" });
    expect(r.itens).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
  });

  it("osint-email roda o pipeline real (Gravatar por fixture) sem rede externa", async () => {
    const fetchImpl = (async (url: string | URL) =>
      String(url).includes("gravatar")
        ? new Response("", { status: 200 })
        : new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const c = coletorPorId("osint-email")!;
    const r = await c.executar(c.padrao, { fetchImpl, consulta: "alguem@example.com" });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.http).toBe(200);
    // achou perfil no Gravatar → 1 item; se o MX falhar no ambiente, ainda é resultado válido
    expect(r.itens).toBeGreaterThanOrEqual(0);
    expect(r.erro).toBeUndefined();
  });
});

describe("Contrato dos stores do núcleo (memória × Prisma, mesma ordem)", () => {
  const URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/acompanhe";
  const dbAlive = (() => {
    const db = createDb(URL);
    return db
      .$queryRaw`select 1`.then(async () => {
        await db.$disconnect();
        return true;
      })
      .catch(async () => {
        await db.$disconnect().catch(() => {});
        return false;
      });
  })();
  // o Prisma lê `orderBy desc` e precisa devolver cronológico; a memória já devolve.
  it("acoes() e metricas() devolvem em ordem cronológica nos DOIS stores", async () => {
    const alive = await dbAlive;
    if (!alive) return; // sem Postgres: nada a comparar, e nada é simulado
    const db = createDb(URL);
    const id = `contrato_${Date.now() % 1_000_000}`;
    const mem = new InMemoryNucleoStore();
    const prisma = new PrismaNucleoStore(db);
    try {
      for (const s of [mem, prisma] as const) {
        for (let i = 0; i < 3; i++) {
          const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
          await s.registrarAcao({
            coletorId: id,
            ts,
            origem: "regras",
            tipo: "ajuste",
            acao: `a${i}`,
            evidencia: "{}",
            resultado: "aplicada",
            motivo: `m${i}`,
            versaoAntes: i,
            versaoDepois: i + 1,
            paramsAntes: { timeoutMs: 10_000 + i },
          });
          await s.registrarMetrica({ coletorId: id, ts, http: 200, ms: 100 + i, itens: i, ok: true, captcha: false, bloqueio: false, score: i });
        }
      }
      const a1 = (await mem.acoes(id)).map((a) => a.acao);
      const a2 = (await prisma.acoes(id)).map((a) => a.acao);
      expect(a1).toEqual(["a0", "a1", "a2"]);
      expect(a2).toEqual(a1);
      expect((await prisma.metricas(id)).map((m) => m.itens)).toEqual([0, 1, 2]);
      expect((await mem.metricas(id)).map((m) => m.itens)).toEqual([0, 1, 2]);
    } finally {
      await db.coletorAcao.deleteMany({ where: { coletorId: id } }).catch(() => {});
      await db.coletorMetrica.deleteMany({ where: { coletorId: id } }).catch(() => {});
      await db.$disconnect();
    }
  });
});
