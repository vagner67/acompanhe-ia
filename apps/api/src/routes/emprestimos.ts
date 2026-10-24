/**
 * Rotas de Empréstimo (plano.md §5.5/§5.6) — doc 03 §3.3/§6.
 * A3: POST /api/loan-requests SEM V1 aprovada → 403 (antes de persistir).
 * RE1: nenhuma rota move dinheiro — liquidação @wallet/Pix P2P (ver contrato).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { makeEmprestimosService, RegraVioladaError, type LoanStore } from "../emprestimos/service.js";
import { exigirV1, type VerificacaoStore, V1NaoAprovadoError } from "../emprestimos/verificacao.js";
import type { JwtService } from "../security/jwt.js";

export interface EmprestimosRoutesDeps {
  jwt: JwtService;
  store: LoanStore;
  verificacao: VerificacaoStore;
  now?: () => Date;
}

const pedidoSchema = z.object({
  uf: z.string().length(2),
  valorCents: z.number().int().positive().max(1_500_000),
  jurosMesBps: z.number().int().min(0).max(2000),
  meses: z.number().int().min(1).max(60),
  jurosTipo: z.enum(["simples", "compostos"]),
  motivo: z.string().min(3).max(500),
});

export function emprestimosRoutes(deps: EmprestimosRoutesDeps) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const svc = makeEmprestimosService({
      store: deps.store,
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

    /** Feed ANÔNIMO (doc 03 §3.3). */
    app.get("/api/feed/emprestimos", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const { uf } = z.object({ uf: z.string().length(2).optional() }).parse(req.query ?? {});
      const pedidos = await deps.store.listRequests(uf ? { uf } : {});
      return reply.send({ cards: pedidos.filter((p) => p.status === "aberta").map((p) => svc.cardAnonimo(p)), rule: "card anônimo" });
    });

    /** A3 — V1+ obrigatório; 403 ANTES de persistir. */
    app.post("/api/loan-requests", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      try {
        await exigirV1(deps.verificacao, userId);
      } catch (e) {
        if (e instanceof V1NaoAprovadoError) return reply.code(403).send({ error: e.message, rule: "A3" });
        throw e;
      }
      const body = pedidoSchema.parse(req.body ?? {});
      const r = await svc.publicarPedido(userId, body);
      return reply.code(201).send({ pedido: svc.cardAnonimo(r), avisoUsura: r.avisoUsura, rule: "RF-E02/RE2" });
    });

    app.post("/api/loan-requests/:id/interesse", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      try {
        const m = await svc.demonstrarInteresse(userId, (req.params as { id: string }).id);
        return reply.code(201).send({ match: m, rule: "72h" });
      } catch (e) {
        if (e instanceof RegraVioladaError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    });

    app.get("/api/loan-matches", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      return { matches: await deps.store.listMatches(userId) };
    });

    app.get("/api/loan-matches/:id", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      const match = await deps.store.getMatch(id);
      if (!match) return reply.code(404).send({ error: "match não encontrado" });
      return { match, rodadas: await deps.store.listRodadas(id) };
    });

    app.post("/api/loan-matches/:id/aceitar", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      try {
        return reply.send({ match: await svc.aceitarMatch((req.params as { id: string }).id, userId) });
      } catch (e) {
        if (e instanceof RegraVioladaError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    });

    app.post("/api/loan-matches/:id/rodadas", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const { proposta } = z.object({ proposta: z.string().min(2).max(500) }).parse(req.body ?? {});
      try {
        const n = await svc.proporRodada((req.params as { id: string }).id, userId, proposta);
        return reply.send({ rodadas: n, max: 3, rule: "PRODUCT_LIMITS" });
      } catch (e) {
        if (e instanceof RegraVioladaError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    });

    /** RE1 — rota de pagamento NÃO move dinheiro: só registra/confirma. */
    app.post("/api/payments/declare", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const { matchId, valorCents } = z.object({ matchId: z.string(), valorCents: z.number().int().positive() }).parse(req.body ?? {});
      try {
        const p = await svc.declararPagamento(matchId, userId, valorCents);
        return reply.code(201).send({ pagamento: p, rule: "RF-E06 — dupla confirmação" });
      } catch (e) {
        if (e instanceof RegraVioladaError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    });

    app.post("/api/payments/confirm", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const { paymentId, confirmar } = z.object({ paymentId: z.string(), confirmar: z.boolean() }).parse(req.body ?? {});
      try {
        return reply.send({ pagamento: await svc.confirmarPagamento(paymentId, userId, confirmar), rule: "declared→confirmed|disputed (TTL 72h)" });
      } catch (e) {
        if (e instanceof RegraVioladaError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    });
  };
}
