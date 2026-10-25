/**
 * Worker — processo separado da API (arquitetura tgstack: "the API process
 * never registers a queue processor"). Consome AlertEvent.status=queued e
 * entrega via Telegram com a política de rate limit (jobs/runner.ts).
 *
 * Uso: `pnpm --filter @acompanhe/api worker [-- --once]`
 *   --once : executa um ciclo e sai (para cron/systemd timer e testes E2E)
 *   loop   : ciclo a cada WORKER_INTERVAL_MS (padrão 30s)
 */
import { createDb } from "@acompanhe/db";
import { ALERT_STATUS, ALERT_CHANNELS } from "@acompanhe/shared";
import { deliverPending, type AlertSender, type DeliveryQueue, type PendingAlert, type SendResult, defaultDeliverOptions } from "./jobs/runner.js";
import { rodarMonitoramento, type CasoMonitorado } from "./jobs/monitor.js";
import { fetchProcessos } from "./juridico/datajud.js";

/** Sender real do Telegram (Bot API sendMessage) — 429/403 mapeados para a política. */
export function telegramSender(botToken: string, fetchFn: typeof fetch = fetch): AlertSender {
  return {
    async send(chatId: string, text: string): Promise<SendResult> {
      try {
        const res = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
        if (res.status === 429) {
          const body = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
          return { ok: false, kind: "rate_limited", retryAfterSec: Math.max(1, body.parameters?.retry_after ?? 1) };
        }
        if (res.status === 403) return { ok: false, kind: "blocked" };
        if (!res.ok) {
          if (res.status >= 500) return { ok: false, kind: "retryable", message: `http_${res.status}` };
          return { ok: false, kind: "client_error", code: res.status };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, kind: "retryable", message: (e as Error).message };
      }
    },
  };
}

/** Fila real (Postgres). chatId = payload.chatId (definido pelo bot no /start). */
export function prismaDeliveryQueue(db: ReturnType<typeof createDb>): DeliveryQueue {
  const toPending = (r: {
    id: bigint;
    userId: string;
    topic: string;
    channel: string;
    status: string;
    payload: unknown;
  }): PendingAlert => {
    const p = (r.payload ?? {}) as { detail?: string; chatId?: string; attempts?: number };
    return {
      id: String(r.id),
      userId: r.userId,
      chatId: p.chatId ?? null,
      topic: r.topic,
      detail: p.detail ?? r.topic,
      channel: r.channel,
      status: r.status,
      attempts: p.attempts ?? 0,
    };
  };
  return {
    async listPending(limit: number) {
      const rows = await db.alertEvent.findMany({
        where: { status: ALERT_STATUS.queued, channel: ALERT_CHANNELS.telegram },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return rows.map(toPending);
    },
    async markDelivered(id: string) {
      await db.alertEvent.update({ where: { id: BigInt(id) }, data: { status: ALERT_STATUS.delivered } });
    },
    async markBlocked(id: string) {
      await db.alertEvent.update({ where: { id: BigInt(id) }, data: { status: ALERT_STATUS.blocked } });
    },
    async markFailed(id: string, attempts: number, reason: string) {
      const row = await db.alertEvent.findUnique({ where: { id: BigInt(id) } });
      const payload = { ...((row?.payload as object) ?? {}), attempts, reason };
      await db.alertEvent.update({ where: { id: BigInt(id) }, data: { status: ALERT_STATUS.failed, payload } });
      // F3: falha definitiva vira deadletter visível no painel (/ops/queues)
      await db.jobsDeadletter.create({
        data: {
          queue: "alerts",
          payload: { alertId: id, userId: row?.userId ?? "?", topic: row?.topic ?? "?" },
          error: reason,
          createdAt: new Date().toISOString(),
        },
      });
    },
    async saveAttempts(id: string, attempts: number) {
      const row = await db.alertEvent.findUnique({ where: { id: BigInt(id) } });
      const payload = { ...((row?.payload as object) ?? {}), attempts };
      await db.alertEvent.update({ where: { id: BigInt(id) }, data: { payload } });
    },
  };
}

async function main() {
  const once = process.argv.includes("--once");
  const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 30_000);
  const db = createDb(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/acompanhe");
  const queue = prismaDeliveryQueue(db);
  const botToken = process.env.BOT_TOKEN ?? "";
  const sender = telegramSender(botToken);
  if (!botToken) console.warn("[worker] BOT_TOKEN ausente — entregas falharão como retryable");

  let cycles = 0; // G2: conta ciclos para o expurgo de retenção
  let ultimoMonitor = 0; // P4 — monitoramento por polling (intervalo próprio)

  const cycle = async () => {
    const s = await deliverPending(queue, sender, defaultDeliverOptions);
    console.log(`[worker] ciclo: sent=${s.sent} blocked=${s.blocked} failed=${s.failed} retried=${s.retried}${s.pausedForSec ? ` paused=${s.pausedForSec}s` : ""}`);
    // VIDA: entregas viram OpsEvent duráveis (painel /ops/queues + timeline)
    if (s.sent > 0) {
      await db.opsEvent.create({ data: { source: "worker", kind: "alert_delivered", service: "worker", ok: true, detail: { sent: s.sent } } }).catch(() => undefined);
    }
    if (s.failed > 0 || s.blocked > 0) {
      await db.opsEvent.create({ data: { source: "worker", kind: "alert_failed", service: "worker", ok: false, detail: { failed: s.failed, blocked: s.blocked } } }).catch(() => undefined);
    }
    // P4 — monitoramento por polling: roda a cada MONITOR_INTERVAL_MIN (padrão 60min;
    // a janela por processo é MONITOR_INTERVAL_HORAS, padrão 6h). Nunca "tempo real".
    const monitorMs = Number(process.env.MONITOR_INTERVAL_MIN ?? 60) * 60_000;
    if (Date.now() - ultimoMonitor >= monitorMs) {
      ultimoMonitor = Date.now();
      const m = await rodarMonitoramento({
        listar: async (limite) => {
          const rows = await db.legalCase.findMany({
            where: { alertasAtivos: true },
            orderBy: [{ ultimaVerificacao: "asc" }],
            take: limite,
          });
          return rows
            .filter((r) => r.alias)
            .map<CasoMonitorado>((r) => ({
              id: r.id,
              userId: r.userId,
              cnj: r.cnj,
              alias: r.alias ?? "",
              movimentosCount: r.movimentosCount,
              ultimoMovimentoNome: (r.ultimoMovimento as { nome?: string } | null)?.nome ?? null,
              ultimoMovimentoData: (r.ultimoMovimento as { dataHora?: string } | null)?.dataHora ?? null,
              alertasAtivos: r.alertasAtivos,
              ultimaVerificacao: r.ultimaVerificacao,
            }));
        },
        buscarDoc: (alias, numeroProcesso) => fetchProcessos(alias, { numeroProcesso }),
        marcarVerificado: async (casoId, iso) => {
          await db.legalCase.update({ where: { id: casoId }, data: { ultimaVerificacao: iso } });
        },
        emitirAlerta: async (nov) => {
          const dedupeKey = `${nov.userId}:novo_movimento:${nov.cnj}:${(nov.ultimoData ?? "").slice(0, 10)}`;
          await db.alertEvent
            .create({
              data: {
                userId: nov.userId,
                topic: "novo_movimento",
                refId: nov.cnj,
                channel: "telegram",
                status: "queued",
                payload: { kind: "novo_movimento", detail: nov.detail },
                dedupeKey,
                createdAt: new Date().toISOString(),
              },
            })
            .catch(() => undefined); // dedupe/unique: já existe → não duplica
        },
      });
      console.log(`[worker] monitor: verificados=${m.verificados} novidades=${m.comNovidade} alertas=${m.alertas} falhas=${m.falhas} pulados=${m.pulados}`);
      await db.opsEvent
        .create({ data: { source: "worker", kind: "monitor_ciclo", service: "worker", ok: m.falhas === 0, detail: { ...m } } })
        .catch(() => undefined);
    }
    // G2: expurgo de retenção a cada 100 ciclos (probes 7d, eventos 30d)
    cycles += 1;
    if (cycles % 100 === 0) {
      const p = await db.serviceProbe.deleteMany({ where: { ts: { lt: new Date(Date.now() - 7 * 86400000) } } }).catch(() => ({ count: 0 }));
      const e = await db.opsEvent.deleteMany({ where: { ts: { lt: new Date(Date.now() - 30 * 86400000) } } }).catch(() => ({ count: 0 }));
      await db.opsEvent.create({ data: { source: "worker", kind: "purge", service: "app", ok: true, detail: { probesDeleted: p.count, eventsDeleted: e.count } } }).catch(() => undefined);
    }
    return s;
  };

  await cycle();
  if (once) return;
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    await cycle();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
