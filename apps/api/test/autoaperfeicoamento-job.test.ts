import { describe, expect, it, vi } from "vitest";
import { InMemoryPerfilStore, DetectorDeriva, PERFIL_PADRAO, type Metrica } from "../src/juridico/autoaperfeicoamento.js";
import { iniciarAutoAperfeicoamento, rodarCicloAuto, scoreFrota } from "../src/jobs/autoaperfeicoamento.js";

const metrica = (fonteId: string, p: Partial<Metrica> = {}): Metrica => ({
  fonteId, coletadaEm: "2026-10-25T03:00:00Z", consultas: 5, itens: 10, erros: 0,
  captchas: 0, timeouts: 0, msP95: 1500, canarioItens: 2, ...p,
});

describe("Ciclo do job — de ponta a ponta com medição injetada", () => {
  it("promove quando um vizinho REALMENTE medido rende mais (o ganho do ciclo)", async () => {
    const store = new InMemoryPerfilStore();
    let avaliados = 0;
    const r = await rodarCicloAuto({
      store,
      fontes: ["esaj-sp"],
      medir: async () => [metrica("esaj-sp", { msP95: 28_000, itens: 1, canarioItens: 0 })],
      // vizinho com timeout maior responde melhor — é o que o hill-climbing deve achar
      medirCandidato: async (_f, cand) => {
        avaliados++;
        return cand.timeoutMs > PERFIL_PADRAO.timeoutMs
          ? metrica("esaj-sp", { msP95: 400, itens: 12, canarioItens: 12, melhorRecall: 12 })
          : metrica("esaj-sp", { msP95: 28_000, itens: 1, canarioItens: 0 });
      },
    });
    expect(avaliados).toBeGreaterThan(1); // avaliou vários vizinhos de verdade
    expect(r.promovidas).toEqual(["esaj-sp"]);
    expect(r.decisoes[0]!.acao).toBe("promover");
    expect((await store.obter("esaj-sp"))!.versao).toBeGreaterThan(1); // persistiu
  });

  it("empate real entre vizinhos mantém o perfil (histerese, sem flip-flop)", async () => {
    const store = new InMemoryPerfilStore();
    const r = await rodarCicloAuto({
      store,
      fontes: ["esaj-sp"],
      medir: async () => [metrica("esaj-sp")],
      medirCandidato: async () => metrica("esaj-sp"),
    });
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
      medirCandidato: async (fonteId) => metrica(fonteId),
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
    const medirCandidato = async (f: string) => metrica(f, { canarioItens: canario, itens: canario });
    const evento = (e: { tipo: string; gravidade: string }) => { eventos.push(e); };

    await rodarCicloAuto({ store, fontes: ["esaj-sp"], medir, medirCandidato, detector, registrarEvento: evento });
    canario = 0; // a fonte "quebra" silenciosamente (HTML mudou)
    await rodarCicloAuto({ store, fontes: ["esaj-sp"], medir, medirCandidato, detector, registrarEvento: evento });
    const terceiro = await rodarCicloAuto({ store, fontes: ["esaj-sp"], medir, medirCandidato, detector, registrarEvento: evento });

    expect(terceiro.derivas).toEqual(["esaj-sp"]);
    expect(eventos.some((e) => e.tipo === "auto.deriva" && e.gravidade === "alerta")).toBe(true);
  });

  it("fonte que nunca funcionou é reportada como tal (não como deriva)", async () => {
    const detector = new DetectorDeriva();
    const medir = async (fontes: string[]) => fontes.map((f) => metrica(f, { canarioItens: 0, itens: 0 }));
    const medirCandidato = async (f: string) => metrica(f, { canarioItens: 0, itens: 0 });
    const r1 = await rodarCicloAuto({ store: new InMemoryPerfilStore(), fontes: ["esaj-nova"], medir, medirCandidato, detector });
    const r2 = await rodarCicloAuto({ store: new InMemoryPerfilStore(), fontes: ["esaj-nova"], medir, medirCandidato, detector });
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

describe("Custo do ciclo — não martelar fonte quebrada", () => {
  it("fonte bloqueada/em erro não gasta avaliações de vizinhos", async () => {
    let avaliacoes = 0;
    const r = await rodarCicloAuto({
      store: new InMemoryPerfilStore(),
      fontes: ["djen-quebrada"],
      medir: async (fs) => fs.map((f) => metrica(f, { erros: 1, itens: 0, canarioItens: 0 })),
      medirCandidato: async (f) => {
        avaliacoes++;
        return metrica(f);
      },
    });
    expect(avaliacoes).toBe(0);
    expect(r.decisoes[0]!.acao).toBe("manter");
    expect(r.decisoes[0]!.motivo).toContain("não respondeu");
  });

  it("fonte saudável é otimizada de fato", async () => {
    let avaliacoes = 0;
    await rodarCicloAuto({
      store: new InMemoryPerfilStore(),
      fontes: ["esaj-al"],
      medir: async (fs) => fs.map((f) => metrica(f, { itens: 5, canarioItens: 5 })),
      medirCandidato: async (f) => {
        avaliacoes++;
        return metrica(f);
      },
      maxAvaliacoes: 3,
    });
    expect(avaliacoes).toBe(3); // respeita o teto configurado
  });

  it("presença de captcha mantém sem gastar avaliações", async () => {
    let avaliacoes = 0;
    const r = await rodarCicloAuto({
      store: new InMemoryPerfilStore(),
      fontes: ["tjmg"],
      medir: async (fs) => fs.map((f) => metrica(f, { captchas: 1, itens: 0 })),
      medirCandidato: async (f) => {
        avaliacoes++;
        return metrica(f);
      },
    });
    expect(avaliacoes).toBe(0);
    expect(r.decisoes[0]!.motivo).toContain("captcha");
  });
});
