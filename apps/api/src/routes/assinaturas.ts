/**
 * Assinaturas — planos, checkout PushinPay, trial, status (plano §1.0).
 * Todo preço vem de PLAN_SKUS; RE1 continua valendo: NENHUMA rota de empréstimo
 * move dinheiro — aqui é só assinatura da plataforma.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { AVULSOS, PLAN_SKUS, TRIAL } from "@acompanhe/shared";

import type { Config } from "../config.js";
import type { JwtService } from "../security/jwt.js";
import type { Entitlements } from "../entitlements.js";
import type { PaymentStore } from "../store.js";
import type { PushinpayClient } from "../payments/pushinpay.js";
import { makeAssinaturasService, type SubscriptionsStore } from "../assinaturas/service.js";
import { resolvePlanPrice, resolveTrialDays, type AdminStore } from "../admin/service.js";

const checkoutSchema = z.object({
  planCode: z.string().min(2).max(20),
  period: z.enum(["monthly", "yearly"]),
  idempotencyKey: z.string().min(8).max(64),
});

const trialSchema = z.object({ planCode: z.string().min(2).max(20) });

export function assinaturasRoutes(deps: {
  config: Config;
  jwt: JwtService;
  payments: PaymentStore;
  entitlements: Entitlements;
  subs: SubscriptionsStore;
  pushinpay: PushinpayClient;
  rules?: AdminStore;
}): (app: FastifyInstance) => Promise<void> {
  const service = makeAssinaturasService({
    payments: deps.payments,
    entitlements: deps.entitlements,
    subs: deps.subs,
    pushinpay: deps.pushinpay,
    webhookUrl: deps.config.PUBLIC_BASE_URL ? `${deps.config.PUBLIC_BASE_URL}/api/webhooks/pushinpay` : "",
  });

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
    app.get("/api/planos", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const status = await service.status(userId);
      // Preços e trial: rules_config do painel (versão vigente) > defaults de PLAN_SKUS
      const planos = [];
      for (const p of PLAN_SKUS) {
        const v = deps.rules
          ? await resolvePlanPrice(deps.rules, p.code, { monthlyCents: p.monthlyCents, yearlyCents: p.yearlyCents })
          : { monthlyCents: p.monthlyCents, yearlyCents: p.yearlyCents, overridden: false };
        planos.push({ ...p, monthlyCents: v.monthlyCents, yearlyCents: v.yearlyCents, priceOverridden: v.overridden });
      }
      const trialDias = deps.rules ? await resolveTrialDays(deps.rules, TRIAL.days) : TRIAL.days;
      return reply.send({ ...status, planos, trial: { ...TRIAL, days: trialDias }, trialDias, avulsos: AVULSOS, pushinpayConfigurado: deps.config.PUSHINPAY_TOKEN.length > 0 });
    });

    app.post("/api/assinaturas/checkout", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const pushinpayRealSemCredencial =
        !deps.config.PUSHINPAY_TOKEN && (deps.pushinpay as { constructor?: { name?: string } }).constructor?.name === "PushinpayClient";
      if (pushinpayRealSemCredencial) {
        return reply.code(503).send({
          error: "credencial PushinPay não configurada — configure PUSHINPAY_TOKEN no servidor para emitir PIX",
          code: "PUSHINPAY_NOT_CONFIGURED",
          pushinpayConfigurado: false,
        });
      }
      const body = checkoutSchema.parse(req.body);
      try {
        const r = await service.checkout(userId, body.planCode, body.period, body.idempotencyKey);
        return reply.send({ checkout: r, rule: "PIX copia-e-cola · webhook assinado libera o plano" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "falha no checkout";
        return reply.code(502).send({ error: msg.slice(0, 200) });
      }
    });

    app.get("/api/assinaturas", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      return reply.send(await service.status(userId));
    });

    app.post("/api/assinaturas/trial", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = trialSchema.parse(req.body);
      const r = await deps.entitlements.useTrial(userId, deps.rules ? await resolveTrialDays(deps.rules, TRIAL.days) : TRIAL.days, new Date(), `${body.planCode}:trial`);
      if (!r.ok) return reply.code(409).send({ error: "trial já utilizado (1× por usuário)", rule: "TRIAL perUserOnce" });
      return reply.send({ ok: true, record: r.record, rule: `${TRIAL.days} dias grátis` });
    });

    app.get("/api/assinaturas/pagamentos", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const rows = await deps.payments.listByUser(userId);
      return reply.send({ pagamentos: rows });
    });
  };
}
