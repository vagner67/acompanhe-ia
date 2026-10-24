/**
 * Detecção do campo único (plano-busca-unificada §3.1) — DVs REAIS:
 * CPF/CNPJ módulo 11 oficial; CNJ ISO 7064 mod 97 (Res. 65/2008).
 */
import { describe, expect, it } from "vitest";

import { detectarConsulta, validarCpf, validarCnpj, cpfDvs, cnpjDvs } from "../src/juridico/deteccao.js";

describe("DV CPF (módulo 11 real)", () => {
  it("CPF com DV válido passa; trocar 1 dígito reprova", () => {
    expect(validarCpf("529.982.247-25")).toBe(true);
    expect(validarCpf("52998224725")).toBe(true);
    expect(validarCpf("529.982.247-26")).toBe(false);
    expect(validarCpf("111.111.111-11")).toBe(false); // repetição
    expect(validarCpf("123")).toBe(false);
    expect(cpfDvs("52998224725")[0]).toBe("2");
    expect(cpfDvs("52998224725")[1]).toBe("5");
  });
});

describe("DV CNPJ (módulo 11 real)", () => {
  it("CNPJ com DV válido passa; trocar 1 dígito reprova", () => {
    expect(validarCnpj("11.222.333/0001-81")).toBe(true);
    expect(validarCnpj("11222333000181")).toBe(true);
    expect(validarCnpj("11.222.333/0001-82")).toBe(false);
    expect(validarCnpj("00000000000000")).toBe(false);
    expect(cnpjDvs("11222333000181")).toEqual(["8", "1"]);
  });
});

describe("detectarConsulta — campo único", () => {
  it("número de processo (formatado ou só dígitos) → cnj com DV real", () => {
    const d1 = detectarConsulta("0006903-69.2014.8.11.0037");
    expect(d1.tipo).toBe("cnj");
    expect(d1.formato).toBe("0006903-69.2014.8.11.0037");
    expect(d1.erro).toBeUndefined();
    const d2 = detectarConsulta("0006903692014811003 7".replace(" ", ""));
    expect(d2.tipo).toBe("cnj");
  });

  it("CNJ com DV errado → erro honesto (nunca busca)", () => {
    const d = detectarConsulta("0006903-99.2014.8.11.0037");
    expect(d.tipo).toBe("cnj");
    expect(d.erro).toContain("verificadores inválidos");
  });

  it("CPF válido → cpf formatado; inválido → erro honesto", () => {
    const ok = detectarConsulta("529.982.247-25");
    expect(ok.tipo).toBe("cpf");
    expect(ok.formato).toBe("529.982.247-25");
    const bad = detectarConsulta("529.982.247-26");
    expect(bad.tipo).toBe("cpf");
    expect(bad.erro).toContain("verificadores inválidos");
  });

  it("CNPJ válido → cnpj; inválido → erro honesto", () => {
    const ok = detectarConsulta("11.222.333/0001-81");
    expect(ok.tipo).toBe("cnpj");
    expect(ok.formato).toBe("11.222.333/0001-81");
    const bad = detectarConsulta("11.222.333/0001-82");
    expect(bad.erro).toContain("verificadores inválidos");
  });

  it("nome: ≥2 palavras sem advertência; 1 palavra avisa homônimos; <3 letras → erro", () => {
    const n = detectarConsulta("João Carlos da Silva");
    expect(n.tipo).toBe("nome");
    expect(n.valor).toBe("João Carlos da Silva");
    expect(n.advertencia).toBeUndefined();
    const so = detectarConsulta("Madonna");
    expect(so.tipo).toBe("nome");
    expect(so.advertencia).toContain("homônimos");
    const curto = detectarConsulta("ab");
    expect(curto.erro).toContain("informe nome, CPF/CNPJ ou número do processo");
  });
});
