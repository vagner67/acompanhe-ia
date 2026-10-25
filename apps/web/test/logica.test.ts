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
