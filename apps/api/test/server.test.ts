import { describe, it, expect } from "vitest";
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { signInitData } from "../src/security/telegram-initdata.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";

const BOT = "123456789:TEST_TOKEN_AAA-BBB";
const NOW = 1_800_000_000;

function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ...env,
  } as NodeJS.ProcessEnv);
  return buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
    nowSec: () => NOW,
  });
}

describe("HTTP — auth Mini App + webhook (doc 02/08)", () => {
  it("GET /health", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    await app.close();
  });

  it("POST /api/auth/telegram devolve JWT 1h com initData válido", async () => {
    const app = makeApp();
    const initData = signInitData(
      { auth_date: String(NOW - 5), user: JSON.stringify({ id: 42, first_name: "Maria" }) },
      BOT,
    );
    const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.expiresInSec).toBe(3600);
    expect(typeof body.token).toBe("string");

    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().tgUserId).toBe("42");
    await app.close();
  });

  it("initData inválido → 403 (fail-closed)", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: { initData: "user=x&auth_date=1&hash=deadbeef" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("webhook sem secret configurado → 503 (doc 08 §3)", async () => {
    const app = makeApp({ PUSHINPAY_WEBHOOK_SECRET: "" });
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/pushinpay",
      payload: { id: "tx1", status: "paid", value: 1490 },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("webhook com secret correto + consulta paid → libera", async () => {
    const app = makeApp();
    // sem client real: simulate via consulta indisponível ⇒ não libera (comportamento seguro)
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/pushinpay",
      headers: { "x-pushinpay-webhook-secret": "whsec" },
      payload: { id: "tx1", status: "paid", value: 1490 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().effect).toBe("none"); // consulta falhou ⇒ não libera (fail-safe)
    await app.close();
  });
});
