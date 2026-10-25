/**
 * Painel do administrador — RBAC por operador (7 papéis), audit hash-chain,
 * rules_config (preços + trial definidos pelo diretor), verificação V1/V2,
 * assinaturas manuais, operadores, usuários, KPIs e visor de BD.
 * Toda ação administrativa vira entrada de AUDIT LOG encadeado.
 */
import { randomUUID } from "node:crypto";

import { SignJWT, jwtVerify } from "jose";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { PLAN_SKUS, TRIAL } from "@acompanhe/shared";

import type { Config } from "../config.js";
import type { Entitlements } from "../entitlements.js";
import type { VerificacaoStore } from "../emprestimos/verificacao.js";
import {
  auditHash,
  can,
  hashPassword,
  permissoesDoPapel,
  resolvePlanPrice,
  resolveTrialDays,
  verifyPassword,
  type AdminRole,
  type AdminStore,
} from "../admin/service.js";
import { loginBlocked, loginFail, loginOk, meterSnapshot } from "../ops/service.js";

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(6).max(100) });
const roleSchema = z.enum(["diretor", "admin_ops", "operador_suporte", "operador_mod", "analista_financeiro", "auditor", "suporte_oab"]);
const ruleSchema = z.object({ scope: z.string().min(1).max(20), key: z.string().min(1).max(40), valueJson: z.unknown() });
const grantSchema = z.object({ tgUserId: z.string().min(1).max(20), planCode: z.string().min(2).max(20), days: z.number().int().min(1).max(366) });

export interface AdminClaims {
  sub: string;
  role: AdminRole;
  kind: "admin";
}

export class AdminJwt {
  constructor(private key: Uint8Array) {}

  async issue(id: string, role: AdminRole): Promise<string> {
    return new SignJWT({ kind: "admin", role })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(id)
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(this.key);
  }

  async verify(token: string): Promise<AdminClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"] });
      if (payload.kind !== "admin" || typeof payload.sub !== "string" || typeof payload.role !== "string") return null;
      return { sub: payload.sub, role: payload.role as AdminRole, kind: "admin" };
    } catch {
      return null;
    }
  }
}

export function adminRoutes(deps: {
  config: Config;
  store: AdminStore;
  entitlements: Entitlements;
  verificacao: VerificacaoStore;
}): (app: FastifyInstance) => Promise<void> {
  const jwt = new AdminJwt(new TextEncoder().encode(`${deps.config.JWT_SECRET}:admin`));

  async function actor(req: FastifyRequest, reply: FastifyReply, resource: string): Promise<AdminClaims | null> {
    const h = req.headers.authorization;
    const claims = h?.startsWith("Bearer ") ? await jwt.verify(h.slice(7)) : null;
    if (!claims) {
      reply.code(401).send({ error: "admin não autenticado" });
      return null;
    }
    const admin = await deps.store.findAdminById(claims.sub);
    if (!admin || !admin.active) {
      reply.code(401).send({ error: "operador inativo" });
      return null;
    }
    if (!can(claims.role, resource)) {
      reply.code(403).send({ error: `papel '${claims.role}' sem permissão em '${resource}'`, rule: "RBAC" });
      return null;
    }
    return claims;
  }

  async function audit(
    claims: AdminClaims | null,
    action: string,
    target: string | null,
    before: unknown,
    after: unknown,
    ip: string | null,
  ): Promise<void> {
    const prevHash = await deps.store.auditLastHash();
    const base = { actorId: claims?.sub ?? null, actorRole: claims?.role ?? null, action, target, before, after, ip, ts: new Date().toISOString() };
    await deps.store.auditAppend({ ...base, prevHash, hash: auditHash(prevHash, base) });
  }

  return async (app) => {
    // ————— auth —————
    app.post("/v1/admin/auth/login", async (req, reply) => {
      const ip = req.ip ?? "desconhecido";
      if (loginBlocked(ip)) return reply.code(429).send({ error: "muitas tentativas — tente em 60s", rule: "S2" });
      const body = loginSchema.parse(req.body);
      const admin = await deps.store.findAdminByEmail(body.email);
      if (!admin || !admin.active || !admin.passwordHash || !verifyPassword(body.password, admin.passwordHash)) {
        loginFail(ip);
        await audit(null, "admin.login.falhou", body.email, null, null, req.ip);
        return reply.code(401).send({ error: "credenciais inválidas" });
      }
      loginOk(ip);
      const token = await jwt.issue(admin.id, admin.role);
      await audit({ sub: admin.id, role: admin.role, kind: "admin" }, "admin.login", admin.email, null, null, req.ip);
      return reply.send({
        token,
        admin: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
          role: admin.role,
          // a UI usa esta lista; sem ela o painel quebrava ao entrar (crash real medido)
          permissions: permissoesDoPapel(admin.role),
        },
      });
    });

    app.get("/v1/admin/auth/me", async (req, reply) => {
      const claims = await actor(req, reply, "kpis");
      if (!claims) return;
      return reply.send({ admin: await deps.store.findAdminById(claims.sub) });
    });

    app.post("/v1/admin/auth/password", async (req, reply) => {
      const h = req.headers.authorization;
      const claims = h?.startsWith("Bearer ") ? await jwt.verify(h.slice(7)) : null;
      if (!claims) return reply.code(401).send({ error: "admin não autenticado" });
      const body = z.object({ password: z.string().min(8).max(100) }).parse(req.body);
      await deps.store.resetPassword(claims.sub, hashPassword(body.password));
      await audit(claims, "admin.password", claims.sub, null, null, req.ip);
      return reply.send({ ok: true });
    });

    // ————— KPIs —————
    app.get("/v1/admin/kpis", async (req, reply) => {
      const claims = await actor(req, reply, "kpis");
      if (!claims) return;
      // KPIs REAIS (plano §3.4) — agregações diretas das tabelas do schema.
      const planos = PLAN_SKUS.map((p) => ({ code: p.code, name: p.name, defaultMonthlyCents: p.monthlyCents }));
      const base = { planos, trialDefaultDias: TRIAL.days, operadores: (await deps.store.listAdmins()).length };
      if (!deps.config.DATABASE_URL) return reply.send({ ...base, aviso: "sem DATABASE_URL — séries vazias" });
      const { createDb } = await import("@acompanhe/db");
      const db = createDb(deps.config.DATABASE_URL) as never as {
        user: { count: (x?: unknown) => Promise<number> };
        subscription: { count: (x?: unknown) => Promise<number> };
        payment: { count: (x?: unknown) => Promise<number>; aggregate: (x: unknown) => Promise<{ _sum: { amountCents: number | null } }> };
        alertEvent: { count: (x?: unknown) => Promise<number> };
        jobsDeadletter: { count: (x?: unknown) => Promise<number> };
        opsEvent: { count: (x?: unknown) => Promise<number> };
      };
      const iso = (d: number) => new Date(d).toISOString();
      const [total, novos7d, ativas, trial, conf30d, cents, alertas, deadletter, restarts24h] = await Promise.all([
        db.user.count(),
        db.user.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 86400000) } } }),
        db.subscription.count({ where: { status: "active", endsAt: { gt: new Date() } } }),
        db.subscription.count({ where: { status: "trial" } }),
        db.payment.count({ where: { providerStatus: "paid", confirmedAt: { not: null, gte: new Date(Date.now() - 30 * 86400000) } } }),
        db.payment.aggregate({ _sum: { amountCents: true }, where: { providerStatus: "paid", confirmedAt: { not: null, gte: new Date(Date.now() - 30 * 86400000) } } }),
        db.alertEvent.count({ where: { createdAt: { gte: iso(Date.now() - 86400000) } } }),
        db.jobsDeadletter.count(),
        db.opsEvent.count({ where: { kind: "process_start", ts: { gte: new Date(Date.now() - 86400000) } } }).catch(() => 0),
      ]);
      return reply.send({
        ...base,
        usuarios: { total, novos7d },
        assinaturas: { ativas, trial },
        pagamentos: { confirmados30d: conf30d, cents: cents._sum.amountCents ?? 0 },
        alertas: { ultimas24h: alertas },
        fila: { deadletter },
        sistema: { ...meterSnapshot(), restarts24h },
      });
    });

    // ————— Operadores (SÓ diretor — pedido do usuário 23/10) —————
    app.get("/v1/admin/operadores", async (req, reply) => {
      const claims = await actor(req, reply, "operadores");
      if (!claims) return;
      return reply.send({ operadores: await deps.store.listAdmins() });
    });

    app.post("/v1/admin/operadores", async (req, reply) => {
      const claims = await actor(req, reply, "operadores");
      if (!claims) return;
      const body = z.object({ email: z.string().email(), name: z.string().min(2).max(80), role: roleSchema, password: z.string().min(8).max(100) }).parse(req.body);
      const existente = await deps.store.findAdminByEmail(body.email);
      if (existente) return reply.code(409).send({ error: "e-mail já cadastrado", rule: "unicidade de operador" });
      let op;
      try {
        op = await deps.store.createAdmin({ email: body.email, name: body.name, role: body.role as AdminRole, passwordHash: hashPassword(body.password) });
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") return reply.code(409).send({ error: "e-mail já cadastrado", rule: "unicidade de operador" });
        throw e;
      }
      await audit(claims, "operador.criado", op.id, null, { email: op.email, role: op.role }, req.ip);
      return reply.code(201).send({ operador: op });
    });

    app.post("/v1/admin/operadores/:id/active", async (req, reply) => {
      const claims = await actor(req, reply, "operadores");
      if (!claims) return;
      const body = z.object({ active: z.boolean() }).parse(req.body);
      await deps.store.setAdminActive((req.params as { id: string }).id, body.active);
      await audit(claims, "operador.ativo", (req.params as { id: string }).id, null, body, req.ip);
      return reply.send({ ok: true });
    });

    // ————— Verificações V1 (aprovação humana — A3) —————
    app.get("/v1/admin/verificacoes", async (req, reply) => {
      const claims = await actor(req, reply, "verificacoes");
      if (!claims) return;
      const status = ((req.query as { status?: string }).status ?? "pending") as "none" | "pending" | "approved" | "rejected";
      const verificacoes = await deps.verificacao.listVerifications(status);
      return reply.send({ status, verificacoes, regra: "aprovar/reprovar por operador autorizado", hint: `POST /v1/admin/verificacoes/:userId/aprovar` });
    });

    app.post("/v1/admin/verificacoes/:userId/aprovar", async (req, reply) => {
      const claims = await actor(req, reply, "verificacoes");
      if (!claims) return;
      const userId = (req.params as { userId: string }).userId;
      const atual = await deps.verificacao.getVerification(userId);
      await deps.verificacao.setVerification({
        userId,
        v1Status: "approved",
        ...(atual?.docTipo ? { docTipo: atual.docTipo } : {}),
        ...(atual?.selfieAt ? { selfieAt: atual.selfieAt } : {}),
        approvedAt: new Date().toISOString(),
        rejectReason: null,
      });
      await audit(claims, "verificacao.aprovada", userId, atual?.v1Status ?? "none", "approved", req.ip);
      return reply.send({ ok: true, userId, v1Status: "approved" });
    });

    app.post("/v1/admin/verificacoes/:userId/reprovar", async (req, reply) => {
      const claims = await actor(req, reply, "verificacoes");
      if (!claims) return;
      const userId = (req.params as { userId: string }).userId;
      const body = z.object({ motivo: z.string().min(3).max(300) }).parse(req.body);
      const atual = await deps.verificacao.getVerification(userId);
      await deps.verificacao.setVerification({ userId, v1Status: "rejected", rejectReason: body.motivo, ...(atual?.docTipo ? { docTipo: atual.docTipo } : {}) });
      await audit(claims, "verificacao.reprovada", userId, atual?.v1Status ?? "none", body.motivo, req.ip);
      return reply.send({ ok: true, userId, v1Status: "rejected" });
    });

    // ————— Assinaturas (concessão manual + leitura) —————
    app.post("/v1/admin/assinaturas/conceder", async (req, reply) => {
      const claims = await actor(req, reply, "assinaturas");
      if (!claims) return;
      const body = grantSchema.parse(req.body);
      const until = new Date(Date.now() + body.days * 24 * 3600 * 1000).toISOString();
      await deps.entitlements.grant(body.tgUserId, body.planCode, { expiresAt: until, via: "manual" });
      await audit(claims, "assinatura.concedida", body.tgUserId, null, { planCode: body.planCode, days: body.days }, req.ip);
      return reply.send({ ok: true, expiresAt: until });
    });

    // ————— rules_config: preços + trial (versão + rollback) —————
    app.get("/v1/admin/rules", async (req, reply) => {
      const claims = await actor(req, reply, "rules");
      if (!claims) return;
      const vigentes = [];
      for (const p of PLAN_SKUS) {
        vigentes.push({ planCode: p.code, ...(await resolvePlanPrice(deps.store, p.code, { monthlyCents: p.monthlyCents, yearlyCents: p.yearlyCents })) });
      }
      return reply.send({ precos: vigentes, trialDias: await resolveTrialDays(deps.store, TRIAL.days), regras: await deps.store.ruleList() });
    });

    app.post("/v1/admin/rules", async (req, reply) => {
      const claims = await actor(req, reply, "rules");
      if (!claims) return;
      const body = ruleSchema.parse(req.body);
      const row = await deps.store.rulePut(body.scope, body.key, body.valueJson, claims.sub);
      await audit(claims, "rule.salva", `${body.scope}|${body.key}`, null, body.valueJson, req.ip);
      return reply.code(201).send({ rule: row });
    });

    app.post("/v1/admin/rules/:id/rollback", async (req, reply) => {
      const claims = await actor(req, reply, "rules");
      if (!claims) return;
      const row = await deps.store.ruleRollback((req.params as { id: string }).id, claims.sub);
      if (!row) return reply.code(404).send({ error: "versão anterior não encontrada" });
      await audit(claims, "rule.rollback", (req.params as { id: string }).id, null, row.valueJson, req.ip);
      return reply.send({ rule: row });
    });

    // ————— Audit log (hash-chain verificável) —————
    app.get("/v1/admin/audit", async (req, reply) => {
      const claims = await actor(req, reply, "audit");
      if (!claims) return;
      const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 100), 500);
      const entries = await deps.store.auditList(limit);
      // verificação da cadeia na leitura (qualquer adulteração quebra)
      let prev: string | null = null;
      let cadeiaOk = true;
      for (const e of [...entries].reverse()) {
        const esperado = auditHash(prev, { actorId: e.actorId, actorRole: e.actorRole, action: e.action, target: e.target, before: e.before, after: e.after, ip: e.ip, ts: e.ts });
        if (e.hash !== esperado) cadeiaOk = false;
        prev = e.hash;
      }
      return reply.send({ entries, cadeiaOk, total: entries.length });
    });

    // ————— Visor de BD (whitelist) —————
    // O client do Prisma expõe os models em camelCase (`syncRun`, `fontePerfil`);
    // usar o nome da tabela direto devolvia "modelo indisponível" em metade delas
    // (medido em produção: nem SyncRun nem FontePerfil abriam no painel).
    const MODELOS: Record<string, string> = {
      user: "user", payment: "payment", subscription: "subscription", nota: "nota", gasto: "gasto",
      loanrequest: "loanRequest", loanmatch: "loanMatch", matchpayment: "matchPayment",
      legalcase: "legalCase", legaladvice: "legalAdvice", contest: "contest", tender: "tender",
      alertevent: "alertEvent", userverification: "userVerification",
      fonteperfil: "fontePerfil", fontemetrica: "fonteMetrica",
      coletoreestado: "coletorEstado", coletormetrica: "coletorMetrica", coletoracao: "coletorAcao",
      syncrun: "syncRun",
    };
    app.get("/v1/admin/db/:tabela", async (req, reply) => {
      const claims = await actor(req, reply, "db");
      if (!claims) return;
      const tabela = (req.params as { tabela: string }).tabela.toLowerCase();
      const permitidas = Object.keys(MODELOS);
      if (!permitidas.includes(tabela)) return reply.code(404).send({ error: "tabela fora da whitelist", permitidas });
      if (!deps.config.DATABASE_URL) return reply.send({ tabela, rows: [], aviso: "sem DATABASE_URL — visor vazio" });
      const { createDb } = await import("@acompanhe/db");
      const db = createDb(deps.config.DATABASE_URL) as never as Record<string, { findMany: (x: unknown) => Promise<unknown[]> }>;
      const model = db[MODELOS[tabela]!];
      if (!model) return reply.code(404).send({ error: "modelo indisponível", tabela, modelo: MODELOS[tabela] });
      const limite = Math.min(Math.max(Number((req.query as { limite?: string }).limite ?? 50), 1), 50); // 1..50 (visor)
      const rows = await model.findMany({ take: limite });
      // `id` é BigInt nas tabelas novas: sem converter, o JSON.stringify estoura
      // (medido em produção: 500 em FontePerfil/ColetorMetrica/SyncRun).
      const json = (x: unknown) =>
        JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as unknown;
      return reply.send({ tabela, rows: json(rows), rule: "visor somente-leitura · 50 linhas" });
    });
  };
}
