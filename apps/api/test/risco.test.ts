/**
 * Motor de criticidade (determinístico, auditável) — cada ponto do score tem
 * regra e processo de origem. Sem IA generativa: mesma entrada ⇒ mesma saída.
 */
import { describe, expect, it } from "vitest";

import { avaliarRisco, VERSAO_REGRAS, type ProcessoParaRisco } from "../src/juridico/risco.js";

const hoje = new Date("2026-10-25T00:00:00Z");

describe("motor de risco determinístico", () => {
  it("conjunto vazio → baixo, sem justificativas", () => {
    const r = avaliarRisco([], hoje);
    expect(r.criticidade).toBe(0);
    expect(r.faixa).toBe("baixo");
    expect(r.justificativas).toEqual([]);
    expect(r.versaoRegras).toBe(VERSAO_REGRAS);
  });

  it("execução fiscal soma R1 e gera justificativa com o processo", () => {
    const p: ProcessoParaRisco = {
      numeroCnj: "0006903-69.2014.8.11.0037",
      classe: "Execução Fiscal",
      status: "ativo",
      polo: "Executado",
    };
    const r = avaliarRisco([p], hoje);
    const regras = r.justificativas.map((j) => j.regra);
    expect(regras).toContain("R1_execucao");
    expect(regras).toContain("R3_polo_passivo");
    expect(regras).toContain("R6_ativo");
    expect(r.justificativas.find((j) => j.regra === "R1_execucao")!.processo).toBe(p.numeroCnj);
    expect(r.criticidade).toBe(3);
    expect(r.faixa).toBe("medio");
  });

  it("matéria criminal soma R2", () => {
    const r = avaliarRisco([{ numeroCnj: "1", classe: "Ação Penal - Roubo", status: "arquivado" }], hoje);
    expect(r.justificativas.some((j) => j.regra === "R2_criminal")).toBe(true);
    expect(r.criticidade).toBe(2);
    expect(r.faixa).toBe("baixo");
  });

  it("volume e valor agregado entram nos degraus certos", () => {
    const cinco: ProcessoParaRisco[] = Array.from({ length: 5 }, (_, i) => ({
      numeroCnj: `p${i}`,
      classe: "Procedimento Comum Cível",
      status: "arquivado",
      valorCausa: 30_000,
    }));
    const r5 = avaliarRisco(cinco, hoje);
    expect(r5.justificativas.some((j) => j.regra === "R4_volume")).toBe(true);
    expect(r5.justificativas.some((j) => j.regra === "R5_valor")).toBe(true); // 150 mil
    expect(r5.justificativas.some((j) => j.regra === "R5_valor_alto")).toBe(false);

    const alto = avaliarRisco(
      Array.from({ length: 16 }, (_, i) => ({ numeroCnj: `q${i}`, status: "arquivado", valorCausa: 100_000 })),
      hoje,
    );
    expect(alto.justificativas.some((j) => j.regra === "R4_volume_alto")).toBe(true);
    expect(alto.justificativas.some((j) => j.regra === "R5_valor_alto")).toBe(true); // 1,6 mi
    expect(alto.criticidade).toBeGreaterThanOrEqual(4);
  });

  it("sigilo e processo antigo ainda ativo somam", () => {
    const r = avaliarRisco(
      [{ numeroCnj: "x", status: "ativo", dataAjuizamento: "2010-01-01", nivelSigilo: 2 }],
      hoje,
    );
    const regras = r.justificativas.map((j) => j.regra);
    expect(regras).toContain("R7_sigilo");
    expect(regras).toContain("R8_antigo_ativo");
    expect(r.criticidade).toBe(3); // R6 + R7 + R8
  });

  it("score é limitado a 10 e a faixa acompanha o valor", () => {
    const muitos: ProcessoParaRisco[] = Array.from({ length: 20 }, (_, i) => ({
      numeroCnj: `z${i}`,
      classe: "Execução Fiscal",
      status: "ativo",
      polo: "Executado",
      valorCausa: 5_000_000,
      nivelSigilo: 1,
      dataAjuizamento: "2005-01-01",
    }));
    const r = avaliarRisco(muitos, hoje);
    expect(r.criticidade).toBe(10);
    expect(r.faixa).toBe("critico");
    expect(r.justificativas.length).toBeGreaterThan(5);
  });

  it("determinismo: duas execuções com a mesma entrada dão o mesmo resultado", () => {
    const entrada: ProcessoParaRisco[] = [{ numeroCnj: "a", classe: "Execução", status: "ativo", polo: "Réu" }];
    expect(JSON.stringify(avaliarRisco(entrada, hoje))).toBe(JSON.stringify(avaliarRisco(entrada, hoje)));
  });
});
