/**
 * Busca web REAL (DuckDuckGo HTML, sem chave) + modo IA pluggável do buscador
 * (plano-91-tribunais-ia §1.3). Fixture = resposta LITERAL medida em 24/10/2026
 * (`fixtures/ddg/busca-cpc.html`); provedores pagos entram por contrato oficial
 * e nos testes por mock — a regra "nunca resposta sem fonte" é travada aqui.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { buscarWeb, buscarWebDetalhado, ehAnomalia, parseDdgHtml } from "../src/juridico/buscaWeb.js";
import { responderComBuscador } from "../src/juridico/buscaIA.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ddg");
const ddgHtml = readFileSync(join(dir, "busca-cpc.html"), "utf8");
const anomalyHtml = readFileSync(join(dir, "anomalia-202.html"), "utf8");

describe("DuckDuckGo HTML (fixture REAL de 24/10/2026)", () => {
  it("parse: ≥8 fontes com URL decodificada do redirect uddg, título e trecho reais", () => {
    const fontes = parseDdgHtml(ddgHtml);
    expect(fontes.length).toBeGreaterThanOrEqual(8);
    expect(fontes[0]!.url.startsWith("http")).toBe(true);
    expect(fontes[0]!.url).not.toContain("duckduckgo.com/l/");
    expect(fontes[0]!.titulo.length).toBeGreaterThan(5);
    expect(fontes[0]!.trecho.length).toBeGreaterThan(10);
  });

  it("buscarWeb consome o HTML servido (fetch) sem inventar", async () => {
    const f = (async () => new Response(ddgHtml, { status: 200 })) as typeof fetch;
    const r = await buscarWeb("prazo apelação CPC", { fetchImpl: f });
    expect(r.length).toBeGreaterThanOrEqual(8);
    expect(r.every((x) => x.url.startsWith("http"))).toBe(true);
  });
});

describe("bloqueio anti-robô do DDG (resposta REAL 202/anomaly de 24/10/2026)", () => {
  it("ehAnomalia reconhece a página real de bloqueio", () => {
    expect(ehAnomalia(anomalyHtml)).toBe(true);
    expect(ehAnomalia(ddgHtml)).toBe(false);
  });

  it("bloqueado → 0 fontes + diagnóstico honesto (nunca inventa)", async () => {
    const f = (async () => new Response(anomalyHtml, { status: 202 })) as typeof fetch;
    const r = await buscarWebDetalhado("prazo apelacao", { fetchImpl: f, tentativas: 1 });
    expect(r.fontes).toEqual([]);
    expect(r.diagnostico.length).toBeGreaterThan(0);
    expect(r.diagnostico[0]!.status).toBe(202);
    expect(r.diagnostico[0]!.motivo).toContain("anti-robô");
  });
});

describe("modo IA do buscador (buscaIA) — resposta sempre com fonte", () => {
  it("sem chave → provedor duckduckgo, geradaPorIA=false, resposta cita as fontes reais", async () => {
    const f = (async (url: RequestInfo | URL) => {
      if (String(url).includes("duckduckgo")) return new Response(ddgHtml, { status: 200 });
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const r = await responderComBuscador("prazo de apelação no CPC", { fetchImpl: f, env: {} });
    expect(r.provedor).toBe("duckduckgo");
    expect(r.geradaPorIA).toBe(false);
    expect(r.fontes.length).toBeGreaterThanOrEqual(8);
    expect(r.resposta).toContain("DuckDuckGo");
    expect(r.resposta).toContain("AI_PROVIDER"); // instrução honesta de configuração
    expect(r.diagnostico.length).toBeGreaterThan(0); // tentativas reais expostas
  });

  it("AI_PROVIDER=tavily + chave → resposta gerada com as fontes do provedor", async () => {
    const f = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("duckduckgo")) return new Response(ddgHtml, { status: 200 });
      if (u.includes("api.tavily.com")) {
        return new Response(
          JSON.stringify({
            answer: "O prazo de apelação é de 15 dias úteis (CPC, art. 1.003, §5º).",
            results: [
              {
                title: "Lei 13.105/2015 (CPC) — Planalto",
                url: "https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2015/lei/l13105.htm",
                content: "Art. 1.003. O prazo para interpor os recursos é de 15 (quinze) dias úteis.",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const r = await responderComBuscador("prazo de apelação", {
      fetchImpl: f,
      env: { AI_PROVIDER: "tavily", AI_API_KEY: "tvly-teste" },
    });
    expect(r.provedor).toBe("tavily");
    expect(r.geradaPorIA).toBe(true);
    expect(r.resposta).toContain("15 dias úteis");
    expect(r.fontes[0]!.url).toContain("planalto.gov.br");
    expect(Array.isArray(r.diagnostico)).toBe(true);
  });

  it("sem chave e DDG bloqueado → explica o bloqueio e indica a chave gratuita (não inventa)", async () => {
    const f = (async () => new Response(anomalyHtml, { status: 202 })) as typeof fetch;
    const r = await responderComBuscador("prazo de apelação", { fetchImpl: f, env: {} });
    expect(r.provedor).toBe("duckduckgo");
    expect(r.geradaPorIA).toBe(false);
    expect(r.fontes).toEqual([]);
    expect(r.resposta).toContain("tavily.com");
    expect(r.resposta).toContain("não invento resultados");
  });

  it("provedor pago falha → cai nos resultados REAIS do DDG (nunca inventa)", async () => {
    const f = (async (url: RequestInfo | URL) => {
      if (String(url).includes("duckduckgo")) return new Response(ddgHtml, { status: 200 });
      return new Response("erro", { status: 500 });
    }) as typeof fetch;
    const r = await responderComBuscador("consulta qualquer", {
      fetchImpl: f,
      env: { AI_PROVIDER: "perplexity", AI_API_KEY: "x" },
    });
    expect(r.provedor).toBe("duckduckgo");
    expect(r.geradaPorIA).toBe(false);
    expect(r.fontes.length).toBeGreaterThan(0);
  });
});
