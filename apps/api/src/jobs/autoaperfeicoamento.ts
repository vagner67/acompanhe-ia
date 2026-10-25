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
  type PerfilFonte,
  type PerfilStore,
} from "../juridico/autoaperfeicoamento.js";
import { medirFonte, medirFontes } from "../juridico/probe.js";

export const FONTES_PADRAO = ["djen", "esaj-sp", "esaj-al", "esaj-ac", "esaj-ce"] as const;

export interface CicloOpts {
  store: PerfilStore;
  fontes?: string[];
  termo?: string;
  agora?: Date;
  detector?: DetectorDeriva;
  /** Injetável em teste; default = HTTP real das fontes. */
  medir?: (fontes: string[], termo: string, agora: string) => Promise<Metrica[]>;
  /**
   * Mede UM candidato (perfil alternativo) daquela fonte. Default = HTTP real
   * com o perfil aplicado. Sem isto o ciclo não avalia vizinhos e nunca promove.
   */
  medirCandidato?: (fonteId: string, perfil: PerfilFonte, termo: string, agora: string) => Promise<Metrica>;
  /**
   * Quantos vizinhos avaliar por fonte. Cada vizinho é uma requisição REAL:
   * 3 é o equilíbrio entre achar ganho e não martelar o portal.
   */
  maxAvaliacoes?: number;
  /** Teto de tempo do ciclo inteiro (ms). Estourou → mantém o que já decidiu. */
  prazoMs?: number;
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
  /** ciclo interrompido pelo teto de tempo (as fontes restantes ficam para o próximo) */
  truncadoPorPrazo?: boolean;
}

export async function rodarCicloAuto(opts: CicloOpts): Promise<CicloResultado> {
  const t0 = Date.now();
  const agora = (opts.agora ?? new Date()).toISOString();
  const fontes = opts.fontes ?? [...FONTES_PADRAO];
  const detector = opts.detector ?? new DetectorDeriva();
  const medir = opts.medir ?? medirFontes;
  const medirCandidato =
    opts.medirCandidato ??
    ((fonteId: string, perfil: PerfilFonte, t: string, agoraIso: string) => medirFonte(fonteId, t, agoraIso, perfil));

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

  // telemetria do ciclo (FonteMetrica) — queremos saber o que o ciclo viu
  const registradora = opts.store as { registrarMetrica?: (m: Metrica, score: number) => Promise<void> };
  if (registradora.registrarMetrica) {
    for (const m of metricas) await registradora.registrarMetrica(m, pontuar(m)).catch(() => {});
  }

  const decisoes: Decisao[] = [];
  const promovidas: string[] = [];
  const prazoMs = opts.prazoMs ?? Number(process.env.AUTO_PRAZO_MS ?? 120_000);
  let estourouPrazo = false;
  for (const m of metricas) {
    if (Date.now() - t0 > prazoMs) {
      estourouPrazo = true; // teto de tempo: as fontes restantes ficam para o próximo ciclo
      break;
    }
    const vigente = await perfilVigente(opts.store, m.fonteId);

    // Só vale otimizar parâmetro de fonte que RESPONDEU. Avaliar vizinhos de uma
    // fonte bloqueada (DJEN 403) ou em erro custa 4 requisições para chegar a
    // "mantenha" — medido: ciclo de 90 s martelando portal. Bloqueio/deriva têm
    // tratamento próprio; aqui a decisão é honesta e barata.
    const saudavel = m.erros === 0 && m.captchas === 0 && m.itens > 0;
    if (!saudavel) {
      decisoes.push({
        fonteId: m.fonteId,
        acao: "manter",
        scoreAtual: pontuar(m),
        scoreNovo: pontuar(m),
        motivo:
          m.captchas > 0
            ? "fonte exige captcha — parâmetros não resolvem; usar portal oficial"
            : m.erros > 0
              ? "fonte não respondeu neste ciclo — nada a otimizar"
              : "fonte respondeu sem itens neste ciclo — nada a otimizar",
        perfil: vigente,
        anteriorVersao: vigente.versao,
      });
      continue;
    }

    // aqui está o coração: cada vizinho é MEDIDO com a sua configuração
    const d = await decidir(
      vigente,
      m,
      (cand) => medirCandidato(m.fonteId, cand, opts.termo ?? "João Carlos", agora),
      { maxAvaliacoes: opts.maxAvaliacoes ?? 3 },
    );
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
    ...(estourouPrazo ? { truncadoPorPrazo: true } : {}),
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
  // P0 (plano.md §2): o detector TEM de viver entre ciclos. Antes cada ciclo criava
  // um `DetectorDeriva` novo → histórico vazio → deriva nunca disparava em produção.
  const detector = opts.detector ?? new DetectorDeriva();

  const executar = async () => {
    if (rodando || parado) return;
    rodando = true;
    try {
      const r = await rodarCicloAuto({ ...opts, detector });
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
