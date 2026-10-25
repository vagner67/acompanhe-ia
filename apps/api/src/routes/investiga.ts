/**
 * Investiga — rotas HTTP (doc 11). ADAPTADORES FINOS (doc 13, R2):
 * auth → validação → `osint/service.ts` → reply. A regra de caso/execução/
 * relatório/export vive no serviço; aqui só a camada HTTP.
 *
 * Superfície (JWT Bearer em todas, exceto admin):
 *   POST /v1/investiga/cases               cria caso (legalBasis+purpose obrigatórios)
 *   GET  /v1/investiga/cases               lista casos do assinante
 *   GET  /v1/investiga/cases/:id           caso + checks + achados
 *   POST /v1/investiga/cases/:id/run       executa checks AGORA (consome quota)
 *   GET  /v1/investiga/cases/:id/report    relatório com sha256 + veredicto
 *   GET  /v1/investiga/cases/:id/alerts    alertas de mudança + idade
 *   GET  /v1/investiga/cases/:id/export.csv|export.pdf
 *   GET  /v1/investiga/quota               janela do dia
 *   POST /v1/admin/investiga/trial         diretor: trial 7d (1x/usuário; X-Admin-Token)
 *
 * Gating: entitlement (investiga | investigaPack | investiga:trial) + quota
 * diária dura (teto 150/dia). Estourou → 429 queue-paused + próxima janela.
 * name/url sem fonte real dedicada em S1 → finding "unknown" explícito
 * (NUNCA fingir resultado).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { INVESTIGA_LIMITS, INVESTIGA_QUOTA } from "@acompanhe/shared";

import type { Config } from "../config.js";
import type { Entitlements } from "../entitlements.js";
import type { JwtService } from "../security/jwt.js";
import { HttpError, makeInvestigaService, type CreateCaseInput } from "../osint/service.js";
import { todayUtc, type QuotaGate } from "../osint/quota.js";
import type { InvestigaStore } from "../osint/store.js";
import type { SherlockExec } from "../osint/sherlock.js";
import { sha256Hex } from "../osint/hash.js";
import type { OsintTargetKind } from "@acompanhe/shared";
import { buscarJuridicoDoCaso, casoAPartirDeProcesso } from "../osint/juridico.js";
import { PLANS_WITH_JURIDICA } from "./processos.js";

/** 24/10: documento digitado no app → kind de alvo real (sem inventar tipo). */
function inferTargetKind(value: string): OsintTargetKind {
  const v = value.trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return "email";
  if (/^https?:\/\//i.test(v)) return "url";
  if (/^\+?[\d\s().-]{10,20}$/.test(v)) return "phone";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)) return "domain";
  return "name";
}

const targetSchema = z.object({
  kind: z.enum(["username", "email", "phone", "domain", "name", "url"]),
  value: z.string().min(2).max(320),
});

const createCaseSchema = z.object({
  title: z.string().min(3).max(120),
  targets: z.array(targetSchema).min(1).max(20),
  legalBasis: z.string().min(10).max(500),
  purpose: z.string().min(10).max(500),
});

const runSchema = z.object({
  /** Nomes EXATOS do data.json do Sherlock (case-sensitive; ver doc 11). */
  sites: z.array(z.string().min(1).max(60)).max(25).optional(),
  targetIndexes: z.array(z.number().int().min(0)).max(20).optional(),
});

const trialSchema = z.object({
  telegramId: z.string().min(1).max(32),
});

/** Converte HttpError do serviço em reply; qualquer outro erro segue o
 *  comportamento padrão do Fastify (contrato congelado doc 13 §4). */
function httpFail(reply: FastifyReply, e: unknown): FastifyReply | never {
  if (e instanceof HttpError) return reply.code(e.status).send(e.body);
  throw e;
}

export function investigaRoutes(deps: {
  config: Config;
  store: InvestigaStore;
  quota: QuotaGate;
  entitlements: Entitlements;
  jwt: JwtService;
  /** Injeção para testes (fixture = saída real capturada do sherlock). */
  sherlockExec?: SherlockExec;
  /**
   * União com o Jurídico (25/10). `buscar` é injetável para teste (as fixtures
   * reais do e-SAJ já estão em test/fixtures/esaj); em produção usa a busca de
   * verdade (`pesquisarTerceiros`).
   */
  juridico?: {
    buscar?: typeof buscarJuridicoDoCaso;
    fetchImpl?: typeof fetch;
    ufs?: string[];
  };
}): (app: FastifyInstance) => Promise<void> {
  const { config, quota, entitlements, jwt } = deps;
  const service = makeInvestigaService({
    config,
    store: deps.store,
    quota: deps.quota,
    entitlements: deps.entitlements,
    ...(deps.sherlockExec ? { sherlockExec: deps.sherlockExec } : {}),
  });

  async function requireSubject(req: FastifyRequest): Promise<string | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const claims = await jwt.verify(header.slice("Bearer ".length));
    return claims?.sub ?? null;
  }

  return async (app) => {
    // ————— criação de caso —————
    app.post("/v1/investiga/cases", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const body = createCaseSchema.parse(req.body);
      try {
        const rec = await service.createCase(subjectId, body as CreateCaseInput);
        return reply.code(201).send({ case: rec });
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— lista de casos —————
    app.get("/v1/investiga/cases", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      return { cases: await service.listCases(subjectId) };
    });

    // ————— detalhe —————
    app.get("/v1/investiga/cases/:id", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      try {
        return await service.getDetail(subjectId, id);
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— execução (síncrona em S1; 429 queue-paused no teto) —————
    app.post("/v1/investiga/cases/:id/run", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      const body = runSchema.parse(req.body ?? {});
      try {
        return await service.runCase(subjectId, id, body);
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— documento do caso (24/10): o alvo digitado vira alvo persistido —————
    app.post("/v1/investiga/cases/:id/documents", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      const { content, kind } = z.object({
        content: z.string().min(2).max(200),
        kind: z.enum(["username", "email", "phone", "domain", "name", "url"]).optional(),
      }).parse(req.body ?? {});
      try {
        await service.getDetail(subjectId, id); // dono + entitlement
        const k = kind ?? inferTargetKind(content);
        await deps.store.addTargets(id, [{ kind: k, value: content.trim() }]);
        return reply.code(201).send({
          document: { id: sha256Hex(content.trim()).slice(0, 16), kind: k, ref: content.trim() },
          rule: "documento vira alvo do caso (rodada/relatório passam a cobri-lo)",
        });
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— consulta sobre o documento (roda OSINT real do caso e devolve achado) —————
    app.post("/v1/investiga/cases/:id/queries", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      const { documentId } = z.object({ documentId: z.string().min(1).max(200) }).parse(req.body ?? {});
      try {
        await service.getDetail(subjectId, id);
        await deps.store.addTargets(id, [{ kind: inferTargetKind(documentId), value: documentId.trim() }]);
        await service.runCase(subjectId, id, {});
        const findings = await deps.store.listFindingsForCase(id);
        const alvo = findings.find((f) => JSON.stringify(f).includes(documentId.trim()));
        return {
          finding: alvo ?? findings[0] ?? null,
          findings: findings.length,
          rule: "consulta real (sherlock/email/phone/domain) — achado bruto, sem inventar",
        };
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— estimativa de renda: SEM fonte contratada = recusa honesta (anti-simulação) —————
    app.post("/v1/investiga/cases/:id/estimativa", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      const { nome } = z.object({ nome: z.string().min(2).max(200) }).parse(req.body ?? {});
      try {
        await service.getDetail(subjectId, id);
      } catch (e) {
        return httpFail(reply, e);
      }
      return reply.code(503).send({
        error: `estimativa de renda de "${nome}" indisponível: não há base de dados de renda contratada e nada será estimado sem fonte auditável`,
        rule: "anti-simulação (24/10) — vira 200 só com fonte real",
      });
    });

    // ————— monitoramento: alvo sob observação + rodada + alertas reais de diff —————
    app.post("/v1/investiga/cases/:id/monitor", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      const { nome, topic } = z.object({ nome: z.string().min(2).max(200), topic: z.string().max(120).optional() }).parse(req.body ?? {});
      try {
        await service.getDetail(subjectId, id);
        await deps.store.addTargets(id, [{ kind: "name", value: nome.trim(), label: "monitorado" }]);
        await service.runCase(subjectId, id, {});
        const { alerts } = await service.getAlerts(subjectId, id);
        return {
          monitor: { topic: topic ?? `osint_${id}`, nome: nome.trim() },
          alertas: alerts.length,
          rule: "monitor = alvo monitorado + rodada + diff de achados (alertas reais)",
        };
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— deep-dive: rodada completa + relatório do caso —————
    app.post("/v1/investiga/cases/:id/deep-dive", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      const { nome } = z.object({ nome: z.string().min(2).max(200), extra: z.unknown().optional() }).parse(req.body ?? {});
      try {
        await service.getDetail(subjectId, id);
        await deps.store.addTargets(id, [{ kind: inferTargetKind(nome), value: nome.trim() }]);
        const run = await service.runCase(subjectId, id, {});
        const report = await service.getReport(subjectId, id);
        const findings = await deps.store.listFindingsForCase(id);
        void run;
        return {
          relatorio: report,
          findings: findings.length,
          rule: "deep-dive = rodada real + relatório completo do caso",
        };
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— relatório —————
    app.get("/v1/investiga/cases/:id/report", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      try {
        return { report: await service.getReport(subjectId, id) };
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— alertas (mudanças + achados velhos) —————
    app.get("/v1/investiga/cases/:id/alerts", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      try {
        return await service.getAlerts(subjectId, id);
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— export CSV (máquina) —————
    app.get("/v1/investiga/cases/:id/export.csv", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      try {
        const csv = await service.exportCsv(subjectId, id);
        return reply
          .header("content-type", "text/csv; charset=utf-8")
          .header("content-disposition", `attachment; filename="investiga-${id}.csv"`)
          .send(csv);
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— export PDF (humano/court-ready base) —————
    app.get("/v1/investiga/cases/:id/export.pdf", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { id } = req.params as { id: string };
      try {
        const pdf = await service.exportPdf(subjectId, id);
        return reply
          .header("content-type", "application/pdf")
          .header("content-disposition", `attachment; filename="investiga-${id}.pdf"`)
          .send(pdf);
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— União Jurídico ↔ Investiga (25/10) —————
    // Investiga → Jurídico: os alvos do caso vão para as fontes jurídicas reais
    // (e-SAJ por nome/CPF/CNPJ + DataJud por CNJ) e voltam como achados com
    // proveniência. Gating duplo: o caso tem de ser seu (Investiga) e a conta
    // precisa do plano Jurídico.
    app.post<{ Params: { id: string } }>("/v1/investiga/cases/:id/juridico", async (req, reply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const caso = await deps.store.getCase(req.params.id);
      if (!caso || caso.subjectId !== subjectId) return reply.code(404).send({ error: "caso não encontrado" });
      if (!(await entitlements.isEntitled(subjectId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({
          error: "plano Consulta Jurídica ativo é necessário para consultar as fontes do Jurídico",
          rule: "v2/08 §9.5",
        });
      }
      const buscar = deps.juridico?.buscar ?? buscarJuridicoDoCaso;
      const r = await buscar(caso, {
        ...(deps.juridico?.fetchImpl ? { fetchImpl: deps.juridico.fetchImpl } : {}),
        ...(deps.juridico?.ufs ? { ufs: deps.juridico.ufs } : {}),
      });
      const gravados = r.achados.length > 0 ? await deps.store.addFindings(r.achados) : [];
      return reply.send({
        casoId: caso.id,
        porAlvo: r.porAlvo,
        gravados: gravados.length,
        achados: gravados,
        avisos: r.avisos,
        rule: "juridico→investiga (status da fonte traduzido, nunca arredondado)",
      });
    });

    app.get<{ Params: { id: string } }>("/v1/investiga/cases/:id/juridico", async (req, reply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const caso = await deps.store.getCase(req.params.id);
      if (!caso || caso.subjectId !== subjectId) return reply.code(404).send({ error: "caso não encontrado" });
      const todos = await deps.store.listFindingsForCase(caso.id);
      const juridicos = todos.filter((f) => f.sourceId.startsWith("juridico:"));
      return reply.send({
        casoId: caso.id,
        total: juridicos.length,
        achados: juridicos,
        processos: [
          ...new Set(
            juridicos
              .map((f) => (f.raw as { numeroProcesso?: string } | undefined)?.numeroProcesso)
              .filter((n): n is string => typeof n === "string"),
          ),
        ],
      });
    });

    // Jurídico → Investiga: processo com parte identificada abre caso OSINT.
    // A criação passa pelo serviço (entitlement do Investiga + limite de casos
    // ativos) — a regra não é duplicada aqui.
    app.post("/v1/investiga/cases/from-processo", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const body = z
        .object({
          numeroProcesso: z.string().min(7).max(30),
          nomeParte: z.string().min(3).max(320),
          uf: z.string().min(2).max(10).nullish(),
          participacao: z.string().max(80).nullish(),
          baseLegal: z.string().min(10).max(500).nullish(),
          finalidade: z.string().min(10).max(500).nullish(),
          titulo: z.string().min(3).max(120).nullish(),
        })
        .parse(req.body);
      const entrada = casoAPartirDeProcesso({
        numeroProcesso: body.numeroProcesso,
        nomeParte: body.nomeParte,
        ...(body.uf !== undefined ? { uf: body.uf } : {}),
        ...(body.participacao !== undefined ? { participacao: body.participacao } : {}),
        ...(body.baseLegal !== undefined ? { baseLegal: body.baseLegal } : {}),
        ...(body.finalidade !== undefined ? { finalidade: body.finalidade } : {}),
        ...(body.titulo !== undefined ? { titulo: body.titulo } : {}),
      });
      if (!entrada) {
        return reply.code(422).send({
          error: "a fonte não devolveu parte identificável neste processo — sem nome não há alvo para investigar",
          rule: "nada de alvo inventado",
        });
      }
      try {
        const rec = await service.createCase(subjectId, entrada as CreateCaseInput);
        return reply.code(201).send({ case: rec, origem: "juridico", processo: body.numeroProcesso, rule: "processo → caso OSINT" });
      } catch (e) {
        return httpFail(reply, e);
      }
    });

    // ————— quota do dia —————
    app.get("/v1/investiga/quota", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireSubject(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const day = todayUtc();
      return {
        window: quota.window(subjectId, day),
        limits: INVESTIGA_LIMITS,
        planQuota: INVESTIGA_QUOTA,
      };
    });

    // ————— trial 7d (diretor; 1x por usuário) —————
    app.post("/v1/admin/investiga/trial", async (req: FastifyRequest, reply: FastifyReply) => {
      const adminToken = req.headers["x-admin-token"];
      if (!config.ADMIN_TOKEN || adminToken !== config.ADMIN_TOKEN) {
        return reply.code(403).send({ error: "apenas o diretor (X-Admin-Token)" });
      }
      const body = trialSchema.parse(req.body);
      const result = await entitlements.useTrial(body.telegramId, INVESTIGA_LIMITS.trialDays);
      if (!result.ok) {
        return reply.code(409).send({
          error: "trial já registrado para este usuário (uma única vez)",
          rule: "v2/08 §9.5",
        });
      }
      return reply.code(201).send({
        trial: {
          telegramId: body.telegramId,
          until: result.record?.expiresAt ?? null,
          days: INVESTIGA_LIMITS.trialDays,
          sku: "investiga:trial",
        },
      });
    });
  };
}
