/**
 * Rotas da Assessoria jurídica (plano.md §4.4) — doc 03 §6.
 * POST /api/processos/{cnj}/acompanhar — RB1: duplicidade → 409 + link do caso.
 * GET  /api/processos — lista do usuário.
 * POST /api/processos/{cnj}/sync — RF-B03: movimentos DataJud (RB3 sigilo, RB5 dedupe).
 * POST /api/juridico/consultas — RF-B07: só OAB verificada; RF-B08: rodapé.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { makeJuridicoService, RODAPE_INFORMATIVO, type LegalStore } from "../juridico/service.js";
import { isValidCnj, aliasFromTribunal, parseCnj, formatCnj } from "../juridico/cnj.js";
import { mapDoc } from "../juridico/service.js";
import { responderPergunta, resumoProcesso } from "../juridico/assistente.js";
import { alertDedupeKey, type AlertSink } from "../jobs/dispatcher.js";
import type { LegalEventDto } from "../juridico/types.js";
import type { DatajudClientOpts } from "../juridico/datajud.js";
import type { JwtService } from "../security/jwt.js";
import type { Entitlements } from "../entitlements.js";

/** SKUs da Consulta Jurídica (v2/08 §9.5; sem pack avulso — AVULSOS só tem investigaPack). */
export const PLANS_WITH_JURIDICA = ["juridica", "juridica:trial"];

export interface ProcessosDeps {
  jwt: JwtService;
  store: LegalStore;
  adminToken: string;
  entitlements: Entitlements;
  oabVerified?: Set<string>;
  datajud?: typeof import("../juridico/datajud.js").fetchProcessos;
  datajudOpts?: DatajudClientOpts;
  /** RF-B04 — alertas de movimentação (dispatcher → worker → Telegram). */
  alertSink?: AlertSink;
  now?: () => Date;
}

const perguntaSchema = z.object({ question: z.string().min(3).max(500) });

const acompanharSchema = z.object({
  role: z.enum(["ativo", "passivo", "outro"]).default("outro"),
  alias: z.string().min(2).max(40).optional(),
  oab: z.string().max(20).optional(),
});

const consultaSchema = z.object({
  cnj: z.string().optional(),
  question: z.string().min(5).max(2000),
  oabUser: z.string().max(64).optional(),
});

export function processosRoutes(deps: ProcessosDeps) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const service = makeJuridicoService({
      store: deps.store,
      ...(deps.oabVerified ? { oabVerified: deps.oabVerified } : {}),
      ...(deps.datajud ? { datajud: deps.datajud } : {}),
      ...(deps.datajudOpts ? { datajudOpts: deps.datajudOpts } : {}),
      ...(deps.alertSink ? { alertSink: deps.alertSink } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });

    async function requireUser(req: FastifyRequest): Promise<string | null> {
      const h = req.headers.authorization;
      if (!h?.startsWith("Bearer ")) return null;
      try {
        const claims = await deps.jwt.verify(h.slice(7));
        return claims?.sub ?? null;
      } catch {
        return null;
      }
    }

    app.get("/api/processos", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const casos = await service.listar(userId);
      return reply.send({ processos: casos, rule: "RB1/RB2" });
    });

    app.post("/api/processos/:cnj/acompanhar", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const { cnj } = req.params as { cnj: string };
      const decoded = decodeURIComponent(cnj);
      if (!isValidCnj(decoded)) return reply.code(422).send({ error: "número CNJ inválido (DV Res. 65/2008)", rule: "RF-B01" });
      const body = acompanharSchema.parse(req.body ?? {});
      const parts = parseCnj(decoded)!;
      const alias = body.alias ?? aliasFromTribunal(parts.justica, parts.tribunal);
      const r = await service.acompanhar(userId, formatCnj(parts), body.role, alias ?? null);
      if (!r.created) return reply.code(409).send({ error: "já acompanhado", link: r.link, rule: "RB1" });
      return reply.code(201).send({ caseId: r.caseId, link: r.link, alias, rule: "RF-B02" });
    });

    // RF-B08 — explicação IA de movimento (rodapé obrigatório; nunca parecer)
    app.get("/api/processos/:cnj/explicar", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!(await deps.entitlements.isEntitled(userId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({ error: "plano Consulta Jurídica ativo é necessário", rule: "v2/08 §9.5" });
      }
      const { mov } = z.object({ mov: z.string().min(2).max(120) }).parse(req.query ?? {});
      return reply.send({ explicacao: service.explicarMovimento(mov), atos: [], rule: "RF-B08 · sempre com rodapé" });
    });

    // E2E 23/10: o link devolvido por acompanhar/RB1 (/api/processos/:cnj) apontava
    // p/ rota inexistente (404) e os movimentos não tinham superfície HTTP.
    app.get("/api/processos/:cnj", async (req: FastifyRequest, reply: FastifyReply) => {
      const subjectId = await requireUser(req);
      if (!subjectId) return reply.code(401).send({ error: "não autenticado" });
      const { cnj } = req.params as { cnj: string };
      const processo = await deps.store.getCase(subjectId, decodeURIComponent(cnj));
      if (!processo) return reply.code(404).send({ error: "não acompanhado" });
      const movimentos = await deps.store.listEvents(processo.id);
      const resumo = resumoProcesso({ caso: processo, movimentos });
      return reply.send({ processo, movimentos, resumo, rule: "RF-B03/RB5 · eventos com dedupe" });
    });

    // ── Buscar (pré-visualizar SEM registrar) — botão 🔎 ──
    app.get("/api/processos/buscar", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!(await deps.entitlements.isEntitled(userId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({ error: "plano Consulta Jurídica ativo é necessário", rule: "v2/08 §9.5" });
      }
      const q = z
        .object({ cnj: z.string().min(7).max(30), alias: z.string().min(2).max(40).optional() })
        .parse(req.query ?? {});
      const decoded = decodeURIComponent(q.cnj);
      if (!isValidCnj(decoded)) return reply.code(422).send({ error: "número CNJ inválido (DV Res. 65/2008)", rule: "RF-B01" });
      const parts = parseCnj(decoded)!;
      const alias = q.alias ?? aliasFromTribunal(parts.justica, parts.tribunal);
      if (!alias) return reply.code(422).send({ error: "alias do tribunal desconhecido — informe alias", rule: "RF-B02" });
      const fetchProcessos = deps.datajud ?? (await import("../juridico/datajud.js")).fetchProcessos;
      const docs = await fetchProcessos(alias, { numeroProcesso: formatCnj(parts).replace(/\D/g, "") }, deps.datajudOpts ?? {});
      const d = docs[0];
      if (!d) return reply.code(404).send({ error: "processo não encontrado no DataJud", rule: "fonte pública CNJ" });
      const caso = mapDoc(d, alias);
      const movimentos: LegalEventDto[] = (d.movimentos ?? []).map((m) => ({
        numeroProcesso: formatCnj(parts),
        codigo: m.codigo,
        nome: m.nome,
        dataHora: m.dataHora,
        tribunal: alias,
      }));
      const resumo = resumoProcesso({ caso, movimentos });
      // NADA é gravado: busca é só pré-visualização (o registro é o Acompanhar).
      return reply.send({ processo: caso, movimentos, resumo, rodape: RODAPE_INFORMATIVO, rule: "buscar = preview sem registro" });
    });

    // ── Perguntar ao assistente (grounded) — botão 💬 Explicar / chat ──
    app.post("/api/processos/:cnj/perguntar", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!(await deps.entitlements.isEntitled(userId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({ error: "plano Consulta Jurídica ativo é necessário", rule: "v2/08 §9.5" });
      }
      const { cnj } = req.params as { cnj: string };
      const decoded = decodeURIComponent(cnj);
      const { question } = perguntaSchema.parse(req.body ?? {});
      // Caso acompanhado → dados persistidos; senão → consulta ao DataJud (sem gravar).
      const caso = await deps.store.getCase(userId, decoded);
      let movimentos: LegalEventDto[] = [];
      if (caso) {
        movimentos = await deps.store.listEvents(caso.id);
      } else {
        const parts = parseCnj(decoded);
        if (!parts || !isValidCnj(decoded)) return reply.code(422).send({ error: "número CNJ inválido" });
        const alias = aliasFromTribunal(parts.justica, parts.tribunal) ?? (req.query as { alias?: string } | undefined)?.alias;
        if (!alias) return reply.code(422).send({ error: "alias do tribunal desconhecido — informe alias", rule: "RF-B02" });
        const fetchProcessos = deps.datajud ?? (await import("../juridico/datajud.js")).fetchProcessos;
        const docs = await fetchProcessos(alias, { numeroProcesso: decoded.replace(/\D/g, "") }, deps.datajudOpts ?? {});
        const d = docs[0];
        if (!d) return reply.code(404).send({ error: "processo não encontrado no DataJud" });
        const mapped = mapDoc(d, alias);
        movimentos = (d.movimentos ?? []).map((m) => ({ numeroProcesso: decoded, codigo: m.codigo, nome: m.nome, dataHora: m.dataHora, tribunal: alias }));
        const r = responderPergunta(question, { caso: mapped, movimentos });
        return reply.send({ ...r, acompanhado: false });
      }
      const r = responderPergunta(question, { caso, movimentos });
      return reply.send({ ...r, acompanhado: true });
    });

    // ── Alertar (RF-B04) — botão 🔔 ──
    app.post("/api/processos/:cnj/alertar", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const { cnj } = req.params as { cnj: string };
      const decoded = decodeURIComponent(cnj);
      const caso = await deps.store.getCase(userId, decoded);
      if (!caso) return reply.code(404).send({ error: "acompanhe o processo primeiro (botão Acompanhar)", rule: "RF-B04" });
      if (!caso.alertasAtivos) await deps.store.updateCase(userId, decoded, { alertasAtivos: true });
      // Confirmação auditável no mesmo pipeline dos alertas (idempotente por dedupe).
      if (deps.alertSink) {
        await deps.alertSink.emit({
          userId,
          kind: "prazo_alerta",
          refId: decoded,
          detail: `alertas de movimentação ativados para ${decoded}`,
          dedupeKey: alertDedupeKey(userId, "prazo_alerta", decoded, "alertar-on"),
        });
      }
      const alertas = deps.alertSink ? await deps.alertSink.list(userId) : [];
      return reply.send({ alertasAtivos: true, alertas: alertas.slice(-10), rule: "RF-B04 · alerta consolidado por janela" });
    });

    app.post("/api/processos/:cnj/sync", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      const { cnj } = req.params as { cnj: string };
      const decoded = decodeURIComponent(cnj);
      const parts = parseCnj(decoded);
      if (!parts) return reply.code(422).send({ error: "número CNJ inválido" });
      const body = (req.body ?? {}) as { alias?: string };
      const alias = body.alias ?? aliasFromTribunal(parts.justica, parts.tribunal);
      if (!alias) return reply.code(422).send({ error: "alias do tribunal desconhecido — informe alias", rule: "RF-B02" });
      try {
        const r = await service.sincronizar(userId, formatCnj(parts), alias);
        return reply.send({ ...r, rodape: RODAPE_INFORMATIVO, rule: "RF-B03/RB3/RB5" });
      } catch (e) {
        return reply.code(502).send({ error: String((e as Error).message ?? e) });
      }
    });

    app.post("/api/juridico/consultas", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!(await deps.entitlements.isEntitled(userId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({ error: "plano Consulta Jurídica ativo é necessário", rule: "v2/08 §9.5" });
      }
      const body = consultaSchema.parse(req.body ?? {});
      try {
        const r = await service.solicitarConsulta(userId, body.cnj ?? null, body.question, body.oabUser ?? null);
        if ("consolidado" in r && r.consolidado) {
          return reply.code(200).send({ consolidado: true, aviso: r.aviso, rodape: r.rodape, rule: "RF-B07/B08 · RB4 janela 6h" });
        }
        return reply.code(201).send({ consulta: r, rodape: RODAPE_INFORMATIVO, rule: "RF-B07/B08" });
      } catch (e) {
        return reply.code(403).send({ error: String((e as Error).message ?? e), rule: "RF-B07" });
      }
    });

    app.get("/api/juridico/consultas", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      return reply.send({ consultas: await deps.store.listAdvices(userId), rodape: RODAPE_INFORMATIVO });
    });

    /** Painel do diretor: registrar advogado com OAB VERIFICADA. */
    app.post("/v1/admin/juridico/oab/verificar", async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.headers["x-admin-token"] !== deps.adminToken) return reply.code(403).send({ error: "admin only" });
      const { oabUser } = z.object({ oabUser: z.string().min(3).max(64) }).parse(req.body ?? {});
      service.oabVerified.add(oabUser);
      return reply.send({ oabUser, verified: true });
    });
  };
}
