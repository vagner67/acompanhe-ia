/**
 * PrismaStore — PrismaStore (plano.md §6.1 / doc 12 F0.1): implementa a MESMA
 * porta `InvestigaStore` sobre Postgres (Prisma), com round-trip exato do
 * contrato congelado (packages/shared/src/investiga-types.ts, doc 13 §4).
 *
 * Fidelidade comprovada por `apps/api/test/store-contract.test.ts` — a MESMA
 * suíte roda contra `OsintStore` (memória) e contra esta classe, com os mesmos
 * asserts. Semântica espelhada do OsintStore:
 *  - "add" = upsert por id (Map.set);
 *  - `updateCheckStatus` sem `error` mantém o erro anterior;
 *  - `listCasesBySubject` ordena createdAt DESC; checks por executedAt ASC;
 *    alertas por createdAt DESC; findings em ordem de inserção (coluna `seq`);
 *  - `raw`/`confidence`: `undefined` ≠ `null` preservados (DbNull vs JsonNull).
 */
import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@acompanhe/db";

import type {
  FindingConfidence,
  MonitorAlert,
  OsintCase,
  OsintCaseStatus,
  OsintCheck,
  OsintCheckStatus,
  OsintFinding,
  OsintTarget,
} from "./types.js";
import type { InvestigaStore } from "./store.js";

/** Subconjunto estrutural do PrismaClient usado aqui (injetável nos testes). */
export type Db = Pick<
  PrismaClient,
  | "osintCase"
  | "osintCheck"
  | "osintFinding"
  | "osintAlert"
  | "$transaction"
>;

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

function toJson(value: unknown, keepNull: boolean): Json | undefined | typeof PRISMA_DB_NULL | typeof PRISMA_JSON_NULL {
  if (value === undefined) return PRISMA_DB_NULL;
  if (value === null) return keepNull ? PRISMA_JSON_NULL : PRISMA_DB_NULL;
  return value as Json;
}

// Marcadores para Prisma DbNull/JsonNull — importados como valores dinâmicos
// para não prender este módulo ao runtime do client em tempo de tipo.
import { Prisma } from "@acompanhe/db";
const PRISMA_DB_NULL = Prisma.DbNull;
const PRISMA_JSON_NULL = Prisma.JsonNull;

function fromJson(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  return value;
}

function fromJsonKeepNull(value: unknown): unknown {
  if (value === undefined) return undefined;
  return value; // JsonNull vindo do driver chega como `null` puro
}

export class PrismaStore implements InvestigaStore {
  constructor(private readonly db: Db) {}

  async createCase(input: {
    subjectId: string;
    title: string;
    targets: OsintTarget[];
    legalBasis: string;
    purpose: string;
    createdBy: string;
    now?: () => string;
  }): Promise<OsintCase> {
    const now = input.now ?? (() => new Date().toISOString());
    const record: OsintCase = {
      id: randomUUID(),
      subjectId: input.subjectId,
      title: input.title,
      status: "draft",
      targets: input.targets,
      legalBasis: input.legalBasis,
      purpose: input.purpose,
      createdBy: input.createdBy,
      createdAt: now(),
      updatedAt: now(),
    };
    await this.db.osintCase.create({
      data: {
        id: record.id,
        subjectId: record.subjectId,
        title: record.title,
        status: record.status,
        targets: record.targets as unknown as object,
        legalBasis: record.legalBasis,
        purpose: record.purpose,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });
    return record;
  }

  async getCase(id: string): Promise<OsintCase | undefined> {
    const row = await this.db.osintCase.findUnique({ where: { id } });
    return row ? caseToDto(row) : undefined;
  }

  async addTargets(caseId: string, targets: OsintTarget[]): Promise<OsintTarget[]> {
    const row = await this.db.osintCase.findUnique({ where: { id: caseId } });
    if (!row) return [];
    const atuais = row.targets as unknown as OsintTarget[];
    const chave = (t: OsintTarget) => `${t.kind}|${t.value}`;
    const vistos = new Set(atuais.map(chave));
    const merged = [...atuais];
    for (const t of targets) {
      if (!vistos.has(chave(t))) { merged.push(t); vistos.add(chave(t)); }
    }
    await this.db.osintCase.update({
      where: { id: caseId },
      data: { targets: merged as unknown as object, updatedAt: new Date().toISOString() },
    });
    return merged;
  }

  async listCasesBySubject(subjectId: string): Promise<OsintCase[]> {
    const rows = await this.db.osintCase.findMany({
      where: { subjectId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(caseToDto);
  }

  async updateCaseStatus(
    id: string,
    status: OsintCaseStatus,
    now = new Date().toISOString(),
  ): Promise<OsintCase | undefined> {
    const rec = await this.getCase(id);
    if (!rec) return undefined;
    await this.db.osintCase.update({ where: { id }, data: { status, updatedAt: now } });
    return { ...rec, status, updatedAt: now };
  }

  async addCheck(check: OsintCheck): Promise<OsintCheck> {
    await this.db.osintCheck.upsert({
      where: { id: check.id },
      create: {
        id: check.id,
        caseId: check.caseId,
        target: check.target as unknown as object,
        legalBasis: check.legalBasis,
        purpose: check.purpose,
        quotaConsumed: check.quotaConsumed,
        status: check.status,
        executedAt: check.executedAt,
        error: check.error ?? null,
      },
      update: {
        caseId: check.caseId,
        target: check.target as unknown as object,
        legalBasis: check.legalBasis,
        purpose: check.purpose,
        quotaConsumed: check.quotaConsumed,
        status: check.status,
        executedAt: check.executedAt,
        error: check.error ?? null,
      },
    });
    return check;
  }

  async getCheck(id: string): Promise<OsintCheck | undefined> {
    const row = await this.db.osintCheck.findUnique({ where: { id } });
    return row ? checkToDto(row) : undefined;
  }

  async updateCheckStatus(
    id: string,
    status: OsintCheckStatus,
    error?: string,
  ): Promise<OsintCheck | undefined> {
    const rec = await this.getCheck(id);
    if (!rec) return undefined;
    const next: OsintCheck = {
      ...rec,
      status,
      ...(error !== undefined ? { error } : {}),
    };
    await this.db.osintCheck.update({
      where: { id },
      data: { status, ...(error !== undefined ? { error } : {}) },
    });
    return next;
  }

  async listChecksByCase(caseId: string): Promise<OsintCheck[]> {
    const rows = await this.db.osintCheck.findMany({
      where: { caseId },
      orderBy: { executedAt: "asc" },
    });
    return rows.map(checkToDto);
  }

  async addFindings(findings: OsintFinding[]): Promise<OsintFinding[]> {
    for (const f of findings) {
      await this.db.osintFinding.upsert({
        where: { id: f.id },
        create: {
          id: f.id,
          checkId: f.checkId ?? null,
          caseId: f.caseId ?? null,
          sourceId: f.sourceId,
          status: f.status,
          summary: f.summary ?? null,
          evidenceUrl: f.evidenceUrl ?? null,
          retrievedAt: f.retrievedAt,
          raw: toJson(f.raw, false) as never,
          confidence: toJson(f.confidence, false) as never,
          inference: f.inference ?? null,
        },
        update: {
          checkId: f.checkId ?? null,
          caseId: f.caseId ?? null,
          sourceId: f.sourceId,
          status: f.status,
          summary: f.summary ?? null,
          evidenceUrl: f.evidenceUrl ?? null,
          retrievedAt: f.retrievedAt,
          raw: toJson(f.raw, false) as never,
          confidence: toJson(f.confidence, false) as never,
          inference: f.inference ?? null,
        },
      });
    }
    return findings;
  }

  async listFindingsForCase(caseId: string): Promise<OsintFinding[]> {
    const checks = await this.db.osintCheck.findMany({ where: { caseId }, select: { id: true } });
    const checkIds = checks.map((c) => c.id);
    const rows = await this.db.osintFinding.findMany({
      where: {
        OR: [
          { checkId: { in: checkIds } },
          { caseId },
        ],
      },
      orderBy: { seq: "asc" },
    });
    return rows.map(findingToDto);
  }

  async listFindingsByCheck(checkId: string): Promise<OsintFinding[]> {
    const rows = await this.db.osintFinding.findMany({
      where: { checkId },
      orderBy: { seq: "asc" },
    });
    return rows.map(findingToDto);
  }

  async addAlerts(alerts: MonitorAlert[]): Promise<MonitorAlert[]> {
    for (const a of alerts) {
      await this.db.osintAlert.upsert({
        where: { id: a.id },
        create: {
          id: a.id,
          caseId: a.caseId,
          kind: a.kind,
          sourceId: a.sourceId,
          targetKey: a.targetKey,
          detail: a.detail,
          createdAt: a.createdAt,
          raw: toJson(a.raw, false) as never,
        },
        update: {
          caseId: a.caseId,
          kind: a.kind,
          sourceId: a.sourceId,
          targetKey: a.targetKey,
          detail: a.detail,
          createdAt: a.createdAt,
          raw: toJson(a.raw, false) as never,
        },
      });
    }
    return alerts;
  }

  async listAlertsByCase(caseId: string): Promise<MonitorAlert[]> {
    const rows = await this.db.osintAlert.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(alertToDto);
  }

  async replaceInferencesForCase(caseId: string, inferences: OsintFinding[]): Promise<OsintFinding[]> {
    await this.db.osintFinding.deleteMany({
      where: { caseId, inference: true },
    });
    return this.addFindings(inferences);
  }

  async replaceFindingsForCase(caseId: string, findings: OsintFinding[]): Promise<OsintFinding[]> {
    const checks = await this.db.osintCheck.findMany({ where: { caseId }, select: { id: true } });
    const checkIds = checks.map((c) => c.id);
    await this.db.osintFinding.deleteMany({
      where: {
        OR: [
          { checkId: { in: checkIds } },
          { caseId },
        ],
      },
    });
    return this.addFindings(findings);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function caseToDto(row: any): OsintCase {
  return {
    id: row.id,
    subjectId: row.subjectId,
    title: row.title,
    status: row.status as OsintCaseStatus,
    targets: row.targets as OsintTarget[],
    legalBasis: row.legalBasis,
    purpose: row.purpose,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function checkToDto(row: any): OsintCheck {
  return {
    id: row.id,
    caseId: row.caseId,
    target: row.target as OsintTarget,
    legalBasis: row.legalBasis,
    purpose: row.purpose,
    quotaConsumed: row.quotaConsumed,
    status: row.status as OsintCheckStatus,
    executedAt: row.executedAt,
    ...(row.error != null ? { error: row.error } : {}),
  };
}

function findingToDto(row: any): OsintFinding {
  return {
    id: row.id,
    ...(row.checkId != null ? { checkId: row.checkId } : {}),
    ...(row.caseId != null ? { caseId: row.caseId } : {}),
    sourceId: row.sourceId,
    status: row.status as OsintFinding["status"],
    ...(row.summary != null ? { summary: row.summary } : {}),
    ...(row.evidenceUrl != null ? { evidenceUrl: row.evidenceUrl } : {}),
    retrievedAt: row.retrievedAt,
    ...(row.raw != null ? { raw: fromJsonKeepNull(row.raw) } : {}),
    ...(row.confidence != null ? { confidence: fromJsonKeepNull(row.confidence) as FindingConfidence } : {}),
    ...(row.inference != null ? { inference: row.inference } : {}),
  };
}

function alertToDto(row: any): MonitorAlert {
  return {
    id: row.id,
    caseId: row.caseId,
    kind: row.kind as MonitorAlert["kind"],
    sourceId: row.sourceId,
    targetKey: row.targetKey,
    detail: row.detail,
    createdAt: row.createdAt,
    ...(row.raw != null ? { raw: fromJsonKeepNull(row.raw) } : {}),
  };
}
