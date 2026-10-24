/**
 * Assessoria jurídica — serviço (plano.md §4).
 * RB1: (userId, cnj) única — duplicidade rejeitada com link do caso.
 * RB2: legal_events append-only (correção = registro novo, nunca edita).
 * RB3: sigilo > 0 → "processo sigiloso — dados limitados" (nunca vazar detalhe).
 * RB4: 1 consulta consolidada por usuário-tribunal/6h.
 * RB5: dedupe hash(numeroProcesso+codigoMovimento+dataHora).
 * RF-B07: consulta humana só a advogado com OAB verificada.
 * RF-B08: explicação IA sempre com rodapé "conteúdo informativo, não é parecer
 * jurídico" — parecer é ato privativo (Lei 8.906/1994, art. 1º).
 */
import { createHash } from "node:crypto";

import type { DatajudDoc, LegalCaseDto, LegalEventDto, ProcessoFilter } from "./types.js";
import { alertDedupeKey } from "../jobs/dispatcher.js";

export const RODAPE_INFORMATIVO = "conteúdo informativo, não é parecer jurídico";
export const SIGILO_MSG = "processo sigiloso — dados limitados";
export const CONSOLIDATION_MS = 6 * 60 * 60 * 1000; // RB4

export function dedupeHash(numeroProcesso: string, codigo: number | string, dataHora: string): string {
  return createHash("sha256").update(`${numeroProcesso}|${codigo}|${dataHora}`).digest("hex");
}

/** RB5 — mesmo movimento publicado duas vezes = hash igual. */
export function movementDedupeHash(numeroProcesso: string, mov: { codigo: number; dataHora: string }): string {
  return dedupeHash(numeroProcesso, mov.codigo, mov.dataHora);
}

function tribunalOf(caso: { tribunal: string }): string {
  return caso.tribunal;
}

export function mapDoc(doc: DatajudDoc, tribunal: string): LegalCaseDto {
  const sigilo = doc.nivelSigilo ?? 0;
  const movs = [...(doc.movimentos ?? [])].sort((a, b) => (a.dataHora < b.dataHora ? 1 : -1));
  const ultimo = movs[0];
  const arquivado = movs.some((m) => /arquivamento|baixa definitiva/i.test(m.nome));
  const suspenso = !arquivado && movs.some((m) => /suspens[ãa]o/i.test(m.nome));
  const status: LegalCaseDto["status"] = arquivado ? "arquivado" : suspenso ? "suspenso" : movs.length ? "ativo" : "desconhecido";
  return {
    numeroProcesso: doc.numeroProcesso,
    grau: doc.grau,
    classe: sigilo > 0 ? SIGILO_MSG : doc.classe?.nome ?? "(sem classe)",
    assunto: sigilo > 0 ? null : doc.assunto?.nome ?? null,
    orgaoJulgador: sigilo > 0 ? SIGILO_MSG : doc.orgaoJulgador?.nome ?? "(sem órgão)",
    orgaoCodigo: doc.orgaoJulgador?.codigo ?? null,
    municipioIbge: doc.orgaoJulgador?.codigoMunicipioIBGE ?? null,
    dataAjuizamento: isoFromCnj(doc.dataAjuizamento),
    valorDaCausa: sigilo > 0 ? null : doc.valores?.valorDaCausa ?? null,
    nivelSigilo: sigilo,
    status,
    tribunal,
    ultimoMovimento: sigilo > 0 || !ultimo ? null : { codigo: ultimo.codigo, nome: ultimo.nome, dataHora: ultimo.dataHora },
    movimentosCount: sigilo > 0 ? 0 : movs.length,
    fieldStatus: "pendente",
    // Sempre false aqui: sincronizar() preserva o flag real do caso (não zera).
    alertasAtivos: false,
    raw: sigilo > 0 ? { sigiloso: true } : doc,
  };
}

/** "20140805000000" → ISO (contrato real do DataJud). */
export function isoFromCnj(yyyymmddHHmmss: string): string {
  const s = yyyymmddHHmmss;
  if (!/^\d{14}$/.test(s)) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}.000Z`;
}

export interface LegalStore {
  createCase(c: LegalCaseDto & { userId: string; role: string; alias: string | null }): Promise<{ id: string; created: boolean }>;
  getCase(userId: string, numeroProcesso: string): Promise<(LegalCaseDto & { id: string; userId: string; role: string }) | undefined>;
  /** Atualiza a PROJEÇÃO do caso (mapDoc do DataJud) após sync — E2E 23/10. */
  updateCase(userId: string, numeroProcesso: string, patch: Partial<LegalCaseDto>): Promise<void>;
  listCases(userId: string): Promise<Array<LegalCaseDto & { id: string }>>;
  appendEvent(
    caseId: string,
    ev: { source: string; code: string | null; occurredAt: string; description: string; raw?: unknown },
  ): Promise<{ id: string; inserted: boolean }>; // inserted=false = RB5 dedupe
  listEvents(caseId: string): Promise<LegalEventDto[]>;
  createAdvice(a: {
    caseId: string | null;
    userId: string;
    question: string;
    oabUser: string | null;
    status: string;
    scheduledAt: string | null;
  }): Promise<{ id: string }>;
  listAdvices(userId: string): Promise<Array<{ id: string; question: string; status: string; oabUser: string | null; answer: string | null }>>;
  markAdvice(id: string, patch: { answer?: string; status?: string; oabUser?: string; pdfSha256?: string }): Promise<void>;
  lastConsolidation(userId: string, tribunal: string): Promise<string | null>; // RB4
  setConsolidation(userId: string, tribunal: string, at: string): Promise<void>;
}

export class InMemoryLegalStore implements LegalStore {
  private cases = new Map<string, LegalCaseDto & { id: string; userId: string; role: string; alias: string | null }>();
  private events = new Map<string, Array<LegalEventDto & { id: string; dedupeHash: string }>>();
  private advices = new Map<string, Array<{ id: string; caseId: string | null; userId: string; question: string; answer: string | null; oabUser: string | null; status: string; scheduledAt: string | null; pdfSha256?: string }>>();
  private consolidations = new Map<string, string>();
  private seq = 0;

  private key(userId: string, numeroProcesso: string): string {
    return `${userId}|${numeroProcesso}`;
  }

  async createCase(c: LegalCaseDto & { userId: string; role: string; alias: string | null }): Promise<{ id: string; created: boolean }> {
    const k = this.key(c.userId, c.numeroProcesso);
    const prev = this.cases.get(k);
    if (prev) return { id: prev.id, created: false };
    const id = `lc_${++this.seq}`;
    this.cases.set(k, { ...c, id });
    return { id, created: true };
  }

  async getCase(userId: string, numeroProcesso: string) {
    return this.cases.get(this.key(userId, numeroProcesso));
  }

  async updateCase(userId: string, numeroProcesso: string, patch: Partial<LegalCaseDto>) {
    const k = this.key(userId, numeroProcesso);
    const prev = this.cases.get(k);
    if (prev) this.cases.set(k, { ...prev, ...patch });
  }

  async listCases(userId: string) {
    return [...this.cases.values()].filter((c) => c.userId === userId).map(({ id, ...c }) => ({ id, ...c }));
  }

  async appendEvent(caseId: string, ev: { source: string; code: string | null; occurredAt: string; description: string; raw?: unknown }) {
    const h = ev.code != null ? createHash("sha256").update(`${caseId}|${ev.code}|${ev.occurredAt}`).digest("hex") : `nocode_${++this.seq}`;
    const list = this.events.get(caseId) ?? [];
    if (list.some((e) => e.dedupeHash === h)) return { id: h, inserted: false }; // RB5
    const id = `le_${++this.seq}`;
    list.push({ id, dedupeHash: h, numeroProcesso: "", codigo: Number(ev.code ?? 0), nome: ev.description, dataHora: ev.occurredAt, tribunal: ev.source });
    this.events.set(caseId, list);
    return { id, inserted: true };
  }

  async listEvents(caseId: string): Promise<LegalEventDto[]> {
    return (this.events.get(caseId) ?? []).map(({ id: _i, dedupeHash: _d, ...e }) => e);
  }

  async createAdvice(a: { caseId: string | null; userId: string; question: string; oabUser: string | null; status: string; scheduledAt: string | null }) {
    const id = `la_${++this.seq}`;
    const list = this.advices.get(a.userId) ?? [];
    list.push({ ...a, id, answer: null });
    this.advices.set(a.userId, list);
    return { id };
  }

  async listAdvices(userId: string) {
    return this.advices.get(userId) ?? [];
  }

  async markAdvice(id: string, patch: { answer?: string; status?: string; oabUser?: string; pdfSha256?: string }) {
    for (const list of this.advices.values()) {
      const a = list.find((x) => x.id === id);
      if (a) {
        if (patch.answer !== undefined) a.answer = patch.answer;
        if (patch.status !== undefined) a.status = patch.status;
        if (patch.oabUser !== undefined) a.oabUser = patch.oabUser;
      }
    }
  }

  async lastConsolidation(userId: string, tribunal: string) {
    return this.consolidations.get(`${userId}|${tribunal}`) ?? null;
  }

  async setConsolidation(userId: string, tribunal: string, at: string) {
    this.consolidations.set(`${userId}|${tribunal}`, at);
  }
}

export interface JuridicoDeps {
  store: LegalStore;
  /** Advogados com OAB VERIFICADA (aprovados pelo painel do diretor). */
  oabVerified?: Set<string>;
  datajud?: typeof import("./datajud.js").fetchProcessos;
  datajudOpts?: import("./datajud.js").DatajudClientOpts;
  /** RF-B04 — destino dos alertas de movimentação (dispatcher → worker → Telegram). */
  alertSink?: import("../jobs/dispatcher.js").AlertSink;
  now?: () => Date;
}

export function makeJuridicoService(deps: JuridicoDeps) {
  const now = deps.now ?? (() => new Date());
  const oabVerified = deps.oabVerified ?? new Set<string>();

  /** RF-B01/B02 — acompanhar processo: RB1 rejeita duplicidade com link. */
  async function acompanhar(userId: string, cnj: string, role: string, alias: string | null) {
    const existente = await deps.store.getCase(userId, cnj);
    if (existente) {
      return { created: false as const, caseId: existente.id, link: `/api/processos/${encodeURIComponent(cnj)}` };
    }
    const doc: LegalCaseDto = {
      numeroProcesso: cnj,
      grau: "",
      classe: "(não consultado)",
      assunto: null,
      orgaoJulgador: "(não consultado)",
      orgaoCodigo: null,
      municipioIbge: null,
      dataAjuizamento: now().toISOString(),
      valorDaCausa: null,
      nivelSigilo: 0,
      status: "desconhecido",
      tribunal: alias ?? "",
      ultimoMovimento: null,
      movimentosCount: 0,
      fieldStatus: "pendente",
      alertasAtivos: false,
      raw: null,
    };
    const { id, created } = await deps.store.createCase({ ...doc, userId, role, alias });
    return { created, caseId: id, link: `/api/processos/${encodeURIComponent(cnj)}` };
  }

  /** RF-B03 — sincroniza movimentos do DataJud; RB5 dedupe; RB3 sigilo. */
  async function sincronizar(userId: string, cnj: string, alias: string, doc?: DatajudDoc) {
    const caso = await deps.store.getCase(userId, cnj);
    if (!caso) throw new Error("não acompanhado");
    const fetchProcessos = deps.datajud ?? (await import("./datajud.js")).fetchProcessos;
    const docs = doc ? [doc] : await fetchProcessos(alias, { numeroProcesso: cnj.replace(/\D/g, "") }, deps.datajudOpts ?? {});
    const d = docs[0];
    if (!d) return { novos: 0, sigiloso: false };
    if ((d.nivelSigilo ?? 0) > 0) return { novos: 0, sigiloso: true }; // RB3
    let novos = 0;
    for (const mov of d.movimentos ?? []) {
      const r = await deps.store.appendEvent(caso.id, {
        source: "datajud",
        code: String(mov.codigo),
        occurredAt: mov.dataHora,
        description: mov.nome,
        raw: mov,
      });
      if (r.inserted) novos++;
    }
    // Projeção do caso (mapDoc) + contagem REAL de eventos — achado do E2E 23/10:
    // sem isto o caso ficava "(não consultado)" para sempre.
    const eventos = await deps.store.listEvents(caso.id);
    const ultimo = eventos[eventos.length - 1];
    // numeroProcesso NÃO é sobrescrito: a chave é o CNJ formatado registrado
    // pelo usuário (o DataJud devolve só dígitos) — teste de regressão 23/10.
    // alertasAtivos NÃO é sobrescrito: mapDoc zera o campo; o flag real é do caso.
    const { numeroProcesso: _chave, alertasAtivos: _alertas, ...projecao } = mapDoc(d, alias || tribunalOf(caso));
    await deps.store.updateCase(userId, cnj, {
      ...projecao,
      movimentosCount: eventos.length,
      ultimoMovimento: ultimo ? { codigo: ultimo.codigo, nome: ultimo.nome, dataHora: ultimo.dataHora } : null,
    });
    // RF-B04 — alerta REAL de movimentação nova (só com o botão Alertar ligado):
    // dispatcher → AlertEvent(queued) → worker → Telegram. Dedupe por hora (RB4/RB5).
    if (novos > 0 && caso.alertasAtivos && deps.alertSink) {
      const janela = now().toISOString().slice(0, 13); // AAAA-MM-DDTHH
      await deps.alertSink.emit({
        userId,
        kind: "novo_movimento",
        refId: cnj,
        detail: `${novos} nova(s) movimentação(ões) em ${cnj}: ${d.movimentos?.[d.movimentos.length - 1]?.nome ?? "atualização"}`,
        dedupeKey: alertDedupeKey(userId, "novo_movimento", cnj, janela),
      });
    }
    return { novos, sigiloso: false };
  }

  /**
   * RB4 — consulta consolidada por usuário-tribunal/6h: se já consultou nesta
   * janela, não consulta de novo (o alerta sai consolidado).
   */
  async function podeConsolidar(userId: string, tribunal: string, at = now().toISOString()): Promise<boolean> {
    const last = await deps.store.lastConsolidation(userId, tribunal);
    if (last && new Date(at).getTime() - new Date(last).getTime() < CONSOLIDATION_MS) return false;
    await deps.store.setConsolidation(userId, tribunal, at);
    return true;
  }

  /**
   * RF-B07 — consulta humana: só advogado com OAB VERIFICADA recebe.
   * RF-B08 — explicação IA sempre sai com o rodapé legal.
   */
  async function solicitarConsulta(userId: string, cnj: string | null, question: string, oabUser: string | null) {
    if (oabUser && !oabVerified.has(oabUser)) {
      throw new Error("advogado sem OAB verificada não recebe consulta");
    }
    const caso = cnj ? await deps.store.getCase(userId, cnj) : undefined;
    // RB4 — 1 consulta por usuário-tribunal/6h (achado do E2E 23/10: a regra
    // existia como primitiva mas NÃO era aplicada pela rota — 2ª consulta
    // criava consulta nova). Janela sem tribunal → bucket "*".
    const janelaAberta = await podeConsolidar(userId, caso?.tribunal || "*");
    if (!janelaAberta) {
      return {
        id: null as string | null,
        consolidado: true as const,
        aviso: "você já tem consulta nesta janela de 6h — acompanhamento consolidado (RB4)",
        rodape: RODAPE_INFORMATIVO,
      };
    }
    const { id } = await deps.store.createAdvice({
      caseId: caso?.id ?? null,
      userId,
      question,
      oabUser: oabUser && oabVerified.has(oabUser) ? oabUser : null,
      status: oabUser ? "agendado" : "solicitado",
      scheduledAt: null,
    });
    return { id, rodape: RODAPE_INFORMATIVO };
  }

  /** RF-B08 — explicação informativa de movimento (NUNCA parecer). */
  function explicarMovimento(nome: string): string {
    return `O movimento "${nome}" indica uma etapa processual registrada pelo tribunal. ${RODAPE_INFORMATIVO}.`;
  }

  async function listar(userId: string, filter: ProcessoFilter = {}) {
    const all = await deps.store.listCases(userId);
    return all.filter((c) => {
      if (filter.numeroProcesso && !c.numeroProcesso.includes(filter.numeroProcesso)) return false;
      if (filter.tribunal && c.tribunal !== filter.tribunal) return false;
      return true;
    });
  }

  return { acompanhar, sincronizar, podeConsolidar, solicitarConsulta, explicarMovimento, listar, oabVerified };
}

export type JuridicoService = ReturnType<typeof makeJuridicoService>;
