import { PRODUCT_LIMITS } from "@acompanhe/shared";
import type { PaymentStore } from "../store.js";

/**
 * Pushin Pay — doc 08 §2/§3 (fatos verificados 21/10/2026).
 * - POST /api/pix/cashIn (value em CENTAVOS, webhook_url) → {id, qr_code EMV, status}
 * - GET /api/transactions/{id} — id volta MINÚSCULO na criação e MAIÚSCULO na consulta (PR #68)
 * - webhook sem secret configurado = QUALQUER UM marca como paga (GitHub bokashipay)
 *   ⇒ FAIL-CLOSED: 503 e nada muda.
 * - "paid" só com consulta confirmando status paid E value == amount (doc 08 §3).
 * - valor mínimo 50 centavos (rejeitar antes do 422).
 */

export function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase();
}

/** ids da Pushin Pay são caixa-insensíveis, mas a API espera MAIÚSCULO na consulta */
export function consultationId(id: string): string {
  return id.trim().toUpperCase();
}

export interface CashInInput {
  valueCents: number;
  webhookUrl: string;
  idempotencyKey: string;
}

export interface CashInResult {
  id: string;
  qrCode: string;
  status: string;
  value: number;
}

export interface TransactionView {
  id: string;
  status: "created" | "processing" | "paid" | "expired";
  value: number;
}

export interface PushinpayClient {
  cashIn(input: CashInInput): Promise<CashInResult>;
  transaction(id: string): Promise<TransactionView | null>;
}

export class PushinpayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PushinpayClient implements PushinpayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async cashIn(input: CashInInput): Promise<CashInResult> {
    if (input.valueCents < PRODUCT_LIMITS.MIN_PUSHINPAY_VALUE_CENTS) {
      throw new PushinpayHttpError(422, `valor mínimo é ${PRODUCT_LIMITS.MIN_PUSHINPAY_VALUE_CENTS} centavos`);
    }
    const res = await this.fetchFn(`${this.baseUrl}/api/pix/cashIn`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({ value: input.valueCents, webhook_url: input.webhookUrl }),
    });
    if (!res.ok) throw new PushinpayHttpError(res.status, `cashIn falhou: ${res.status}`);
    const body = (await res.json()) as { id: string; qr_code: string; status: string; value: number };
    return { id: normalizeProviderId(body.id), qrCode: body.qr_code, status: body.status, value: body.value };
  }

  async transaction(id: string): Promise<TransactionView | null> {
    const res = await this.fetchFn(`${this.baseUrl}/api/transactions/${consultationId(id)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new PushinpayHttpError(res.status, `transaction falhou: ${res.status}`);
    const body = (await res.json()) as { id: string; status: string; value: number };
    return {
      id: normalizeProviderId(body.id),
      status: body.status as TransactionView["status"],
      value: Number(body.value),
    };
  }
}

export type WebhookOutcome =
  | { httpStatus: 200; effect: "none" | "released" | "already_released" | "investigation"; detail: string }
  | { httpStatus: 400 | 401 | 503; effect: "none"; detail: string };

export interface WebhookDeps {
  secretConfigured: boolean;
  secretExpected: string;
  store: PaymentStore;
  /** Superfície mínima usada pelo webhook (fica injetável em teste). */
  client: Pick<PushinpayClient, "cashIn" | "transaction">;
  /** criar registro em `created` se não existir (vem do cashIn do fluxo de cobrança) */
  expectedAmountCents?: (providerIdLower: string) => Promise<number | null>;
}

/**
 * Processador do webhook — doc 08 §3 + Gherkin §7.
 * Duplo webhook = 1 liberação (effectApplied). Value divergente = investigação, NUNCA libera.
 */
export async function processPushinpayWebhook(
  rawBody: unknown,
  headers: Record<string, string | undefined>,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  // 1. fail-closed: sem secret configurado, rejeita (503) — nada muda
  if (!deps.secretConfigured || !deps.secretExpected) {
    return { httpStatus: 503, effect: "none", detail: "webhook secret não configurado (fail-closed)" };
  }

  // 2. header custom do painel Pushin Pay (doc 08 §3)
  const provided = headers["x-pushinpay-webhook-secret"] ?? headers["pushinpay-webhook-secret"];
  if (!provided || !constantTimeEqual(provided, deps.secretExpected)) {
    return { httpStatus: 401, effect: "none", detail: "assinatura do webhook inválida" };
  }

  // 3. payload com Zod
  const parsed = parseWebhookBody(rawBody);
  if (!parsed.ok) return { httpStatus: 400, effect: "none", detail: parsed.error };

  const idLower = normalizeProviderId(parsed.id);

  // 4. idempotência: efeito já aplicado → 200 sem novo efeito
  const existing = await deps.store.findByProviderId(idLower);
  if (existing?.effectApplied) {
    return { httpStatus: 200, effect: "already_released", detail: "pagamento já liquidado (idempotente)" };
  }
  if (existing?.status === "investigation") {
    return { httpStatus: 200, effect: "investigation", detail: "já em investigação" };
  }

  const record = existing ?? {
    providerIdLower: idLower,
    amountCents: (await deps.expectedAmountCents?.(idLower)) ?? 0,
    currency: "BRL" as const,
    channel: "pushinpay" as const,
    status: "created" as const,
    createdAt: new Date().toISOString(),
    effectApplied: false,
  };
  await deps.store.save(record);

  // 5. status do evento: só "paid" interessa; created/processing/expired = só registra
  if (parsed.status !== "paid") {
    await deps.store.save({ ...record, status: parsed.status === "expired" ? "expired" : "processing" });
    return { httpStatus: 200, effect: "none", detail: `status ${parsed.status} registrado` };
  }

  // 6. "paid" exige CONFIRMAÇÃO na API + valor conferido (doc 08 §3) — webhook sozinho nunca
  const confirmed = await deps.client.transaction(idLower).catch(() => null);
  if (!confirmed || confirmed.status !== "paid") {
    return { httpStatus: 200, effect: "none", detail: "paid não confirmado na consulta — aguardando polling" };
  }

  const expected = record.amountCents || (await deps.expectedAmountCents?.(idLower)) || 0;
  if (expected <= 0 || confirmed.value !== expected) {
    await deps.store.flagInvestigation(idLower, `value divergente: webhook/consulta ${confirmed.value} ≠ esperado ${expected}`);
    return { httpStatus: 200, effect: "investigation", detail: "valor divergente — investigação, sem liberação" };
  }

  // 7. liberação idempotente
  const released = await deps.store.applyPaidEffect(idLower, new Date().toISOString());
  return {
    httpStatus: 200,
    effect: released ? "released" : "already_released",
    detail: released ? "pagamento confirmado e liquidado" : "já liquidado",
  };
}

function parseWebhookBody(raw: unknown): { ok: true; id: string; status: string } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "body inválido" };
  const body = raw as Record<string, unknown>;
  if (typeof body.id !== "string" || body.id.length === 0) return { ok: false, error: "id ausente" };
  const status = typeof body.status === "string" ? body.status : "";
  if (!["created", "processing", "paid", "expired"].includes(status)) {
    return { ok: false, error: "status inválido" };
  }
  return { ok: true, id: body.id, status };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    Buffer.compare(ba, ba);
    return false;
  }
  return Buffer.compare(ba, bb) === 0; // comparação em bytes; sem early-return por caractere
}
