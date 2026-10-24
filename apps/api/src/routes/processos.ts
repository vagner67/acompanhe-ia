/**
 * Rotas da Assessoria jurídica (plano.md §4.4) — doc 03 §6.
 * POST /api/processos/{cnj}/acompanhar — RB1: duplicidade → 409 + link do caso.
 * GET  /api/processos — lista do usuário.
 * POST /api/processos/{cnj}/sync — RF-B03: movimentos DataJud (RB3 sigilo, RB5 dedupe).
 * POST /api/juridico/consultas — RF-B07: só OAB verificada; RF-B08: rodapé.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { makeJuridicoService, RODAPE_INFORMATIVO, type LegalStore } from "../juridico/service.js";
import { isValidCnj, aliasFromTribunal, parseCnj, formatCnj } from "../juridico/cnj.js";
import type { DatajudClientOpts } from "../juridico/datajud.js";
import type { JwtService } from "../security/jwt.js";
import type { Entitlements } from "../entitlements.js";

/** SKUs da Consulta Jurídica (v2/08 §9.5; sem pack avulso — AVULSOS só tem investigaPack). */
export const PLANS_WITH_JURIDICA = ["juridica", "juridica:trial"];

export interface ProcessosDeps {
  jwt: JwtService;
  store: LegalStore;
  adminToken: string;
  entitlements: Entitlements;
  oabVerified?: Set<string>;
  datajud?: typeof import("../juridico/datajud.js").fetchProcessos;
  datajudOpts?: DatajudClientOpts;
  now?: () => Date;
}

const acompanharSchema = z.object({
  role: z.enum(["ativo", "passivo", "outro"]).default("outro"),
  alias: z.string().min(2).max(40).optional(),
  oab: z.string().max(20).optional(),
});

const consultaSchema = z.object({
  cnj: z.string().optional(),
  question: z.string().min(5).max(2000),
  oabUser: z.string().max(64).optional(),
});

export function processosRoutes(deps: ProcessosDeps) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const service = makeJuridicoService({
      store: deps.store,
      ...(deps.oabVerified ? { oabVerified: deps.oabVerified } : {}),
      ...(deps.datajud ? { datajud: deps.datajud } : {}),
      ...(deps.datajudOpts ? { datajudOpts: deps.datajudOpts } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });

    async function requireUser(req: FastifyRequest): Promise<string | null> {
      const h = req.headers.authorization;
      if (!h?.startsWith("Bearer ")) return null;
      try {
        const claims = await deps.jwt.verify(h.slice(7));
        return claims?.sub ?? null;
      } catch {
        return null;
      }
    }

    app.get("/api/processos", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const casos = await service.listar(userId);
      return reply.send({ processos: casos, rule: "RB1/RB2" });
    });

    app.post("/api/processos/:cnj/acompanhar", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const { cnj } = req.params as { cnj: string };
      const decoded = decodeURIComponent(cnj);
      if (!isValidCnj(decoded)) return reply.code(422).send({ error: "número CNJ inválido (DV Res. 65/2008)", rule: "RF-B01" });
      const body = acompanharSchema.parse(req.body ?? {});
      const parts = parseCnj(decoded)!;
      const alias = body.alias ?? aliasFromTribunal(parts.justica, parts.tribunal);
      const r = await service.acompanhar(userId, formatCnj(parts), body.role, alias ?? null);
      if (!r.created) return reply.code(409).send({ error: "já acompanhado", link: r.link, rule: "RB1" });
      return reply.code(201).send({ caseId: r.caseId, link: r.link, alias, rule: "RF-B02" });
    });

    // RF-B08 — explicação IA de movimento (rodapé obrigatório; nunca parecer)
    app.get("/api/processos/:cnj/explicar", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!(await deps.entitlements.isEntitled(userId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({ error: "plano Consulta Jurídica ativo é necessário", rule: "v2/08 §9.5" });
      }
      const { mov } = z.object({ mov: z.string().min(2).max(120) }).parse(req.query ?? {});
      return reply.send({ explicacao: service.explicarMovimento(mov), atos: [], rule: "RF-B08 · sempre com rodapé" });
    });

    // E2E 23/10: o link devolvido por acompanhar/RB1 (/api/processos/:cnj) apontava
    // p/ rota inexistente (404) e os movimentos não tinham superfície HTTP.
    app.get("/api/processos/:cnj", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireUser(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { cnj } = req.params as { cnj: string };
      const processo = await deps.store.getCase(subjectId, decodeURIComponent(cnj));
      if (!processo) return reply.code(404).send({ error: "não acompanhado" });
      const movimentos = await deps.store.listEvents(processo.id);
      return reply.send({ processo, movimentos, rule: "RF-B03/RB5 · eventos com dedupe" });
    });

    app.post("/api/processos/:cnj/sync", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const { cnj } = req.params as { cnj: string };
      const decoded = decodeURIComponent(cnj);
      const parts = parseCnj(decoded);
      if (!parts) return reply.code(422).send({ error: "número CNJ inválido" });
      const body = (req.body ?? {}) as { alias?: string };
      const alias = body.alias ?? aliasFromTribunal(parts.justica, parts.tribunal);
      if (!alias) return reply.code(422).send({ error: "alias do tribunal desconhecido — informe alias", rule: "RF-B02" });
      try {
        const r = await service.sincronizar(userId, formatCnj(parts), alias);
        return reply.send({ ...r, rodape: RODAPE_INFORMATIVO, rule: "RF-B03/RB3/RB5" });
      } catch (e) {
        return reply.code(502).send({ error: String((e as Error).message ?? e) });
      }
    });

    app.post("/api/juridico/consultas", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!(await deps.entitlements.isEntitled(userId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({ error: "plano Consulta Jurídica ativo é necessário", rule: "v2/08 §9.5" });
      }
      const body = consultaSchema.parse(req.body ?? {});
      try {
        const r = await service.solicitarConsulta(userId, body.cnj ?? null, body.question, body.oabUser ?? null);
        if ("consolidado" in r && r.consolidado) {
          return reply.code(200).send({ consolidado: true, aviso: r.aviso, rodape: r.rodape, rule: "RF-B07/B08 · RB4 janela 6h" });
        }
        return reply.code(201).send({ consulta: r, rodape: RODAPE_INFORMATIVO, rule: "RF-B07/B08" });
      } catch (e) {
        return reply.code(403).send({ error: String((e as Error).message ?? e), rule: "RF-B07" });
      }
    });

    app.get("/api/juridico/consultas", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      return reply.send({ consultas: await deps.store.listAdvices(userId), rodape: RODAPE_INFORMATIVO });
    });

    /** Painel do diretor: registrar advogado com OAB VERIFICADA. */
    app.post("/v1/admin/juridico/oab/verificar", async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.headers["x-admin-token"] !== deps.adminToken) return reply.code(403).send({ error: "admin only" });
      const { oabUser } = z.object({ oabUser: z.string().min(3).max(64) }).parse(req.body ?? {});
      service.oabVerified.add(oabUser);
      return reply.send({ oabUser, verified: true });
    });
  };
}
