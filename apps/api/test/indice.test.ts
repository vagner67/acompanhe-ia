/**
 * Índice próprio (P1/P2/P3): normalização, hash LGPD, score de vínculo,
 * ranking e facetas. Dados derivados das fixtures REAIS já capturadas
 * (DataJud capture + resultados e-SAJ de TJAL).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseResultadosEsaj } from "../src/juridico/esaj.js";
import type { DatajudDoc } from "../src/juridico/types.js";
import {
  chaveDocumento,
  facetasDe,
  InMemoryIndiceStore,
  mesclarProcesso,
  normalizarNome,
  processoDaBuscaEsaj,
  processoDoDatajud,
  ranquear,
  similaridadeNome,
  type ProcessoIndiceDto,
} from "../src/juridico/indice.js";
import { ingerirDaBuscaEsaj, ingerirPorNumeros } from "../src/juridico/ingestao.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const REAL = (JSON.parse(readFileSync(join(dir, "datajud-capture.json"), "utf8")) as { hit: DatajudDoc }).hit;
const tjal = parseResultadosEsaj(readFileSync(join(dir, "esaj", "tjal-nmparte-positivo.html"), "utf8"), "al", 1);

describe("normalização e LGPD", () => {
  it("normaliza acento/caixa/pontuação", () => {
    expect(normalizarNome("João  Carlos da Silva")).toBe("JOAO CARLOS DA SILVA");
    expect(normalizarNome("MARIA D'ÁVILA")).toBe("MARIA D AVILA");
  });

  it("documento vira SHA-256 (LGPD: nunca CPF em claro), estável com/sem máscara", () => {
    const a = chaveDocumento("529.982.247-25");
    const b = chaveDocumento("52998224725");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain("529");
  });

  it("similaridade de nome tolera ordem/acento e rejeita nomes distintos", () => {
    expect(similaridadeNome("Joao Carlos da Silva", "JOAO CARLOS DA SILVA")).toBe(1);
    expect(similaridadeNome("Joao Carlos da Silva", "Maria Souza Lima")).toBe(0);
  });
});

describe("conversão para o índice", () => {
  it("DataJud → processo do índice, SEM partes (o DataJud não publica nomes)", () => {
    const p = processoDoDatajud(REAL, "tjmt", new Date("2026-10-25T00:00:00Z"));
    // contrato: o índice guarda SEMPRE o CNJ canônico (com máscara), qualquer que
    // seja a forma que a fonte entregou — foi o que quebrou o smoke fim a fim.
    expect(p.numeroCnj).toBe("0006903-69.2014.8.11.0037");
    expect(p.numeroCnj.replace(/\D+/g, "")).toBe(REAL.numeroProcesso.replace(/\D+/g, ""));
    expect(p.tribunal).toBe("tjmt");
    expect(p.partes).toEqual([]); // honestidade estrutural
    expect(p.classe).toBe(REAL.classe.nome);
    expect(p.dataAjuizamento).toBe("2014-08-05");
    expect(p.movimentos.length).toBeGreaterThan(10);
    expect(p.ultimoMovimentoNome).toBeTruthy();
    expect(p.fonte).toBe("datajud-tjmt");
  });

  it("e-SAJ por NOME → motivo 'sem_documento' (peso 0.5) e nome normalizado", () => {
    const [p] = ingerirDaBuscaEsaj([tjal.itens[0]!], "nome", new Date("2026-10-25T00:00:00Z"));
    expect(p!.partes.length).toBe(1);
    expect(p!.partes[0]!.motivoVinculo).toBe("sem_documento");
    expect(p!.partes[0]!.scoreVinculo).toBe(0.5);
    expect(p!.partes[0]!.documentoHash).toBeNull();
    expect(p!.partes[0]!.nomeNormalizado).toBe(normalizarNome(p!.partes[0]!.nome));
  });

  it("e-SAJ por DOCUMENTO → vínculo 'documento_informado' (peso 1) com hash", () => {
    const [p] = ingerirDaBuscaEsaj([tjal.itens[0]!], "documento", new Date(), "52998224725");
    expect(p!.partes[0]!.motivoVinculo).toBe("documento_informado");
    expect(p!.partes[0]!.scoreVinculo).toBe(1);
    expect(p!.partes[0]!.documentoHash).toBe(chaveDocumento("52998224725"));
  });

  it("mesclar mantém partes antigas quando o novo registro não traz partes", () => {
    const comParte = processoDaBuscaEsaj(tjal.itens[0]!, "nome");
    const semParte = processoDoDatajud(REAL, "tjal");
    const m = mesclarProcesso(comParte, semParte);
    expect(m.partes.length).toBe(comParte.partes.length);
    expect(m.classe).toBeTruthy();
  });
});

describe("ranking (P3) e facetas", () => {
  const agora = new Date("2026-10-25T12:00:00Z");
  const doIndice: ProcessoIndiceDto[] = [
    ...ingerirDaBuscaEsaj(tjal.itens.slice(0, 5), "nome", agora),
    processoDoDatajud(REAL, "tjmt", agora),
  ];

  it("busca por nome retorna só quem tem parte compatível, com motivo legível", () => {
    const alvo = tjal.itens[0]!.nomeParte!;
    const r = ranquear(doIndice, { nome: alvo, limite: 10 });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.motivo).toBe("sem_documento");
    expect(r[0]!.motivoLegivel).toContain("homônimo");
    expect(r[0]!.parteEncontrada).toBeTruthy();
  });

  it("busca por documento sem hash no índice → vazio honesto (não chuta vínculo)", () => {
    expect(ranquear(doIndice, { documento: "111.444.777-35", limite: 10 })).toEqual([]);
  });

  it("busca por número acha o processo do DataJud com score 1", () => {
    const num = REAL.numeroProcesso;
    const formatado = `${num.slice(0, 7)}-${num.slice(7, 9)}.${num.slice(9, 13)}.${num[13]}.${num.slice(14, 16)}.${num.slice(16, 20)}`;
    const r = ranquear(doIndice, { numero: formatado, limite: 5 });
    expect(r.length).toBe(1);
    expect(r[0]!.motivo).toBe("numero");
    expect(r[0]!.score).toBe(1);
  });

  it("facetas contam tribunal e ano", () => {
    const f = facetasDe(doIndice);
    expect(f.tribunais.some((t) => t.valor === "esaj-al")).toBe(true);
    expect(f.tribunais.some((t) => t.valor === "tjmt")).toBe(true);
    expect(f.anos.some((a) => a.valor === "2014")).toBe(true);
  });

  it("store em memória: upsert idempotente e busca por documento casa o hash", async () => {
    const store = new InMemoryIndiceStore();
    const itens = ingerirDaBuscaEsaj(tjal.itens.slice(0, 2), "documento", agora, "529.982.247-25");
    expect(await store.upsertMuitos(itens)).toBe(2);
    expect(await store.upsertMuitos(itens)).toBe(2); // idempotente
    expect(await store.total()).toBe(2);
    const achados = await store.buscar({ documento: "52998224725" });
    expect(achados.length).toBe(2);
    expect((await store.buscar({ documento: "11144477735" })).length).toBe(0);
  });
});

describe("ingestão por número (91 tribunais, fallback superior)", () => {
  it("usa a corte do (J,TR) e cai no superior quando a corte não tem o processo", async () => {
    const chamadas: string[] = [];
    const r = await ingerirPorNumeros(
      ["0006903-15.2014.8.13.0037"],
      {
        datajud: async (alias) => {
          chamadas.push(alias);
          return alias === "stj" ? [REAL] : [];
        },
      },
      new Date("2026-10-25T00:00:00Z"),
    );
    expect(chamadas).toEqual(["tjmg", "stj"]);
    expect(r.ingeridos.length).toBe(1);
    expect(r.ingeridos[0]!.fonte).toBe("datajud-stj");
  });

  it("número inválido vai para invalidos (nunca para o índice) e STF vira naoEncontrado", async () => {
    const r = await ingerirPorNumeros(
      ["123", "0001234-30.2020.1.00.0000"],
      { datajud: async () => [REAL] },
      new Date(),
    );
    expect(r.invalidos).toEqual(["123"]);
    expect(r.naoEncontrados).toEqual(["0001234-30.2020.1.00.0000"]);
    expect(r.ingeridos).toEqual([]);
  });
});

describe("número do índice é sempre canônico", () => {
  it("DataJud sem máscara entra formatado e casa com busca formatada", async () => {
    const { processoDoDatajud, InMemoryIndiceStore } = await import("../src/juridico/indice.js");
    const p = processoDoDatajud({ numeroProcesso: "00069036920148110037", movimentos: [] } as never, "tjmt");
    expect(p.numeroCnj).toBe("0006903-69.2014.8.11.0037");
    const store = new InMemoryIndiceStore();
    await store.upsertMuitos([p]);
    expect((await store.buscar({ numero: "0006903-69.2014.8.11.0037" })).length).toBe(1);
  });
});
