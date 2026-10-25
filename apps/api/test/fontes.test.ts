/**
 * Catálogo de fontes (padrão P7) — a cobertura anunciada tem que ser a cobertura
 * real, derivada dos mesmos mapas verificados (ESAJ_BASES, TRIBUNAIS_DATAJUD).
 */
import { describe, expect, it } from "vitest";

import { ESAJ_BASES } from "../src/juridico/esaj.js";
import { TRIBUNAIS_DATAJUD } from "../src/juridico/cnj.js";
import { cobertura, fontesPara, FONTES_INFO } from "../src/juridico/fontes.js";

describe("catálogo de fontes", () => {
  it("toda fonte declara verificadoEm (nada anunciado sem verificação)", () => {
    for (const f of FONTES_INFO) {
      expect(f.verificadoEm).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.capacidades.length).toBeGreaterThan(0);
    }
  });

  it("e-SAJ do catálogo = exatamente as bases verificadas no código (ac, al, ce, sp)", () => {
    const doCatalogo = FONTES_INFO.filter((f) => f.tipo === "esaj").map((f) => f.id.replace("esaj-", "")).sort();
    expect(doCatalogo).toEqual(Object.keys(ESAJ_BASES).sort());
    expect(doCatalogo).toEqual(["ac", "al", "ce", "sp"]);
  });

  it("DataJud cobre os 91 tribunais e NÃO é anunciado para nome (não publica partes)", () => {
    const datajud = FONTES_INFO.find((f) => f.id === "datajud")!;
    expect(datajud.nome).toContain(String(TRIBUNAIS_DATAJUD.length));
    expect(TRIBUNAIS_DATAJUD.length).toBe(91);
    expect(datajud.capacidades).toEqual(["numero"]);
    expect(datajud.limitacao).toContain("não publica nomes");
  });

  it("DJEN está no catálogo como indisponível, com o motivo medido (403 geo)", () => {
    const djen = FONTES_INFO.find((f) => f.id === "djen")!;
    expect(djen.estado).toBe("indisponivel");
    expect(djen.limitacao).toContain("403");
    expect(fontesPara("nome").some((f) => f.id === "djen")).toBe(false);
  });

  it("cobertura() fecha com o catálogo", () => {
    const c = cobertura();
    expect(c.numero.tribunais).toBe(91);
    expect(c.nome.ufs).toEqual(["ac", "al", "ce", "sp"]);
    expect(c.documento.ufs).toEqual(["ac", "al", "ce", "sp"]);
    expect(c.nome.fontes).toEqual(["esaj-ac", "esaj-al", "esaj-ce", "esaj-sp"]);
  });
});
