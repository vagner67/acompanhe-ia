import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryPaymentStore, type PaymentRecord } from "../src/store.js";
import {
  processPushinpayWebhook,
  normalizeProviderId,
  consultationId,
  type PushinpayClient,
  type TransactionView,
} from "../src/payments/pushinpay.js";

const SECRET = "segredo-super-secreto";
const TX = "abc123-def";

function fakeClient(view: TransactionView | null): Pick<PushinpayClient, "cashIn" | "transaction"> {
  return {
    async cashIn() {
      throw new Error("não usado no teste");
    },
    async transaction() {
      return view;
    },
  };
}

function depsWith(
  client: Pick<PushinpayClient, "cashIn" | "transaction">,
  store = new InMemoryPaymentStore(),
  secret = SECRET,
) {
  return {
    secretConfigured: secret.length > 0,
    secretExpected: secret,
    store,
    client,
    expectedAmountCents: async () => 1490,
  };
}

const paidBody = { id: TX, status: "paid", value: 1490 };

describe("processPushinpayWebhook (doc 08 §3/§7)", () => {
  let store: InMemoryPaymentStore;
  beforeEach(() => {
    store = new InMemoryPaymentStore();
  });

  it("FAIL-CLOSED: sem secret configurado → 503 e nada muda", async () => {
    const res = await processPushinpayWebhook(paidBody, {}, depsWith(fakeClient({ id: TX, status: "paid", value: 1490 }), store, ""));
    expect(res.httpStatus).toBe(503);
    expect(res.effect).toBe("none");
    expect(await store.findByProviderId(TX)).toBeNull();
  });

  it("webhook forjado (header errado) → 401 e nada muda", async () => {
    const res = await processPushinpayWebhook(
      paidBody,
      { "x-pushinpay-webhook-secret": "errado" },
      depsWith(fakeClient({ id: TX, status: "paid", value: 1490 }), store),
    );
    expect(res.httpStatus).toBe(401);
    expect(res.effect).toBe("none");
    expect(await store.findByProviderId(TX)).toBeNull();
  });

  it("libera só com consulta confirmando paid + valor conferido", async () => {
    const res = await processPushinpayWebhook(
      paidBody,
      { "x-pushinpay-webhook-secret": SECRET },
      depsWith(fakeClient({ id: TX, status: "paid", value: 1490 }), store),
    );
    expect(res).toMatchObject({ httpStatus: 200, effect: "released" });
    const row = await store.findByProviderId(TX);
    expect(row?.status).toBe("paid");
    expect(row?.effectApplied).toBe(true);
    expect(row?.amountCents).toBe(1490);
  });

  it("duplo webhook = 1 liberação (idempotente)", async () => {
    const d = depsWith(fakeClient({ id: TX, status: "paid", value: 1490 }), store);
    const first = await processPushinpayWebhook(paidBody, { "x-pushinpay-webhook-secret": SECRET }, d);
    const second = await processPushinpayWebhook(paidBody, { "x-pushinpay-webhook-secret": SECRET }, d);
    expect(first.effect).toBe("released");
    expect(second.effect).toBe("already_released");
  });

  it("valor divergente → investigação, NÃO libera", async () => {
    const res = await processPushinpayWebhook(
      paidBody,
      { "x-pushinpay-webhook-secret": SECRET },
      depsWith(fakeClient({ id: TX, status: "paid", value: 999 }), store),
    );
    expect(res.effect).toBe("investigation");
    const row = await store.findByProviderId(TX);
    expect(row?.status).toBe("investigation");
    expect(row?.effectApplied).toBe(false);
  });

  it("paid no webhook mas não confirmado na consulta → nada libera (aguarda polling)", async () => {
    const res = await processPushinpayWebhook(
      paidBody,
      { "x-pushinpay-webhook-secret": SECRET },
      depsWith(fakeClient(null), store),
    );
    expect(res.effect).toBe("none");
    expect((await store.findByProviderId(TX))?.effectApplied).toBe(false);
  });

  it("status created/processing → só registra, sem efeito", async () => {
    const res = await processPushinpayWebhook(
      { id: TX, status: "created" },
      { "x-pushinpay-webhook-secret": SECRET },
      depsWith(fakeClient({ id: TX, status: "created", value: 1490 }), store),
    );
    expect(res).toMatchObject({ httpStatus: 200, effect: "none" });
    expect((await store.findByProviderId(TX))?.effectApplied).toBe(false);
  });

  it("payload inválido → 400", async () => {
    const res = await processPushinpayWebhook(
      { id: "", status: "hacked" },
      { "x-pushinpay-webhook-secret": SECRET },
      depsWith(fakeClient(null), store),
    );
    expect(res.httpStatus).toBe(400);
  });

  it("ids são normalizados: lower no registro, UPPER na consulta", () => {
    expect(normalizeProviderId("ABC123")).toBe("abc123");
    expect(consultationId("abc123")).toBe("ABC123");
    // registro com id vindo UPPER do webhook bate com o lower do cashIn
    expect(normalizeProviderId(TX.toUpperCase())).toBe(normalizeProviderId(TX));
  });
});

describe("InMemoryPaymentStore", () => {
  it("applyPaidEffect é atômico e idempotente", async () => {
    const store = new InMemoryPaymentStore();
    const rec: PaymentRecord = {
      providerIdLower: "x1",
      amountCents: 500,
      currency: "BRL",
      channel: "pushinpay",
      status: "created",
      createdAt: new Date().toISOString(),
      effectApplied: false,
    };
    await store.save(rec);
    expect(await store.applyPaidEffect("X1", new Date().toISOString())).toBe(true);
    expect(await store.applyPaidEffect("x1", new Date().toISOString())).toBe(false);
  });
});
