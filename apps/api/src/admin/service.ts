/**
 * Admin — RBAC por operador (papéis do schema AdminUser), login email+senha
 * (scrypt — node:crypto, sem dependência), AUDIT LOG em hash-chain
 * (prevHash→hash: qualquer adulteração quebra a cadeia) e rules_config
 * versionado (preços e trial definidos pelo DIRETOR no painel, com rollback).
 */
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

export type AdminRole =
  | "diretor"
  | "admin_ops"
  | "operador_suporte"
  | "operador_mod"
  | "analista_financeiro"
  | "auditor"
  | "suporte_oab";

export interface AdminUserDto {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  active: boolean;
  createdAt: string;
}

/** Matriz de permissões — recursos × papéis. diretor = soberano (tudo). */
const PERMISSIONS: Record<AdminRole, string[]> = {
  diretor: ["*"],
  admin_ops: ["kpis", "users", "assinaturas", "verificacoes", "rules", "jobs", "db", "ops"],
  operador_suporte: ["kpis", "users", "verificacoes"],
  operador_mod: ["kpis", "users"],
  analista_financeiro: ["kpis", "assinaturas", "db"],
  auditor: ["kpis", "audit", "users", "assinaturas", "rules", "ops"],
  suporte_oab: ["verificacoes"],
};

export function can(role: AdminRole, resource: string): boolean {
  const p = PERMISSIONS[role] ?? [];
  return p.includes("*") || p.includes(resource);
}

export interface AuditEntry {
  id?: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  ts: string;
  prevHash: string | null;
  hash: string;
}

/** Stringify canônico (chaves ordenadas) — jsonb reordena chaves no round-trip;
 *  sem isto, a cadeia "quebrava" no Postgres com entradas cujo `after` era objeto. */
export function canonJson(x: unknown): string {
  if (x === null || x === undefined) return "null";
  if (typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return `[${x.map(canonJson).join(",")}]`;
  const keys = Object.keys(x as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonJson((x as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function auditHash(prevHash: string | null, e: Omit<AuditEntry, "id" | "prevHash" | "hash">): string {
  return createHash("sha256")
    .update(`${prevHash ?? "GENESIS"}|${e.actorId ?? ""}|${e.actorRole ?? ""}|${e.action}|${e.target ?? ""}|${e.ip ?? ""}|${e.ts}|${canonJson(e.before)}|${canonJson(e.after)}`)
    .digest("hex");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const h = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${h}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, h] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !h) return false;
  const calc = scryptSync(password, salt, 32).toString("hex");
  return timingSafeEqual(Buffer.from(calc, "hex"), Buffer.from(h, "hex"));
}

export interface RuleRow {
  id: string;
  scope: string;
  key: string;
  valueJson: unknown;
  version: number;
  effectiveAt: string;
  approvedBy?: string | null;
}

export interface FlagRow {
  key: string;
  enabled: boolean;
  payload: unknown;
  updatedBy: string | null;
  updatedAt: string;
}

export interface AdminStore {
  findAdminByEmail(email: string): Promise<(AdminUserDto & { passwordHash: string | null }) | undefined>;
  findAdminById(id: string): Promise<AdminUserDto | undefined>;
  createAdmin(a: { email: string; name: string; role: AdminRole; passwordHash: string }): Promise<AdminUserDto>;
  listAdmins(): Promise<AdminUserDto[]>;
  setAdminActive(id: string, active: boolean): Promise<void>;
  resetPassword(id: string, passwordHash: string): Promise<void>;
  auditAppend(e: Omit<AuditEntry, "id">): Promise<AuditEntry>;
  auditList(limit: number): Promise<AuditEntry[]>;
  auditLastHash(): Promise<string | null>;
  rulePut(scope: string, key: string, valueJson: unknown, approvedBy: string | null): Promise<RuleRow>;
  ruleGet(scope: string, key: string): Promise<RuleRow | undefined>;
  ruleList(): Promise<RuleRow[]>;
  ruleRollback(id: string, approvedBy: string | null): Promise<RuleRow | undefined>;
  flagList(): Promise<FlagRow[]>;
  /** G1: updatedBy obrigatório — sem ator, recusa. */
  flagSet(key: string, enabled: boolean, payload: unknown, updatedBy: string): Promise<FlagRow>;
}

export class InMemoryAdminStore implements AdminStore {
  private admins = new Map<string, AdminUserDto & { passwordHash: string | null }>();
  private audit: AuditEntry[] = [];
  private rules = new Map<string, RuleRow[]>();
  private seq = 0;

  async findAdminByEmail(email: string) {
    for (const a of this.admins.values()) if (a.email === email) return a;
    return undefined;
  }
  async findAdminById(id: string) {
    const a = this.admins.get(id);
    return a ? { id: a.id, email: a.email, name: a.name, role: a.role, active: a.active, createdAt: a.createdAt } : undefined;
  }
  async createAdmin(a: { email: string; name: string; role: AdminRole; passwordHash: string }) {
    const id = randomUUID();
    const row = { id, email: a.email, name: a.name, role: a.role, active: true, createdAt: new Date().toISOString(), passwordHash: a.passwordHash };
    this.admins.set(id, row);
    const { passwordHash: _p, ...dto } = row;
    return dto;
  }
  async listAdmins() {
    return [...this.admins.values()].map(({ passwordHash: _p, ...a }) => a);
  }
  async setAdminActive(id: string, active: boolean) {
    const a = this.admins.get(id);
    if (a) a.active = active;
  }
  async resetPassword(id: string, passwordHash: string) {
    const a = this.admins.get(id);
    if (a) a.passwordHash = passwordHash;
  }
  async auditAppend(e: Omit<AuditEntry, "id">) {
    const entry: AuditEntry = { ...e, id: `a_${++this.seq}` };
    this.audit.push(entry);
    return entry;
  }
  async auditList(limit: number) {
    return this.audit.slice(-limit).reverse();
  }
  async auditLastHash() {
    return this.audit.length ? this.audit[this.audit.length - 1]!.hash : null;
  }
  async rulePut(scope: string, key: string, valueJson: unknown, approvedBy: string | null) {
    const list = this.rules.get(`${scope}|${key}`) ?? [];
    const row: RuleRow = {
      id: `r_${++this.seq}`,
      scope,
      key,
      valueJson,
      version: list.length + 1,
      effectiveAt: new Date().toISOString(),
      approvedBy: approvedBy ?? null,
    };
    list.push(row);
    this.rules.set(`${scope}|${key}`, list);
    return row;
  }
  async ruleGet(scope: string, key: string) {
    const list = this.rules.get(`${scope}|${key}`) ?? [];
    return list[list.length - 1];
  }
  async ruleList() {
    return [...this.rules.values()].map((l) => l[l.length - 1]!);
  }
  async ruleRollback(id: string, approvedBy: string | null) {
    for (const [k, list] of this.rules) {
      const idx = list.findIndex((r) => r.id === id);
      if (idx > 0) {
        const prev = list[idx - 1]!;
        const row = { ...prev, id: `r_${++this.seq}`, version: list.length + 1, effectiveAt: new Date().toISOString(), approvedBy: approvedBy ?? null };
        list.push(row);
        this.rules.set(k, list);
        return row;
      }
    }
    return undefined;
  }

  private flags = new Map<string, FlagRow>();
  async flagList() {
    return [...this.flags.values()];
  }
  async flagSet(key: string, enabled: boolean, payload: unknown, updatedBy: string): Promise<FlagRow> {
    if (!updatedBy) throw new Error("updatedBy obrigatório (G1)");
    const row: FlagRow = { key, enabled, payload, updatedBy, updatedAt: new Date().toISOString() };
    this.flags.set(key, row);
    return row;
  }
}

/** Resolve preço do plano: rules_config (versão vigente) > PLAN_SKUS (default). */
export function resolvePlanPrice(
  rules: AdminStore,
  planCode: string,
  defaults: { monthlyCents: number; yearlyCents: number },
): Promise<{ monthlyCents: number; yearlyCents: number; overridden: boolean }> {
  return rules.ruleGet("plans", planCode).then((r) =>
    r
      ? {
          monthlyCents: Number((r.valueJson as { monthlyCents?: number }).monthlyCents ?? defaults.monthlyCents),
          yearlyCents: Number((r.valueJson as { yearlyCents?: number }).yearlyCents ?? defaults.yearlyCents),
          overridden: true,
        }
      : { ...defaults, overridden: false },
  );
}

export async function resolveTrialDays(rules: AdminStore, defaultDays: number): Promise<number> {
  const r = await rules.ruleGet("trial", "days");
  return r ? Number((r.valueJson as { days?: number }).days ?? defaultDays) : defaultDays;
}

/** Garante o diretor inicial (o usuário pediu: SÓ o diretor; ele cria os demais). */
export async function ensureDiretor(store: AdminStore, password: string): Promise<{ created: boolean; email: string; password?: string }> {
  const email = "diretor@acompanhe.app";
  const existing = await store.findAdminByEmail(email);
  if (existing) return { created: false, email };
  await store.createAdmin({ email, name: "Diretor", role: "diretor", passwordHash: hashPassword(password) });
  return { created: true, email, password };
}
