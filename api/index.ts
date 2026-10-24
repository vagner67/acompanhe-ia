/**
 * Entrada Vercel Serverless — embolde o Fastify da API (apps/api/src/server.ts).
 * Envs obrigatórias: DATABASE_URL (Neon), JWT_SECRET, ADMIN_TOKEN, PUBLIC_BASE_URL,
 * PUSHINPAY_WEBHOOK_SECRET; opcional: PUSHINPAY_TOKEN.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildApp } from "../apps/api/src/server.js";
import { loadConfig } from "../apps/api/src/config.js";
import { InMemoryPaymentStore } from "../apps/api/src/store.js";
import { PushinpayClient } from "../apps/api/src/payments/pushinpay.js";

let appPromise: Promise<ReturnType<typeof buildApp>> | null = null;

function getApp() {
  if (!appPromise) {
    const config = loadConfig();
    const app = buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient(config.PUSHINPAY_API_BASE, config.PUSHINPAY_TOKEN),
    });
    appPromise = app.ready().then(() => app);
  }
  return appPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const app = await getApp();
  app.server.emit("request", req, res);
}
