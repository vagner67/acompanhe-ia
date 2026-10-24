/**
 * Licitação — rotas HTTP (plano.md §2.3–2.4). Adaptadores finos (padrão doc 13):
 * auth → zod → `licitacoes/service.ts` → reply.
 *   GET  /api/licitacoes                 RF-C02 filtros sobre o acervo (uf/city/palavra/modalidade/valor/datas)
 *   POST /api/licitacoes/busca           RF-C02 busca full-text viva (PNCP /api/search) + radar RF-C03
 *   GET  /api/licitacoes/filtros         RF-C03 filtros salvos do assinante
 *   POST /api/licitacoes/filtros         RF-C03 salvar "meu radar"
 *   GET  /api/licitacoes/alertas         RF-C05 prazo de propostas (T-3) dos matches
 *   POST /v1/admin/licitacoes/sync       job de sync (X-Admin-Token; doc 03 §7)
 * Toda rota autenticada exceto /health (doc 02). Link do card = campo REAL da
 * API (RC4) — nunca URL inventada.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Config } from "../config.js";
import type { JwtService } from "../security/jwt.js";
import {
  makeLicitacoesService,
  type TenderFilter,
  type TenderStore,
} from "../licitacoes/service.js";
import type { PncpClientOpts } from "../licitacoes/pncp.js";

const filterSchema = z.object({
  uf: z.string().length(2).optional(),
  cityIbge: z.number().int().optional(),
  palavra: z.string().min(2).max(80).optional(),
  modality: z.number().int().min(1).max(20).optional(),
  minCents: z.number().int().min(0).optional(),
  maxCents: z.number().int().min(0).optional(),
  propostaAte: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  somenteAbertos: z.boolean().optional(),
});

const searchSchema = z.object({
  q: z.string().min(2).max(120).optional(),
  tiposDocumento: z.union([z.string().min(2), z.array(z.string().min(2)).min(1)]),
  status: z.string().max(40).optional(),
  ufs: z.string().max(60).optional(),
  pagina: z.number().int().min(1).optional(),
  tamanhoPagina: z.number().int().min(10).max(100).optional(),
});

const saveFilterSchema = z.object({
  name: z.string().min(2).max(80),
  filter: filterSchema,
});

const syncSchema = z.object({
  kind: z.enum(["publicacao", "atualizacao", "proposta"]),
  dataInicial: z.string().regex(/^\d{8}$/),
  dataFinal: z.string().regex(/^\d{8}$/),
  codigoModalidadeContratacao: z.number().int().min(1),
  tamanhoPagina: z.number().int().min(10).max(500).optional(),
});

function toTenderFilter(f: z.infer<typeof filterSchema>): TenderFilter {
  return { ...f };
}

export function licitacoesRoutes(deps: {
  config: Config;
  jwt: JwtService;
  store: TenderStore;
  pncp?: PncpClientOpts;
  adminToken: string;
}): (app: FastifyInstance) => Promise<void> {
  const { jwt } = deps;
  const service = makeLicitacoesService({
    store: deps.store,
    ...(deps.pncp ? { pncp: deps.pncp } : {}),
  });

  async function requireSubject(req: FastifyRequest): Promise<string | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const claims = await jwt.verify(header.slice("Bearer ".length));
    return claims?.sub ?? null;
  }

  async function authed(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const subjectId = await requireSubject(req);
    if (!subjectId) {
      reply.code(401).send({ error: "não autenticado" });
      return null;
    }
    return subjectId;
  }

  return async (app) => {
    app.get("/api/licitacoes", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await authed(req, reply);
      if (!subjectId) return;
      const filter = toTenderFilter(filterSchema.parse(req.query ?? {}));
      const tenders = await service.list(filter);
      return reply.send({ tenders, total: tenders.length, rule: "RF-C02 · regionalização A6" });
    });

    app.post("/api/licitacoes/busca", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await authed(req, reply);
      if (!subjectId) return;
      const body = searchSchema.parse(req.body);
      try {
        const result = await service.search({
          ...body,
          tiposDocumento: body.tiposDocumento,
        });
        return reply.send({
          items: result.tenders,
          count: result.total,
          tenders: result.tenders,
          total: result.total,
          newMatches: result.newMatches,
          rule: "RF-C02/RF-C03 · fonte PNCP /api/search (RC4: link só de campo real)",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "falha na busca";
        return reply.code(502).send({ error: "fonte PNCP indisponível", detail: msg.slice(0, 200) });
      }
    });

    // 24/10: o app chama GET /api/licitacoes/busca?q=&ufs= (api2.ts) — mesmo serviço.
    app.get("/api/licitacoes/busca", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await authed(req, reply);
      if (!subjectId) return;
      const { q, ufs } = z.object({ q: z.string().min(1).max(120), ufs: z.string().max(40).optional() }).parse(req.query ?? {});
      try {
        const result = await service.search({
          q,
          ufs: ufs || undefined,
          tiposDocumento: "edital", // default honesto da tela do app (mesmo do exemplo da UI)
          pagina: 1,
          tamanhoPagina: 20,
        });
        return reply.send({
          items: result.tenders,
          count: result.total,
          tenders: result.tenders,
          total: result.total,
          newMatches: result.newMatches,
          rule: "RF-C02/RF-C03 · busca do app (q/ufs)",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "falha na busca";
        return reply.code(502).send({ error: "fonte PNCP indisponível", detail: msg.slice(0, 200) });
      }
    });

    // ————— interesses (radar) — mesmo UserInterest dos filtros: topic↔name, query↔filter —————
    app.get("/api/licitacoes/interesses", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await authed(req, reply);
      if (!subjectId) return;
      const saved = await service.listSaved(subjectId);
      return reply.send({ interests: saved.map((s) => ({ topic: s.name, query: s.filter ?? {} })) });
    });

    app.post("/api/licitacoes/interesses", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await authed(req, reply);
      if (!subjectId) return;
      const body = z.object({
        topic: z.string().min(1).max(80),
        query: z.record(z.unknown()).optional().default({}),
      }).parse(req.body ?? {});
      await service.saveInterest(subjectId, body.topic, body.query as never);
      return reply.code(201).send({ ok: true, interesse: { topic: body.topic, query: body.query } });
    });

    app.delete("/api/licitacoes/interesses/:topic", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await authed(req, reply);
      if (!subjectId) return;
      const topic = decodeURIComponent((req.params as { topic: string }).topic);
      const ok = await service.removeSaved(subjectId, topic);
      return ok ? reply.send({ ok: true }) : reply.code(404).send({ error: "interesse não encontrado" });
    });

    app.get("/api/licitacoes/filtros", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await authed(req, reply);
      if (!subjectId) return;
      const lista = await service.listSaved(subjectId);
      return reply.send({ filtros: lista, filters: lista });
    });

    app.post("/api/licitacoes/filtros", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await authed(req, reply);
      if (!subjectId) return;
      const body = saveFilterSchema.parse(req.body);
      await service.saveInterest(subjectId, body.name, toTenderFilter(body.filter));
      return reply.code(201).send({ ok: true, name: body.name });
    });

    app.get("/api/licitacoes/alertas", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await authed(req, reply);
      if (!subjectId) return;
      const alerts = await service.alertsForUser(subjectId);
      return reply.send({ alerts, rule: "RF-C05 — T-3 de encerramento de propostas" });
    });

    app.delete("/api/licitacoes/filtros/:name", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await authed(req, reply);
      if (!subjectId) return;
      const ok = await service.removeSaved(subjectId, decodeURIComponent((req.params as { name: string }).name));
      return ok ? reply.send({ ok: true }) : reply.code(404).send({ error: "filtro não encontrado" });
    });

    app.post("/v1/admin/licitacoes/sync", async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.headers["x-admin-token"] !== deps.adminToken) {
        return reply.code(403).send({ error: "admin token inválido" });
      }
      const body = syncSchema.parse(req.body);
      try {
        const result = await service.sync(body.kind, body);
        return reply.send({ ok: true, ...result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "falha no sync";
        return reply.code(502).send({ error: "fonte PNCP indisponível", detail: msg.slice(0, 200) });
      }
    });
  };
}
