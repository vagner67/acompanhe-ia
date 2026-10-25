/**
 * Mapa (J,TR) → alias DataJud — 91 índices VERIFICADOS ao vivo em 24/10/2026
 * (plano-91-tribunais-ia §1.1): cada alias respondeu à sondagem match_all e um
 * processo real de cada índice confirmou o J.TR. Testes travam o mapa completo.
 */
import { describe, expect, it } from "vitest";

import { aliasCandidatesFromCnj, aliasFromTribunal, TRIBUNAIS_DATAJUD } from "../src/juridico/cnj.js";

describe("91 tribunais do DataJud (mapa medido 24/10/2026)", () => {
  it("TRIBUNAIS_DATAJUD = 91 aliases únicos, sem STF", () => {
    expect(TRIBUNAIS_DATAJUD.length).toBe(91);
    expect(new Set(TRIBUNAIS_DATAJUD).size).toBe(91);
    expect(TRIBUNAIS_DATAJUD.includes("stf")).toBe(false);
    for (const a of ["stj", "tst", "tse", "stm", "trf1", "trf6", "trt1", "trt24", "tre-df", "tre-sp", "tjal", "tjsp", "tjmmg", "tjmsp"]) {
      expect(TRIBUNAIS_DATAJUD).toContain(a);
    }
  });

  it("aliasFromTribunal: TJs, TRTs, TREs, superiores e militares", () => {
    expect(aliasFromTribunal("8", "02")).toBe("tjal");
    expect(aliasFromTribunal("8", "27")).toBe("tjto");
    expect(aliasFromTribunal("8", "07")).toBe("tjdft");
    expect(aliasFromTribunal("5", "01")).toBe("trt1");
    expect(aliasFromTribunal("5", "24")).toBe("trt24");
    expect(aliasFromTribunal("6", "26")).toBe("tre-sp");
    expect(aliasFromTribunal("6", "16")).toBe("tre-pr"); // medido: docs de tre-pr são 6.16
    expect(aliasFromTribunal("6", "00")).toBe("tse"); // TSE tem numeração própria 6.00 (medido)
    expect(aliasFromTribunal("6", "07")).toBe("tre-df");
    expect(aliasFromTribunal("7", "06")).toBe("stm");
    expect(aliasFromTribunal("9", "13")).toBe("tjmmg");
    expect(aliasFromTribunal("2", "00")).toBe("stj");
    expect(aliasFromTribunal("4", "06")).toBe("trf6");
  });

  it("candidatos incluem a corte superior do ramo (superiores guardam nº de ORIGEM)", () => {
    expect(aliasCandidatesFromCnj("8", "13")).toEqual(["tjmg", "stj"]);
    expect(aliasCandidatesFromCnj("5", "01")).toEqual(["trt1", "tst"]); // 5.01 convive TRT1+TST
    expect(aliasCandidatesFromCnj("5", "02")).toEqual(["trt2", "tst"]);
    expect(aliasCandidatesFromCnj("6", "26")).toEqual(["tre-sp", "tse"]);
    expect(aliasCandidatesFromCnj("7", "06")).toEqual(["stm"]);
    expect(aliasCandidatesFromCnj("9", "13")).toEqual(["tjmmg", "stm"]);
    expect(aliasCandidatesFromCnj("2", "00")).toEqual(["stj"]);
    expect(aliasCandidatesFromCnj("1", "01")).toEqual([]); // STF não está no DataJud
  });
});

describe("formatarNumero — entrada com ou sem máscara", () => {
  it("20 dígitos → formato canônico; entrada já formatada continua igual", async () => {
    const { formatarNumero } = await import("../src/juridico/cnj.js");
    expect(formatarNumero("00069036920148110037")).toBe("0006903-69.2014.8.11.0037");
    expect(formatarNumero("0006903-69.2014.8.11.0037")).toBe("0006903-69.2014.8.11.0037");
    expect(formatarNumero("123")).toBeNull();
  });
});

describe("rotas :cnj aceitam número SEM máscara (DataJud entrega assim)", () => {
  it("a forma canônica é derivável de 20 dígitos e o DV continua sendo validado", async () => {
    const { formatarNumero, isValidCnj } = await import("../src/juridico/cnj.js");
    expect(formatarNumero("00069036920148110037")).toBe("0006903-69.2014.8.11.0037");
    expect(isValidCnj(formatarNumero("00069036920148110037")!)).toBe(true);
    expect(isValidCnj(formatarNumero("00069036920148110000")!)).toBe(false);
  });
});
