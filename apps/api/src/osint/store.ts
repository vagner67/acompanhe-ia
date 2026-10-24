/**
 * OsintStore — persistência de casos/checks/achados (fase S1: em memória,
 * mesma abordagem do Store do servidor; contrato de interface estável para a
 * migração Prisma em S2).
 */
import { randomUUID } from "node:crypto";

import type {
  MonitorAlert,
  OsintCase,
  OsintCaseStatus,
  OsintCheck,
  OsintCheckStatus,
  OsintFinding,
  OsintTarget,
} from "./types.js";

/**
 * Porta de persistência do Investiga (doc 13, R6) — a rota/serviço depende
 * DESTA interface, não da classe em memória. `PrismaStore` (plano 12, F0.1)
 * implementa a mesma porta sem tocar no restante do código.
 */
export interface InvestigaStore {
  createCase(input: {
    subjectId: string;
    title: string;
    targets: OsintTarget[];
    legalBasis: string;
    purpose: string;
    createdBy: string;
    now?: () => string;
  }): Promise<OsintCase>;
  /** 24/10 (deep): documento/consulta do app precisa acrescentar alvo a caso vivo. */
  addTargets(caseId: string, targets: OsintTarget[]): Promise<OsintTarget[]>;
  getCase(id: string): Promise<OsintCase | undefined>;
  listCasesBySubject(subjectId: string): Promise<OsintCase[]>;
  updateCaseStatus(id: string, status: OsintCaseStatus, now?: string): Promise<OsintCase | undefined>;
  addCheck(check: OsintCheck): Promise<OsintCheck>;
  getCheck(id: string): Promise<OsintCheck | undefined>;
  updateCheckStatus(id: string, status: OsintCheckStatus, error?: string): Promise<OsintCheck | undefined>;
  listChecksByCase(caseId: string): Promise<OsintCheck[]>;
  addFindings(findings: OsintFinding[]): Promise<OsintFinding[]>;
  listFindingsForCase(caseId: string): Promise<OsintFinding[]>;
  listFindingsByCheck(checkId: string): Promise<OsintFinding[]>;
  addAlerts(alerts: MonitorAlert[]): Promise<MonitorAlert[]>;
  listAlertsByCase(caseId: string): Promise<MonitorAlert[]>;
  replaceInferencesForCase(caseId: string, inferences: OsintFinding[]): Promise<OsintFinding[]>;
  replaceFindingsForCase(caseId: string, findings: OsintFinding[]): Promise<OsintFinding[]>;
}

export class OsintStore implements InvestigaStore {
  private cases = new Map<string, OsintCase>();
  private checks = new Map<string, OsintCheck>();
  private findings = new Map<string, OsintFinding>();
  private alerts = new Map<string, MonitorAlert>();

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
    this.cases.set(record.id, record);
    return record;
  }

  async addTargets(caseId: string, targets: OsintTarget[]): Promise<OsintTarget[]> {
    const rec = this.cases.get(caseId);
    if (!rec) return [];
    const chave = (t: OsintTarget) => `${t.kind}|${t.value}`;
    const vistos = new Set(rec.targets.map(chave));
    for (const t of targets) {
      if (!vistos.has(chave(t))) { rec.targets.push(t); vistos.add(chave(t)); }
    }
    rec.updatedAt = new Date().toISOString();
    return rec.targets;
  }

  async getCase(id: string): Promise<OsintCase | undefined> {
    return this.cases.get(id);
  }

  async listCasesBySubject(subjectId: string): Promise<OsintCase[]> {
    return [...this.cases.values()]
      .filter((c) => c.subjectId === subjectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async updateCaseStatus(id: string, status: OsintCaseStatus, now = new Date().toISOString()): Promise<OsintCase | undefined> {
    const rec = this.cases.get(id);
    if (!rec) return undefined;
    const updated: OsintCase = { ...rec, status, updatedAt: now };
    this.cases.set(id, updated);
    return updated;
  }

  async addCheck(check: OsintCheck): Promise<OsintCheck> {
    this.checks.set(check.id, check);
    return check;
  }

  async getCheck(id: string): Promise<OsintCheck | undefined> {
    return this.checks.get(id);
  }

  async updateCheckStatus(id: string, status: OsintCheckStatus, error?: string): Promise<OsintCheck | undefined> {
    const rec = this.checks.get(id);
    if (!rec) return undefined;
    const next: OsintCheck = {
      ...rec,
      status,
      ...(error !== undefined ? { error } : {}),
    };
    this.checks.set(id, next);
    return next;
  }

  async listChecksByCase(caseId: string): Promise<OsintCheck[]> {
    return [...this.checks.values()]
      .filter((c) => c.caseId === caseId)
      .sort((a, b) => (a.executedAt < b.executedAt ? -1 : 1));
  }

  async addFindings(findings: OsintFinding[]): Promise<OsintFinding[]> {
    for (const f of findings) this.findings.set(f.id, f);
    return findings;
  }

  async listFindingsForCase(caseId: string): Promise<OsintFinding[]> {
    const checkIds = new Set(
      [...this.checks.values()].filter((c) => c.caseId === caseId).map((c) => c.id),
    );
    return [...this.findings.values()].filter(
      (f) =>
        (f.checkId !== undefined && checkIds.has(f.checkId)) || f.caseId === caseId,
    );
  }

  async listFindingsByCheck(checkId: string): Promise<OsintFinding[]> {
    return [...this.findings.values()].filter((f) => f.checkId === checkId);
  }

  async addAlerts(alerts: MonitorAlert[]): Promise<MonitorAlert[]> {
    for (const a of alerts) this.alerts.set(a.id, a);
    return alerts;
  }

  async listAlertsByCase(caseId: string): Promise<MonitorAlert[]> {
    return [...this.alerts.values()]
      .filter((a) => a.caseId === caseId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Substitui as inferências (correlação) de um caso. */
  async replaceInferencesForCase(caseId: string, inferences: OsintFinding[]): Promise<OsintFinding[]> {
    for (const [id, f] of this.findings) {
      if (f.caseId === caseId && f.inference) this.findings.delete(id);
    }
    return this.addFindings(inferences);
  }

  /** Substitui os achados de um caso (usado na re-verificação). */
  async replaceFindingsForCase(caseId: string, findings: OsintFinding[]): Promise<OsintFinding[]> {
    const checkIds = new Set(
      [...this.checks.values()].filter((c) => c.caseId === caseId).map((c) => c.id),
    );
    for (const [id, f] of this.findings) {
      const owned =
        f.caseId === caseId || (f.checkId !== undefined && checkIds.has(f.checkId));
      if (owned) this.findings.delete(id);
    }
    return this.addFindings(findings);
  }
}
