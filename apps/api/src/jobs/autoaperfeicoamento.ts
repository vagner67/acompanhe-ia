/**
 * Job do auto-aperfeiçoamento (plano-91-tribunais-nacional.md §5).
 *
 * A cada ciclo: mede os canários REAIS de cada fonte, decide (hill-climbing com
 * ε=3 e histerese), grava o perfil quando há promoção e sinaliza deriva quando
 * a fonte parou de devolver o que devolvia. Nunca lança: um ciclo com problema
 * é registrado e o próximo tenta de novo (auto-correção, sem derrubar o worker).
 */
import {
  decidir,
  DetectorDeriva,
  perfilVigente,
  pontuar,
  type Decisao,
  type Metrica,
  type PerfilStore,
} from "../juridico/autoaperfeicoamento.js";
import { medirFontes } from "../juridico/probe.js";

export const FONTES_PADRAO = ["djen", "esaj-sp", "esaj-al", "esaj-ac", "esaj-ce"] as const;

export interface CicloOpts {
  store: PerfilStore;
  fontes?: string[];
  termo?: string;
  agora?: Date;
  detector?: DetectorDeriva;
  /** Injetável em teste; default = HTTP real das fontes. */
  medir?: (fontes: string[], termo: string, agora: string) => Promise<Metrica[]>;
  /** Registro de evento de operação (opsEvent) — opcional. */
  registrarEvento?: (e: { tipo: string; detalhe: string; gravidade: "info" | "alerta" }) => Promise<void> | void;
}

export interface CicloResultado {
  ok: boolean;
  medidoEm: string;
  metricas: Metrica[];
  decisoes: Decisao[];
  promovidas: string[];
  derivas: string[];
  nuncaFuncionaram: string[];
  msTotal: number;
  erro: string | null;
}

export async function rodarCicloAuto(opts: CicloOpts): Promise<CicloResultado> {
  const t0 = Date.now();
  const agora = (opts.agora ?? new Date()).toISOString();
  const fontes = opts.fontes ?? [...FONTES_PADRAO];
  const detector = opts.detector ?? new DetectorDeriva();
  const medir = opts.medir ?? medirFontes;

  let metricas: Metrica[] = [];
  let erro: string | null = null;
  try {
    metricas = await medir(fontes, opts.termo ?? "João Carlos", agora);
  } catch (e) {
    erro = (e as Error).message;
    return {
      ok: false,
      medidoEm: agora,
      metricas: [],
      decisoes: [],
      promovidas: [],
      derivas: [],
      nuncaFuncionaram: [],
      msTotal: Date.now() - t0,
      erro,
    };
  }

  const decisoes: Decisao[] = [];
  const promovidas: string[] = [];
  for (const m of metricas) {
    const vigente = await perfilVigente(opts.store, m.fonteId);
    const d = await decidir(vigente, m, async () => m);
    decisoes.push(d);
    if (d.acao === "promover") {
      await opts.store.salvar(d.perfil, d);
      promovidas.push(m.fonteId);
      await opts.registrarEvento?.({
        tipo: "auto.promocao",
        detalhe: `${m.fonteId} v${d.anteriorVersao}→v${d.perfil.versao}: ${d.motivo} (score ${d.scoreAtual}→${d.scoreNovo})`,
        gravidade: "info",
      });
    }
  }

  const derivas = detector.verificar(metricas).map((d) => d.fonteId);
  const nuncaFuncionaram = fontes.filter((f) => detector.nuncaFuncionou(f));
  if (derivas.length) {
    await opts.registrarEvento?.({
      tipo: "auto.deriva",
      detalhe: `fonte parou de devolver itens do canário: ${derivas.join(", ")} — revisar seletor/contrato`,
      gravidade: "alerta",
    });
  }

  return {
    ok: true,
    medidoEm: agora,
    metricas,
    decisoes,
    promovidas,
    derivas,
    nuncaFuncionaram,
    msTotal: Date.now() - t0,
    erro: null,
  };
}

/** Score consolidado da frota (média das fontes) — métrica de painel. */
export function scoreFrota(metricas: Metrica[]): number {
  if (!metricas.length) return 0;
  const soma = metricas.reduce((a, m) => a + pontuar(m), 0);
  return Math.round((soma / metricas.length) * 100) / 100;
}

export interface AgendadorOpts extends CicloOpts {
  /** Intervalo entre ciclos (horas). Default 6h; mínimo 1h. */
  horas?: number;
  onResultado?: (r: CicloResultado) => void;
}

/**
 * Agenda o ciclo. Retorna `parar()` — usado pelo shutdown e pelos testes.
 * O prazo por ciclo é limitado: um ciclo lento não empilha com o próximo.
 */
export function iniciarAutoAperfeicoamento(opts: AgendadorOpts): { parar: () => void } {
  const horas = Math.max(opts.horas ?? Number(process.env.AUTO_HORAS ?? 6), 1);
  const intervalo = horas * 3_600_000;
  let rodando = false;
  let parado = false;

  const executar = async () => {
    if (rodando || parado) return;
    rodando = true;
    try {
      const r = await rodarCicloAuto(opts);
      opts.onResultado?.(r);
      if (!r.ok) {
        await opts.registrarEvento?.({ tipo: "auto.ciclo_falhou", detalhe: r.erro ?? "erro desconhecido", gravidade: "alerta" });
      }
    } catch (e) {
      await opts.registrarEvento?.({ tipo: "auto.ciclo_falhou", detalhe: (e as Error).message, gravidade: "alerta" });
    } finally {
      rodando = false;
    }
  };

  void executar(); // primeiro ciclo imediato
  const timer = setInterval(executar, intervalo);
  if (typeof timer.unref === "function") timer.unref();

  return {
    parar: () => {
      parado = true;
      clearInterval(timer);
    },
  };
}
