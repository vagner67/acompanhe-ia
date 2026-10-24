/**
 * Concursos — rotas HTTP (plano.md §3.4). Adaptadores finos (padrão doc 13).
 *   GET  /api/concursos                 RF-D04 filtros (uf/banca/status/palavra)
 *   GET  /api/concursos/:externalId     RF-D03 ficha + RF-D05 timeline (RD2)
 *   GET  /api/concursos/alertas         RF-D07 T-7/T-3/T-1 dos acompanhados
 *   POST /v1/admin/concursos/ingesta    job (X-Admin-Token): edicao DOU ou busca
 * RD1: o módulo só lê HTML/JSON do DOU — nunca baixa PDF (PCI read-only).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { JwtService } from "../security/jwt.js";
import { makeConcursosService, type ContestFilter, type ContestStore } from "../concursos/service.js";
import type { DouClientOpts } from "../concursos/dou.js";

const filterSchema = z.object({
  uf: z.string().length(2).optional(),
  banca: z.string().max(40).optional(),
  status: z.enum(["previsto", "autorizado", "edital_publicado", "inscricoes_abertas", "homologado"]).optional(),
  palavra: z.string().min(2).max(80).optional(),
});

const ingestaSchema = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("edicao"),
    data: z.string().regex(/^\d{2}-\d{2}-\d{4}$/),
    secao: z.enum(["do1", "do2", "do3"]),
  }),
  z.object({
    tipo: z.literal("busca"),
    q: z.string().min(2).max(120),
    secao: z.enum(["do1", "do2", "do3", "todos"]).optional(),
    publishFrom: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
    publishTo: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
  }),
]);

const alertasSchema = z.object({
  acompanhados: z.array(z.string().min(3).max(200)).max(50),
});

function toContestFilter(f: z.infer<typeof filterSchema>): ContestFilter {
  return { ...f };
}

export function concursosRoutes(deps: {
  jwt: JwtService;
  store: ContestStore;
  dou?: DouClientOpts;
  adminToken: string;
}): (app: FastifyInstance) => Promise<void> {
  const { jwt } = deps;
  const service = makeConcursosService({
    store: deps.store,
    ...(deps.dou ? { dou: deps.dou } : {}),
  });

  async function requireSubject(req: FastifyRequest): Promise<string | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const claims = await jwt.verify(header.slice("Bearer ".length));
    return claims?.sub ?? null;
  }

  return async (app) => {
    app.get("/api/concursos", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const filter = toContestFilter(filterSchema.parse(req.query ?? {}));
      const concursos = await service.list(filter);
      return reply.send({ concursos, items: concursos, total: concursos.length, count: concursos.length, rule: "RF-D04 · RD2 retificação=versão" });
    });

    app.get("/api/concursos/:externalId", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { externalId } = req.params as { externalId: string };
      const t = await service.timeline(externalId);
      if (!t.original) return reply.code(404).send({ error: "concurso não encontrado" });
      return reply.send({ concurso: t.original, versoes: t.versoes, timeline: t.versoes, rule: "RF-D03/RF-D05" });
    });

    // 24/10: o app pede a timeline em rota própria (api2.concursoTimeline).
    app.get("/api/concursos/:externalId/timeline", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { externalId } = req.params as { externalId: string };
      const t = await service.timeline(externalId);
      return reply.send({ timeline: t.versoes, rule: "RF-D05 · marcos reais (versões RD2 do edital)" });
    });

    app.get("/api/concursos/alertas", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const src = (req.query && Object.keys(req.query).length ? req.query : req.body ?? {}) as Record<string, unknown>;
      const { acompanhados } = alertasSchema.parse(src);
      const alerts = await service.alertsForUser(subjectId, acompanhados);
      return reply.send({ alerts, rule: "RF-D07 — T-7/T-3/T-1 de inscrição" });
    });

    app.post("/v1/admin/concursos/ingesta", async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.headers["x-admin-token"] !== deps.adminToken) {
        return reply.code(403).send({ error: "admin token inválido" });
      }
      const body = ingestaSchema.parse(req.body);
      try {
        const result =
          body.tipo === "edicao"
            ? await service.ingestEdicao(body.data, body.secao)
            : await service.ingestBusca({
                q: body.q,
                ...(body.secao ? { secao: body.secao } : {}),
                publishFrom: body.publishFrom,
                publishTo: body.publishTo,
              });
        return reply.send({ ok: true, ...result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "falha na ingesta";
        return reply.code(502).send({ error: "fonte DOU indisponível", detail: msg.slice(0, 200) });
      }
    });
  };
}
