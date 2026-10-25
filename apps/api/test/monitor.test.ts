/**
 * P4 — monitoramento por polling: janela de verificação, comparação de
 * movimentos e ciclo completo com fakes (sem rede, sem banco).
 */
import { describe, expect, it } from "vitest";

import { compararMovimentos, deveVerificar, rodarMonitoramento, type CasoMonitorado, type Novidade } from "../src/jobs/monitor.js";
import type { DatajudDoc } from "../src/juridico/types.js";

const agora = new Date("2026-10-25T12:00:00Z");

const caso = (over: Partial<CasoMonitorado> = {}): CasoMonitorado => ({
  id: "c1",
  userId: "u1",
  cnj: "0006903-69.2014.8.11.0037",
  alias: "tjmt",
  movimentosCount: 2,
  ultimoMovimentoNome: "Distribuição",
  ultimoMovimentoData: "2014-09-23T14:01:31.000Z",
  alertasAtivos: true,
  ultimaVerificacao: null,
  ...over,
});

const docCom = (n: number): DatajudDoc => ({
  numeroProcesso: "00069036920148110037",
  dataAjuizamento: "20140805000000",
  grau: "G1",
  nivelSigilo: 0,
  orgaoJulgador: { codigo: 1, nome: "Vara", codigoMunicipioIBGE: 1 },
  classe: { codigo: 1, nome: "Execução Fiscal" },
  movimentos: Array.from({ length: n }, (_, i) => ({
    codigo: i,
    dataHora: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    nome: `Movimento ${i}`,
  })),
});

describe("janela de verificação", () => {
  it("sem verificação anterior → verifica", () => {
    expect(deveVerificar(caso(), agora, 6)).toBe(true);
  });
  it("verificado há 2h com janela de 6h → não verifica", () => {
    expect(deveVerificar(caso({ ultimaVerificacao: "2026-10-25T10:00:00Z" }), agora, 6)).toBe(false);
  });
  it("verificado há 7h com janela de 6h → verifica", () => {
    expect(deveVerificar(caso({ ultimaVerificacao: "2026-10-25T05:00:00Z" }), agora, 6)).toBe(true);
  });
  it("alerta desligado → nunca verifica", () => {
    expect(deveVerificar(caso({ alertasAtivos: false }), agora, 6)).toBe(false);
  });
});

describe("comparação de movimentos", () => {
  it("conta os novos pela diferença e pega o mais recente por data", () => {
    const c = compararMovimentos(caso(), docCom(5));
    expect(c.novos).toBe(3);
    expect(c.ultimoNome).toBe("Movimento 4");
    expect(c.ultimoData).toBe("2024-01-05T00:00:00.000Z");
  });
  it("sem novidade → novos=0 e mantém o último conhecido", () => {
    const c = compararMovimentos(caso({ movimentosCount: 5 }), docCom(5));
    expect(c.novos).toBe(0);
    expect(c.ultimoNome).toBe("Movimento 4");
  });
  it("fonte sem documento → não inventa novidade", () => {
    const c = compararMovimentos(caso(), undefined);
    expect(c.novos).toBe(0);
    expect(c.ultimoNome).toBe("Distribuição");
  });
});

describe("ciclo de monitoramento", () => {
  it("verifica, alerta e marca a verificação; respeita a janela", async () => {
    const alertas: Novidade[] = [];
    const marcados: string[] = [];
    const r = await rodarMonitoramento({
      listar: async () => [
        caso({ id: "a", alertasAtivos: true, ultimaVerificacao: null, movimentosCount: 1 }),
        caso({ id: "b", alertasAtivos: true, ultimaVerificacao: "2026-10-25T11:00:00Z", movimentosCount: 1 }),
        caso({ id: "c", alertasAtivos: false, movimentosCount: 1 }),
      ],
      buscarDoc: async () => [docCom(4)],
      marcarVerificado: async (id, iso) => void marcados.push(`${id}@${iso}`),
      emitirAlerta: async (n) => void alertas.push(n),
      agora: () => agora,
      intervaloHoras: 6,
    });
    expect(r.verificados).toBe(1); // só "a"
    expect(r.pulados).toBe(2); // "b" na janela, "c" sem alerta
    expect(r.alertas).toBe(1);
    expect(alertas[0]!.novos).toBe(3);
    expect(alertas[0]!.detail).toContain("3 nova(s) movimentação(ões)");
    expect(marcados[0]).toBe(`a@${agora.toISOString()}`);
  });

  it("erro na fonte conta como falha e não marca verificação", async () => {
    const marcados: string[] = [];
    const r = await rodarMonitoramento({
      listar: async () => [caso()],
      buscarDoc: async () => {
        throw new Error("datajud fora");
      },
      marcarVerificado: async (id) => void marcados.push(id),
      emitirAlerta: async () => undefined,
      agora: () => agora,
      intervaloHoras: 6,
    });
    expect(r.falhas).toBe(1);
    expect(r.verificados).toBe(0);
    expect(marcados).toEqual([]);
  });
});
