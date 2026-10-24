/**
 * Dev-auth (arquitetura tgstack: rodar o app em navegador sem Telegram) e
 * health profundo (Postgres). A rota de dev NUNCA existe em produção.
 */
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";

function makeApp(nodeEnv: "development" | "test" | "production", databaseUrl?: string) {
  const config = loadConfig({
    BOT_TOKEN: "123456789:TEST_TOKEN_AAA-BBB",
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: nodeEnv,
    ADMIN_TOKEN: "adm-tok",
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
  } as NodeJS.ProcessEnv);
  return buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
  });
}

describe("dev-auth (mock de navegador, fora do Telegram)", () => {
  it("em test/dev: emite JWT e o token abre /api/me", async () => {
    const app = makeApp("test");
    const res = await app.inject({ method: "POST", url: "/api/auth/telegram/dev", payload: { userId: "dev-42", username: "dev" } });
    expect(res.statusCode).toBe(200);
    const { token, dev } = res.json() as { token: string; dev: boolean };
    expect(dev).toBe(true);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { tgUserId: string }).tgUserId).toBe("dev-42");
  });

  it("em produção a rota não existe (404)", async () => {
    const app = makeApp("production");
    const res = await app.inject({ method: "POST", url: "/api/auth/telegram/dev", payload: { userId: "x" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("health profundo", () => {
  it("sem DATABASE_URL: 200 e db=n/a", async () => {
    const app = makeApp("test");
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { db: string }).db).toBe("n/a");
  });

  it("com Postgres inacessível: 503 e db=down (watchdog/deploy percebem)", async () => {
    const app = makeApp("test", "postgresql://postgres:postgres@127.0.0.1:59999/nao_existe");
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { status: string; db: string }).db).toBe("down");
    expect((res.json() as { status: string }).status).toBe("degraded");
  });
});
