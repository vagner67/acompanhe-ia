/**
 * Assinaturas — checkout PushinPay real, trial 7d 1×/usuário, efeito do webhook.
 * Preços SÓ de PLAN_SKUS (skus.ts); o diretor ajusta em rules_config (doc 05 §3).
 * Fluxo: checkout → PaymentRecord (created) → usuário paga PIX → webhook assinado
 * → consulta transação → applyPaid → SKU concedido + Subscription ativa.
 */
import { PLAN_SKUS, TRIAL, type PlanCode, type PlanSku } from "@acompanhe/shared";

import type { Entitlements, EntitlementRecord } from "../entitlements.js";
import type { PaymentRecord, PaymentStore } from "../store.js";
import type { PushinpayClient } from "../payments/pushinpay.js";

export type Period = "monthly" | "yearly";

export interface SubscriptionsStore {
  create(s: {
    userId: string;
    planCode: string;
    channel: string;
    startsAt: string;
    endsAt: string;
    autoRenew: string;
    providerRef: string | null;
    status: string;
  }): Promise<{ id: string }>;
  listByUser(userId: string): Promise<Array<{ id: string; planCode: string; status: string; startsAt: string; endsAt: string; channel: string }>>;
}

export class InMemorySubscriptionsStore implements SubscriptionsStore {
  private rows = new Map<string, { id: string; userId: string; planCode: string; channel: string; startsAt: string; endsAt: string; autoRenew: string; providerRef: string | null; status: string }>();
  private seq = 0;

  async create(s: { userId: string; planCode: string; channel: string; startsAt: string; endsAt: string; autoRenew: string; providerRef: string | null; status: string }) {
    const id = `sub_${++this.seq}`;
    this.rows.set(id, { id, ...s });
    return { id };
  }

  async listByUser(userId: string) {
    return [...this.rows.values()].filter((r) => r.userId === userId).map(({ id, planCode, status, startsAt, endsAt, channel }) => ({ id, planCode, status, startsAt, endsAt, channel }));
  }
}

export function planSku(code: string): PlanSku | undefined {
  return PLAN_SKUS.find((p) => p.code === code);
}

export function priceOf(plan: PlanSku, period: Period): number {
  return period === "yearly" ? plan.yearlyCents : plan.monthlyCents;
}

export interface CheckoutResult {
  paymentId: string;
  qrCode: string;
  valueCents: number;
  planCode: string;
  period: Period;
  status: string;
}

export interface AssinaturasDeps {
  payments: PaymentStore;
  entitlements: Entitlements;
  subs: SubscriptionsStore;
  pushinpay: PushinpayClient;
  webhookUrl: string;
  now?: () => Date;
}

export function makeAssinaturasService(deps: AssinaturasDeps) {
  const now = deps.now ?? (() => new Date());

  /** POST /api/assinaturas/checkout — cria cobrança PIX real. */
  async function checkout(userId: string, planCode: string, period: Period, idempotencyKey: string): Promise<CheckoutResult> {
    const plan = planSku(planCode);
    if (!plan) throw new Error("plano desconhecido");
    if (!deps.webhookUrl) throw new Error("PUBLIC_BASE_URL não configurado — checkout indisponível");
    const valueCents = priceOf(plan, period);
    const cash = await deps.pushinpay.cashIn({ valueCents, webhookUrl: deps.webhookUrl, idempotencyKey });
    const record: PaymentRecord = {
      providerIdLower: cash.id,
      amountCents: valueCents,
      currency: "BRL",
      channel: "pushinpay",
      status: "created",
      refType: "subscription",
      refId: planCode,
      userId,
      createdAt: now().toISOString(),
      effectApplied: false,
    };
    await deps.payments.save(record);
    return { paymentId: cash.id, qrCode: cash.qrCode, valueCents, planCode, period, status: cash.status };
  }

  /**
   * Efeito do webhook (já validado/consultado pelo processPushinpayWebhook):
   * concede o SKU do plano + Subscription ativa (30d mensal / 360d anual).
   * Idempotente: effectApplied garante 1 efeito por transação.
   */
  async function applyPaid(providerIdLower: string, paidAt: string): Promise<{ granted: boolean; planCode?: string }> {
    const rec = await deps.payments.findByProviderId(providerIdLower);
    if (!rec || rec.refType !== "subscription" || !rec.refId || !rec.userId) return { granted: false };
    const period: Period = rec.amountCents === priceOf(planSku(rec.refId)!, "yearly") ? "yearly" : "monthly";
    const days = period === "yearly" ? 360 : 30;
    const until = new Date(new Date(paidAt).getTime() + days * 24 * 3600 * 1000).toISOString();
    await deps.entitlements.grant(rec.userId, rec.refId, { expiresAt: until, via: "pushinpay" }, paidAt);
    await deps.subs.create({
      userId: rec.userId,
      planCode: rec.refId,
      channel: "pushinpay",
      startsAt: paidAt,
      endsAt: until,
      autoRenew: "none",
      providerRef: providerIdLower,
      status: "active",
    });
    return { granted: true, planCode: rec.refId };
  }

  /** GET /api/assinaturas — estado do usuário. */
  async function status(userId: string): Promise<{
    entitlement: EntitlementRecord;
    assinaturas: Array<{ id: string; planCode: string; status: string; startsAt: string; endsAt: string; channel: string }>;
    trialDisponivel: boolean;
    trialDias: number;
  }> {
    const entitlement = await deps.entitlements.get(userId);
    return {
      entitlement,
      assinaturas: await deps.subs.listByUser(userId),
      trialDisponivel: !entitlement.trialUsedAt,
      trialDias: TRIAL.days,
    };
  }

  /** POST /api/assinaturas/trial — 7d grátis, 1× por usuário (doc 08 §9). */
  async function trial(userId: string, planCode: string) {
    const plan = planSku(planCode);
    if (!plan) throw new Error("plano desconhecido");
    return deps.entitlements.useTrial(userId, TRIAL.days, now(), `${planCode}:trial`);
  }

  return { checkout, applyPaid, status, trial };
}

export type AssinaturasService = ReturnType<typeof makeAssinaturasService>;
export type { PlanCode };
