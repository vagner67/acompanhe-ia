/**
 * Worker de entrega de alertas — "two processes, one codebase" (arquitetura
 * tgstack: o processo de API nunca faz trabalho longo; um worker separado
 * consome a fila com rate limit). Adaptado ao nosso infra: a fila é a tabela
 * AlertEvent (status=queued), sem Redis.
 *
 * Política de envio (tgstack broadcasts.processor.ts, mesma semântica):
 *   - ritmo global `ratePerSecond`, sem rajada;
 *   - 429 → PAUSA a entrega inteira por `retry_after` (o ciclo termina cedo);
 *   - 403 → usuário bloqueou o bot: marca `blocked`, conta como falha, SEM retry;
 *   - outros 4xx → falha definitiva (`failed`);
 *   - erro de rede/5xx → até `maxAttempts` tentativas (attempts em payload).
 */
import { ALERT_STATUS, ALERT_CHANNELS } from "@acompanhe/shared";

export interface PendingAlert {
  id: string;
  userId: string;
  chatId: string | null;
  topic: string;
  detail: string;
  channel: string;
  status: string;
  attempts: number;
}

export type SendResult =
  | { ok: true }
  | { ok: false; kind: "rate_limited"; retryAfterSec: number }
  | { ok: false; kind: "blocked" }
  | { ok: false; kind: "client_error"; code: number }
  | { ok: false; kind: "retryable"; message: string };

export interface AlertSender {
  send(chatId: string, text: string): Promise<SendResult>;
}

export interface DeliveryQueue {
  listPending(limit: number): Promise<PendingAlert[]>;
  markDelivered(id: string): Promise<void>;
  markBlocked(id: string): Promise<void>;
  markFailed(id: string, attempts: number, reason: string): Promise<void>;
  saveAttempts(id: string, attempts: number): Promise<void>;
}

export interface DeliverySummary {
  sent: number;
  blocked: number;
  failed: number;
  retried: number;
  pausedForSec: number | null;
}

export interface DeliverOptions {
  ratePerSecond: number;
  maxAttempts: number;
  batchLimit: number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultDeliverOptions: DeliverOptions = {
  ratePerSecond: 25,
  maxAttempts: 3,
  batchLimit: 500,
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Entrega um lote de alertas `queued`. Não lança: todo resultado vira contagem
 * + estado na fila (o chamador decide o próximo ciclo).
 */
export async function deliverPending(
  queue: DeliveryQueue,
  sender: AlertSender,
  opts: DeliverOptions = defaultDeliverOptions,
): Promise<DeliverySummary> {
  const summary: DeliverySummary = { sent: 0, blocked: 0, failed: 0, retried: 0, pausedForSec: null };
  const pending = await queue.listPending(opts.batchLimit);
  const intervalMs = Math.ceil(1000 / Math.max(1, opts.ratePerSecond));

  for (const alert of pending) {
    // 403 = bloqueado: nunca mais tentar, seja o canal qual for.
    if (!alert.chatId) {
      await queue.markFailed(alert.id, alert.attempts, "sem chatId");
      summary.failed++;
      continue;
    }
    const result = await sender.send(alert.chatId, `[${alert.topic}] ${alert.detail}`);
    if (result.ok) {
      await queue.markDelivered(alert.id);
      summary.sent++;
    } else if (result.kind === "rate_limited") {
      // Pausa a ENTREGA por retry_after e encerra o ciclo (nada de rajada depois).
      summary.pausedForSec = result.retryAfterSec;
      await queue.saveAttempts(alert.id, alert.attempts);
      return summary;
    } else if (result.kind === "blocked") {
      await queue.markBlocked(alert.id);
      summary.blocked++;
    } else if (result.kind === "client_error") {
      await queue.markFailed(alert.id, alert.attempts, `http_${result.code}`);
      summary.failed++;
    } else {
      // retryable: tentativas em payload.attempts, teto maxAttempts
      const attempts = alert.attempts + 1;
      if (attempts >= opts.maxAttempts) {
        await queue.markFailed(alert.id, attempts, result.message);
        summary.failed++;
      } else {
        await queue.saveAttempts(alert.id, attempts);
        summary.retried++;
      }
    }
    await opts.sleep(intervalMs);
  }
  return summary;
}

/** Fila em memória para testes. */
export class InMemoryDeliveryQueue implements DeliveryQueue {
  constructor(public alerts: PendingAlert[]) {}
  async listPending(limit: number) {
    return this.alerts.filter((a) => a.status === ALERT_STATUS.queued).slice(0, limit);
  }
  async markDelivered(id: string) {
    const a = this.alerts.find((x) => x.id === id);
    if (a) a.status = ALERT_STATUS.delivered;
  }
  async markBlocked(id: string) {
    const a = this.alerts.find((x) => x.id === id);
    if (a) a.status = ALERT_STATUS.blocked;
  }
  async markFailed(id: string, attempts: number) {
    const a = this.alerts.find((x) => x.id === id);
    if (a) {
      a.status = ALERT_STATUS.failed;
      a.attempts = attempts;
    }
  }
  async saveAttempts(id: string, attempts: number) {
    const a = this.alerts.find((x) => x.id === id);
    if (a) a.attempts = attempts;
  }
}

export const TELEGRAM_CHANNEL = ALERT_CHANNELS.telegram;
