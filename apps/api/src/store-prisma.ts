/**
 * Stores Prisma (Postgres) — a camada que tira TODO o produto da memória.
 * Cada classe implementa EXATAMENTE a interface já coberta pelos testes
 * (LoanStore 21 · VerificacaoStore · LegalStore · Entitlements). Comentários
 * referenciam as regras (RB5 dedupe, RB4 janela, A3, RF-E06…).
 */
import { createHash, randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@acompanhe/db";

import type { LegalStore } from "./juridico/service.js";
import type { LegalCaseDto, LegalEventDto } from "./juridico/types.js";
import type { LoanStore, LoanRequestDto, LoanMatchDto, PaymentDto } from "./emprestimos/service.js";
import type { VerificacaoStore, UserVerification, TrustSignal } from "./emprestimos/verificacao.js";
import type { Entitlements, EntitlementRecord } from "./entitlements.js";
import type { PaymentRecord, PaymentStore } from "./store.js";
import type { SubscriptionsStore } from "./assinaturas/service.js";
import type { AdminStore, AdminRole, AdminUserDto, AuditEntry, RuleRow, FlagRow } from "./admin/service.js";

type Db = PrismaClient;

const iso = (d: Date = new Date()): string => d.toISOString();

// ————————————————————————————————— Legal (jurídico) —————————————————————————————————

export class PrismaLegalStore implements LegalStore {
  constructor(private db: Db) {}

  async createCase(
    c: LegalCaseDto & { userId: string; role: string; alias: string | null },
  ): Promise<{ id: string; created: boolean }> {
    const prev = await this.db.legalCase.findUnique({
      where: { userId_cnj: { userId: c.userId, cnj: c.numeroProcesso } },
    });
    if (prev) return { id: prev.id, created: false };
    const row = await this.db.legalCase.create({
      data: {
        userId: c.userId,
        cnj: c.numeroProcesso,
        role: c.role,
        alias: c.alias,
        sigilo: c.nivelSigilo,
        grau: c.grau,
        classe: c.classe,
        assunto: c.assunto,
        orgaoJulgador: c.orgaoJulgador,
        orgaoCodigo: c.orgaoCodigo,
        municipioIbge: c.municipioIbge,
        dataAjuizamento: c.dataAjuizamento,
        valorDaCausa: c.valorDaCausa,
        status: c.status,
        tribunal: c.tribunal,
        ultimoMovimento: c.ultimoMovimento == null ? Prisma.DbNull : (c.ultimoMovimento as object),
        movimentosCount: c.movimentosCount,
        fieldStatus: c.fieldStatus,
        alertasAtivos: c.alertasAtivos ?? false,
        raw: c.raw == null ? Prisma.DbNull : (c.raw as object),
        createdAt: iso(),
        updatedAt: iso(),
      },
    });
    return { id: row.id, created: true };
  }

  async getCase(
    userId: string,
    numeroProcesso: string,
  ): Promise<(LegalCaseDto & { id: string; userId: string; role: string }) | undefined> {
    const row = await this.db.legalCase.findUnique({
      where: { userId_cnj: { userId, cnj: numeroProcesso } },
    });
    return row ? rowToLegal(row) : undefined;
  }

  async updateCase(userId: string, numeroProcesso: string, patch: Partial<LegalCaseDto>): Promise<void> {
    await this.db.legalCase.updateMany({
      where: { userId, cnj: numeroProcesso },
      data: {
        ...(patch.grau !== undefined ? { grau: patch.grau } : {}),
        ...(patch.classe !== undefined ? { classe: patch.classe } : {}),
        ...(patch.assunto !== undefined ? { assunto: patch.assunto } : {}),
        ...(patch.orgaoJulgador !== undefined ? { orgaoJulgador: patch.orgaoJulgador } : {}),
        ...(patch.orgaoCodigo !== undefined ? { orgaoCodigo: patch.orgaoCodigo } : {}),
        ...(patch.municipioIbge !== undefined ? { municipioIbge: patch.municipioIbge } : {}),
        ...(patch.dataAjuizamento !== undefined ? { dataAjuizamento: patch.dataAjuizamento } : {}),
        ...(patch.valorDaCausa !== undefined ? { valorDaCausa: patch.valorDaCausa } : {}),
        ...(patch.nivelSigilo !== undefined ? { sigilo: patch.nivelSigilo } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.tribunal !== undefined ? { tribunal: patch.tribunal } : {}),
        ...(patch.ultimoMovimento !== undefined ? { ultimoMovimento: patch.ultimoMovimento === null ? Prisma.DbNull : (patch.ultimoMovimento as object) } : {}),
        ...(patch.movimentosCount !== undefined ? { movimentosCount: patch.movimentosCount } : {}),
        ...(patch.fieldStatus !== undefined ? { fieldStatus: patch.fieldStatus } : {}),
        ...(patch.alertasAtivos !== undefined ? { alertasAtivos: patch.alertasAtivos } : {}),
        ...(patch.raw !== undefined ? { raw: patch.raw === null ? Prisma.DbNull : (patch.raw as object) } : {}),
        updatedAt: iso(),
      },
    });
  }

  async listCases(userId: string): Promise<Array<LegalCaseDto & { id: string }>> {
    const rows = await this.db.legalCase.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => rowToLegal(r));
  }

  async appendEvent(
    caseId: string,
    ev: { source: string; code: string | null; occurredAt: string; description: string; raw?: unknown },
  ): Promise<{ id: string; inserted: boolean }> {
    const h =
      ev.code != null
        ? createHash("sha256").update(`${caseId}|${ev.code}|${ev.occurredAt}`).digest("hex")
        : `nocode_${randomUUID()}`;
    try {
      const r = await this.db.legalEvent.create({
        data: {
          caseId,
          source: ev.source,
          code: ev.code,
          occurredAt: ev.occurredAt,
          description: ev.description,
          raw: ev.raw == null ? Prisma.DbNull : (ev.raw as object),
          dedupeHash: h,
          createdAt: iso(),
        },
      });
      return { id: String(r.id), inserted: true };
    } catch {
      return { id: h, inserted: false }; // RB5 — corrida/duplicata
    }
  }

  async listEvents(caseId: string): Promise<LegalEventDto[]> {
    const rows = await this.db.legalEvent.findMany({ where: { caseId }, orderBy: { occurredAt: "asc" } });
    return rows.map((r) => ({
      numeroProcesso: "",
      codigo: Number(r.code ?? 0),
      nome: r.description,
      dataHora: r.occurredAt,
      tribunal: r.source,
    }));
  }

  async createAdvice(a: {
    caseId: string | null;
    userId: string;
    question: string;
    oabUser: string | null;
    status: string;
    scheduledAt: string | null;
  }): Promise<{ id: string }> {
    const r = await this.db.legalAdvice.create({
      data: { ...a, createdAt: iso() },
    });
    return { id: r.id };
  }

  async listAdvices(
    userId: string,
  ): Promise<Array<{ id: string; question: string; status: string; oabUser: string | null; answer: string | null }>> {
    const rows = await this.db.legalAdvice.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return rows.map((r) => ({ id: r.id, question: r.question, status: r.status, oabUser: r.oabUser, answer: r.answer }));
  }

  async markAdvice(
    id: string,
    patch: { answer?: string; status?: string; oabUser?: string; pdfSha256?: string },
  ): Promise<void> {
    await this.db.legalAdvice.updateMany({
      where: { id },
      data: {
        ...(patch.answer !== undefined ? { answer: patch.answer } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.oabUser !== undefined ? { oabUser: patch.oabUser } : {}),
        ...(patch.pdfSha256 !== undefined ? { pdfSha256: patch.pdfSha256 } : {}),
      },
    });
  }

  async lastConsolidation(userId: string, tribunal: string): Promise<string | null> {
    const r = await this.db.consolidationWindow.findUnique({
      where: { userId_tribunal: { userId, tribunal } },
    });
    return r?.at ?? null;
  }

  async setConsolidation(userId: string, tribunal: string, at: string): Promise<void> {
    await this.db.consolidationWindow.upsert({
      where: { userId_tribunal: { userId, tribunal } },
      create: { userId, tribunal, at },
      update: { at },
    });
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToLegal(row: any): LegalCaseDto & { id: string; userId: string; role: string } {
  return {
    id: String(row.id),
    userId: row.userId,
    role: row.role,
    numeroProcesso: row.cnj,
    grau: row.grau,
    classe: row.classe,
    assunto: row.assunto,
    orgaoJulgador: row.orgaoJulgador,
    orgaoCodigo: row.orgaoCodigo,
    municipioIbge: row.municipioIbge,
    dataAjuizamento: row.dataAjuizamento,
    valorDaCausa: row.valorDaCausa,
    nivelSigilo: row.sigilo,
    status: row.status,
    tribunal: row.tribunal,
    ultimoMovimento: row.ultimoMovimento ?? null,
    movimentosCount: row.movimentosCount,
    fieldStatus: row.fieldStatus,
    alertasAtivos: row.alertasAtivos ?? false,
    raw: row.raw ?? null,
  };
}

// ————————————————————————————————— Empréstimos —————————————————————————————————

export class PrismaLoanStore implements LoanStore {
  constructor(private db: Db) {}

  async createRequest(r: LoanRequestDto): Promise<void> {
    await this.db.loanRequest.create({
      data: {
        id: r.id,
        userId: r.userId,
        amountCents: r.valorCents,
        purpose: r.motivo,
        termMonths: r.meses,
        maxInterestBps: r.jurosMesBps,
        jurosTipo: r.jurosTipo,
        uf: r.uf,
        status: r.status,
        avisoUsura: r.avisoUsura,
        createdAt: r.createdAt,
      },
    });
  }

  async getRequest(id: string): Promise<LoanRequestDto | undefined> {
    const r = await this.db.loanRequest.findUnique({ where: { id } });
    return r ? requestToDto(r) : undefined;
  }

  async listRequests(filter: { uf?: string }): Promise<LoanRequestDto[]> {
    const rows = await this.db.loanRequest.findMany({
      where: { status: "aberta", ...(filter.uf ? { uf: filter.uf } : {}) },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(requestToDto);
  }

  async createMatch(m: LoanMatchDto): Promise<void> {
    await this.db.loanMatch.create({
      data: {
        id: m.id,
        requestId: m.requestId,
        offerUserId: m.offerUserId,
        requestUserId: m.requestUserId,
        status: m.status,
        rodadas: m.rodadas,
        expiresAt: m.expiraEm,
        createdAt: m.createdAt,
      },
    });
  }

  async getMatch(id: string): Promise<LoanMatchDto | undefined> {
    const r = await this.db.loanMatch.findUnique({ where: { id } });
    return r ? matchToDto(r) : undefined;
  }

  async listMatches(userId: string): Promise<LoanMatchDto[]> {
    const rows = await this.db.loanMatch.findMany({
      where: { OR: [{ requestUserId: userId }, { offerUserId: userId }] },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(matchToDto);
  }

  async updateMatch(id: string, patch: Partial<LoanMatchDto>): Promise<void> {
    await this.db.loanMatch.updateMany({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.rodadas !== undefined ? { rodadas: patch.rodadas } : {}),
        ...(patch.expiraEm !== undefined ? { expiresAt: patch.expiraEm } : {}),
      },
    });
  }

  async addRodada(matchId: string, rodada: { by: string; proposta: string; at: string }): Promise<number> {
    const n = await this.db.loanNegotiation.count({ where: { matchId } });
    await this.db.loanNegotiation.create({
      data: {
        matchId,
        round: n + 1,
        proposedBy: rodada.by,
        payload: { proposta: rodada.proposta },
        createdAt: rodada.at,
      },
    });
    return n + 1;
  }

  async listRodadas(matchId: string): Promise<Array<{ by: string; proposta: string; at: string }>> {
    const rows = await this.db.loanNegotiation.findMany({ where: { matchId }, orderBy: { round: "asc" } });
    return rows.map((r) => ({
      by: r.proposedBy,
      proposta: String((r.payload as { proposta?: string } | null)?.proposta ?? ""),
      at: r.createdAt,
    }));
  }

  async createPayment(p: PaymentDto): Promise<void> {
    await this.db.matchPayment.create({
      data: {
        id: p.id,
        matchId: p.matchId,
        valorCents: p.valorCents,
        declaredBy: p.declaredBy,
        confirmadoPor: p.confirmadoPor,
        status: p.status,
        declaredAt: p.declaredAt,
        ttlEm: p.ttlEm,
      },
    });
  }

  async getPayment(id: string): Promise<PaymentDto | undefined> {
    const r = await this.db.matchPayment.findUnique({ where: { id } });
    return r ? paymentToDto(r) : undefined;
  }

  async updatePayment(id: string, patch: Partial<PaymentDto>): Promise<void> {
    await this.db.matchPayment.updateMany({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.confirmadoPor !== undefined ? { confirmadoPor: patch.confirmadoPor } : {}),
      },
    });
  }

  async listPayments(matchId: string): Promise<PaymentDto[]> {
    const rows = await this.db.matchPayment.findMany({ where: { matchId }, orderBy: { declaredAt: "asc" } });
    return rows.map(paymentToDto);
  }
}

function requestToDto(r: any): LoanRequestDto {
  return {
    id: r.id,
    userId: r.userId,
    uf: r.uf ?? "",
    valorCents: r.amountCents,
    jurosMesBps: r.maxInterestBps ?? 0,
    meses: r.termMonths ?? 0,
    jurosTipo: r.jurosTipo as LoanRequestDto["jurosTipo"],
    motivo: r.purpose,
    status: r.status as LoanRequestDto["status"],
    createdAt: r.createdAt,
    avisoUsura: r.avisoUsura ?? null,
  };
}

function matchToDto(r: any): LoanMatchDto {
  return {
    id: r.id,
    requestId: r.requestId,
    offerUserId: r.offerUserId,
    requestUserId: r.requestUserId,
    status: r.status as LoanMatchDto["status"],
    rodadas: r.rodadas,
    createdAt: r.createdAt,
    expiraEm: r.expiresAt,
  };
}

function paymentToDto(r: any): PaymentDto {
  return {
    id: r.id,
    matchId: r.matchId,
    valorCents: r.valorCents,
    declaredBy: r.declaredBy,
    confirmadoPor: r.confirmadoPor,
    status: r.status as PaymentDto["status"],
    declaredAt: r.declaredAt,
    ttlEm: r.ttlEm,
  };
}

// ————————————————————————————————— Verificação (V1..V4) —————————————————————————————————

export class PrismaVerificacaoStore implements VerificacaoStore {
  constructor(private db: Db) {}

  async getVerification(userId: string): Promise<UserVerification | undefined> {
    const r = await this.db.userVerification.findUnique({ where: { userId } });
    if (!r) return undefined;
    return {
      userId: r.userId,
      v1Status: r.v1Status as UserVerification["v1Status"],
      v2Status: r.v2Status as UserVerification["v1Status"],
      selfieAt: r.selfieAt ? r.selfieAt.toISOString() : null,
      docTipo: r.docTipo,
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      rejectReason: r.rejectReason,
    };
  }

  async listVerifications(status: UserVerification["v1Status"]): Promise<UserVerification[]> {
    const rows = await this.db.userVerification.findMany({ where: { v1Status: status }, orderBy: { updatedAt: "desc" } });
    return rows.map((r) => ({
      userId: r.userId,
      v1Status: r.v1Status as UserVerification["v1Status"],
      v2Status: r.v2Status as UserVerification["v1Status"],
      selfieAt: r.selfieAt ? r.selfieAt.toISOString() : null,
      docTipo: r.docTipo,
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      rejectReason: r.rejectReason,
    }));
  }

  async setVerification(v: UserVerification): Promise<void> {
    await this.db.userVerification.upsert({
      where: { userId: v.userId },
      create: {
        userId: v.userId,
        v1Status: v.v1Status,
        v2Status: v.v2Status ?? "none",
        selfieAt: v.selfieAt ? new Date(v.selfieAt) : null,
        docTipo: v.docTipo ?? null,
        approvedAt: v.approvedAt ? new Date(v.approvedAt) : null,
        rejectReason: v.rejectReason ?? null,
      },
      update: {
        v1Status: v.v1Status,
        ...(v.v2Status !== undefined ? { v2Status: v.v2Status } : {}),
        ...(v.selfieAt !== undefined ? { selfieAt: v.selfieAt ? new Date(v.selfieAt) : null } : {}),
        ...(v.docTipo !== undefined ? { docTipo: v.docTipo ?? null } : {}),
        ...(v.approvedAt !== undefined ? { approvedAt: v.approvedAt ? new Date(v.approvedAt) : null } : {}),
        ...(v.rejectReason !== undefined ? { rejectReason: v.rejectReason ?? null } : {}),
      },
    });
  }

  async addSignal(s: TrustSignal): Promise<void> {
    await this.db.trustSignal.create({ data: { userId: s.userId, kind: s.kind, value: s.value, at: s.at } });
  }

  async listSignals(userId: string): Promise<TrustSignal[]> {
    const rows = await this.db.trustSignal.findMany({ where: { userId }, orderBy: { at: "asc" } });
    return rows.map((r) => ({ userId: r.userId, kind: r.kind as TrustSignal["kind"], value: r.value, at: r.at }));
  }
}

// ————————————————————————————————— Entitlements —————————————————————————————————

export class PrismaEntitlements implements Entitlements {
  constructor(private db: Db) {}

  async get(subjectId: string, now = new Date().toISOString()): Promise<EntitlementRecord> {
    const r = await this.db.entitlement.findUnique({ where: { subjectId } });
    if (!r) return { subjectId, skus: [] };
    const rec: EntitlementRecord = {
      subjectId: r.subjectId,
      skus: (r.skus as string[] | null) ?? [],
    };
    if (r.expiresAt) rec.expiresAt = r.expiresAt.toISOString();
    if (r.trialUsedAt) rec.trialUsedAt = r.trialUsedAt.toISOString();
    if (r.grantedVia) rec.grantedVia = r.grantedVia as NonNullable<EntitlementRecord["grantedVia"]>;
    if (rec.expiresAt && rec.expiresAt < now) return { ...rec, skus: [] };
    return rec;
  }

  async grant(
    subjectId: string,
    sku: string,
    opts: { expiresAt?: string; via?: EntitlementRecord["grantedVia"] } = {},
    now = new Date().toISOString(),
  ): Promise<EntitlementRecord> {
    const current = await this.get(subjectId, now);
    const skus = current.skus.includes(sku) ? current.skus : [...current.skus, sku];
    const expiresAt = opts.expiresAt ?? current.expiresAt;
    const grantedVia = opts.via ?? current.grantedVia;
    await this.db.entitlement.upsert({
      where: { subjectId },
      create: {
        subjectId,
        skus,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        trialUsedAt: current.trialUsedAt ? new Date(current.trialUsedAt) : null,
        grantedVia: grantedVia ?? null,
      },
      update: {
        skus,
        ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt) } : {}),
        ...(grantedVia !== undefined ? { grantedVia } : {}),
      },
    });
    const rec: EntitlementRecord = { subjectId, skus };
    if (expiresAt) rec.expiresAt = expiresAt;
    if (current.trialUsedAt) rec.trialUsedAt = current.trialUsedAt;
    if (grantedVia) rec.grantedVia = grantedVia as NonNullable<EntitlementRecord["grantedVia"]>;
    return rec;
  }

  async useTrial(subjectId: string, trialDays: number, now = new Date(), sku = "investiga:trial"): Promise<{ ok: boolean; record?: EntitlementRecord }> {
    const isoNow = now.toISOString();
    const current = await this.get(subjectId, isoNow);
    if (current.trialUsedAt) return { ok: false };
    const until = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString();
    const skus = [...new Set([...current.skus, sku])];
    const expiresAt = current.expiresAt && current.expiresAt > until ? current.expiresAt : until;
    await this.db.entitlement.upsert({
      where: { subjectId },
      create: { subjectId, skus, expiresAt: new Date(expiresAt), trialUsedAt: now, grantedVia: "trial" },
      update: { skus, expiresAt: new Date(expiresAt), trialUsedAt: now, grantedVia: "trial" },
    });
    return { ok: true, record: { subjectId, skus, expiresAt, trialUsedAt: isoNow, grantedVia: "trial" } };
  }

  async isEntitled(subjectId: string, acceptedSkus: string[], now = new Date().toISOString()): Promise<boolean> {
    const { skus } = await this.get(subjectId, now);
    return skus.some((s) => acceptedSkus.includes(s));
  }
}


// ————————————————————————————————— Pagamentos + Assinaturas —————————————————————————————————

export class PrismaPaymentStore implements PaymentStore {
  constructor(private db: Db, private entitlements: Entitlements, private subs: SubscriptionsStore) {}

  async findByProviderId(providerIdLower: string): Promise<PaymentRecord | null> {
    const r = await this.db.payment.findUnique({ where: { providerId: providerIdLower.toLowerCase() } });
    return r ? paymentRowToRecord(r) : null;
  }

  async save(record: PaymentRecord): Promise<void> {
    const providerId = record.providerIdLower.toLowerCase();
    await this.db.payment.upsert({
      where: { providerId },
      create: {
        userId: record.userId ?? "desconhecido",
        refType: record.refType ?? "avulso",
        refId: record.refId ?? null,
        amountCents: record.amountCents,
        currency: record.currency,
        channel: record.channel,
        providerId,
        providerStatus: record.status,
        idempotencyKey: providerId,
        confirmedAt: record.paidAt ? new Date(record.paidAt) : null,
        createdAt: new Date(record.createdAt),
      },
      update: {
        providerStatus: record.status,
        ...(record.paidAt ? { confirmedAt: new Date(record.paidAt) } : {}),
      },
    });
  }

  /** Efeito "released": marca pago + concede SKU + cria Subscription (idempotente). */
  async applyPaidEffect(providerIdLower: string, paidAt: string): Promise<boolean> {
    const providerId = providerIdLower.toLowerCase();
    const row = await this.db.payment.findUnique({ where: { providerId } });
    if (!row) return false;
    if (row.providerStatus === "paid") return false;
    await this.db.payment.update({ where: { providerId }, data: { providerStatus: "paid", confirmedAt: new Date(paidAt) } });
    if (row.refType === "subscription" && row.refId) {
      const rec = await this.entitlements.get(row.userId);
      const until = new Date(new Date(paidAt).getTime() + 30 * 24 * 3600 * 1000).toISOString();
      await this.entitlements.grant(row.userId, row.refId, { expiresAt: rec.expiresAt && rec.expiresAt > until ? rec.expiresAt : until, via: "pushinpay" }, paidAt);
      await this.subs.create({
        userId: row.userId,
        planCode: row.refId,
        channel: row.channel,
        startsAt: paidAt,
        endsAt: until,
        autoRenew: "none",
        providerRef: providerId,
        status: "active",
      });
    }
    return true;
  }

  async flagInvestigation(providerIdLower: string, reason: string): Promise<void> {
    await this.db.payment.updateMany({
      where: { providerId: providerIdLower.toLowerCase() },
      data: { providerStatus: "investigation", providerPayload: { reason } },
    });
  }

  async listByUser(userId: string): Promise<PaymentRecord[]> {
    const rows = await this.db.payment.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50 });
    return rows.map(paymentRowToRecord);
  }
}

function paymentRowToRecord(r: any): PaymentRecord {
  return {
    providerIdLower: r.providerId,
    amountCents: r.amountCents,
    currency: r.currency,
    channel: r.channel,
    status: r.providerStatus,
    refType: r.refType,
    refId: r.refId ?? undefined,
    userId: r.userId,
    createdAt: r.createdAt.toISOString(),
    paidAt: r.confirmedAt ? r.confirmedAt.toISOString() : undefined,
    effectApplied: r.providerStatus === "paid",
  };
}

export class PrismaSubscriptionsStore implements SubscriptionsStore {
  constructor(private db: Db) {}

  async create(s: {
    userId: string;
    planCode: string;
    channel: string;
    startsAt: string;
    endsAt: string;
    autoRenew: string;
    providerRef: string | null;
    status: string;
  }) {
    const r = await this.db.subscription.create({
      data: {
        userId: s.userId,
        planCode: s.planCode,
        channel: s.channel,
        startsAt: new Date(s.startsAt),
        endsAt: new Date(s.endsAt),
        autoRenew: s.autoRenew,
        providerRef: s.providerRef,
        status: s.status,
      },
    });
    return { id: r.id };
  }

  async listByUser(userId: string) {
    const rows = await this.db.subscription.findMany({ where: { userId }, orderBy: { startsAt: "desc" }, take: 50 });
    return rows.map((r) => ({
      id: r.id,
      planCode: r.planCode,
      status: r.status,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      channel: r.channel,
    }));
  }
}

// (o store antigo de notas/gastos vive agora em src/anota/prisma.ts)

export class PrismaAdminStore implements AdminStore {
  constructor(private db: Db) {}

  async findAdminByEmail(email: string): Promise<(AdminUserDto & { passwordHash: string | null }) | undefined> {
    const r = await this.db.adminUser.findUnique({ where: { email } });
    return r ? { ...adminRowToDto(r), passwordHash: r.passwordHash } : undefined;
  }

  async findAdminById(id: string): Promise<AdminUserDto | undefined> {
    const r = await this.db.adminUser.findUnique({ where: { id } });
    return r ? adminRowToDto(r) : undefined;
  }

  async createAdmin(a: { email: string; name: string; role: AdminRole; passwordHash: string }): Promise<AdminUserDto> {
    const r = await this.db.adminUser.create({
      data: { email: a.email, name: a.name, role: a.role, passwordHash: a.passwordHash, active: true, createdAt: new Date() },
    });
    return adminRowToDto(r);
  }

  async listAdmins(): Promise<AdminUserDto[]> {
    const rows = await this.db.adminUser.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(adminRowToDto);
  }

  async setAdminActive(id: string, active: boolean) {
    await this.db.adminUser.updateMany({ where: { id }, data: { active } });
  }

  async resetPassword(id: string, passwordHash: string) {
    await this.db.adminUser.updateMany({ where: { id }, data: { passwordHash } });
  }

  async auditAppend(e: Omit<AuditEntry, "id">): Promise<AuditEntry> {
    const r = await this.db.auditLog.create({
      data: {
        actorId: e.actorId ?? null,
        actorRole: e.actorRole ?? null,
        action: e.actorId && e.actorRole ? `${e.action}` : e.action,
        target: e.target ?? null,
        before: e.before === null || e.before === undefined ? Prisma.DbNull : (e.before as object),
        after: e.after === null || e.after === undefined ? Prisma.DbNull : (e.after as object),
        ip: e.ip ?? null,
        ts: new Date(e.ts),
        prevHash: e.prevHash ?? null,
        hash: e.hash,
      },
    });
    return { ...e, id: String(r.id) };
  }

  async auditList(limit: number): Promise<AuditEntry[]> {
    const rows = await this.db.auditLog.findMany({ orderBy: { ts: "desc" }, take: limit });
    return rows.map((r) => ({
      id: String(r.id),
      actorId: r.actorId,
      actorRole: r.actorRole ?? null,
      action: r.action,
      target: r.target,
      before: r.before ?? null,
      after: r.after ?? null,
      ip: r.ip,
      ts: r.ts.toISOString(),
      prevHash: r.prevHash,
      hash: r.hash,
    }));
  }

  async auditLastHash() {
    const r = await this.db.auditLog.findFirst({ orderBy: { ts: "desc" }, select: { hash: true } });
    return r?.hash ?? null;
  }

  async rulePut(scope: string, key: string, valueJson: unknown, approvedBy: string | null): Promise<RuleRow> {
    const last = await this.db.rulesConfig.findFirst({ where: { scope, key }, orderBy: { version: "desc" } });
    const r = await this.db.rulesConfig.create({
      data: {
        scope,
        key,
        valueJson: (valueJson as object) ?? {},
        version: (last?.version ?? 0) + 1,
        approvedBy: approvedBy ?? null,
        effectiveAt: new Date(),
      },
    });
    return { id: String(r.id), scope: r.scope, key: r.key, valueJson: r.valueJson, version: r.version, effectiveAt: r.effectiveAt.toISOString(), approvedBy: r.approvedBy ?? null };
  }

  async flagList(): Promise<FlagRow[]> {
    const rows = await this.db.featureFlag.findMany({ orderBy: { updatedAt: "desc" } });
    return rows.map((r) => ({ key: r.key, enabled: r.enabled, payload: r.payload, updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString() }));
  }

  async flagSet(key: string, enabled: boolean, payload: unknown, updatedBy: string): Promise<FlagRow> {
    if (!updatedBy) throw new Error("updatedBy obrigatório (G1)");
    const r = await this.db.featureFlag.upsert({
      where: { key },
      create: { key, enabled, payload: (payload as object) ?? undefined, updatedBy },
      update: { enabled, payload: (payload as object) ?? undefined, updatedBy },
    });
    return { key: r.key, enabled: r.enabled, payload: r.payload, updatedBy: r.updatedBy, updatedAt: r.updatedAt.toISOString() };
  }

  async ruleGet(scope: string, key: string): Promise<RuleRow | undefined> {
    const r = await this.db.rulesConfig.findFirst({ where: { scope, key }, orderBy: { version: "desc" } });
    return r ? { id: String(r.id), scope: r.scope, key: r.key, valueJson: r.valueJson, version: r.version, effectiveAt: r.effectiveAt.toISOString(), approvedBy: r.approvedBy ?? null } : undefined;
  }

  async ruleList(): Promise<RuleRow[]> {
    const rows = await this.db.rulesConfig.findMany({ orderBy: [{ scope: "asc" }, { key: "asc" }, { version: "desc" }] });
    const seen = new Set<string>();
    const out = [];
    for (const r of rows) {
      const k = `${r.scope}|${r.key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ id: String(r.id), scope: r.scope, key: r.key, valueJson: r.valueJson, version: r.version, effectiveAt: r.effectiveAt.toISOString(), approvedBy: r.approvedBy ?? null });
    }
    return out;
  }

  async ruleRollback(id: string, approvedBy: string | null): Promise<RuleRow | undefined> {
    const alvo = await this.db.rulesConfig.findUnique({ where: { id: BigInt(id) } }).catch(() => null);
    if (!alvo) return undefined;
    const anterior = await this.db.rulesConfig.findFirst({
      where: { scope: alvo.scope, key: alvo.key, version: { lt: alvo.version } },
      orderBy: { version: "desc" },
    });
    if (!anterior) return undefined;
    return this.rulePut(alvo.scope, alvo.key, anterior.valueJson, approvedBy);
  }
}

function adminRowToDto(r: any): AdminUserDto {
  return { id: r.id, email: r.email, name: r.name, role: r.role, active: r.active, createdAt: r.createdAt.toISOString() };
}

// ═══════════════════════════ GAMIFICAÇÃO ═══════════════════════════
import type { GameStore, GameProfileDto } from "./gamificacao/service.js";
import { XP } from "@acompanhe/shared";

export class PrismaGameStore implements GameStore {
  constructor(private db: PrismaClient) {}
  async getProfile(userId: string): Promise<GameProfileDto> {
    const p = await this.db.gameProfile.findUnique({ where: { userId } });
    return p
      ? { userId, xp: p.xp, level: p.level, streak: p.streak, lastActionAt: p.lastActionAt?.toISOString() ?? null, ufOptIn: p.ufOptIn }
      : { userId, xp: 0, level: 1, streak: 0, lastActionAt: null, ufOptIn: false };
  }
  async saveProfile(p: GameProfileDto) {
    await this.db.gameProfile.upsert({
      where: { userId: p.userId },
      create: {
        userId: p.userId,
        xp: p.xp,
        level: p.level,
        streak: p.streak,
        ...(p.lastActionAt ? { lastActionAt: new Date(p.lastActionAt) } : {}),
        ufOptIn: p.ufOptIn,
      },
      update: {
        xp: p.xp,
        level: p.level,
        streak: p.streak,
        ...(p.lastActionAt ? { lastActionAt: new Date(p.lastActionAt) } : {}),
        ufOptIn: p.ufOptIn,
      },
    });
  }
  async addEvent(userId: string, action: string, xp: number, at: string) {
    await this.db.gameEvent.create({ data: { userId, action, xp, at: new Date(at) } });
  }
  async countActionSince(userId: string, action: string, sinceIso: string) {
    return this.db.gameEvent.count({ where: { userId, action, at: { gte: new Date(sinceIso) } } });
  }
  async distinctProductsSince(userId: string, sinceIso: string) {
    const mapa: Record<string, string> = {
      [XP.notaCriada]: "anota",
      [XP.gastoCriado]: "anota",
      [XP.filtroSalvo]: "radar",
      [XP.casoInvestiga]: "investiga",
      [XP.propostaEmprestimo]: "emprestimo",
      [XP.consultaJuridica]: "juridico",
    };
    const rows = await this.db.gameEvent.findMany({ where: { userId, at: { gte: new Date(sinceIso) } }, distinct: ["action"] });
    const prods = new Set<string>();
    for (const r of rows) if (mapa[r.action]) prods.add(mapa[r.action]!);
    return prods.size;
  }
  async addBadge(userId: string, badge: string, at: string) {
    await this.db.userBadge.upsert({
      where: { userId_badge: { userId, badge } },
      create: { userId, badge, at: new Date(at) },
      update: {},
    });
  }
  async listBadges(userId: string) {
    return (await this.db.userBadge.findMany({ where: { userId }, orderBy: { at: "asc" } })).map((b) => ({ badge: b.badge, at: b.at.toISOString() }));
  }
  async missionBump(userId: string, code: string, period: string) {
    const row = await this.db.userMission.upsert({
      where: { userId_code_period: { userId, code, period } },
      create: { userId, code, period, progress: 1, done: false },
      update: { progress: { increment: 1 } },
    });
    return { progress: row.progress, done: row.done };
  }
  async listMissions(userId: string, period: string) {
    return (await this.db.userMission.findMany({ where: { userId, period } })).map((m) => ({ code: m.code, progress: m.progress, done: m.done }));
  }
  async ranking(uf: string, limit: number) {
    return (
      await this.db.gameProfile.findMany({ where: { ufOptIn: true }, orderBy: { xp: "desc" }, take: limit, select: { userId: true, xp: true, level: true } })
    ).map((r) => ({ userId: r.userId, xp: r.xp, level: r.level }));
  }
}
