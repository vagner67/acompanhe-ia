/**
 * Quota de consumo do Investiga — gating duro de checks/dia.
 *
 * TETO SISTÊMICO: 150 checks por dia por assinante (contrato absoluto de
 * v2/08 §9.3). Após estourar: `429 queue-paused` com a próxima janela; a fila
 * não é destruída — dorme. Extras (Pack/avulso) são entradas adicionadas pelo
 * diretor via painel (fora deste gating).
 */
import { INVESTIGA_LIMITS } from "@acompanhe/shared";
import type { QuotaWindow } from "@acompanhe/shared";

export type { QuotaWindow } from "@acompanhe/shared";

/** Porta de quota (doc 13, R6) — implementação em memória abaixo; futura
 *  implementação persistente troca sem tocar em rotas/serviço. */
export interface QuotaGate {
  window(subjectId: string, day: string, limit?: number): QuotaWindow;
  canUse(subjectId: string, day: string, amount?: number, limit?: number): boolean;
  consume(subjectId: string, day: string, amount?: number, limit?: number): boolean;
  /** Estorno (doc 13, R3) — usado quando a coleta falha e o check não rendeu. */
  refund(subjectId: string, day: string, amount?: number): void;
  nextWindow(day: string): string;
  countActiveCases(statuses: OsintCaseStatusLike[]): number;
}

export class InvestigaQuotaGate implements QuotaGate {
  private used = new Map<string, number>();

  private key(subjectId: string, day: string): string {
    return `${subjectId}:${day}`;
  }

  window(subjectId: string, day: string, limit = INVESTIGA_LIMITS.maxChecksPerDay): QuotaWindow {
    const used = this.used.get(this.key(subjectId, day)) ?? 0;
    return {
      day,
      used,
      limit,
      remaining: Math.max(0, limit - used),
    };
  }

  canUse(subjectId: string, day: string, amount = 1, limit = INVESTIGA_LIMITS.maxChecksPerDay): boolean {
    return this.window(subjectId, day, limit).remaining >= amount;
  }

  /** Consome quota. Retorna false (e não consome) se não houver saldo. */
  consume(subjectId: string, day: string, amount = 1, limit = INVESTIGA_LIMITS.maxChecksPerDay): boolean {
    if (!this.canUse(subjectId, day, amount, limit)) return false;
    const k = this.key(subjectId, day);
    this.used.set(k, (this.used.get(k) ?? 0) + amount);
    return true;
  }

  /** Estorna quota consumida (falha de coleta — doc 13, R3). Nunca abaixo de 0. */
  refund(subjectId: string, day: string, amount = 1): void {
    const k = this.key(subjectId, day);
    this.used.set(k, Math.max(0, (this.used.get(k) ?? 0) - amount));
  }

  /** Próxima janela (UTC) quando o teto é atingido. */
  nextWindow(day: string): string {
    const d = new Date(`${day}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  /** Contagem de casos ativos (limit de simultaneidade). */
  countActiveCases(statuses: OsintCaseStatusLike[]): number {
    return statuses.filter((s) => s === "running" || s === "queued" || s === "draft" || s === "completed").length;
  }
}

type OsintCaseStatusLike = "draft" | "queued" | "running" | "completed" | "archived";

/** Data da janela de quota em UTC (doc 13, R2.4 — único dono da regra de janela). */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
