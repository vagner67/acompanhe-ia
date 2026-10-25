/**
 * Minhas — empréstimos do usuário + verificação V1 + perfil/região (plano §1.1/§1.6).
 *
 * O AnotA saiu daqui na refatoração de 25/10 (`routes/anota.ts`): este arquivo
 * ficou só com os domínios de empréstimo, verificação e perfil. As rotas antigas
 * de notas/gastos continuam respondendo — os apelidos vivem em `anota.ts`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { JwtService } from "../security/jwt.js";
import type { LoanStore } from "../emprestimos/service.js";
import type { VerificacaoStore as VerStore } from "../emprestimos/verificacao.js";

const verificacaoSchema = z.object({
  docTipo: z.enum(["cnh", "rg", "cpf", "passaporte"]),
  selfieAt: z.string().min(4).max(40).optional(),
});

const perfilSchema = z.object({ uf: z.string().length(2), cityIbge: z.number().int().positive() });

export function minhasRoutes(deps: {
  jwt: JwtService;
  loans: LoanStore;
  verificacao: VerStore;
  upsertUser?: (userId: string, p: { uf: string; cityIbge: number }) => Promise<void>;
}): (app: FastifyInstance) => Promise<void> {
  async function subject(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "não autenticado" });
      return null;
    }
    try {
      const claims = await deps.jwt.verify(h.slice(7));
      return claims?.sub ?? null;
    } catch {
      reply.code(401).send({ error: "sessão inválida" });
      return null;
    }
  }

  return async (app) => {
    // ————— Empréstimos do usuário + Caderno de Dívidas —————
    app.get("/api/minhas/emprestimos", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const matches = await deps.loans.listMatches(userId);
      const detalhes = [];
      for (const m of matches) {
        detalhes.push({ match: m, rodadas: await deps.loans.listRodadas(m.id), pagamentos: await deps.loans.listPayments(m.id) });
      }
      return reply.send({ matches: detalhes, rule: "RF-E05 · agenda dos dois lados" });
    });

    app.get("/api/minhas/dividas", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const matches = await deps.loans.listMatches(userId);
      const ativos = [];
      for (const m of matches.filter((x) => x.status === "aceito")) {
        ativos.push({ matchId: m.id, requestId: m.requestId, expiraEm: m.expiraEm, pagamentos: await deps.loans.listPayments(m.id) });
      }
      return reply.send({ dividas: ativos, limiteAtivos: 3, rule: "Caderno de Dívidas (plano anota)" });
    });

    // ————— Verificação V1 (A3: obrigatória para empréstimo) —————
    app.get("/api/minhas/verificacao", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const v = await deps.verificacao.getVerification(userId);
      return reply.send({ verificacao: v ?? { userId, v1Status: "none" }, sinais: await deps.verificacao.listSignals(userId) });
    });

    app.post("/api/minhas/verificacao", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = verificacaoSchema.parse(req.body);
      const atual = await deps.verificacao.getVerification(userId);
      if (atual?.v1Status === "approved") return reply.send({ ok: true, v1Status: "approved" });
      await deps.verificacao.setVerification({
        userId,
        v1Status: "pending",
        docTipo: body.docTipo,
        selfieAt: body.selfieAt ?? new Date().toISOString(),
        approvedAt: null,
      });
      return reply.code(201).send({ ok: true, v1Status: "pending", rule: "aprovação humana no painel (A3)" });
    });

    // ————— Perfil/região (onboarding) —————
    app.post("/api/minhas/perfil", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = perfilSchema.parse(req.body);
      await deps.upsertUser?.(userId, body);
      return reply.send({ ok: true, ...body });
    });
  };
}
