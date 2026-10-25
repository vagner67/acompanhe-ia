/**
 * Rotas de Empréstimo (plano.md §5.5/§5.6) — doc 03 §3.3/§6.
 * A3: POST /api/loan-requests SEM V1 aprovada → 403 (antes de persistir).
 * RE1: nenhuma rota move dinheiro — liquidação @wallet/Pix P2P (ver contrato).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { makeEmprestimosService, RegraVioladaError, type LoanMatchDto, type LoanStore } from "../emprestimos/service.js";
import { exigirV1, type VerificacaoStore, V1NaoAprovadoError } from "../emprestimos/verificacao.js";
import {
  contratoParaAnotA,
  lancamentosDoContrato,
  resumoContratos,
  sincronizarPagamentoNoAnota,
  type ContratoNoAnota,
  type OpcoesLancamento,
} from "../emprestimos/ponte-anota.js";
import type { AnotaStore } from "../anota/store.js";
import type { JwtService } from "../security/jwt.js";

export interface EmprestimosRoutesDeps {
  jwt: JwtService;
  store: LoanStore;
  verificacao: VerificacaoStore;
  /**
   * União com o AnotA (25/10). Quando presente, o contrato aceito pode ser
   * lançado no livro-caixa do usuário e cada pagamento declarado/confirmado é
   * espelhado lá. Ausente = produto segue só com empréstimo (testes antigos).
   */
  anota?: { store: AnotaStore };
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

    // ───────────── União com o AnotA: contrato → livro-caixa do usuário ─────────────
    /** Contrato do próprio usuário, exigindo match aceito (senão null/erro de regra). */
    async function contratoDoUsuario(userId: string, matchId: string): Promise<ContratoNoAnota | null> {
      const match = await deps.store.getMatch(matchId);
      if (!match) return null;
      if (match.requestUserId !== userId && match.offerUserId !== userId) return null;
      if (match.status !== "aceito") {
        throw new RegraVioladaError(`contrato ${match.status} não entra no AnotA — só contrato aceito`, 422);
      }
      const pedido = await deps.store.getRequest(match.requestId);
      if (!pedido) return null;
      return contratoParaAnotA(match, pedido, userId);
    }

    /**
     * Espelha um pagamento no AnotA **dos dois lados** (devedor e credor têm
     * livros próprios). Não derruba o pagamento se o espelho falhar: pagamento é
     * regra do empréstimo, o AnotA é consequência — e a resposta diz o que houve.
     */
    async function espelharPagamento(matchId: string, paymentId: string): Promise<Record<string, unknown>> {
      if (!deps.anota) return { sincronizado: false, motivo: "AnotA não disponível neste servidor" };
      try {
        const match = await deps.store.getMatch(matchId);
        if (!match) return { sincronizado: false, motivo: "contrato não encontrado" };
        const pagamento = await deps.store.getPayment(paymentId);
        if (!pagamento) return { sincronizado: false, motivo: "pagamento não encontrado" };
        const pedido = await deps.store.getRequest(match.requestId);
        if (!pedido) return { sincronizado: false, motivo: "pedido do contrato não encontrado" };
        const pagamentos = await deps.store.listPayments(matchId);
        const confirmados = pagamentos
          .filter((p) => p.status === "confirmed")
          .sort((a, b) => a.declaredAt.localeCompare(b.declaredAt));
        const ordem = confirmados.findIndex((p) => p.id === paymentId) + 1; // 0 = ainda não confirmado
        const partes: Array<Record<string, unknown>> = [];
        for (const uid of [match.requestUserId, match.offerUserId]) {
          const contrato = contratoParaAnotA(match, pedido, uid);
          const r = await sincronizarPagamentoNoAnota(deps.anota.store, contrato, pagamento, uid, {}, ordem);
          partes.push({ userId: uid, papel: contrato.papel, ...r });
        }
        return { sincronizado: true, partes };
      } catch (e) {
        return { sincronizado: false, motivo: e instanceof Error ? e.message : String(e) };
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
        // União 25/10: o pagamento declarado aparece no AnotA como pendente.
        const anotA = await espelharPagamento(matchId, p.id);
        return reply.code(201).send({ pagamento: p, anotA, rule: "RF-E06 — dupla confirmação" });
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
        const p = await svc.confirmarPagamento(paymentId, userId, confirmar);
        if (!p) return reply.code(404).send({ error: "pagamento não encontrado" });
        // União 25/10: confirmado → lançamento vira "pago" no AnotA; contestado segue pendente.
        const anotA = await espelharPagamento(p.matchId, p.id);
        return reply.send({ pagamento: p, anotA, rule: "declared→confirmed|disputed (TTL 72h)" });
      } catch (e) {
        if (e instanceof RegraVioladaError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    });
    // ═══════════ AnotA × Empréstimo: a união (25/10) ═══════════
    // Caminho `/api/anota/emprestimos` porque é onde a tela do AnotA procura.
    // A regra (juros, parcela, aceite) continua toda no módulo de empréstimo.
    const lancarSchema = z.object({
      contaId: z.string().uuid().nullish(),
      categoriaId: z.string().uuid().nullish(),
      categoria: z.string().min(1).max(40).optional(),
    });

    app.get("/api/anota/emprestimos", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!deps.anota) return reply.code(503).send({ error: "AnotA não disponível neste servidor" });
      const matches = await deps.store.listMatches(userId);
      const aceitos: LoanMatchDto[] = matches.filter((m) => m.status === "aceito");
      const contratos: ContratoNoAnota[] = [];
      for (const m of aceitos) {
        const pedido = await deps.store.getRequest(m.requestId);
        if (pedido) contratos.push(contratoParaAnotA(m, pedido, userId));
      }
      const lancamentos = await deps.anota.store.listarLancamentos(userId);
      const pagamentosPorMatch: Record<string, Awaited<ReturnType<LoanStore["listPayments"]>>> = {};
      for (const m of aceitos) pagamentosPorMatch[m.id] = await deps.store.listPayments(m.id);
      const r = resumoContratos(contratos, lancamentos, pagamentosPorMatch);
      return reply.send({
        ...r,
        matchesAceitos: aceitos.length,
        matchesTotal: matches.length,
        rule: "contrato aceito → parcelas no AnotA (fitId loan:<matchId>:<n>)",
      });
    });

    app.post<{ Params: { matchId: string } }>("/api/anota/emprestimos/:matchId/lancar", async (req, reply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!deps.anota) return reply.code(503).send({ error: "AnotA não disponível neste servidor" });
      const body = lancarSchema.parse(req.body ?? {});
      try {
        const contrato = await contratoDoUsuario(userId, req.params.matchId);
        if (!contrato) return reply.code(404).send({ error: "contrato não encontrado para este usuário" });
        const opcoes: OpcoesLancamento = {
          contaId: body.contaId ?? null,
          categoriaId: body.categoriaId ?? null,
          ...(body.categoria ? { categoria: body.categoria } : {}),
        };
        const todos = lancamentosDoContrato(contrato, userId, opcoes);
        const novos = [];
        for (const l of todos) {
          if (l.fitId && (await deps.anota.store.existeFitId(userId, l.fitId))) continue;
          novos.push(l);
        }
        const criados = novos.length > 0 ? await deps.anota.store.criarLancamentos(novos) : [];
        return reply.code(criados.length > 0 ? 201 : 200).send({
          criados: criados.length,
          jaExistiam: todos.length - novos.length,
          totalParcelas: todos.length,
          totalCents: contrato.totalCents,
          lancamentos: criados,
          rule: "idempotente por fitId — reexecutar não duplica",
        });
      } catch (e) {
        if (e instanceof RegraVioladaError) return reply.code(e.statusCode).send({ error: e.message });
        throw e;
      }
    });

    app.post<{ Params: { matchId: string; paymentId: string } }>(
      "/api/anota/emprestimos/:matchId/pagamentos/:paymentId/lancar",
      async (req, reply) => {
        const userId = await requireUser(req);
        if (!userId) return reply.code(401).send({ error: "não autenticado" });
        if (!deps.anota) return reply.code(503).send({ error: "AnotA não disponível neste servidor" });
        const body = lancarSchema.parse(req.body ?? {});
        const pagamento = await deps.store.getPayment(req.params.paymentId);
        if (!pagamento || pagamento.matchId !== req.params.matchId) {
          return reply.code(404).send({ error: "pagamento não encontrado neste contrato" });
        }
        try {
          const contrato = await contratoDoUsuario(userId, req.params.matchId);
          if (!contrato) return reply.code(404).send({ error: "contrato não encontrado para este usuário" });
          const opcoes: OpcoesLancamento = {
            contaId: body.contaId ?? null,
            categoriaId: body.categoriaId ?? null,
            ...(body.categoria ? { categoria: body.categoria } : {}),
          };
          const r = await sincronizarPagamentoNoAnota(deps.anota.store, contrato, pagamento, userId, opcoes);
          return reply.send({ ...r, pagamento });
        } catch (e) {
          if (e instanceof RegraVioladaError) return reply.code(e.statusCode).send({ error: e.message });
          throw e;
        }
      },
    );
  };
}
