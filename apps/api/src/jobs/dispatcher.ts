/**
 * Funções compartilhadas (plano.md §7) — dispatcher de alertas + jobs.
 * Todo alerta passa por aqui e vira AlertEvent (auditável, deduplicado).
 * Jobs: poll-processos (6h/UF, RB4), daily-ladder-and-tags, daily-heat,
 * alertas de inscrição de concurso (T-7/3/1) e de vencimento de parcela.
 * Nada de cron-mágico: cada job é uma função pura chamada por um scheduler
 * (o scheduler é o que o systemd/cron do deploy chama — testável sem rede).
 */
import type { createDb } from "@acompanhe/db";

type PrismaClient = ReturnType<typeof createDb>;

export type AlertKind =
  | "prazo_inscricao" // Concursos RF-D07
  | "novo_movimento" // Jurídico RF-B04
  | "vencimento_parcela" // Empréstimo RF-E05
  | "match_expirando" // doc 03 §3.3 (72h)
  | "heat_alert" // doc 06 — quente/fria
  | "prazo_alerta"; // genérico acompanhhe

export interface AlertEventInput {
  userId: string;
  kind: AlertKind;
  refId: string; // id do objeto (contest, caso, match…)
  detail: string;
  dedupeKey: string; // hash(userId|kind|refId|janela)
}

export interface AlertSink {
  emit(a: AlertEventInput): Promise<{ id: string; inserted: boolean }>;
  list(userId: string, kind?: AlertKind): Promise<Array<AlertEventInput & { id: string; sentAt: string }>>;
}

/** Dedupe em memória para testes; Prisma usa @@unique([dedupeKey]) equivalente. */
export class InMemoryAlertSink implements AlertSink {
  private events = new Map<string, AlertEventInput & { id: string; sentAt: string }>();
  private seq = 0;

  async emit(a: AlertEventInput) {
    if (this.events.has(a.dedupeKey)) return { id: this.events.get(a.dedupeKey)!.id, inserted: false };
    const id = `ae_${++this.seq}`;
    this.events.set(a.dedupeKey, { ...a, id, sentAt: new Date().toISOString() });
    return { id, inserted: true };
  }

  async list(userId: string, kind?: AlertKind) {
    return [...this.events.values()].filter((e) => e.userId === userId && (!kind || e.kind === kind));
  }
}

export function alertDedupeKey(userId: string, kind: string, refId: string, janela: string): string {
  return `${userId}|${kind}|${refId}|${janela}`;
}

/**
 * poll-processos (plano.md §4.5): consolida movimentos NOVOS por usuário e
 * emite 1 alerta consolidado por usuário-tribunal (RB4) — a janela de 6h é o
 * `janela` do dedupe (RB5 complementar).
 */
export async function jobPollProcessos(
  sink: AlertSink,
  novos: Array<{ userId: string; tribunal: string; numeroProcesso: string; total: number }>,
  janelaIso: string,
): Promise<number> {
  // 1 alerta por usuário+tribunal+janela (não por movimento)
  const consolidado = new Map<string, { userId: string; tribunal: string; total: number; numeroProcesso: string }>();
  for (const n of novos) {
    const k = `${n.userId}|${n.tribunal}`;
    const prev = consolidado.get(k);
    consolidado.set(k, prev ? { ...prev, total: prev.total + n.total } : n);
  }
  let emitidos = 0;
  for (const c of consolidado.values()) {
    const r = await sink.emit({
      userId: c.userId,
      kind: "novo_movimento",
      refId: c.tribunal,
      detail: `${c.total} nova(s) movimentação(ões) em processos acompanhados (${c.tribunal})`,
      dedupeKey: alertDedupeKey(c.userId, "novo_movimento", c.tribunal, janelaIso),
    });
    if (r.inserted) emitidos++;
  }
  return emitidos;
}

/** RF-E05 — vencimento de parcela: alerta aos DOIS lados (ver service.lembretesVencimento). */
export async function jobVencimentoParcelas(
  sink: AlertSink,
  parcelas: Array<{ matchId: string; devedorId: string; credorId: string; vencimento: string; valorCents: number }>,
): Promise<number> {
  let emitidos = 0;
  for (const p of parcelas) {
    for (const [userId, papel] of [
      [p.devedorId, "devedor"],
      [p.credorId, "credor"],
    ] as const) {
      const r = await sink.emit({
        userId,
        kind: "vencimento_parcela",
        refId: p.matchId,
        detail: `Parcela de R$ ${(p.valorCents / 100).toFixed(2)} vence em ${p.vencimento} (${papel})`,
        dedupeKey: alertDedupeKey(userId, "vencimento_parcela", p.matchId, p.vencimento),
      });
      if (r.inserted) emitidos++;
    }
  }
  return emitidos;
}

/** doc 03 §3.3 — match expirando (72h): aviso faltando 6h. */
export async function jobMatchExpirando(
  sink: AlertSink,
  matches: Array<{ id: string; userId: string; expiraEm: string }>,
  agoraIso: string,
): Promise<number> {
  const agora = new Date(agoraIso).getTime();
  let emitidos = 0;
  for (const m of matches) {
    const faltam = new Date(m.expiraEm).getTime() - agora;
    if (faltam > 0 && faltam <= 6 * 3600_000) {
      const r = await sink.emit({
        userId: m.userId,
        kind: "match_expirando",
        refId: m.id,
        detail: `Match expira em ${Math.round(faltam / 60000)} min`,
        dedupeKey: alertDedupeKey(m.userId, "match_expirando", m.id, m.expiraEm),
      });
      if (r.inserted) emitidos++;
    }
  }
  return emitidos;
}

/** Registro persistente (Postgres) — model AlertEvent (topic/channel/status). */
type AlertDb = {
  alertEvent: {
    create: (x: unknown) => Promise<{ id: bigint | string }>;
    findUnique: (x: unknown) => Promise<{ id: bigint | string } | null>;
    findMany: (x: unknown) => Promise<Array<Record<string, unknown>>>;
  };
};

const TOPIC: Record<AlertKind, string> = {
  prazo_inscricao: "concursos",
  novo_movimento: "processos",
  vencimento_parcela: "emprestimos",
  match_expirando: "emprestimos",
  heat_alert: "emprestimos",
  prazo_alerta: "financeiro",
};

export class PrismaAlertSink implements AlertSink {
  constructor(private db: PrismaClient) {}

  async emit(a: AlertEventInput) {
    const db = this.db as unknown as AlertDb;
    const prev = await db.alertEvent.findUnique({ where: { dedupeKey: a.dedupeKey } });
    if (prev) return { id: String(prev.id), inserted: false };
    try {
      const r = await db.alertEvent.create({
        data: {
          userId: a.userId,
          topic: TOPIC[a.kind],
          refId: a.refId,
          channel: "telegram",
          status: "queued",
          payload: { kind: a.kind, detail: a.detail },
          dedupeKey: a.dedupeKey,
          createdAt: new Date().toISOString(),
        },
      });
      return { id: String(r.id), inserted: true };
    } catch {
      // corrida: outra inserção venceu o dedupe
      const p2 = await db.alertEvent.findUnique({ where: { dedupeKey: a.dedupeKey } });
      return { id: p2 ? String(p2.id) : "", inserted: false };
    }
  }

  async list(userId: string, kind?: AlertKind) {
    const db = this.db as unknown as AlertDb;
    const rows = await db.alertEvent.findMany({
      where: { userId, ...(kind ? { payload: { path: ["kind"], equals: kind } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((r) => ({
      id: String(r.id),
      userId: String(r.userId),
      kind: ((r.payload as { kind?: AlertKind })?.kind ?? "prazo_alerta") as AlertKind,
      refId: String(r.refId ?? ""),
      detail: String((r.payload as { detail?: string })?.detail ?? ""),
      dedupeKey: String(r.dedupeKey ?? ""),
      sentAt: String(r.createdAt),
    }));
  }
}
