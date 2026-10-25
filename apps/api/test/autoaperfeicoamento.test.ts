import { describe, expect, it } from "vitest";
import {
  decidir,
  DetectorDeriva,
  InMemoryPerfilStore,
  LIMITES,
  mutacoes,
  PERFIL_PADRAO,
  perfilVigente,
  pontuar,
  type Metrica,
  type PerfilFonte,
} from "../src/juridico/autoaperfeicoamento.js";

const perfil = (p: Partial<PerfilFonte> = {}): PerfilFonte => ({ fonteId: "esaj-sp", ...PERFIL_PADRAO, ...p });

const metrica = (m: Partial<Metrica> = {}): Metrica => ({
  fonteId: "esaj-sp",
  coletadaEm: "2026-10-25T03:00:00Z",
  consultas: 1,
  itens: 10,
  erros: 0,
  captchas: 0,
  timeouts: 0,
  msP95: 1200,
  canarioItens: 3,
  ...m,
});

describe("Pontuação — comparável e honesta", () => {
  it("fonte saudável pontua alto; captcha derruba 80", () => {
    const saudavel = pontuar(metrica());
    const comCaptcha = pontuar(metrica({ captchas: 3 }));
    expect(saudavel).toBeGreaterThan(100);
    expect(saudavel - comCaptcha).toBeGreaterThanOrEqual(80);
  });

  it("fonte lenta perde pontos, mas pouco (não distorce a decisão)", () => {
    const rapida = pontuar(metrica({ msP95: 500 }));
    const lenta = pontuar(metrica({ msP95: 20_000 }));
    expect(rapida - lenta).toBeGreaterThan(0);
    expect(rapida - lenta).toBeLessThan(20);
  });

  it("todos os erros → confiabilidade zero, sem número negativo absurdo", () => {
    const s = pontuar(metrica({ erros: 1, consultas: 1, itens: 0, canarioItens: 0 }));
    expect(s).toBeLessThan(1);
    expect(Number.isFinite(s)).toBe(true);
  });

  it("fonte pequena com histórico próprio não é punida por uma fonte grande", () => {
    const pequena = pontuar(metrica({ itens: 3, canarioItens: 3, melhorRecall: 3 }));
    const grande = pontuar(metrica({ itens: 100, canarioItens: 100, melhorRecall: 100 }));
    expect(Math.abs(pequena - grande)).toBeLessThan(1);
  });

  it("1 item na primeira medição NÃO vale aproveitamento pleno (piso de recall)", () => {
    const um = pontuar(metrica({ itens: 1, canarioItens: 1 }));
    const cheio = pontuar(metrica({ itens: 10, canarioItens: 10 }));
    expect(cheio - um).toBeGreaterThan(50);
  });
});

describe("Mutações — só dentro dos limites declarados", () => {
  it("gera candidatos e nenhum sai da faixa [min,max]", () => {
    const cands = mutacoes(perfil());
    expect(cands.length).toBeGreaterThanOrEqual(6);
    for (const c of cands) {
      expect(c.timeoutMs).toBeGreaterThanOrEqual(LIMITES.timeoutMin);
      expect(c.timeoutMs).toBeLessThanOrEqual(LIMITES.timeoutMax);
      expect(c.paginas).toBeGreaterThanOrEqual(LIMITES.paginasMin);
      expect(c.paginas).toBeLessThanOrEqual(LIMITES.paginasMax);
      expect(c.concorrencia).toBeGreaterThanOrEqual(LIMITES.concorrenciaMin);
      expect(c.concorrencia).toBeLessThanOrEqual(LIMITES.concorrenciaMax);
      expect([0, 1, 2]).toContain(c.varianteNome);
    }
  });

  it("clampa no extremo em vez de sair da faixa", () => {
    const cands = mutacoes(perfil({ timeoutMs: LIMITES.timeoutMax, paginas: LIMITES.paginasMax, concorrencia: LIMITES.concorrenciaMax }));
    for (const c of cands) {
      expect(c.timeoutMs).toBeLessThanOrEqual(LIMITES.timeoutMax);
      expect(c.paginas).toBeLessThanOrEqual(LIMITES.paginasMax);
      expect(c.concorrencia).toBeLessThanOrEqual(LIMITES.concorrenciaMax);
    }
  });

  it("é determinístico: mesma entrada, mesmos candidatos", () => {
    expect(mutacoes(perfil())).toEqual(mutacoes(perfil()));
  });
});

describe("Decisão — histerese ε=3 e auto-correção", () => {
  it("promove só quando o ganho passa do epsilon", async () => {
    const base = metrica({ msP95: 20_000, itens: 10, canarioItens: 1 }); // lenta e fraca
    const d = await decidir(perfil(), base, async () => metrica({ msP95: 400, itens: 40, canarioItens: 4 }));
    expect(d.acao).toBe("promover");
    expect(d.scoreNovo).toBeGreaterThan(d.scoreAtual);
    expect(d.perfil.versao).toBeGreaterThan(1);
  });

  it("empate (ganho < 3) mantém o perfil — sem flip-flop", async () => {
    const base = metrica();
    const d = await decidir(perfil(), base, async () => metrica({ msP95: 1250 }));
    expect(d.acao).toBe("manter");
    expect(d.perfil.versao).toBe(1);
  });

  it("candidato com captcha nunca é promovido, mesmo com mais itens", async () => {
    const base = metrica({ itens: 10, canarioItens: 1 });
    const d = await decidir(perfil(), base, async () => metrica({ itens: 500, canarioItens: 50, captchas: 5 }));
    expect(d.acao).not.toBe("promover");
  });

  it("medir que lança exceção não derruba o ciclo (erro vira candidato ruim)", async () => {
    const d = await decidir(perfil(), metrica(), async () => {
      throw new Error("ECONNRESET");
    });
    expect(d.acao).toBe("manter");
    expect(d.motivo.length).toBeGreaterThan(0);
  });

  it("motivo descreve a mudança em português legível", async () => {
    const d = await decidir(perfil(), metrica({ msP95: 30_000 }), async (c) =>
      metrica({ msP95: 200, itens: 60, canarioItens: 6, melhorRecall: 6 }),
    );
    expect(d.motivo).toMatch(/timeout|páginas|concorrência|relay|varianteNome|nenhuma/);
  });
});

describe("Store — versões e rollback", () => {
  it("guarda histórico e volta para a versão anterior", async () => {
    const store = new InMemoryPerfilStore();
    await store.salvar(perfil({ versao: 2, timeoutMs: 9000 }), { fonteId: "esaj-sp" } as never);
    const r = await store.rollback("esaj-sp", 2);
    expect(r?.timeoutMs).toBe(9000);
    expect((await store.historico("esaj-sp")).length).toBe(1);
  });

  it("rollback para versão inexistente devolve null e não altera nada", async () => {
    const store = new InMemoryPerfilStore();
    expect(await store.rollback("esaj-sp", 99)).toBeNull();
  });

  it("perfilVigente devolve o padrão quando não há nada salvo", async () => {
    const p = await perfilVigente(new InMemoryPerfilStore(), "tjmg");
    expect(p.fonteId).toBe("tjmg");
    expect(p.versao).toBe(1);
    expect(p.timeoutMs).toBe(PERFIL_PADRAO.timeoutMs);
  });
});

describe("Detector de deriva — 2 ciclos com canário zerado", () => {
  it("um ciclo zerado não basta", () => {
    const d = new DetectorDeriva();
    d.registrar("esaj-sp", 0, false);
    expect(d.deriva("esaj-sp")).toBe(false);
  });

  it("dois ciclos zerados depois de já ter funcionado → deriva", () => {
    const d = new DetectorDeriva();
    d.registrar("esaj-sp", 4); // já devolveu itens: contrato conhecido
    d.registrar("esaj-sp", 0);
    d.registrar("esaj-sp", 0);
    expect(d.deriva("esaj-sp")).toBe(true);
  });

  it("fonte que NUNCA devolveu item é indisponibilidade, não deriva", () => {
    const d = new DetectorDeriva();
    d.registrar("esaj-nova", 0);
    d.registrar("esaj-nova", 0);
    expect(d.deriva("esaj-nova")).toBe(false);
    expect(d.nuncaFuncionou("esaj-nova")).toBe(true);
  });

  it("ciclo com erro não conta como deriva (é falha, não mudança de contrato)", () => {
    const d = new DetectorDeriva();
    d.registrar("esaj-sp", 3);
    d.registrar("esaj-sp", 0, true); // falha de rede, não mudança de contrato
    d.registrar("esaj-sp", 0, false);
    expect(d.deriva("esaj-sp")).toBe(false);
  });

  it("voltar a achar itens limpa a deriva", () => {
    const d = new DetectorDeriva();
    d.registrar("esaj-sp", 5);
    d.registrar("esaj-sp", 0);
    d.registrar("esaj-sp", 0);
    expect(d.deriva("esaj-sp")).toBe(true);
    d.registrar("esaj-sp", 5);
    expect(d.deriva("esaj-sp")).toBe(false);
  });

  it("verificar() devolve a lista de fontes em deriva", () => {
    const d = new DetectorDeriva();
    d.verificar([metrica({ fonteId: "a", canarioItens: 5 }), metrica({ fonteId: "b", canarioItens: 7 })]);
    d.verificar([metrica({ fonteId: "a", canarioItens: 0 }), metrica({ fonteId: "b", canarioItens: 7 })]);
    const emDeriva = d.verificar([metrica({ fonteId: "a", canarioItens: 0 }), metrica({ fonteId: "b", canarioItens: 7 })]);
    expect(emDeriva.map((e) => e.fonteId)).toEqual(["a"]);
  });
});
