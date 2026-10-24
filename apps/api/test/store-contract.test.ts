/**
 * Contrato de store (plano.md §6.1.3 / doc 12 F0.3) — A MESMA suíte roda
 * contra o OsintStore (memória) e contra o PrismaStore (Postgres real), com os
 * mesmos asserts. Se os dois divergirem, o contrato quebrou.
 *
 * + teste de RESTART (F0.1): dois PrismaStore consecutivos sobre o mesmo banco
 *   devolvem o mesmo caso/achados/alertas — o que a memória não garante.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import { createDb } from "@acompanhe/db";

import { OsintStore, type InvestigaStore } from "../src/osint/store.js";
import { PrismaStore } from "../src/osint/prisma-store.js";
import type {
  MonitorAlert,
  OsintCheck,
  OsintFinding,
} from "../src/osint/types.js";

const TEST_URL =
  process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:postgres@127.0.0.1:5432/acompanhe_test";

const now = () => "2026-10-23T12:00:00.000Z";

const caseInput = {
  subjectId: "u1",
  title: "caso contrato",
  targets: [
    { kind: "username" as const, value: "octocat" },
    { kind: "email" as const, value: "test@example.com", label: "e-mail alvo" },
  ],
  legalBasis: "LGPD art. 7º, V — exercício regular de direitos",
  purpose: "verificar presença pública do alvo",
  createdBy: "u1",
};

const confidence = {
  score: 65,
  band: "média" as const,
  factors: { sourceClass: "ugc" as const, corroborations: 0, ageDays: 0, statusKnown: true },
};

type OptionalUndefined<T> = { [K in keyof T]?: T[K] | undefined };

function makeFinding(over: OptionalUndefined<OsintFinding> = {}): OsintFinding {
  return {
    id: randomUUID(),
    sourceId: "sherlock",
    status: "found",
    summary: "@octocat encontrado em GitHub",
    evidenceUrl: "https://www.github.com/octocat",
    retrievedAt: now(),
    raw: { siteName: "GitHub", exists: "Claimed" },
    confidence,
    ...over,
  } as OsintFinding;
}

function makeCheck(caseId: string, over: OptionalUndefined<OsintCheck> = {}): OsintCheck {
  return {
    id: randomUUID(),
    caseId,
    target: { kind: "username", value: "octocat" },
    legalBasis: caseInput.legalBasis,
    purpose: caseInput.purpose,
    quotaConsumed: 1,
    status: "completed",
    executedAt: now(),
    ...over,
  } as OsintCheck;
}

function makeAlert(caseId: string, over: OptionalUndefined<MonitorAlert> = {}): MonitorAlert {
  return {
    id: randomUUID(),
    caseId,
    kind: "status_changed",
    sourceId: "sherlock",
    targetKey: "sherlock:Cracked Forum",
    detail: "MUDOU: sherlock:Cracked Forum not_found → found",
    createdAt: now(),
    raw: { from: "not_found", to: "found" },
    ...over,
  } as MonitorAlert;
}

const db = createDb(TEST_URL);

async function cleanOsint(): Promise<void> {
  await db.osintAlert.deleteMany();
  await db.osintFinding.deleteMany();
  await db.osintCheck.deleteMany();
  await db.osintCase.deleteMany();
}

beforeAll(async () => {
  await db.$queryRaw`SELECT 1`; // Postgres real ou falha ruidosamente — sem skip
});
afterAll(async () => {
  await cleanOsint();
  await db.$disconnect();
});

const impls: Array<{ name: string; make: () => InvestigaStore; prisma: boolean }> = [
  { name: "OsintStore (memória)", make: () => new OsintStore(), prisma: false },
  { name: "PrismaStore (Postgres)", make: () => new PrismaStore(db), prisma: true },
];

for (const impl of impls) {
  describe(`contrato InvestigaStore — ${impl.name}`, () => {
    beforeEach(async () => {
      if (impl.prisma) await cleanOsint();
    });

    it("createCase → getCase faz round-trip exato do contrato", async () => {
      const store = impl.make();
      const rec = await store.createCase({ ...caseInput, now });
      const got = await store.getCase(rec.id);
      expect(got).toEqual(rec);
      expect(got?.targets).toHaveLength(2);
      expect(got?.status).toBe("draft");
    });

    it("listCasesBySubject isola por dono e ordena createdAt DESC", async () => {
      const store = impl.make();
      const a = await store.createCase({ ...caseInput, title: "primeiro", now: () => "2026-10-23T10:00:00.000Z" });
      const b = await store.createCase({ ...caseInput, title: "segundo", now: () => "2026-10-23T11:00:00.000Z" });
      await store.createCase({ ...caseInput, subjectId: "outro", title: "alheio" });
      const list = await store.listCasesBySubject("u1");
      expect(list.map((c) => c.title)).toEqual(["segundo", "primeiro"]);
      expect(list.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    });

    it("updateCaseStatus atualiza e devolve undefined para id inexistente", async () => {
      const store = impl.make();
      const rec = await store.createCase({ ...caseInput, now });
      const upd = await store.updateCaseStatus(rec.id, "completed", "2026-10-23T13:00:00.000Z");
      expect(upd?.status).toBe("completed");
      expect(upd?.updatedAt).toBe("2026-10-23T13:00:00.000Z");
      expect(await store.updateCaseStatus(randomUUID(), "completed")).toBeUndefined();
    });

    it("addCheck é upsert por id e lista por executedAt ASC", async () => {
      const store = impl.make();
      const rec = await store.createCase({ ...caseInput, now });
      const c1 = makeCheck(rec.id, { executedAt: "2026-10-23T12:00:00.000Z" });
      const c2 = makeCheck(rec.id, { executedAt: "2026-10-23T13:00:00.000Z" });
      await store.addCheck(c2);
      await store.addCheck(c1);
      await store.addCheck({ ...c1, status: "error" }); // upsert: mesmo id
      const list = await store.listChecksByCase(rec.id);
      expect(list.map((c) => c.id)).toEqual([c1.id, c2.id]);
      expect(list[0]!.status).toBe("error");
    });

    it("updateCheckStatus sem error MANTÉM o erro anterior (semântica do Map)", async () => {
      const store = impl.make();
      const rec = await store.createCase({ ...caseInput, now });
      const c = makeCheck(rec.id);
      await store.addCheck(c);
      await store.updateCheckStatus(c.id, "error", "falha na coleta");
      const same = await store.updateCheckStatus(c.id, "completed");
      expect(same?.error).toBe("falha na coleta");
      expect(same?.status).toBe("completed");
      const explicit = await store.updateCheckStatus(c.id, "error", "outra");
      expect(explicit?.error).toBe("outra");
      expect(await store.updateCheckStatus(randomUUID(), "completed")).toBeUndefined();
    });

    it("findings: round-trip de raw/confidence; lista por ordem de inserção", async () => {
      const store = impl.make();
      const rec = await store.createCase({ ...caseInput, now });
      const c = makeCheck(rec.id);
      await store.addCheck(c);
      const f1 = makeFinding({ checkId: c.id, summary: undefined, evidenceUrl: undefined, raw: undefined, confidence: undefined });
      const f2 = makeFinding({ checkId: c.id });
      await store.addFindings([f1, f2]);
      const byCheck = await store.listFindingsByCheck(c.id);
      expect(byCheck.map((f) => f.id)).toEqual([f1.id, f2.id]);
      expect(byCheck[0]!.raw).toBeUndefined();
      expect(byCheck[0]!.confidence).toBeUndefined();
      expect(byCheck[1]!.raw).toEqual({ siteName: "GitHub", exists: "Claimed" });
      expect(byCheck[1]!.confidence).toEqual(confidence);
    });

    it("listFindingsForCase inclui findings por checkId E inferências por caseId", async () => {
      const store = impl.make();
      const rec = await store.createCase({ ...caseInput, now });
      const c = makeCheck(rec.id);
      await store.addCheck(c);
      const viaCheck = makeFinding({ checkId: c.id });
      const inference = makeFinding({ caseId: rec.id, sourceId: "correlation", inference: true });
      await store.addFindings([viaCheck, inference]);
      const all = await store.listFindingsForCase(rec.id);
      expect(all.map((f) => f.id)).toEqual([viaCheck.id, inference.id]);
    });

    it("addAlerts é upsert e lista por createdAt DESC", async () => {
      const store = impl.make();
      const rec = await store.createCase({ ...caseInput, now });
      const a1 = makeAlert(rec.id, { createdAt: "2026-10-23T12:00:00.000Z" });
      const a2 = makeAlert(rec.id, { createdAt: "2026-10-23T14:00:00.000Z" });
      await store.addAlerts([a1, a2, { ...a1, detail: "editado" }]);
      const list = await store.listAlertsByCase(rec.id);
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.id)).toEqual([a2.id, a1.id]);
      expect(list[1]!.detail).toBe("editado");
    });

    it("replaceInferencesForCase troca só inferências; replaceFindingsForCase limpa as do caso", async () => {
      const store = impl.make();
      const rec = await store.createCase({ ...caseInput, now });
      const c = makeCheck(rec.id);
      await store.addCheck(c);
      const raw = makeFinding({ checkId: c.id });
      const inf1 = makeFinding({ caseId: rec.id, sourceId: "correlation", inference: true });
      await store.addFindings([raw, inf1]);

      const inf2 = makeFinding({ caseId: rec.id, sourceId: "correlation", inference: true });
      await store.replaceInferencesForCase(rec.id, [inf2]);
      let all = await store.listFindingsForCase(rec.id);
      expect(all.map((f) => f.id).sort()).toEqual([raw.id, inf2.id].sort());

      const replacement = makeFinding({ checkId: c.id, summary: "substituto" });
      await store.replaceFindingsForCase(rec.id, [replacement]);
      all = await store.listFindingsForCase(rec.id);
      expect(all.map((f) => f.id)).toEqual([replacement.id]);
      expect(all[0]!.summary).toBe("substituto");
    });
  });
}

describe("RESTART (doc 12 F0.1) — PrismaStore sobrevive a restart", () => {
  beforeEach(cleanOsint);

  it("dois PrismaStore consecutivos sobre o mesmo DB devolvem o mesmo caso/achados/alertas", async () => {
    const store1 = new PrismaStore(createDb(TEST_URL));
    const rec = await store1.createCase({ ...caseInput, now });
    const c = makeCheck(rec.id);
    await store1.addCheck(c);
    const f = makeFinding({ checkId: c.id });
    const a = makeAlert(rec.id);
    await store1.addFindings([f]);
    await store1.addAlerts([a]);

    // "restart": instância e conexões NOVAS, mesmo banco.
    const store2 = new PrismaStore(createDb(TEST_URL));
    expect(await store2.getCase(rec.id)).toEqual(await store1.getCase(rec.id));
    expect(await store2.listFindingsForCase(rec.id)).toEqual([f]);
    expect(await store2.listAlertsByCase(rec.id)).toEqual([a]);
    expect(await store2.listChecksByCase(rec.id)).toEqual([c]);
  });
});
