/**
 * Instância E2E de teste (23/10/2026) — NÃO é o app de produção.
 *
 * Mesma aplicação real (buildApp), porta 3001, com UMA pré-condição de teste:
 * o estado de verificação V1 do usuário de teste já aprovado — equivalente ao
 * resultado do processo humano de verificação. Feito assim porque NÃO EXISTE
 * rota de aprovação de V1 no produto (lacuna real encontrada pelo E2E).
 * Exige E2E_USER_ID (sub do JWT emitido por /api/auth/telegram).
 */
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";
import { InMemoryLoanStore } from "../src/emprestimos/service.js";
import { InMemoryVerificacaoStore } from "../src/emprestimos/verificacao.js";

const config = loadConfig(process.env as NodeJS.ProcessEnv);
const userIds = (process.env.E2E_USER_ID ?? "9").split(",");

const verificacao = new InMemoryVerificacaoStore();
for (const userId of userIds) {
  await verificacao.setVerification({
    userId,
    v1Status: "approved",
    approvedAt: new Date().toISOString(),
  });
}
const userId = userIds[0]!;
const store = new InMemoryLoanStore();

const app = buildApp({
  config,
  payments: new InMemoryPaymentStore(),
  pushinpay: new PushinpayClient(config.PUSHINPAY_API_BASE, config.PUSHINPAY_TOKEN || "e2e-token"),
  emprestimos: { store, verificacao },
});

await app.listen({ port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" });
console.log(`E2E loans server :3001 — V1 pré-aprovado para userId=${userId}`);
