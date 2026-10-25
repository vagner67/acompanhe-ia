/**
 * P4 — monitoramento por polling (plano-refatoracao §6.5). Núcleo determinístico
 * e testável; o worker só injeta banco + DataJud + sink de alertas.
 *
 * Honestidade: NÃO é tempo real. O DataJud atualiza com defasagem e o ciclo é
 * configurável (padrão 6h). A UI diz "verificado por último em …".
 */
import type { DatajudDoc } from "../juridico/types.js";

export interface CasoMonitorado {
  id: string;
  userId: string;
  cnj: string;
  alias: string;
  movimentosCount: number;
  ultimoMovimentoNome: string | null;
  ultimoMovimentoData: string | null;
  alertasAtivos: boolean;
  ultimaVerificacao: string | null;
}

export interface Novidade {
  casoId: string;
  userId: string;
  cnj: string;
  novos: number;
  ultimoNome: string | null;
  ultimoData: string | null;
  detail: string;
}

/** Só consulta o que está com alerta ligado e fora da janela de espera. */
export function deveVerificar(caso: CasoMonitorado, agora: Date, intervaloHoras: number): boolean {
  if (!caso.alertasAtivos) return false;
  if (!caso.ultimaVerificacao) return true;
  const t = Date.parse(caso.ultimaVerificacao);
  if (!Number.isFinite(t)) return true;
  return agora.getTime() - t >= intervaloHoras * 3600_000;
}

export interface Comparacao {
  novos: number;
  ultimoNome: string | null;
  ultimoData: string | null;
}

/**
 * Compara o documento novo do DataJud com o estado conhecido do caso.
 * O DataJud entrega a lista completa de movimentos: o "novo" é a diferença de
 * contagem, e o último movimento é o mais recente por data.
 */
export function compararMovimentos(caso: CasoMonitorado, doc: DatajudDoc | undefined): Comparacao {
  if (!doc) return { novos: 0, ultimoNome: caso.ultimoMovimentoNome, ultimoData: caso.ultimoMovimentoData };
  const movs = [...(doc.movimentos ?? [])].sort((a, b) => (a.dataHora < b.dataHora ? 1 : -1));
  const ultimo = movs[0];
  const total = movs.length;
  const novos = Math.max(0, total - caso.movimentosCount);
  return {
    novos,
    ultimoNome: ultimo?.nome ?? caso.ultimoMovimentoNome,
    ultimoData: ultimo?.dataHora ?? caso.ultimoMovimentoData,
  };
}

export interface MonitoramentoDeps {
  listar: (limite: number) => Promise<CasoMonitorado[]>;
  buscarDoc: (alias: string, numeroProcesso: string) => Promise<DatajudDoc[]>;
  marcarVerificado: (casoId: string, iso: string) => Promise<void>;
  emitirAlerta: (nov: Novidade) => Promise<void>;
  agora?: () => Date;
  intervaloHoras?: number;
  limite?: number;
}

export interface ResumoMonitoramento {
  verificados: number;
  comNovidade: number;
  alertas: number;
  falhas: number;
  pulados: number;
}

/** Um ciclo de monitoramento (usado pelo worker). Idempotente por dedupe no sink. */
export async function rodarMonitoramento(deps: MonitoramentoDeps): Promise<ResumoMonitoramento> {
  const agora = deps.agora?.() ?? new Date();
  const intervalo = deps.intervaloHoras ?? Number(process.env.MONITOR_INTERVAL_HORAS ?? 6);
  const casos = await deps.listar(deps.limite ?? 50);
  const r: ResumoMonitoramento = { verificados: 0, comNovidade: 0, alertas: 0, falhas: 0, pulados: 0 };
  for (const caso of casos) {
    if (!deveVerificar(caso, agora, intervalo)) {
      r.pulados += 1;
      continue;
    }
    try {
      const digits = caso.cnj.replace(/\D+/g, "");
      const docs = await deps.buscarDoc(caso.alias, digits);
      r.verificados += 1;
      const c = compararMovimentos(caso, docs[0]);
      if (c.novos > 0) {
        r.comNovidade += 1;
        await deps.emitirAlerta({
          casoId: caso.id,
          userId: caso.userId,
          cnj: caso.cnj,
          novos: c.novos,
          ultimoNome: c.ultimoNome,
          ultimoData: c.ultimoData,
          detail: `${c.novos} nova(s) movimentação(ões) em ${caso.cnj}: ${c.ultimoNome ?? "atualização"}`,
        });
        r.alertas += 1;
      }
      await deps.marcarVerificado(caso.id, agora.toISOString());
    } catch {
      r.falhas += 1;
    }
  }
  return r;
}
