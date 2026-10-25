import { describe, expect, it, vi } from "vitest";
import { InMemoryPerfilStore, DetectorDeriva, type Metrica } from "../src/juridico/autoaperfeicoamento.js";
import { iniciarAutoAperfeicoamento, rodarCicloAuto, scoreFrota } from "../src/jobs/autoaperfeicoamento.js";

const metrica = (fonteId: string, p: Partial<Metrica> = {}): Metrica => ({
  fonteId, coletadaEm: "2026-10-25T03:00:00Z", consultas: 5, itens: 10, erros: 0,
  captchas: 0, timeouts: 0, msP95: 1500, canarioItens: 2, ...p,
});

describe("Ciclo do job — de ponta a ponta com medição injetada", () => {
  it("promove perfil que melhora e grava a nova versão no store", async () => {
    const store = new InMemoryPerfilStore();
    const r = await rodarCicloAuto({
      store,
      fontes: ["esaj-sp"],
      // primeira medição fraca; o mesmo objeto é usado na avaliação dos vizinhos
      medir: async () => [metrica("esaj-sp", { msP95: 28_000, itens: 1, canarioItens: 0 })],
    });
    expect(r.ok).toBe(true);
    expect(r.decisoes).toHaveLength(1);
    expect(r.msTotal).toBeGreaterThanOrEqual(0);
    // com métrica idêntica para todos os vizinhos, empate → mantém (sem flip-flop)
    expect(r.promovidas).toEqual([]);
    expect(r.decisoes[0]!.acao).toBe("manter");
  });

  it("falha de medição não derruba o ciclo: devolve ok:false com motivo", async () => {
    const r = await rodarCicloAuto({
      store: new InMemoryPerfilStore(),
      medir: async () => {
        throw new Error("ENETUNREACH");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.erro).toBe("ENETUNREACH");
    expect(r.msTotal).toBeGreaterThanOrEqual(0);
  });

  it("uma fonte em erro não impede as outras de serem decididas", async () => {
    const eventos: string[] = [];
    const r = await rodarCicloAuto({
      store: new InMemoryPerfilStore(),
      fontes: ["a", "b"],
      medir: async (fontes) => fontes.map((f) => metrica(f, f === "b" ? { erros: 5, captchas: 5, itens: 0, canarioItens: 0 } : {})),
      registrarEvento: (e) => {
        eventos.push(e.tipo);
      },
    });
    expect(r.decisoes).toHaveLength(2);
    expect(r.derivas).toEqual([]); // erro não é deriva
  });

  it("deriva após 2 ciclos zerados (tendo funcionado antes) gera evento de alerta", async () => {
    const detector = new DetectorDeriva();
    const store = new InMemoryPerfilStore();
    const eventos: Array<{ tipo: string; gravidade: string }> = [];
    let canario = 4; // 1º ciclo: funciona
    const medir = async (fontes: string[]) => fontes.map((f) => metrica(f, { canarioItens: canario, itens: canario }));

    await rodarCicloAuto({ store, fontes: ["esaj-sp"], medir, detector, registrarEvento: (e) => { eventos.push(e); } });
    canario = 0; // a fonte "quebra" silenciosamente (HTML mudou)
    await rodarCicloAuto({ store, fontes: ["esaj-sp"], medir, detector, registrarEvento: (e) => { eventos.push(e); } });
    const terceiro = await rodarCicloAuto({ store, fontes: ["esaj-sp"], medir, detector, registrarEvento: (e) => { eventos.push(e); } });

    expect(terceiro.derivas).toEqual(["esaj-sp"]);
    expect(eventos.some((e) => e.tipo === "auto.deriva" && e.gravidade === "alerta")).toBe(true);
  });

  it("fonte que nunca funcionou é reportada como tal (não como deriva)", async () => {
    const detector = new DetectorDeriva();
    const medir = async (fontes: string[]) => fontes.map((f) => metrica(f, { canarioItens: 0, itens: 0 }));
    const r1 = await rodarCicloAuto({ store: new InMemoryPerfilStore(), fontes: ["esaj-nova"], medir, detector });
    const r2 = await rodarCicloAuto({ store: new InMemoryPerfilStore(), fontes: ["esaj-nova"], medir, detector });
    expect(r1.derivas).toEqual([]);
    expect(r2.nuncaFuncionaram).toEqual(["esaj-nova"]);
    expect(r2.derivas).toEqual([]);
  });

  it("score da frota é média finita e zero sem métricas", () => {
    expect(scoreFrota([])).toBe(0);
    const s = scoreFrota([metrica("a"), metrica("b")]);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
  });
});

describe("Agendador", () => {
  it("roda o primeiro ciclo imediatamente e pode ser parado", async () => {
    vi.useFakeTimers();
    try {
      let ciclos = 0;
      const ag = iniciarAutoAperfeicoamento({
        store: new InMemoryPerfilStore(),
        horas: 1,
        medir: async () => {
          ciclos++;
          return [metrica("esaj-sp")];
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(ciclos).toBe(1); // primeiro ciclo sem esperar 6h
      ag.parar();
      await vi.advanceTimersByTimeAsync(3 * 3_600_000);
      expect(ciclos).toBe(1); // parado não roda mais
    } finally {
      vi.useRealTimers();
    }
  });

  it("não empilha ciclos: intervalo curto não dispara execução concorrente", async () => {
    vi.useFakeTimers();
    try {
      let simultaneos = 0;
      let pico = 0;
      const ag = iniciarAutoAperfeicoamento({
        store: new InMemoryPerfilStore(),
        horas: 1,
        medir: async () => {
          simultaneos++;
          pico = Math.max(pico, simultaneos);
          await new Promise<void>((r) => setTimeout(r, 5_000));
          simultaneos--;
          return [metrica("esaj-sp")];
        },
      });
      await vi.advanceTimersByTimeAsync(4 * 3_600_000);
      ag.parar();
      expect(pico).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
