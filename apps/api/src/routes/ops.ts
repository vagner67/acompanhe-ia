/**
 * Rotas do painel de operações (plano §3.2–§3.4, pilares G/R/S/E §7).
 *
 * S1 — ingest vive em /api/internal/* e o web-serve.mjs BLOQUEIA /api/internal
 *      do proxy: o túnel nunca alcança; + verificação de loopback no socket
 *      + x-service-token. O check de IP SOZINHO seria derrotado pelo proxy
 *      (o socket chega como 127.0.0.1). O namespace /api mantém a regra de
 *      arquitetura (toda rota sob /api, /v1 ou /health — architecture.test).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { AdminJwt } from "./admin.js";
import { auditHash, can, type AdminStore } from "../admin/service.js";
import { PrismaOpsStore, type OpsStore, type EventInput, type ProbeInput } from "../ops/store.js";
import {
  OPS_SOURCES, OPS_SERVICES, aggregateProbes, capHours, capLimit, detailHygienic,
  healthScore, redact, WEIGHTS,
} from "../ops/service.js";

// leitura do token de serviço centralizada em ../service-token.ts (mesma regra
// de produção: Render Secret File via SERVICE_TOKEN_FILE, cache de 5s)
import { readServiceToken, esquecerServiceToken, caminhoServiceToken } from "../service-token.js";

const LOG_FILES: Record<string, string> = {
  api: "/tmp/api.log",
  web: "/tmp/web.log",
  bot: "/tmp/bot.log",
  tunnel: "/tmp/cf.log",
  "keep-alive": "/tmp/keep-alive.log",
  worker: "/tmp/worker.log",
};

type AdminClaims = { sub: string; role: string; kind: string };

export function opsRoutes(deps: {
  config: { JWT_SECRET: string };
  store: AdminStore;
  /** injetável p/ testes; produção lê .secrets.json com cache 5s */
  serviceToken?: () => string | null;
  opsStore?: OpsStore;
  /** caminho dos relatórios de teste (deep-run/run-e2e) */
  docsDir?: string;
}): (app: FastifyInstance) => Promise<void> {
  const jwt = new AdminJwt(new TextEncoder().encode(`${deps.config.JWT_SECRET}:admin`));
  const getToken = deps.serviceToken ?? readServiceToken;
  const docsDir = deps.docsDir ?? "/home/user/acompanhe-ia/docs";

  async function getOps(): Promise<OpsStore> {
    if (deps.opsStore) return deps.opsStore;
    const { createDb } = await import("@acompanhe/db");
    const db = createDb(process.env.DATABASE_URL ?? "") as never as ConstructorParameters<typeof PrismaOpsStore>[0];
    return new PrismaOpsStore(db);
  }

  async function actor(req: FastifyRequest, reply: FastifyReply, resource: string): Promise<AdminClaims | null> {
    const h = req.headers.authorization;
    const claims = h?.startsWith("Bearer ") ? await jwt.verify(h.slice(7)) : null;
    if (!claims) {
      reply.code(401).send({ error: "admin não autenticado" });
      return null;
    }
    const admin = await deps.store.findAdminById(claims.sub);
    if (!admin || !admin.active) {
      reply.code(401).send({ error: "operador inativo" });
      return null;
    }
    if (!can(claims.role, resource)) {
      reply.code(403).send({ error: `papel '${claims.role}' sem permissão em '${resource}'`, rule: "RBAC" });
      return null;
    }
    return claims as AdminClaims;
  }

  async function audit(claims: AdminClaims | null, action: string, target: string | null, before: unknown, after: unknown, ip: string | null) {
    const prevHash = await deps.store.auditLastHash();
    const base = { actorId: claims?.sub ?? null, actorRole: claims?.role ?? null, action, target, before, after, ip, ts: new Date().toISOString() };
    await deps.store.auditAppend({ ...base, prevHash, hash: auditHash(prevHash, base) });
  }

  let ingestCount = 0;

  return async (app) => {
    // ───────────────── ingest interno (keep-alive / probe / worker) ─────────
    app.post("/api/internal/ops/ingest", async (req, reply) => {
      const ip = req.socket.remoteAddress ?? "";
      const loopback = ip === "" || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
      if (!loopback) return reply.code(403).send({ error: "ingest apenas localhost (S1)" });
      const token = req.headers["x-service-token"];
      if (!token || token !== getToken()) return reply.code(401).send({ error: "service token inválido" });

      const body = (req.body ?? {}) as { events?: EventInput[]; probes?: ProbeInput[] };
      const events = body.events ?? (req.body && !body.probes ? [req.body as EventInput] : []);
      const probes = body.probes ?? [];
      for (const e of events) {
        if (!OPS_SOURCES.includes(e.source as never)) return reply.code(400).send({ error: `source inválido: ${e.source}` });
        if (!OPS_SERVICES.includes(e.service as never)) return reply.code(400).send({ error: `service inválido: ${e.service}` });
        if (typeof e.kind !== "string" || !e.kind || e.kind.length > 32) return reply.code(400).send({ error: "kind inválido" });
        if (!detailHygienic(e.detail)) return reply.code(400).send({ error: "detail contém chave sensível (S4)" });
      }
      for (const p of probes) {
        if (!OPS_SERVICES.includes(p.service as never)) return reply.code(400).send({ error: `service inválido: ${p.service}` });
        if (!detailHygienic(p.detail)) return reply.code(400).send({ error: "detail contém chave sensível (S4)" });
      }

      const ops = await getOps();
      const saved: string[] = [];
      for (const e of events) saved.push((await ops.insertEvent({ ...e, ok: e.ok !== false })).id);
      const n = await ops.insertProbes(probes);

      // G2: expurgo automático a cada 100 ingestões
      ingestCount += 1;
      let purged: { probesDeleted: number; eventsDeleted: number } | null = null;
      if (ingestCount % 100 === 0) purged = await ops.purge(7, 30);

      return reply.code(201).send({ ok: true, events: saved, probes: n, purged });
    });

    app.post("/api/internal/ops/purge", async (req, reply) => {
      const ip = req.socket.remoteAddress ?? "";
      const loopback = ip === "" || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
      if (!loopback) return reply.code(403).send({ error: "purge apenas localhost (S1)" });
      const token = req.headers["x-service-token"];
      if (!token || token !== getToken()) return reply.code(401).send({ error: "service token inválido" });
      const ops = await getOps();
      const purged = await ops.purge(7, 30);
      await ops.insertEvent({ source: "api", kind: "purge", service: "app", ok: true, detail: purged });
      return reply.send({ ok: true, ...purged });
    });

    // ───────────────── leitura admin (RBAC recurso "ops") ─────────────────
    app.get("/v1/admin/ops/overview", async (req, reply) => {
      const claims = await actor(req, reply, "ops");
      if (!claims) return;
      const ops = await getOps();
      const [recent, restarts, alerts, stats, events] = await Promise.all([
        ops.recentProbesPerService(5),
        ops.restarts24h(),
        ops.alertCounts(),
        ops.tableStats(),
        ops.listEvents({ limit: 8 }),
      ]);
      const fails: Record<string, number> = {};
      for (const [svc, rows] of Object.entries(recent)) fails[svc] = rows.filter((p) => !p.ok).length;
      const { meterSnapshot } = await import("../ops/service.js");
      return reply.send({
        healthScore: healthScore(fails),
        pesos: WEIGHTS,
        sinais: { ...meterSnapshot(), backlog: alerts.queued ?? 0 },
        servicos: Object.entries(recent).map(([service, rows]) => ({
          service,
          ok: rows.length ? rows[0]!.ok : null,
          probes: rows.length,
          fails5: fails[service] ?? 0,
          restarts24h: restarts[service] ?? 0,
        })),
        ultimasAlteracoes: events,
        tabelas: stats,
      });
    });

    app.get("/v1/admin/ops/services", async (req, reply) => {
      const claims = await actor(req, reply, "ops");
      if (!claims) return;
      const ops = await getOps();
      const [recent, restarts, events] = await Promise.all([
        ops.recentProbesPerService(1),
        ops.restarts24h(),
        ops.listEvents({ limit: 200 }),
      ]);
      const ultimo: Record<string, EventRowLite | null> = {};
      for (const e of events) {
        if (!(e.service in ultimo)) ultimo[e.service] = { kind: e.kind, ts: e.ts, ok: e.ok, detail: e.detail };
      }
      return reply.send({
        servicos: Object.entries(recent).map(([service, rows]) => ({
          service,
          ok: rows.length ? rows[0]!.ok : null,
          latencyMs: rows.length ? rows[0]!.latencyMs : null,
          ultimoProbe: rows.length ? rows[0]!.ts : null,
          restarts24h: restarts[service] ?? 0,
          ultimoEvento: ultimo[service] ?? null,
          ...(rows[0]?.latencyMs !== undefined && rows[0]?.latencyMs !== null ? {} : {}),
        })),
      });
    });

    app.get("/v1/admin/ops/timeline", async (req, reply) => {
      const claims = await actor(req, reply, "ops");
      if (!claims) return;
      const q = req.query as { kind?: string; limit?: string };
      const limit = capLimit(Number(q.limit ?? 100));
      if (limit === null) return reply.code(400).send({ error: `limit deve ser 1..500 (E1)` });
      const ops = await getOps();

      const [auditEntries, rules, flags, events] = await Promise.all([
        deps.store.auditList(limit),
        deps.store.ruleList(),
        deps.store.flagList().catch(() => []),
        ops.listEvents({ ...(q.kind ? { kind: q.kind } : {}), limit }),
      ]);

      // R2: pares causa→efeito (heal/health_fail → process_start)
      type Row = { ts: string; fonte: string; acao: string; ator: string | null; antes: unknown; depois: unknown; hash?: string; ok?: boolean };
      const rows: Row[] = [];
      for (const e of auditEntries) rows.push({ ts: e.ts, fonte: "audit", acao: e.action, ator: e.actorId, antes: e.before, depois: e.after, hash: e.hash });
      for (const r of rules) rows.push({ ts: r.effectiveAt, fonte: "rules", acao: `rule ${r.scope}|${r.key} v${r.version}`, ator: r.approvedBy ?? null, antes: null, depois: r.valueJson });
      for (const f of flags) rows.push({ ts: f.updatedAt, fonte: "flags", acao: `flag ${f.key}=${f.enabled}`, ator: f.updatedBy, antes: null, depois: f.payload });
      for (const e of events) rows.push({ ts: e.ts, fonte: "ops", acao: `${e.kind} (${e.service})`, ator: e.source, antes: null, depois: e.detail, ok: e.ok });
      rows.sort((a, b) => (a.ts < b.ts ? 1 : -1));

      // cadeia do audit na leitura (igual /v1/admin/audit)
      let prev: string | null = null;
      let cadeiaOk = true;
      for (const e of [...auditEntries].reverse()) {
        const esperado = auditHash(prev, { actorId: e.actorId, actorRole: (e as { actorRole?: string | null }).actorRole ?? null, action: e.action, target: e.target, before: e.before, after: e.after, ip: e.ip, ts: e.ts });
        if (e.hash !== esperado) cadeiaOk = false;
        prev = e.hash;
      }
      return reply.send({ entries: rows.slice(0, limit), cadeiaOk, fontes: ["audit", "rules", "flags", "ops"] });
    });

    app.get("/v1/admin/ops/probes", async (req, reply) => {
      const claims = await actor(req, reply, "ops");
      if (!claims) return;
      const q = req.query as { service?: string; hours?: string };
      const hours = capHours(Number(q.hours ?? 24));
      if (hours === null) return reply.code(400).send({ error: `hours deve ser 1..168 (E1)` });
      const ops = await getOps();
      const since = new Date(Date.now() - hours * 3600000);
      const probes = await ops.listProbes({ ...(q.service ? { service: q.service } : {}), since, limit: 5000 });
      const agregado = hours > 24 ? aggregateProbes(probes, 5) : null; // E1: bucket 5min
      return reply.send({ hours, service: q.service ?? "todas", total: probes.length, pontos: agregado ?? probes });
    });

    app.get("/v1/admin/ops/queues", async (req, reply) => {
      const claims = await actor(req, reply, "ops");
      if (!claims) return;
      const ops = await getOps();
      const [alertas, deadletter, syncRuns, tabelas] = await Promise.all([
        ops.alertCounts(),
        ops.deadletterList(20),
        ops.syncRunList(20),
        ops.tableStats(),
      ]);
      return reply.send({ alertas, deadletter, syncRuns, tabelas, aviso: syncRuns.length === 0 ? "SyncRun sem escritor: não existe ingestão agendada no código (scheduler externo) — tabela real vazia" : null });
    });

    app.get("/v1/admin/ops/logs", async (req, reply) => {
      const claims = await actor(req, reply, "ops");
      if (!claims) return;
      const q = req.query as { service?: string; lines?: string };
      const file = LOG_FILES[q.service ?? ""];
      if (!file) return reply.code(404).send({ error: "serviço de log desconhecido", permitidos: Object.keys(LOG_FILES) });
      const lines = Math.min(Math.max(Number(q.lines ?? 100), 1), 500);
      let out = "";
      try {
        const raw = readFileSync(file, "utf8").split("\n");
        out = raw.slice(-lines).join("\n");
      } catch { out = "(log inexistente)"; }
      return reply.send({ service: q.service, file, lines, tail: redact(out) }); // S3
    });

    app.get("/v1/admin/ops/tests", async (req, reply) => {
      const claims = await actor(req, reply, "ops");
      if (!claims) return;
      const ler = (f: string): { arquivo: string; resumo: string | null; linhas: string[] } => {
        try {
          const txt = readFileSync(`${docsDir}/${f}`, "utf8");
          const m = txt.match(/PASS=\d+\s+FAIL=\d+\s+EXT=\d+\s+KONHECIDO=\d+\s+total=\d+/) ?? txt.match(/PASS=\d+[^\n]*/);
          return { arquivo: f, resumo: m ? m[0] : null, linhas: txt.split("\n").filter((l) => /^\|?\s*(RUN-|RESUMO|E2E)/.test(l)).slice(0, 5) };
        } catch {
          return { arquivo: f, resumo: null, linhas: [] };
        }
      };
      return reply.send({ runs: [ler("deep-resultados.md"), ler("relatorio-e2e.md")] });
    });

    // ───────────────── flags (G1: ator obrigatório) ───────────────────────
    app.get("/v1/admin/ops/flags", async (req, reply) => {
      const claims = await actor(req, reply, "ops");
      if (!claims) return;
      return reply.send({ flags: await deps.store.flagList() });
    });

    app.post("/v1/admin/ops/flags", async (req, reply) => {
      const claims = await actor(req, reply, "ops");
      if (!claims) return;
      const b = req.body as { key?: string; enabled?: boolean; payload?: unknown };
      if (!b?.key || typeof b.enabled !== "boolean") return reply.code(400).send({ error: "key e enabled obrigatórios" });
      if (!claims.sub) return reply.code(400).send({ error: "ator obrigatório (G1)" });
      const ops = await getOps();
      const row = await deps.store.flagSet(b.key, b.enabled, b.payload ?? null, claims.sub); // G1: updatedBy = ator
      await audit(claims, "flag.set", b.key, null, { enabled: b.enabled, payload: b.payload ?? null }, req.ip);
      await ops.insertEvent({ source: "api", kind: "flag_change", service: "app", ok: true, detail: { key: b.key, enabled: b.enabled, by: claims.sub } });
      return reply.code(201).send({ flag: row });
    });

    // ───────────────── G3: rotação do SERVICE_TOKEN (só diretor) ─────────
    app.post("/v1/admin/ops/rotate-service-token", async (req, reply) => {
      const claims = await actor(req, reply, "ops");
      if (!claims) return;
      if (claims.role !== "diretor") return reply.code(403).send({ error: "apenas o diretor rotaciona credenciais", rule: "RBAC" });
      const novo = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
      try {
        const fs = await import("node:fs");
        const sec = JSON.parse(fs.readFileSync(caminhoServiceToken(), "utf8")) as Record<string, unknown>;
        sec.SERVICE_TOKEN = novo;
        fs.writeFileSync(caminhoServiceToken(), JSON.stringify(sec, null, 2));
        fs.chmodSync(caminhoServiceToken(), 0o600);
      } catch (e) {
        return reply.code(500).send({ error: `falha ao gravar secrets: ${String(e)}` });
      }
      esquecerServiceToken(); // força releitura imediata
      await audit(claims, "ops.rotate_service_token", "SERVICE_TOKEN", null, { rotatedAt: new Date().toISOString() }, req.ip);
      return reply.send({ ok: true, rotatedAt: new Date().toISOString() });
    });
  };
}

interface EventRowLite {
  kind: string;
  ts: string;
  ok: boolean;
  detail: unknown;
}
