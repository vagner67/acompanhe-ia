/**
 * Teste direto do serviço (sem HTTP) — doc 13, R2.3: despacho
 * `runTarget` por kind com EXEC FAKE por kind, e R3 via serviço.
 */
import { describe, it, expect } from "vitest";

import { loadConfig } from "../src/config.js";
import { InMemoryEntitlementsStore } from "../src/entitlements.js";
import { InvestigaQuotaGate } from "../src/osint/quota.js";
import { OsintStore } from "../src/osint/store.js";
import { HttpError, makeInvestigaService, type TargetChecker, type TargetCheckerMap } from "../src/osint/service.js";
import type { OsintFinding, OsintTargetKind } from "../src/osint/types.js";

const BOT = "123456789:TEST_TOKEN_AAA-BBB";

async function makeService(checkers: TargetCheckerMap = {}) {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "diretor-token",
  } as NodeJS.ProcessEnv);
  const store = new OsintStore();
  const quota = new InvestigaQuotaGate();
  const entitlements = new InMemoryEntitlementsStore();
  await entitlements.grant("u1", "investiga");
  const service = makeInvestigaService({ config, store, quota, entitlements, checkers });
  return { service, store, quota };
}

function sentinel(sourceId: string): TargetChecker {
  return async (target) =>
    ({
      findings: [
        {
          id: `f-${sourceId}`,
          sourceId,
          status: "found" as const,
          retrievedAt: "2026-10-23T10:00:00.000Z",
          raw: { via: target.value },
        },
      ],
    }) satisfies { findings: OsintFinding[] };
}

describe("runTarget — despacho kind → checker com exec fake por kind (doc 13, R2.3)", () => {
  const kinds: Array<{ kind: OsintTargetKind; sourceId: string }> = [
    { kind: "username", sourceId: "sherlock" },
    { kind: "email", sourceId: "hibp" },
    { kind: "phone", sourceId: "libphonenumber" },
    { kind: "domain", sourceId: "rdap" },
  ];

  for (const { kind, sourceId } of kinds) {
    it(`kind "${kind}" despacha para o checker do kind (sentinela ${sourceId})`, async () => {
      const called: string[] = [];
      const spy: TargetChecker = async (target, _opts, _at) => {
        called.push(target.kind);
        return { findings: [{ id: "x", sourceId, status: "found", retrievedAt: "2026-10-23T10:00:00.000Z" }] };
      };
      const { service } = await makeService({ [kind]: spy } as TargetCheckerMap);
      const rec = await service.createCase("u1", {
        title: "caso dispatcher",
        targets: [{ kind, value: "octocat" }],
        legalBasis: "execução de contrato (LGPD art. 7º, V)",
        purpose: "teste de despacho por kind",
      });
      const out = await service.runCase("u1", rec.id, {});
      expect(called).toEqual([kind]);
      expect(out.findings.map((f) => f.sourceId)).toEqual([sourceId]);
      expect(out.checks).toHaveLength(1);
    });
  }

  it("kind name → unknown honesto (sem fonte real; nenhum checker chamado)", async () => {
    const { service } = await makeService({
      username: sentinel("sherlock"),
      email: sentinel("hibp"),
      phone: sentinel("libphonenumber"),
      domain: sentinel("rdap"),
    });
    const rec = await service.createCase("u1", {
      title: "caso name",
      targets: [{ kind: "name", value: "Fulano" }],
      legalBasis: "execução de contrato (LGPD art. 7º, V)",
      purpose: "teste de alvo sem fonte",
    });
    const out = await service.runCase("u1", rec.id, {});
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.status).toBe("unknown");
    expect(out.findings[0]?.sourceId).toBe("s1-no-source");
    expect(String((out.findings[0]?.raw as { note?: string }).note)).toContain("não inventar");
  });

  it("checkId é carimbado em todo achado do run (orquestração)", async () => {
    const { service } = await makeService({ username: sentinel("sherlock") });
    const rec = await service.createCase("u1", {
      title: "caso checkid",
      targets: [{ kind: "username", value: "octocat" }],
      legalBasis: "execução de contrato (LGPD art. 7º, V)",
      purpose: "teste de checkId",
    });
    const out = await service.runCase("u1", rec.id, {});
    expect(out.findings[0]?.checkId).toBe(out.checks[0]?.id);
  });

  it("falha de checker → HttpError 500 + quota estornada + resto unknown (R3 pelo serviço)", async () => {
    const boom: TargetChecker = async () => {
      throw new Error("explodiu");
    };
    const { service, quota } = await makeService({ username: boom });
    const rec = await service.createCase("u1", {
      title: "caso falha",
      targets: [
        { kind: "username", value: "octocat" },
        { kind: "username", value: "octocat2" },
      ],
      legalBasis: "execução de contrato (LGPD art. 7º, V)",
      purpose: "teste de falha",
    });
    await expect(service.runCase("u1", rec.id, {})).rejects.toBeInstanceOf(HttpError);
    const detail = await service.getDetail("u1", rec.id);
    expect(detail.case.status).toBe("error");
    expect(quota.window("u1", new Date().toISOString().slice(0, 10)).used).toBe(0);
    expect(
      detail.findings.some((f) => f.status === "unknown" && String(f.summary).includes("coleta interrompida")),
    ).toBe(true);
  });
});
