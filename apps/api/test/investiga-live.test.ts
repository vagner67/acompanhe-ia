/**
 * Teste LIVE (opt-in) — só roda com SHERLOCK_LIVE=1.
 * Executa o BINÁRIO REAL do sherlock (instalado via pip) através da API HTTP
 * completa: buildApp → JWT → criar caso → run → relatório. Nada mockado.
 *
 *   SHERLOCK_LIVE=1 npx vitest run test/investiga-live.test.ts
 */
import { describe, it, expect } from "vitest";

import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { InMemoryEntitlementsStore } from "../src/entitlements.js";
import { JwtService } from "../src/security/jwt.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";

const live = process.env.SHERLOCK_LIVE === "1" ? describe : describe.skip;

live("Investiga LIVE — binário real do sherlock via HTTP", () => {
  it("octocat no GitHub → found com evidenceUrl real", async () => {
    const config = loadConfig({
      BOT_TOKEN: "123456789:TEST_TOKEN_AAA-BBB",
      JWT_SECRET: "test-secret-0123456789abcdef",
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv);
    const entitlements = new InMemoryEntitlementsStore();
    const app = buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
      osint: { entitlements },
    });
    const jwt = new JwtService("test-secret-0123456789abcdef", 3600);
    await entitlements.grant("777001", "investiga");
    const headers = { authorization: `Bearer ${await jwt.issue(777001, "live")}` };

    const created = await app.inject({
      method: "POST",
      url: "/v1/investiga/cases",
      headers,
      payload: {
        title: "Live smoke — octocat",
        targets: [{ kind: "username", value: "octocat" }],
        legalBasis: "execução de contrato (LGPD art. 7º, V)",
        purpose: "smoke test live do motor Sherlock",
      },
    });
    expect(created.statusCode).toBe(201);
    const caseId = created.json().case.id;

    const run = await app.inject({
      method: "POST",
      url: `/v1/investiga/cases/${caseId}/run`,
      headers,
      payload: { sites: ["GitHub"] },
    });
    expect(run.statusCode).toBe(200);
    const finding = run.json().findings.find((f: { sourceId: string }) => f.sourceId === "sherlock");
    expect(finding.status).toBe("found");
    expect(finding.evidenceUrl).toBe("https://www.github.com/octocat");

    const report = await app.inject({ method: "GET", url: `/v1/investiga/cases/${caseId}/report`, headers });
    expect(report.json().report.verdict).toBe("LEAD — verificar manualmente");
  }, 120_000);
});
