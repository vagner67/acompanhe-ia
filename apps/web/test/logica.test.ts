import { describe, expect, it } from "vitest";
import type { DetalheTercero, ItemIndice, ProcessoTercero, ResultadoEsaj } from "../src/api2";
import {
  acoesDoEstado,
  contarPorFonte,
  detectarTipo,
  encurtar,
  faixaCriticidade,
  resumoCobertura,
  unificarResultados,
  linhaCobertura,
  relatorioFontes,
  resumoFontesNacional,
} from "../src/juridico/logica";

/**
 * Testes da lógica da tela jurídica refatorada (docs/plano-refatoracao-ui.md).
 * Cobrem o que quebraria silenciosamente a UI: detecção do que o usuário digitou,
 * dedupe entre índice próprio e e-SAJ, e o que aparece em cada estado.
 */

const processoEsaj = (over: Partial<ProcessoTercero> = {}): ProcessoTercero => ({
  numeroProcesso: "0002985-97.2026.8.02.0001",
  codigoInterno: null,
  uf: "al",
  foro: "1ª Vara Cível",
  classe: "Carta Precatória Cível",
  assunto: "Usucapião Especial",
  participacao: "Autor",
  nomeParte: "João Carlos da Paz",
  dataDistribuicao: "2026-02-10",
  localDistribuicao: null,
  fonte: "esaj-al",
  url: "https://www.tjal.jus.br/x",
  ...over,
});

const itemIndice = (over: Partial<ItemIndice> = {}): ItemIndice => ({
  processo: {
    numeroCnj: "0002985-97.2026.8.02.0001",
    tribunal: "tjal",
    uf: "al",
    classe: "Carta Precatória Cível",
    assunto: "Usucapião Especial",
    orgaoJulgador: "1ª Vara Cível",
    dataAjuizamento: "2026-02-10",
    ultimoMovimentoNome: "Conclusão ao Juiz",
    ultimoMovimentoData: "2026-03-01",
    fonte: "indice",
    atualizadoEm: "2026-10-25T00:00:00.000Z",
  },
  score: 1,
  motivo: "numero",
  motivoLegivel: "número do processo informado",
  parteEncontrada: null,
  ...over,
});

describe("detectarTipo — o que o usuário digitou", () => {
  it("reconhece CNJ com e sem máscara", () => {
    expect(detectarTipo("0006903-69.2014.8.11.0037")).toBe("cnj");
    expect(detectarTipo("00069036920148110037")).toBe("cnj");
  });
  it("reconhece CPF (11), CNPJ (14) e nome", () => {
    expect(detectarTipo("529.982.247-25")).toBe("cpf");
    expect(detectarTipo("11.222.333/0001-81")).toBe("cnpj");
    expect(detectarTipo("João Carlos")).toBe("nome");
    expect(detectarTipo("   ")).toBe("");
  });
});

describe("unificarResultados — índice + e-SAJ numa lista só", () => {
  it("deduplica pelo número mesmo com máscaras diferentes", () => {
    const lista = unificarResultados([itemIndice()], [processoEsaj()], {});
    expect(lista).toHaveLength(1);
    // o item do índice manda no score, a e-SAJ completa o que falta
    expect(lista[0]!.score).toBe(1);
    expect(lista[0]!.partes).toBe("João Carlos da Paz");
    expect(lista[0]!.fontes).toEqual(["indice", "esaj-al"]);
    expect(lista[0]!.url).toBe("https://www.tjal.jus.br/x");
  });

  it("ordena por grau de vínculo (score) e depois por número", () => {
    const lista = unificarResultados(
      [
        itemIndice({ score: 0.5, processo: { ...itemIndice().processo, numeroCnj: "0000001-11.2026.8.02.0001" } }),
        itemIndice({ score: 1, processo: { ...itemIndice().processo, numeroCnj: "0000002-22.2026.8.02.0001" } }),
      ],
      [processoEsaj({ numeroProcesso: "0000003-33.2026.8.02.0001", nomeParte: "Outra Pessoa" })],
      {},
    );
    expect(lista.map((i) => Math.round((i.score ?? -1) * 10))).toEqual([10, 5, -10]);
  });

  it("enriquece o item de e-SAJ com o cruzamento do DataJud", () => {
    const detalhe: DetalheTercero = {
      numeroProcesso: "0002985-97.2026.8.02.0001",
      status: "ativo",
      classe: "Carta Precatória Cível",
      orgaoJulgador: "1ª Vara Cível",
      valorDaCausa: 1000,
      ultimoMovimento: { nome: "Conclusão ao Juiz", dataHora: "2026-03-01" },
      dataAjuizamento: "2026-02-10",
      fonte: "datajud",
    };
    const [item] = unificarResultados([], [processoEsaj()], { "0002985-97.2026.8.02.0001": detalhe });
    expect(item!.status).toBe("ativo");
    expect(item!.ultimoMovimento).toBe("Conclusão ao Juiz");
    expect(item!.tribunal).toBe("e-SAJ AL");
  });

  it("lista vazia quando não há nada (nunca inventa)", () => {
    expect(unificarResultados(null, null, null)).toEqual([]);
    expect(unificarResultados([], [], {})).toEqual([]);
  });
});

describe("acoesDoEstado — divulgação progressiva sem sanfona", () => {
  it("sem consulta: só buscar", () => {
    expect(acoesDoEstado("", false)).toEqual(["buscar"]);
  });
  it("nome: buscar + pesquisa profunda (nunca 'acompanhar' sem processo)", () => {
    expect(acoesDoEstado("nome", false)).toEqual(["buscar", "profunda"]);
    expect(acoesDoEstado("cpf", false)).not.toContain("acompanhar");
  });
  it("CNJ sem processo aberto: abrir/índice; com processo: ações completas", () => {
    expect(acoesDoEstado("cnj", false)).toEqual(["abrir", "indice"]);
    expect(acoesDoEstado("cnj", true)).toEqual(["abrir", "acompanhar", "alertar", "sincronizar", "perguntar"]);
  });
});

describe("resumoCobertura / contarPorFonte / faixaCriticidade", () => {
  it("resumo usa o catálogo real e não inventa número", () => {
    const cat = {
      fontes: [],
      cobertura: { numero: { fontes: 1, tribunais: 91 }, nome: { fontes: ["esaj-sp"], ufs: ["ac", "al", "ce", "sp"] }, documento: { fontes: [], ufs: ["ac"] } },
      rodape: "",
    };
    expect(resumoCobertura(cat)).toBe("91 tribunais por número · nome/CPF em AC, AL, CE, SP");
    expect(resumoCobertura(null)).toBe("fontes públicas verificadas");
  });

  it("conta por fonte somando páginas e preservando o estado com resultados", () => {
    const r = (over: Partial<ResultadoEsaj>): ResultadoEsaj => ({
      estado: "resultados",
      uf: "al",
      fonte: "esaj-al",
      total: 10,
      pagina: 1,
      ultimaPagina: 1,
      itens: [processoEsaj()],
      ...over,
    });
    const contagens = contarPorFonte([
      r({ pagina: 1 }),
      r({ pagina: 2, estado: "vazio", itens: [] }),
      r({ fonte: "esaj-sp", uf: "sp", estado: "bloqueado", itens: [] }),
    ]);
    expect(contagens.find((c) => c.fonte === "esaj-al")!.itens).toBe(1);
    expect(contagens.find((c) => c.fonte === "esaj-al")!.estado).toBe("resultados");
    expect(contagens.find((c) => c.fonte === "esaj-sp")!.estado).toBe("bloqueado");
  });

  it("faixas de criticidade batem com risco-v1", () => {
    expect(faixaCriticidade(0).rotulo).toBe("baixo");
    expect(faixaCriticidade(2).rotulo).toBe("baixo");
    expect(faixaCriticidade(3).rotulo).toBe("médio");
    expect(faixaCriticidade(5).rotulo).toBe("médio");
    expect(faixaCriticidade(6).rotulo).toBe("alto");
    expect(faixaCriticidade(8).rotulo).toBe("alto");
    expect(faixaCriticidade(9).rotulo).toBe("crítico");
  });

  it("encurtar nunca devolve string vazia", () => {
    expect(encurtar(null)).toBe("—");
    expect(encurtar("abc", 10)).toBe("abc");
    expect(encurtar("a".repeat(30), 10)).toHaveLength(10);
    expect(encurtar("a".repeat(30), 10).endsWith("…")).toBe(true);
  });
});

// ── Busca nacional: relatório de fontes honesto e linha de cobertura ──
describe("busca nacional — relatório de fontes", () => {
  it("traduz cada estado para texto humano (inclusive os ruins)", () => {
    const linhas = relatorioFontes([
      { fonte: "esaj-sp", estado: "ok", itens: 3, ms: 900 },
      { fonte: "djen", estado: "geo_bloqueado", itens: 0, motivo: "403 CloudFront" },
      { fonte: "esaj-ce", estado: "timeout", itens: 0 },
      { fonte: "indice", estado: "vazio", itens: 0 },
      { fonte: "esaj-sp", estado: "refinar", itens: 0 },
    ]);
    expect(linhas.map((l) => l.rotulo)).toEqual(["e-SAJ SP", "DJEN", "e-SAJ CE", "INDICE", "e-SAJ SP"]);
    expect(linhas[0]!.texto).toBe("respondeu");
    expect(linhas[1]!.texto).toContain("bloqueado fora do Brasil");
    expect(linhas[1]!.texto).toContain("403 CloudFront");
    expect(linhas[2]!.tom).toBe("ruim");
    expect(linhas[3]!.tom).toBe("parcial");
    expect(linhas[4]!.texto).toContain("refine a busca");
    expect(linhas[4]!.tom).toBe("parcial");
  });

  it("estado desconhecido não vira 'ok' nem some", () => {
    const [l] = relatorioFontes([{ fonte: "x", estado: "novo-estado", itens: 0 }]);
    expect(l!.texto).toBe("novo-estado");
    expect(l!.tom).toBe("ruim");
  });

  it("resumo separa quem respondeu de quem falhou", () => {
    const r = resumoFontesNacional([
      { fonte: "a", estado: "ok", itens: 2 },
      { fonte: "b", estado: "vazio", itens: 0 },
      { fonte: "c", estado: "timeout", itens: 0 },
      { fonte: "d", estado: "pulado", itens: 0 },
    ]);
    expect(r).toEqual({ responderam: 2, falharam: 2, total: 4 });
    expect(resumoFontesNacional(null)).toEqual({ responderam: 0, falharam: 0, total: 0 });
  });

  it("linha de cobertura diz a verdade sobre o DJEN", () => {
    expect(linhaCobertura({ tribunais: 91, numero: 91, nome: 4, cpf: 4, djen: false })).toBe(
      "91/91 por número · nome/CPF em 4 (e-SAJ aberto)",
    );
    expect(linhaCobertura({ tribunais: 91, numero: 91, nome: 4, cpf: 4, djen: true })).toContain("todos via DJEN");
    expect(linhaCobertura(null)).toContain("91 tribunais");
  });
});

describe("perfil de coleta aplicado — transparência na tela", () => {
  it("versão do perfil acompanha a linha da fonte quando existe", () => {
    const [com, sem] = relatorioFontes([
      { fonte: "esaj-sp", estado: "ok", itens: 3, perfilVersao: 4 },
      { fonte: "djen", estado: "pulado", itens: 0 },
    ]);
    expect(com!.perfilVersao).toBe(4);
    expect(sem!.perfilVersao).toBeUndefined();
    expect(relatorioFontes([{ fonte: "x", estado: "ok", itens: 1, perfilVersao: 0 }])[0]!.perfilVersao).toBeUndefined();
  });
});
