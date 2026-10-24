/**
 * Config + auth do Telegram — correções do bug apontado no print do E2E 24/10:
 * sem BOT_TOKEN a config caía num placeholder silencioso e o /api/auth/telegram
 * respondia "initData inválido" culpando o usuário.
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { loadConfig } from "../src/config.js";
import { verifyTelegramInitData } from "../src/security/telegram-initdata.js";
import { buildApp } from "../src/server.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";

const base = {
  JWT_SECRET: "test-secret-0123456789abcdef",
  PUSHINPAY_WEBHOOK_SECRET: "whsec",
  NODE_ENV: "test",
  ADMIN_TOKEN: "adm-tok",
} as NodeJS.ProcessEnv;

describe("loadConfig — BOT_TOKEN nunca mais quebra auth em silêncio", () => {
  it("alias TELEGRAM_BOT_TOKEN é aceito (compat .env histórico)", () => {
    const c = loadConfig({ ...base, TELEGRAM_BOT_TOKEN: "123456789:ALIAS_TOKEN_AAA-BBB" } as NodeJS.ProcessEnv);
    expect(c.BOT_TOKEN).toBe("123456789:ALIAS_TOKEN_AAA-BBB");
  });

  it("BOT_TOKEN direto continua valendo", () => {
    const c = loadConfig({ ...base, BOT_TOKEN: "123456789:DIRETO_TOKEN_AAA" } as NodeJS.ProcessEnv);
    expect(c.BOT_TOKEN).toBe("123456789:DIRETO_TOKEN_AAA");
  });

  it("produção sem token: recusa subir (fail fast, sem placeholder)", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toThrow(/TELEGRAM_BOT_TOKEN|BOT_TOKEN/);
  });

  it("desenvolvimento sem token: placeholder reconhecível (rota responde 503 honesto)", () => {
    const c = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(c.BOT_TOKEN.startsWith("000000000:DEV_PLACEHOLDER")).toBe(true);
  });
});

describe("verifyTelegramInitData — HMAC exato do Telegram (WebAppData)", () => {
  it("hash assinado com o token certo valida; token errado reprova", () => {
    const token = "123456789:REAL_TOKEN_AAA-BBB";
    const user = JSON.stringify({ id: 42, first_name: "T" });
    const params: Record<string, string> = { auth_date: "1800000000", query_id: "AA", user };
    const dcs = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("\n");
    const secret = createHmac("sha256", "WebAppData").update(token).digest();
    const hash = createHmac("sha256", secret).update(dcs).digest("hex");
    const initData = new URLSearchParams({ ...params, hash }).toString();

    const ok = verifyTelegramInitData(initData, token, { maxAgeSec: 10_000_000, nowSec: 1_800_000_001 });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("esperava ok=true");
    expect(ok.user?.id).toBe(42);

    const bad = verifyTelegramInitData(initData, "123456789:OUTRO_TOKEN", { maxAgeSec: 10_000_000, nowSec: 1_800_000_001 });
    expect(bad.ok).toBe(false);
  });
});

describe("POST /api/auth/telegram — erro honesto de configuração", () => {
  it("sem token real (placeholder): 503 'TELEGRAM_BOT_TOKEN não configurado no servidor'", async () => {
    const config = loadConfig({ ...base } as NodeJS.ProcessEnv); // cai no placeholder
    const app = buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: { initData: "query_id=AA&user=%7B%7D&auth_date=1&hash=deadbeef" },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toContain("TELEGRAM_BOT_TOKEN não configurado");
    await app.close();
  });

  it("com token real e hash errado: 403 'initData inválido' (culpa o cliente mesmo)", async () => {
    const config = loadConfig({ ...base, BOT_TOKEN: "123456789:REAL_TOKEN_AAA-BBB" } as NodeJS.ProcessEnv);
    const app = buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: { initData: "query_id=AA&user=%7B%7D&auth_date=1&hash=deadbeef" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("initData inválido");
    await app.close();
  });
});
