/**
 * Prova do BD (plano §4) — os stores Prisma persistem ENTRE "restarts"
 * (2 PrismaClients independentes sobre o mesmo Postgres). Sem Postgres
 * disponível o bloco inteiro é pulado com aviso honesto.
 */
import { describe, expect, it } from "vitest";

import { createDb } from "@acompanhe/db";

import { PrismaEntitlements, PrismaLegalStore, PrismaLoanStore, PrismaVerificacaoStore } from "../src/store-prisma.js";

const URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/acompanhe";

async function dbAlive(): Promise<boolean> {
  const db = createDb(URL);
  try {
    await db.$queryRaw`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await db.$disconnect();
  }
}

const alive = await dbAlive();

describe.skipIf(!alive)("store-prisma — persistência real (restart-safe)", () => {
  const uid = `t_${Date.now() % 100000}`;

  it("jurídico: caso+eventos+projeção sobrevivem a um novo client", async () => {
    const a = createDb(URL);
    const s1 = new PrismaLegalStore(a);
    await s1.createCase({
      userId: uid,
      role: "outro",
      alias: "tjmt",
      numeroProcesso: "0006903-69.2014.8.11.0037",
      grau: "",
      classe: "(não consultado)",
      assunto: null,
      orgaoJulgador: "(não consultado)",
      orgaoCodigo: null,
      municipioIbge: null,
      dataAjuizamento: "2026-10-23T00:00:00.000Z",
      valorDaCausa: null,
      nivelSigilo: 0,
      status: "desconhecido",
      tribunal: "tjmt",
      ultimoMovimento: null,
      movimentosCount: 0,
      fieldStatus: "pendente",
      raw: null,
    });
    const caso = await s1.getCase(uid, "0006903-69.2014.8.11.0037");
    await s1.appendEvent(caso!.id, { source: "datajud", code: "581", occurredAt: "2024-05-28T19:23:05.000Z", description: "Baixa Definitiva" });
    await s1.appendEvent(caso!.id, { source: "datajud", code: "581", occurredAt: "2024-05-28T19:23:05.000Z", description: "Baixa Definitiva" }); // RB5
    await s1.updateCase(uid, "0006903-69.2014.8.11.0037", { classe: "Apelação Cível", movimentosCount: 1 });
    await a.$disconnect();

    const b = createDb(URL);
    const s2 = new PrismaLegalStore(b);
    const depois = await s2.getCase(uid, "0006903-69.2014.8.11.0037");
    expect(depois!.classe).toBe("Apelação Cível");
    expect(depois!.movimentosCount).toBe(1);
    expect((await s2.listEvents(depois!.id)).length).toBe(1); // dedupe RB5 persistido
    await b.$disconnect();
  });

  it("empréstimos: pedido+match+rodadas+pagamento sobrevivem", async () => {
    const a = createDb(URL);
    const s1 = new PrismaLoanStore(a);
    await s1.createRequest({
      id: `lr_${uid}`,
      userId: uid,
      uf: "MT",
      valorCents: 30000,
      jurosMesBps: 400,
      meses: 6,
      jurosTipo: "simples",
      motivo: "teste de persistência",
      status: "aberta",
      createdAt: new Date().toISOString(),
      avisoUsura: null,
    });
    await s1.createMatch({
      id: `lm_${uid}`,
      requestId: `lr_${uid}`,
      offerUserId: `${uid}_c`,
      requestUserId: uid,
      status: "pendente",
      rodadas: 0,
      createdAt: new Date().toISOString(),
      expiraEm: new Date(Date.now() + 72 * 3600_000).toISOString(),
    });
    await s1.addRodada(`lm_${uid}`, { by: uid, proposta: "3,5% a.m.", at: new Date().toISOString() });
    await s1.createPayment({
      id: `pay_${uid}`,
      matchId: `lm_${uid}`,
      valorCents: 342857,
      declaredBy: uid,
      confirmadoPor: null,
      status: "declared",
      declaredAt: new Date().toISOString(),
      ttlEm: new Date(Date.now() + 72 * 3600_000).toISOString(),
    });
    await a.$disconnect();

    const b = createDb(URL);
    const s2 = new PrismaLoanStore(b);
    expect((await s2.getRequest(`lr_${uid}`))!.valorCents).toBe(30000);
    expect((await s2.getMatch(`lm_${uid}`))!.status).toBe("pendente");
    expect((await s2.listRodadas(`lm_${uid}`)).length).toBe(1);
    expect((await s2.getPayment(`pay_${uid}`))!.status).toBe("declared");
    expect((await s2.listMatches(uid)).some((m) => m.id === `lm_${uid}`)).toBe(true);
    await b.$disconnect();
  });

  it("verificação + entitlements (trial 1x) sobrevivem", async () => {
    const a = createDb(URL);
    const v1 = new PrismaVerificacaoStore(a);
    await v1.setVerification({ userId: uid, v1Status: "approved", approvedAt: new Date().toISOString() });
    await v1.addSignal({ userId: uid, kind: "tempo_conta", value: 80, at: new Date().toISOString() });
    const e1 = new PrismaEntitlements(a);
    const t1 = await e1.useTrial(uid, 7);
    expect(t1.ok).toBe(true);
    await a.$disconnect();

    const b = createDb(URL);
    const v2 = new PrismaVerificacaoStore(b);
    expect((await v2.getVerification(uid))!.v1Status).toBe("approved");
    expect((await v2.listSignals(uid)).length).toBe(1);
    const e2 = new PrismaEntitlements(b);
    expect((await e2.useTrial(uid, 7)).ok).toBe(false); // 1x só
    expect(await e2.isEntitled(uid, ["investiga:trial"])).toBe(true);
    await b.$disconnect();
  });

  it("RB4: janela de consolidação persiste", async () => {
    const a = createDb(URL);
    const s = new PrismaLegalStore(a);
    expect(await s.lastConsolidation(uid, "tjmt")).toBeNull();
    await s.setConsolidation(uid, "tjmt", "2026-10-23T22:00:00.000Z");
    await a.$disconnect();
    const b = createDb(URL);
    expect(await new PrismaLegalStore(b).lastConsolidation(uid, "tjmt")).toBe("2026-10-23T22:00:00.000Z");
    await b.$disconnect();
  });
});
