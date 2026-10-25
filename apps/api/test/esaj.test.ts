/**
 * Parser e-SAJ × fixtures REAIS capturadas em 24/10/2026 (plano-busca-unificada §2.2/§4).
 * Nada de HTML inventado para resultados: os arquivos em fixtures/esaj/ são as
 * respostas literais do TJAL/TJSP (positivo, muitos, vazio, DOCPARTE vazio).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { classificarPagina, parseResultadosEsaj, montarUrlPesquisa, ESAJ_BASES } from "../src/juridico/esaj.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "esaj");
const ler = (nome: string) => readFileSync(join(dir, nome), "utf8");

describe("estados REAIS da fonte (textos literais medidos)", () => {
  it("classifica: resultados / multiplos / vazio", () => {
    expect(classificarPagina(ler("tjal-nmparte-positivo.html"))).toBe("resultados");
    expect(classificarPagina(ler("tjal-nmparte-muitos.html"))).toBe("multiplos");
    expect(classificarPagina(ler("tjal-nmparte-vazio.html"))).toBe("vazio");
    expect(classificarPagina(ler("tjal-docparte-vazio.html"))).toBe("vazio");
    expect(classificarPagina(ler("tjsp-nmparte-joao.html"))).toBe("resultados");
    expect(classificarPagina(ler("tjsp-nmparte-vazio.html"))).toBe("vazio");
  });

  it("captcha/erro → bloqueado/erro honestos (nunca resultados)", () => {
    expect(classificarPagina("<html>resolva o captcha para continuar</html>")).toBe("bloqueado");
    expect(classificarPagina("<html>página qualquer sem dados</html>")).toBe("erro");
  });
});

describe("TJAL — página positiva real (JOAO CARLOS DA SILVA → 29 Processos)", () => {
  const r = parseResultadosEsaj(ler("tjal-nmparte-positivo.html"), "al", 1);

  it("estado, total real e paginação medidos", () => {
    expect(r.estado).toBe("resultados");
    expect(r.total).toBe(29);
    expect(r.ultimaPagina).toBe(2);
    expect(r.itens.length).toBeGreaterThanOrEqual(20);
  });

  it("1ª linha tem os campos LITERAIS da fixture (classe, assunto, foro, data)", () => {
    const it0 = r.itens.find((i) => i.numeroProcesso === "0724866-89.2026.8.02.0001");
    expect(it0).toBeTruthy();
    expect(it0!.nomeParte).toBe("João Carlos dos Santos Silva");
    expect(it0!.participacao).toBe("Autor");
    expect(it0!.classe).toBe("Procedimento Comum Cível");
    expect(it0!.assunto).toBe("Consórcio");
    expect(it0!.dataDistribuicao).toBe("18/05/2026");
    expect(it0!.localDistribuicao).toContain("CEJUSC");
    expect(it0!.foro).toBe("Foro de Maceió");
    expect(it0!.codigoInterno).toBe("01001YLLQ0000");
    expect(it0!.url).toContain("show.do?processo.codigo=01001YLLQ0000");
    expect(it0!.fonte).toBe("esaj-al");
  });

  it("todos os itens têm CNJ no padrão oficial e não há duplicatas", () => {
    for (const i of r.itens) expect(i.numeroProcesso).toMatch(/^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/);
    expect(new Set(r.itens.map((i) => i.numeroProcesso)).size).toBe(r.itens.length);
  });
});

describe("TJSP — página positiva real (mesmo parser — estrutura idêntica medida)", () => {
  const r = parseResultadosEsaj(ler("tjsp-nmparte-joao.html"), "sp", 1);
  it("19 processos reais, 1 página, campos extraídos", () => {
    expect(r.estado).toBe("resultados");
    expect(r.total).toBe(19);
    expect(r.ultimaPagina).toBe(1);
    expect(r.itens.length).toBe(19);
    expect(r.itens.every((i) => /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/.test(i.numeroProcesso))).toBe(true);
    expect(r.itens.some((i) => (i.nomeParte ?? "").length > 3)).toBe(true);
    expect(r.itens.every((i) => i.fonte === "esaj-sp")).toBe(true);
  });
});

describe("estados sem resultado — honestidade total", () => {
  it("MUITOS: zero itens, sem total fabricado", () => {
    const r = parseResultadosEsaj(ler("tjal-nmparte-muitos.html"), "al", 1);
    expect(r.estado).toBe("multiplos");
    expect(r.itens).toEqual([]);
    expect(r.total).toBeNull();
  });
  it("VAZIO (nome sem registros e DOCPARTE sem registros): zero itens", () => {
    for (const arq of ["tjal-nmparte-vazio.html", "tjal-docparte-vazio.html", "tjsp-nmparte-vazio.html"]) {
      const r = parseResultadosEsaj(ler(arq), "al", 1);
      expect(r.estado).toBe("vazio");
      expect(r.itens).toEqual([]);
    }
  });
});

describe("URLs do contrato verificado", () => {
  it("monta exatamente o padrão medido (cbPesquisa/valorConsulta/cdForo/paginaConsulta)", () => {
    const url = montarUrlPesquisa(ESAJ_BASES.al!, "NMPARTE", "JOAO CARLOS", 2);
    expect(url).toBe(
      "https://www2.tjal.jus.br/cpopg/search.do?conversationId=&cbPesquisa=NMPARTE&dadosConsulta.valorConsulta=JOAO%20CARLOS&cdForo=1&paginaConsulta=2",
    );
    const url2 = montarUrlPesquisa(ESAJ_BASES.sp!, "DOCPARTE", "529.982.247-25", 1);
    expect(url2).toContain("cbPesquisa=DOCPARTE");
    expect(url2).toContain("dadosConsulta.valorConsulta=529.982.247-25");
    expect(ESAJ_BASES.al).toBe("https://www2.tjal.jus.br");
    expect(ESAJ_BASES.sp).toBe("https://esaj.tjsp.jus.br");
  });
});

describe("TJAC e TJCE — fixtures REAIS (cobertura: 4 bases verificadas em 24/10/2026)", () => {
  it("ESAJ_BASES = ac, al, ce, sp (todas verificadas ao vivo)", () => {
    expect(Object.keys(ESAJ_BASES).sort()).toEqual(["ac", "al", "ce", "sp"]);
  });

  it("TJAC: RESULTADOS reais com nº CNJ/J=8.01 e VAZIO real", () => {
    const r = parseResultadosEsaj(ler("tjac-nmparte.html"), "ac", 1);
    expect(r.estado).toBe("resultados");
    expect(r.itens.length).toBeGreaterThan(0);
    expect(r.itens[0]!.numeroProcesso).toMatch(/^\d{7}-\d{2}\.\d{4}\.8\.01\.\d{4}$/);
    expect(parseResultadosEsaj(ler("tjac-nmparte-vazio.html"), "ac", 1).estado).toBe("vazio");
  });

  it("TJCE: RESULTADOS reais com nº CNJ/J=8.06 e VAZIO real", () => {
    const r = parseResultadosEsaj(ler("tjce-nmparte.html"), "ce", 1);
    expect(r.estado).toBe("resultados");
    expect(r.itens.length).toBeGreaterThan(0);
    expect(r.itens[0]!.numeroProcesso).toMatch(/^\d{7}-\d{2}\.\d{4}\.8\.06\.\d{4}$/);
    expect(parseResultadosEsaj(ler("tjce-nmparte-vazio.html"), "ce", 1).estado).toBe("vazio");
  });
});
