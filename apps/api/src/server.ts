import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { JwtService } from "./security/jwt.js";
import { verifyTelegramInitData } from "./security/telegram-initdata.js";
import { InMemoryIndiceStore } from "./juridico/indice.js";
import { InMemoryPaymentStore, type PaymentRecord, type PaymentStore } from "./store.js";
import { PushinpayClient, processPushinpayWebhook } from "./payments/pushinpay.js";
import { InMemoryEntitlementsStore, type Entitlements } from "./entitlements.js";
import { PrismaIndiceStore } from "./juridico/indice-prisma.js";
import { PerfilStoreResiliente, PrismaPerfilStore } from "./juridico/perfil-prisma.js";
import { InMemoryPerfilStore } from "./juridico/autoaperfeicoamento.js";
import {
  PrismaEntitlements,
  PrismaLegalStore,
  PrismaLoanStore,
  PrismaMinhasStore,
  PrismaPaymentStore,
  PrismaSubscriptionsStore,
  PrismaVerificacaoStore,
} from "./store-prisma.js";
import { assinaturasRoutes } from "./routes/assinaturas.js";
import { adminRoutes, AdminJwt } from "./routes/admin.js";
import { opsRoutes } from "./routes/ops.js";
import { PrismaOpsStore } from "./ops/store.js";
import { recordRequest } from "./ops/service.js";
import { gamificacaoRoutes } from "./gamificacao/routes.js";
import { PrismaGameStore } from "./store-prisma.js";
import { InMemoryGameStore } from "./gamificacao/service.js";
import { ensureDiretor, hashPassword, resolvePlanPrice, resolveTrialDays, InMemoryAdminStore, type AdminStore } from "./admin/service.js";
import { PrismaAdminStore } from "./store-prisma.js";
import { minhasRoutes } from "./routes/minhas.js";
import { filtrosRoutes, InMemoryFiltroStore, PrismaFiltroStore, type FiltroStore } from "./filtros.js";
import { InMemoryMinhasStore, manualOcr, type MinhasStore } from "./minhas/service.js";
import { detectTesseract } from "./minhas/ocr.js";
import { InMemorySubscriptionsStore, type SubscriptionsStore } from "./assinaturas/service.js";
import { OsintStore } from "./osint/store.js";
import { PrismaStore } from "./osint/prisma-store.js";
import { createDb } from "@acompanhe/db";
import type { InvestigaStore } from "./osint/store.js";
import { InvestigaQuotaGate, type QuotaGate } from "./osint/quota.js";
import { investigaRoutes } from "./routes/investiga.js";
import { licitacoesRoutes } from "./routes/licitacoes.js";
import { concursosRoutes } from "./routes/concursos.js";
import { processosRoutes } from "./routes/processos.js";
import { InMemoryAlertSink, PrismaAlertSink, type AlertSink } from "./jobs/dispatcher.js";
import { emprestimosRoutes } from "./routes/emprestimos.js";
import { InMemoryLoanStore, type LoanStore } from "./emprestimos/service.js";
import { InMemoryVerificacaoStore, type VerificacaoStore } from "./emprestimos/verificacao.js";
import { InMemoryLegalStore, type LegalStore } from "./juridico/service.js";
import { InMemoryContestStore, PrismaContestStore, type ContestStore } from "./concursos/service.js";
import type { DouClientOpts } from "./concursos/dou.js";
import { InMemoryTenderStore, PrismaTenderStore, type TenderStore } from "./licitacoes/service.js";
import type { PncpClientOpts } from "./licitacoes/pncp.js";
import type { SherlockExec } from "./osint/sherlock.js";

export interface AppDeps {
  config: Config;
  payments: PaymentStore;
  pushinpay: PushinpayClient;
  nowSec?: () => number;
  /** Override do store do painel de operações (testes). */
  ops?: { store?: import("./ops/store.js").OpsStore };
  /** Overrides para testes de Concursos (fetch do DOU injetável). */
  concursos?: {
    store?: ContestStore;
    dou?: DouClientOpts;
  };
  /** Overrides para a Assessoria jurídica. */
  juridico?: {
    store?: LegalStore;
    oabVerified?: Set<string>;
    datajud?: typeof import("./juridico/datajud.js").fetchProcessos;
    datajudOpts?: import("./juridico/datajud.js").DatajudClientOpts;
    indice?: import("./juridico/indice.js").IndiceStore;
    serviceToken?: () => string | null;
    /** Busca nacional orquestrada (injetável em teste). */
    nacional?: typeof import("./juridico/nacional.js").consultarNacional;
    /** Perfis do auto-aperfeiçoamento (memória ou Postgres). */
    perfis?: import("./juridico/autoaperfeicoamento.js").PerfilStore;
    /** Medição do ciclo (injetável em teste, sem rede). */
    autoMedir?: {
      medir?: (fontes: string[], termo: string, agora: string) => Promise<import("./juridico/autoaperfeicoamento.js").Metrica[]>;
      medirCandidato?: (
        fonteId: string,
        perfil: import("./juridico/autoaperfeicoamento.js").PerfilFonte,
        termo: string,
        agora: string,
      ) => Promise<import("./juridico/autoaperfeicoamento.js").Metrica>;
      maxAvaliacoes?: number;
      prazoMs?: number;
    };
  };
  admin?: { store?: AdminStore };
  minhas?: { store?: MinhasStore; ocr?: import("./minhas/service.js").OcrProvider };
  assinaturas?: { subs?: SubscriptionsStore };
  filtros?: { store?: FiltroStore };
  /** Overrides para Empréstimo. */
  emprestimos?: {
    store?: LoanStore;
    verificacao?: VerificacaoStore;
  };
  /** Overrides para testes de Licitação (fetch do PNCP injetável). */
  licitacoes?: {
    store?: TenderStore;
    pncp?: PncpClientOpts;
  };
  /** Overrides para testes do Investiga (fixture = saída real do sherlock). */
  osint?: {
    store?: InvestigaStore;
    quota?: QuotaGate;
    entitlements?: Entitlements;
    sherlockExec?: SherlockExec;
  };
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    // DELETE/PUT sem body com content-type json não devem quebrar (FST_ERR_CTP_EMPTY_JSON_BODY)
    bodyLimit: 2 * 1024 * 1024, logger: deps.config.NODE_ENV !== "test", trustProxy: true });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const s = typeof body === "string" ? body.trim() : "";
    if (!s) return done(null, {});
    try {
      done(null, JSON.parse(s));
    } catch (e) {
      done(e as Error, undefined);
    }
  });
  const jwt = new JwtService(deps.config.JWT_SECRET, deps.config.JWT_TTL_SECONDS);

  void app.register(cors, { origin: true, methods: ["GET", "POST"] });
  // Estáticos do mini app + /admin.html servidos pelo MESMO processo (deploy de serviço único).
  // Caminho relativo idêntico a partir de src/ e dist/ (apps/api/{src,dist}/../../web/dist).
  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(webDist)) {
    void app.register(fastifyStatic, { root: webDist, index: ["index.html"] });
  }

  // nunca logar initData/PII — o Fastify loga só o essencial (doc 02 LGPD)
  app.addHook("onRequest", async (req) => {
    (req as { __t0?: number }).__t0 = Date.now();
    return undefined;
  });
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-request-id", req.id); // R1: correlação de ponta a ponta
    const t0 = (req as { __t0?: number }).__t0;
    if (typeof t0 === "number") recordRequest(reply.statusCode, Date.now() - t0);
    return undefined;
  });

  /** Auth da Mini App — doc 02 §3: HMAC + constant-time + auth_date (janela de login 24 h). */
  app.post("/api/auth/telegram", async (req, reply) => {
    if (deps.config.BOT_TOKEN.startsWith("000000000:DEV_PLACEHOLDER")) {
      // Honesto: o problema é o SERVIDOR sem token, não o initData do cliente.
      return reply.code(503).send({ error: "TELEGRAM_BOT_TOKEN não configurado no servidor" });
    }
    const body = req.body as { initData?: unknown } | undefined;
    if (typeof body?.initData !== "string" || body.initData.length === 0) {
      return reply.code(400).send({ error: "initData ausente" });
    }
    const result = verifyTelegramInitData(body.initData, deps.config.BOT_TOKEN, {
      maxAgeSec: deps.config.AUTH_DATE_LOGIN_MAX_AGE,
      ...(deps.nowSec ? { nowSec: deps.nowSec() } : {}),
    });
    if (!result.ok || !result.user) {
      return reply.code(403).send({ error: "initData inválido", reason: result.ok ? "bad_user" : result.reason });
    }
    const token = await jwt.issue(result.user.id, result.user.username);
    return { token, expiresInSec: deps.config.JWT_TTL_SECONDS, user: { id: result.user.id, firstName: result.user.first_name } };
  });

  /**
   * Auth de DESENVOLVIMENTO (arquitetura tgstack: rodar o app em navegador
   * sem o Telegram). NUNCA em produção: a rota não existe quando NODE_ENV=production.
   */
  app.post("/api/auth/telegram/dev", async (req, reply) => {
    if (deps.config.NODE_ENV === "production") {
      return reply.code(404).send({ error: "not found" });
    }
    const body = req.body as { userId?: unknown; username?: unknown } | undefined;
    const userId = typeof body?.userId === "string" && body.userId.length > 0 ? body.userId : "dev-user";
    const username = typeof body?.username === "string" ? body.username : undefined;
    const token = await jwt.issue(userId, username);
    return { token, expiresInSec: deps.config.JWT_TTL_SECONDS, user: { id: userId, firstName: "Dev" }, dev: true };
  });

  /** Sessão atual (Bearer JWT). */
  app.get("/api/me", async (req, reply) => {
    const claims = await requireSession(req.headers.authorization, jwt);
    if (!claims) return reply.code(401).send({ error: "não autenticado" });
    return { tgUserId: claims.sub, username: claims.username ?? null };
  });

  /**
   * Webhook Pushin Pay (doc 08 §3) — fail-closed; paid só com consulta + valor.
   * Header custom configurado no painel; sem secret o endpoint NUNCA libera nada.
   */
  app.post("/api/webhooks/pushinpay", async (req, reply) => {
    const outcome = await processPushinpayWebhook(req.body, normalizeHeaders(req.headers), {
      secretConfigured: deps.config.PUSHINPAY_WEBHOOK_SECRET.length > 0,
      secretExpected: deps.config.PUSHINPAY_WEBHOOK_SECRET,
      store: deps.payments,
      client: deps.pushinpay,
    });
    return reply.code(outcome.httpStatus).send({ ok: outcome.httpStatus === 200, effect: outcome.effect, detail: outcome.detail });
  });

  // Investiga — plano de OSINT avançado (doc 11).
  registerInvestiga(app, deps, jwt);

  return app;
}

/** Registra as rotas do Investiga (testes podem injetar fixture do sherlock). */
export function registerInvestiga(app: FastifyInstance, deps: AppDeps, jwt: JwtService) {
  // Persistência do Investiga (doc 12 F0.1 / plano.md §6.1): PrismaStore sobre
  // Postgres quando DATABASE_URL existe; memória só como fallback de dev.
  const osintStore =
    deps.osint?.store ??
    (deps.config.DATABASE_URL
      ? new PrismaStore(createDb(deps.config.DATABASE_URL))
      : (() => {
          if (deps.config.NODE_ENV !== "test") {
            console.warn("[investiga] DATABASE_URL ausente — OsintStore em MEMÓRIA (dados somem no restart)");
          }
          return new OsintStore();
        })());
  const quota = deps.osint?.quota ?? new InvestigaQuotaGate();
  const dbForStores = deps.config.DATABASE_URL ? createDb(deps.config.DATABASE_URL) : null;

  // Health profundo (tgstack infra/health): prova o Postgres; 503 quando cai.
  app.get("/health", async (_req, reply) => {
    let db: "ok" | "down" | "n/a" = "n/a";
    if (dbForStores) {
      try {
        await dbForStores.$queryRaw`select 1`;
        db = "ok";
      } catch {
        db = "down";
      }
    }
    const status = db === "down" ? "degraded" : "ok";
    if (db === "down") reply.code(503);
    return { status, db, service: "acompanhe-api", time: new Date().toISOString() };
  });
  const entitlements: Entitlements =
    deps.osint?.entitlements ?? (dbForStores ? new PrismaEntitlements(dbForStores) : new InMemoryEntitlementsStore());
  void app.register(
    investigaRoutes({
      config: deps.config,
      store: osintStore,
      quota,
      entitlements,
      jwt,
      ...(deps.osint?.sherlockExec ? { sherlockExec: deps.osint.sherlockExec } : {}),
    }),
  );

  // Licitação (plano.md §2) — mesma porta: Prisma quando há DATABASE_URL.
  const tenderStore: TenderStore =
    deps.licitacoes?.store ??
    (deps.config.DATABASE_URL ? new PrismaTenderStore(createDb(deps.config.DATABASE_URL)) : new InMemoryTenderStore());
  void app.register(
    licitacoesRoutes({
      config: deps.config,
      jwt,
      store: tenderStore,
      adminToken: deps.config.ADMIN_TOKEN,
      ...(deps.licitacoes?.pncp ? { pncp: deps.licitacoes.pncp } : {}),
    }),
  );
  // Concursos (plano.md §3) — mesma porta: Prisma quando há DATABASE_URL.
  const contestStore: ContestStore =
    deps.concursos?.store ??
    (deps.config.DATABASE_URL ? new PrismaContestStore(createDb(deps.config.DATABASE_URL)) : new InMemoryContestStore());
  void app.register(
    concursosRoutes({
      jwt,
      store: contestStore,
      adminToken: deps.config.ADMIN_TOKEN,
      ...(deps.concursos?.dou ? { dou: deps.concursos.dou } : {}),
    }),
  );
  // Assessoria jurídica (plano.md §4) — mesma porta.
  const legalStore: LegalStore =
    deps.juridico?.store ?? (dbForStores ? new PrismaLegalStore(dbForStores) : new InMemoryLegalStore());
  // RF-B04 — alertas de movimentação: pipeline real (AlertEvent → worker → Telegram).
  const legalAlertSink: AlertSink = dbForStores ? new PrismaAlertSink(dbForStores) : new InMemoryAlertSink();
  // Perfis de coleta do auto-aperfeiçoamento (plano-91-tribunais §5).
  // UM store para o job E para as rotas: sem isso o ciclo aprendia num caderno
  // que a busca nunca lia. Com banco -> Prisma (sobrevive a deploy).
  const perfisStore: import("./juridico/autoaperfeicoamento.js").PerfilStore =
    deps.juridico?.perfis ??
    (dbForStores
      ? new PerfilStoreResiliente(new PrismaPerfilStore(dbForStores), (m) => app.log.warn(m))
      : new InMemoryPerfilStore());
  // tipagem explícita do decorado (o projeto não usa augmentation do fastify)
  (app as typeof app & { juridicoPerfis: typeof perfisStore }).juridicoPerfis = perfisStore;
  // Índice próprio do Jurídico (plano-refatoracao §6.2): Prisma quando há banco.
  const indiceStore: import("./juridico/indice.js").IndiceStore =
    deps.juridico?.indice ?? (dbForStores ? new PrismaIndiceStore(dbForStores) : new InMemoryIndiceStore());
  void app.register(
    processosRoutes({
      jwt,
      store: legalStore,
      adminToken: deps.config.ADMIN_TOKEN,
      entitlements,
      alertSink: legalAlertSink,
      ...(deps.juridico?.oabVerified ? { oabVerified: deps.juridico.oabVerified } : {}),
      ...(deps.juridico?.datajud ? { datajud: deps.juridico.datajud } : {}),
      ...(deps.juridico?.datajudOpts ? { datajudOpts: deps.juridico.datajudOpts } : {}),
      indice: indiceStore,
      ...(deps.juridico?.serviceToken ? { serviceToken: deps.juridico.serviceToken } : {}),
      ...(deps.juridico?.nacional ? { nacional: deps.juridico.nacional } : {}),
      perfis: perfisStore,
      ...(deps.juridico?.autoMedir ? { autoMedir: deps.juridico.autoMedir } : {}),
    }),
  );
  // Empréstimo (plano.md §5) — mesma porta. RE1: nenhuma rota move dinheiro.
  const loanStore: LoanStore =
    deps.emprestimos?.store ?? (dbForStores ? new PrismaLoanStore(dbForStores) : new InMemoryLoanStore());
  const verificacaoStore: VerificacaoStore =
    deps.emprestimos?.verificacao ??
    (dbForStores ? new PrismaVerificacaoStore(dbForStores) : new InMemoryVerificacaoStore());
  void app.register(
    emprestimosRoutes({
      jwt,
      store: loanStore,
      verificacao: verificacaoStore,
    }),
  );
  // AnotA + assinaturas + filtros (plano §1.0/§1.1) — mesma porta Prisma.
  const subs: SubscriptionsStore =
    deps.assinaturas?.subs ?? (dbForStores ? new PrismaSubscriptionsStore(dbForStores) : new InMemorySubscriptionsStore());
  const minhasStore: MinhasStore = deps.minhas?.store ?? (dbForStores ? new PrismaMinhasStore(dbForStores) : new InMemoryMinhasStore());
  const filtroStore: FiltroStore =
    deps.filtros?.store ?? (dbForStores ? new PrismaFiltroStore(dbForStores as never) : new InMemoryFiltroStore());
  // Painel do administrador (RBAC por operador + audit hash-chain + rules_config).
  const adminStore: AdminStore = deps.admin?.store ?? (dbForStores ? new PrismaAdminStore(dbForStores) : new InMemoryAdminStore());
  const bootstrapPassword = deps.config.ADMIN_TOKEN || randomPassword();
  if (deps.config.NODE_ENV !== "test") {
    void ensureDiretor(adminStore, bootstrapPassword).then((r) => {
      if (r.created) console.warn(`[admin] diretor criado — email=${r.email} senha inicial=${bootstrapPassword} (troque em /v1/admin/auth/password)`);
    });
  }
  void app.register(adminRoutes({ config: deps.config, store: adminStore, entitlements, verificacao: verificacaoStore }));

  // Painel de operações (docs/plano-painel-ops.md) — alterações/processos/vida/saúde.
  void app.register(
    opsRoutes({
      config: deps.config,
      store: adminStore,
      ...(deps.ops?.store ? { opsStore: deps.ops.store } : dbForStores ? { opsStore: new PrismaOpsStore(dbForStores) } : {}),
    }),
  );

  // Gamificação — XP por ação real, streak, missões, conquistas, ranking opt-in.
  const gameStore = dbForStores ? new PrismaGameStore(dbForStores) : new InMemoryGameStore();
  void app.register(async (a) => {
    gamificacaoRoutes(a, gameStore, jwt);
  });

  // ZodError -> 422 (validação amigável em vez de 500).
  app.setErrorHandler((err, _req, reply) => {
    if (err && typeof err === "object" && (err as { name?: string }).name === "ZodError") {
      return reply.code(422).send({ error: "dados inválidos", detalhes: (err as unknown as { issues?: unknown }).issues });
    }
    return reply.send(err);
  });

  void app.register(
    assinaturasRoutes({
      config: deps.config,
      jwt,
      payments: paymentsWithGrants(deps, dbForStores, entitlements, subs),
      entitlements,
      subs,
      pushinpay: deps.pushinpay,
      rules: adminStore,
    }),
  );
  const upsertUser = dbForStores
    ? async (userId: string, p: { uf: string; cityIbge: number }) => {
        const tg = BigInt(userId);
        await (dbForStores as never as { user: { upsert: (x: unknown) => Promise<unknown> } }).user.upsert({
          where: { tgUserId: tg },
          create: { tgUserId: tg, uf: p.uf, cityIbge: p.cityIbge },
          update: { uf: p.uf, cityIbge: p.cityIbge },
        });
      }
    : null;
  void app.register(
    minhasRoutes({
      jwt,
      store: minhasStore,
      loans: loanStore,
      verificacao: verificacaoStore,
      ocr: deps.minhas?.ocr ?? detectTesseract() ?? manualOcr,
      ...(upsertUser ? { upsertUser } : {}),
    }),
  );
  void app.register(filtrosRoutes("concurso", { jwt, store: filtroStore }));
  return { osintStore, quota, entitlements, tenderStore, contestStore, legalStore, loanStore, verificacaoStore };
}

/** Decora QUALQUER PaymentStore: efeito "released" concede SKU + Subscription. */
export class EffectfulPaymentStore implements PaymentStore {
  constructor(
    private inner: PaymentStore,
    private entitlements: Entitlements,
    private subs: SubscriptionsStore,
  ) {}
  findByProviderId(id: string) {
    return this.inner.findByProviderId(id);
  }
  save(r: PaymentRecord) {
    return this.inner.save(r);
  }
  listByUser(userId: string) {
    return this.inner.listByUser(userId);
  }
  flagInvestigation(id: string, reason: string) {
    return this.inner.flagInvestigation(id, reason);
  }
  async applyPaidEffect(providerIdLower: string, paidAt: string): Promise<boolean> {
    const applied = await this.inner.applyPaidEffect(providerIdLower, paidAt);
    if (!applied) return false;
    const rec = await this.inner.findByProviderId(providerIdLower);
    if (rec?.refType === "subscription" && rec.refId && rec.userId) {
      const current = await this.entitlements.get(rec.userId);
      const until = new Date(new Date(paidAt).getTime() + 30 * 24 * 3600 * 1000).toISOString();
      await this.entitlements.grant(rec.userId, rec.refId, {
        expiresAt: current.expiresAt && current.expiresAt > until ? current.expiresAt : until,
        via: "pushinpay",
      }, paidAt);
      await this.subs.create({
        userId: rec.userId,
        planCode: rec.refId,
        channel: rec.channel,
        startsAt: paidAt,
        endsAt: until,
        autoRenew: "none",
        providerRef: providerIdLower,
        status: "active",
      });
    }
    return true;
  }
}

function paymentsWithGrants(
  deps: AppDeps,
  dbForStores: ReturnType<typeof createDb> | null,
  entitlements: Entitlements,
  subs: SubscriptionsStore,
): PaymentStore {
  const base = deps.payments ?? (dbForStores ? new PrismaPaymentStore(dbForStores, entitlements, subs) : null);
  if (!base) throw new Error("PaymentStore indisponível");
  return new EffectfulPaymentStore(base, entitlements, subs);
}

function randomPassword(): string {
  return `adm-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function requireSession(authorization: string | undefined, jwt: JwtService) {
  if (!authorization?.startsWith("Bearer ")) return null;
  return jwt.verify(authorization.slice("Bearer ".length));
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = typeof v === "string" ? v : undefined;
  }
  return out;
}

async function main() {
  const config = loadConfig();
  const app = buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: new PushinpayClient(config.PUSHINPAY_API_BASE, config.PUSHINPAY_TOKEN),
  });
  await app.listen({ port: config.PORT, host: config.HOST });

  // Auto-aperfeiçoamento das fontes (plano-91-tribunais-nacional §5).
  // Ciclo medido a cada AUTO_HORAS (default 6h); desligável com AUTO_HABILITADO=0.
  // Falha de fonte não derruba o processo: o job registra e tenta no próximo ciclo.
  if ((process.env.AUTO_HABILITADO ?? "1") !== "0") {
    const { iniciarAutoAperfeicoamento } = await import("./jobs/autoaperfeicoamento.js");
    iniciarAutoAperfeicoamento({
      store: (app as typeof app & { juridicoPerfis: import("./juridico/autoaperfeicoamento.js").PerfilStore }).juridicoPerfis,
      onResultado: (r) => {
        app.log.info(
          {
            ok: r.ok,
            fontes: r.metricas.length,
            promovidas: r.promovidas,
            derivas: r.derivas,
            nuncaFuncionaram: r.nuncaFuncionaram,
            ms: r.msTotal,
          },
          "auto-aperfeicoamento: ciclo concluído",
        );
      },
    });
  }
}

// sobe só quando executado diretamente (testes importam buildApp)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
