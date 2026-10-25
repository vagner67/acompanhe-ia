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
import { isValidCnj, aliasFromTribunal, aliasCandidatesFromCnj, parseCnj, formatCnj, formatarNumero } from "../juridico/cnj.js";
import { detectarConsulta } from "../juridico/deteccao.js";
import { mapDoc } from "../juridico/service.js";
import { responderPergunta, resumoProcesso } from "../juridico/assistente.js";
import { alertDedupeKey, type AlertSink } from "../jobs/dispatcher.js";
import type { LegalEventDto } from "../juridico/types.js";
import type { DatajudClientOpts } from "../juridico/datajud.js";
import { INGEST_LOTE } from "../juridico/limites.js";
import { readServiceToken } from "../service-token.js";
import { avaliarRisco } from "../juridico/risco.js";
import { cobertura, FONTES_INFO } from "../juridico/fontes.js";
import { ranquear, type IndiceStore } from "../juridico/indice.js";
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
  /** Índice próprio (plano-refatoracao §6.2) — base do buscador do Jurídico. */
  indice?: IndiceStore;
  /** Token de serviço para rotas de ingestão em lote (job/ops). */
  serviceToken?: () => string | null;
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
      // 91 tribunais: a corte do (J,TR) + a superior do ramo (superiores guardam
      // números de ORIGEM; 5.01 = TRT1 e TST convivem) — mapa verificado 24/10/2026.
      const candidatos = q.alias ? [q.alias] : aliasCandidatesFromCnj(parts.justica, parts.tribunal);
      if (candidatos.length === 0) {
        return reply.code(422).send({
          error: parts.justica === "1"
            ? "STF não publica no DataJud (os 91 índices públicos não incluem o STF) — consulte em https://portal.stf.jus.br/processos/"
            : "tribunal sem índice público conhecido — informe alias",
          rule: "RF-B02",
        });
      }
      const fetchProcessos = deps.datajud ?? (await import("../juridico/datajud.js")).fetchProcessos;
      let d: ReturnType<typeof mapDoc> | null = null;
      let alias = candidatos[0]!;
      let movimentos: LegalEventDto[] = [];
      for (const cand of candidatos) {
        const docs = await fetchProcessos(cand, { numeroProcesso: formatCnj(parts).replace(/\D/g, "") }, deps.datajudOpts ?? {});
        if (docs[0]) {
          alias = cand;
          const m = mapDoc(docs[0], cand);
          d = m;
          movimentos = (docs[0].movimentos ?? []).map((mm) => ({
            numeroProcesso: formatCnj(parts),
            codigo: mm.codigo,
            nome: mm.nome,
            dataHora: mm.dataHora,
            tribunal: cand,
          }));
          break;
        }
      }
      if (!d) return reply.code(404).send({ error: "processo não encontrado no DataJud", rule: "fonte pública CNJ" });
      const caso = d;
      const resumo = resumoProcesso({ caso, movimentos });
      // NADA é gravado: busca é só pré-visualização (o registro é o Acompanhar).
      return reply.send({ processo: caso, movimentos, resumo, rodape: RODAPE_INFORMATIVO, rule: "buscar = preview sem registro" });
    });

    // ── Busca unificada por NOME/CPF/CNPJ → processos de terceiros (plano-busca-unificada §3.4) ──
    app.get("/api/processos/pesquisar", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!(await deps.entitlements.isEntitled(userId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({ error: "plano Consulta Jurídica ativo é necessário", rule: "v2/08 §9.5" });
      }
      const q = z
        .object({
          q: z.string().min(3).max(120),
          uf: z.string().min(2).max(10).optional(),
          pagina: z.coerce.number().int().min(1).max(10).optional(),
        })
        .parse(req.query ?? {});
      const det = detectarConsulta(decodeURIComponent(q.q));
      if (det.erro) return reply.code(422).send({ error: det.erro, rule: "deteccao/DV real" });
      if (det.tipo === "cnj") {
        return reply.code(422).send({ error: "número de processo — use a busca de processo do app", rule: "deteccao" });
      }
      // UF fora da cobertura verificada → busca em TODAS as fontes verificadas,
      // com advertência honesta do motivo (nunca "erro" silencioso — plano-busca-unificada §3.4).
      const ufPedida = q.uf && q.uf.toLowerCase() !== "todas" ? q.uf.toLowerCase() : undefined;
      const { pesquisarTerceiros, COBERTURA_UFS } = await import("../juridico/pesquisa.js");
      const ufCoberta = !ufPedida || COBERTURA_UFS.includes(ufPedida);
      const ufs = ufPedida && ufCoberta ? [ufPedida] : undefined;
      const r = await pesquisarTerceiros(det.tipo as "nome" | "cpf" | "cnpj", det.valor, {
        ...(ufs ? { ufs } : {}),
        ...(q.pagina ? { pagina: q.pagina } : {}),
        ...(deps.datajudOpts?.fetchImpl ? { fetchImpl: deps.datajudOpts.fetchImpl } : {}),
      });
      const advertencias = [
        ...(det.advertencia ? [det.advertencia] : []),
        ...(ufPedida && !ufCoberta
          ? [`tribunal ${ufPedida.toUpperCase()} ainda não está conectado — cobertura atual: ${[...COBERTURA_UFS].sort().map((u) => u.toUpperCase()).join(", ").replace(/, ([^,]*)$/, " e $1")}; a busca foi feita nas fontes verificadas`]
          : []),
      ];
      return reply.send({
        tipo: det.tipo,
        ...(det.formato ? { formato: det.formato } : {}),
        ...(advertencias.length ? { advertencia: advertencias.join(" · ") } : {}),
        fontes: r.fontes,
        itens: r.itens,
        rodape: r.rodape,
      });
    });

    // ── Cruzamento real com DataJud dos CNJs achados na pesquisa (plano-busca-unificada §3.4) ──
    app.get("/api/processos/detalhes-lote", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!(await deps.entitlements.isEntitled(userId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({ error: "plano Consulta Jurídica ativo é necessário", rule: "v2/08 §9.5" });
      }
      const q = z.object({ cnjs: z.string().min(7).max(2000) }).parse(req.query ?? {});
      const lista = decodeURIComponent(q.cnjs)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (lista.length < 1 || lista.length > 30) {
        return reply.code(422).send({ error: "informe de 1 a 30 números CNJ separados por vírgula", rule: "lote" });
      }
      for (const c of lista) {
        if (!isValidCnj(c)) return reply.code(422).send({ error: `número CNJ inválido: ${c}`, rule: "RF-B01" });
      }
      const fetchProcessos = deps.datajud ?? (await import("../juridico/datajud.js")).fetchProcessos;
      const { detalharProcessos } = await import("../juridico/pesquisa.js");
      const itens = await detalharProcessos(lista, {
        datajud: fetchProcessos,
        ...(deps.datajudOpts ? { datajudOpts: deps.datajudOpts } : {}),
      });
      return reply.send({ itens, rodape: RODAPE_INFORMATIVO });
    });

    // ── Modo IA de buscador no chat (plano-91-tribunais-ia §1.3): pesquisa web
    //    REAL com fontes citadas. Sem AI_PROVIDER/AI_API_KEY → resultados DuckDuckGo
    //    reais (geradaPorIA=false); com chave (tavily|perplexity|gemini) → resposta
    //    gerada + fontes. Nunca resposta sem fonte.
    app.post("/api/processos/buscar-web", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!(await deps.entitlements.isEntitled(userId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({ error: "plano Consulta Jurídica ativo é necessário", rule: "v2/08 §9.5" });
      }
      const { pergunta } = z.object({ pergunta: z.string().min(3).max(300) }).parse(req.body ?? {});
      const { responderComBuscador } = await import("../juridico/buscaIA.js");
      const r = await responderComBuscador(pergunta, {
        ...(deps.datajudOpts?.fetchImpl ? { fetchImpl: deps.datajudOpts.fetchImpl } : {}),
      });
      return reply.send({ ...r, rodape: RODAPE_INFORMATIVO });
    });

    // ── Catálogo de fontes: cobertura REAL exibida na tela (padrão P7) ──
    app.get("/api/processos/fontes", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      return reply.send({
        fontes: FONTES_INFO,
        cobertura: cobertura(),
        rodape: RODAPE_INFORMATIVO,
        rule: "catálogo = cobertura verificada; nada anunciado sem verificadoEm",
      });
    });

    // ── Busca no ÍNDICE PRÓPRIO (pipeline P1/P2/P3 do plano-refatoracao §6.2–6.3) ──
    app.get("/api/processos/indice", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!(await deps.entitlements.isEntitled(userId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({ error: "plano Consulta Jurídica ativo é necessário", rule: "v2/08 §9.5" });
      }
      const q = z
        .object({
          q: z.string().min(3).max(120),
          uf: z.string().min(2).max(2).optional(),
          tribunal: z.string().min(2).max(40).optional(),
          ano: z.string().length(4).optional(),
        })
        .parse(req.query ?? {});
      if (!deps.indice) return reply.code(503).send({ error: "índice indisponível neste ambiente", rule: "indice" });
      const det = detectarConsulta(decodeURIComponent(q.q));
      if (det.erro) return reply.code(422).send({ error: det.erro, rule: "deteccao/DV real" });
      const filtros = {
        ...(q.uf ? { uf: q.uf.toLowerCase() } : {}),
        ...(q.tribunal ? { tribunal: q.tribunal.toLowerCase() } : {}),
        ...(q.ano ? { ano: q.ano } : {}),
        limite: 30,
      };
      const busca =
        det.tipo === "cnj"
          ? { numero: formatarNumero(det.valor) ?? det.valor, ...filtros }
          : det.tipo === "cpf" || det.tipo === "cnpj"
            ? { documento: det.valor, ...filtros }
            : { nome: det.valor, ...filtros };
      const brutos = await deps.indice.buscar(busca);
      const itens = ranquear(brutos, busca);
      const facetas = await deps.indice.facetas(busca);
      const total = await deps.indice.total();
      const advertencias: string[] = [];
      if (det.tipo !== "cnj") {
        const soNome = itens.every((i) => i.motivo === "sem_documento");
        if (itens.length > 0 && soNome) {
          advertencias.push(
            "os vínculos abaixo foram feitos por NOME — a fonte não informou o documento, então pode haver homônimos; o grau de certeza de cada item está indicado",
          );
        }
        if (itens.length === 0) {
          advertencias.push(
            "o índice só contém nomes que as fontes públicas publicaram ou processos que você acompanha — busque também nas fontes ao vivo (🔎 Buscar / 🔬 Pesquisa profunda)",
          );
        }
      }
      return reply.send({
        tipo: det.tipo,
        itens,
        facetas,
        totalNoIndice: total,
        ...(advertencias.length ? { advertencia: advertencias.join(" · ") } : {}),
        rodape: RODAPE_INFORMATIVO,
        rule: "índice próprio: vínculo com score e motivo, nunca afirmação sem base",
      });
    });

    // ── Ingestão do índice em lote (job/ops) — protegida por token de serviço ──
    app.post("/api/processos/indice/ingest", async (req: FastifyRequest, reply: FastifyReply) => {
      const esperado = deps.serviceToken?.() ?? readServiceToken();
      const recebido = (req.headers["x-service-token"] as string | undefined) ?? "";
      if (!esperado || recebido !== esperado) return reply.code(401).send({ error: "token de serviço inválido" });
      if (!deps.indice) return reply.code(503).send({ error: "índice indisponível neste ambiente" });
      const { numeros } = z
        .object({ numeros: z.array(z.string().min(7).max(30)).min(INGEST_LOTE.min).max(INGEST_LOTE.max) })
        .parse(req.body ?? {});
      const { ingerirPorNumeros } = await import("../juridico/ingestao.js");
      const fetchProcessos = deps.datajud ?? (await import("../juridico/datajud.js")).fetchProcessos;
      const r = await ingerirPorNumeros(
        numeros,
        { datajud: fetchProcessos, ...(deps.datajudOpts ? { datajudOpts: deps.datajudOpts } : {}) },
        deps.now ? deps.now() : new Date(),
      );
      const gravados = await deps.indice.upsertMuitos(r.ingeridos);
      return reply.send({
        gravados,
        naoEncontrados: r.naoEncontrados,
        invalidos: r.invalidos,
        totalNoIndice: await deps.indice.total(),
      });
    });

    // ── Motor de risco determinístico (padrão "motor de decisão", §6.6) ──
    app.post("/api/processos/risco", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await requireUser(req);
      if (!userId) return reply.code(401).send({ error: "não autenticado" });
      if (!(await deps.entitlements.isEntitled(userId, PLANS_WITH_JURIDICA))) {
        return reply.code(403).send({ error: "plano Consulta Jurídica ativo é necessário", rule: "v2/08 §9.5" });
      }
      if (!deps.indice) return reply.code(503).send({ error: "índice indisponível neste ambiente" });
      const body = z
        .object({ q: z.string().min(3).max(120).optional(), cnjs: z.array(z.string().min(7).max(30)).max(50).optional() })
        .parse(req.body ?? {});
      if (!body.q && !body.cnjs) return reply.code(422).send({ error: "informe q (nome/CPF/número) ou cnjs", rule: "risco" });
      const coletados: Array<{
        numeroCnj: string;
        classe: string | null;
        status: string | null;
        valorCausa: number | null;
        dataAjuizamento: string | null;
        polo: string | null;
        nivelSigilo: number | null;
      }> = [];
      if (body.cnjs) {
        for (const cnj of body.cnjs) {
          const [p] = await deps.indice.buscar({ numero: cnj, limite: 1 });
          if (!p) continue;
          coletados.push({
            numeroCnj: p.numeroCnj,
            classe: p.classe,
            status: p.status,
            valorCausa: p.valorCausa,
            dataAjuizamento: p.dataAjuizamento,
            polo: p.partes[0]?.polo ?? null,
            nivelSigilo: null,
          });
        }
      } else if (body.q) {
        const det = detectarConsulta(body.q);
        if (det.erro) return reply.code(422).send({ error: det.erro, rule: "deteccao/DV real" });
        const busca =
          det.tipo === "cnj"
            ? { numero: formatarNumero(det.valor) ?? det.valor, limite: 50 }
            : det.tipo === "cpf" || det.tipo === "cnpj"
              ? { documento: det.valor, limite: 50 }
              : { nome: det.valor, limite: 50 };
        const itens = ranquear(await deps.indice.buscar(busca), busca);
        for (const it of itens) {
          const p = it.processo;
          coletados.push({
            numeroCnj: p.numeroCnj,
            classe: p.classe,
            status: p.status,
            valorCausa: p.valorCausa,
            dataAjuizamento: p.dataAjuizamento,
            polo: it.parteEncontrada ? (p.partes.find((x) => x.nome === it.parteEncontrada)?.polo ?? null) : null,
            nivelSigilo: null,
          });
        }
      }
      const avaliacao = avaliarRisco(coletados, deps.now ? deps.now() : new Date());
      return reply.send({
        ...avaliacao,
        considerados: coletados.length,
        rodape: RODAPE_INFORMATIVO,
        rule: "score determinístico e auditável — cada ponto tem regra e processo de origem",
      });
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
