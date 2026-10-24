import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { makeGameService, XP_ACTIONS, type GameStore, type XpAction } from "./service.js";

export function gamificacaoRoutes(
  app: FastifyInstance,
  gameStore: GameStore,
  jwt: { verify(token: string): Promise<{ sub: string } | null> },
): void {
  const svc = makeGameService(gameStore);

  async function subject(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) {
      await reply.code(401).send({ error: "não autenticado" });
      return null;
    }
    try {
      const claims = await jwt.verify(h.slice(7));
      return claims?.sub ?? null;
    } catch {
      await reply.code(401).send({ error: "sessão inválida" });
      return null;
    }
  }

  app.get("/api/gamificacao", async (req, reply) => {
    const userId = await subject(req, reply);
    if (!userId) return;
    return svc.snapshot(userId);
  });

  app.post("/api/gamificacao/acao", async (req, reply) => {
    const userId = await subject(req, reply);
    if (!userId) return;
    const body = z.object({ acao: z.enum(Object.keys(XP_ACTIONS) as [XpAction]) }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: "ação inválida" });
    return svc.award(userId, body.data.acao);
  });

  app.post("/api/gamificacao/ranking", async (req, reply) => {
    const userId = await subject(req, reply);
    if (!userId) return;
    const body = z.object({ participar: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: "participar:booleano" });
    return svc.toggleRanking(userId, body.data.participar);
  });

  app.get("/api/gamificacao/ranking", async (req) => {
    const q = z.object({ uf: z.string().min(2).max(2), limite: z.coerce.number().min(1).max(50) }).safeParse(req.query);
    const uf = q.success ? q.data.uf : "BR";
    const limite = q.success ? q.data.limite : 10;
    return { uf, ranking: await gameStore.ranking(uf, limite) };
  });
}
