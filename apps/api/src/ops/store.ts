/**
 * OpsStore — persistência do painel de operações (plano §3.1–§3.3).
 * Fontes reais: OpsEvent/ServiceProbe (novas), AlertEvent/JobsDeadletter/
 * SyncRun (existentes no schema).
 */
import { createDb } from "@acompanhe/db";

type Db = ReturnType<typeof createDb>;

export interface EventInput {
  source: string;
  kind: string;
  service: string;
  ok: boolean;
  detail?: unknown;
  ts?: string | Date;
}
export interface ProbeInput {
  service: string;
  ok: boolean;
  latencyMs?: number | null;
  detail?: unknown;
  ts?: string | Date;
}
export interface EventRow {
  id: string;
  ts: string;
  source: string;
  kind: string;
  service: string;
  ok: boolean;
  detail: unknown;
}
export interface ProbeRow {
  ts: string;
  service: string;
  ok: boolean;
  latencyMs: number | null;
}

export interface OpsStore {
  insertEvent(e: EventInput): Promise<EventRow>;
  insertProbes(ps: ProbeInput[]): Promise<number>;
  listEvents(opts: { kind?: string; limit: number }): Promise<EventRow[]>;
  listProbes(opts: { service?: string; since: Date; limit?: number }): Promise<ProbeRow[]>;
  /** últimos N probes por serviço (para o health score) */
  recentProbesPerService(n: number): Promise<Record<string, ProbeRow[]>>;
  /** process_start por serviço nas últimas 24h (proxy de restarts) */
  restarts24h(): Promise<Record<string, number>>;
  alertCounts(): Promise<Record<string, number>>;
  deadletterList(limit: number): Promise<Array<{ id: string; queue: string; error: string; createdAt: string }>>;
  syncRunList(limit: number): Promise<Array<{ id: string; source: string; status: string; items: number; startedAt: string }>>;
  tableStats(): Promise<{ events: number; probes: number; alertEvents: number; deadletter: number }>;
  purge(probeDays: number, eventDays: number): Promise<{ probesDeleted: number; eventsDeleted: number }>;
}

export class PrismaOpsStore implements OpsStore {
  constructor(private db: Db) {}

  async insertEvent(e: EventInput): Promise<EventRow> {
    const r = await this.db.opsEvent.create({
      data: {
        source: e.source,
        kind: e.kind,
        service: e.service,
        ok: e.ok,
        detail: (e.detail ?? undefined) as never,
        ...(e.ts ? { ts: new Date(e.ts) } : {}),
      },
    });
    return { id: String(r.id), ts: r.ts.toISOString(), source: r.source, kind: r.kind, service: r.service, ok: r.ok, detail: r.detail };
  }

  async insertProbes(ps: ProbeInput[]): Promise<number> {
    if (!ps.length) return 0;
    const r = await this.db.serviceProbe.createMany({
      data: ps.map((p) => ({
        service: p.service,
        ok: p.ok,
        latencyMs: typeof p.latencyMs === "number" ? p.latencyMs : null,
        detail: (p.detail ?? undefined) as never,
        ...(p.ts ? { ts: new Date(p.ts) } : {}),
      })),
    });
    return r.count;
  }

  async listEvents(opts: { kind?: string; limit: number }): Promise<EventRow[]> {
    const rows = await this.db.opsEvent.findMany({
      ...(opts.kind ? { where: { kind: opts.kind } } : {}),
      orderBy: { ts: "desc" },
      take: opts.limit,
    });
    return rows.map((r) => ({ id: String(r.id), ts: r.ts.toISOString(), source: r.source, kind: r.kind, service: r.service, ok: r.ok, detail: r.detail }));
  }

  async listProbes(opts: { service?: string; since: Date; limit?: number }): Promise<ProbeRow[]> {
    const rows = await this.db.serviceProbe.findMany({
      where: { ts: { gte: opts.since }, ...(opts.service ? { service: opts.service } : {}) },
      orderBy: { ts: "asc" },
      take: opts.limit ?? 5000,
    });
    return rows.map((r) => ({ ts: r.ts.toISOString(), service: r.service, ok: r.ok, latencyMs: r.latencyMs }));
  }

  async recentProbesPerService(n: number): Promise<Record<string, ProbeRow[]>> {
    const out: Record<string, ProbeRow[]> = {};
    for (const svc of ["api", "web", "bot", "tunnel", "worker"]) {
      const rows = await this.db.serviceProbe.findMany({ where: { service: svc }, orderBy: { ts: "desc" }, take: n });
      out[svc] = rows.map((r) => ({ ts: r.ts.toISOString(), service: r.service, ok: r.ok, latencyMs: r.latencyMs }));
    }
    return out;
  }

  async restarts24h(): Promise<Record<string, number>> {
    const rows = await this.db.opsEvent.groupBy({
      by: ["service"],
      where: { kind: "process_start", ts: { gte: new Date(Date.now() - 86400000) } },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.service] = r._count._all;
    return out;
  }

  async alertCounts(): Promise<Record<string, number>> {
    const rows = await this.db.alertEvent.groupBy({ by: ["status"], _count: { _all: true } });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r._count._all;
    return out;
  }

  async deadletterList(limit: number) {
    const rows = await this.db.jobsDeadletter.findMany({ orderBy: { id: "desc" }, take: limit });
    return rows.map((r) => ({ id: String(r.id), queue: r.queue, error: r.error, createdAt: String(r.createdAt) }));
  }

  async syncRunList(limit: number) {
    const rows = await this.db.syncRun.findMany({ orderBy: { id: "desc" }, take: limit });
    return rows.map((r) => ({ id: String(r.id), source: r.source, status: r.status, items: r.items, startedAt: String(r.startedAt) }));
  }

  async tableStats() {
    const [events, probes, alertEvents, deadletter] = await Promise.all([
      this.db.opsEvent.count(),
      this.db.serviceProbe.count(),
      this.db.alertEvent.count(),
      this.db.jobsDeadletter.count(),
    ]);
    return { events, probes, alertEvents, deadletter };
  }

  async purge(probeDays: number, eventDays: number) {
    const p = await this.db.serviceProbe.deleteMany({ where: { ts: { lt: new Date(Date.now() - probeDays * 86400000) } } });
    const e = await this.db.opsEvent.deleteMany({ where: { ts: { lt: new Date(Date.now() - eventDays * 86400000) } } });
    return { probesDeleted: p.count, eventsDeleted: e.count };
  }
}
