/**
 * Serviço de Licitação (plano.md §2) — regra FORA da camada HTTP (padrão doc 13).
 * Fontes reais (client `pncp.ts`): consulta v1 (publicacao/atualizacao/proposta)
 * e /api/search. Regras duras: RC1 id estável · RC2 retry no client · RC3
 * paginação completa · RC4 card com link da fonte (só campo real) · RC5 entidades
 * distintas por tipo de documento (search `document_type` preservado em raw).
 */
import { createHash } from "node:crypto";

import type { PrismaClient } from "@acompanhe/db";

import {
  fetchContratacoesPage,
  fetchSearch,
  mapContratacao,
  mapSearchItem,
  type ContratacaoKind,
  type PncpClientOpts,
  type ContratacoesParams,
  type SearchParams,
} from "./pncp.js";
import type { TenderDto } from "./types.js";

export interface TenderFilter {
  // `| undefined` explícito: exactOptionalPropertyTypes (tsconfig.base)
  uf?: string | undefined;
  cityIbge?: number | undefined;
  palavra?: string | undefined;
  modality?: number | undefined;
  minCents?: number | undefined;
  maxCents?: number | undefined;
  propostaAte?: string | undefined; // ISO date — só abertos até esta data
  somenteAbertos?: boolean | undefined;
}

export interface SavedFilter {
  name: string;
  filter: TenderFilter;
}

/** Porta de persistência do módulo (mesmo padrão de InvestigaStore). */
export interface TenderStore {
  upsertTender(t: TenderDto): Promise<TenderDto>;
  getTender(pncpId: string): Promise<TenderDto | undefined>;
  listTenders(filter: TenderFilter): Promise<TenderDto[]>;
  saveInterest(userId: string, name: string, filter: TenderFilter): Promise<void>;
  listInterests(userId: string): Promise<SavedFilter[]>;
  removeInterest(userId: string, name: string): Promise<boolean>;
  recordMatches(tenderId: string, matches: Array<{ userId: string; filterName: string }>): Promise<void>;
  listMatches(userId: string): Promise<Array<{ tenderId: string; filterName: string; createdAt: string }>>;
}

export class InMemoryTenderStore implements TenderStore {
  private tenders = new Map<string, TenderDto>();
  private interests = new Map<string, Array<{ name: string; filter: TenderFilter }>>();
  private matches = new Map<string, Array<{ userId: string; filterName: string; createdAt: string }>>();

  async upsertTender(t: TenderDto): Promise<TenderDto> {
    this.tenders.set(t.pncpId, t);
    return t;
  }

  async getTender(pncpId: string): Promise<TenderDto | undefined> {
    return this.tenders.get(pncpId);
  }

  async listTenders(filter: TenderFilter): Promise<TenderDto[]> {
    return [...this.tenders.values()].filter((t) => matchesFilter(t, filter));
  }

  async saveInterest(userId: string, name: string, filter: TenderFilter): Promise<void> {
    const list = this.interests.get(userId) ?? [];
    const idx = list.findIndex((i) => i.name === name);
    const entry = { name, filter };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this.interests.set(userId, list);
  }

  async listInterests(userId: string): Promise<SavedFilter[]> {
    return this.interests.get(userId) ?? [];
  }

  async removeInterest(userId: string, name: string): Promise<boolean> {
    const list = this.interests.get(userId) ?? [];
    const idx = list.findIndex((i) => i.name === name);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.interests.set(userId, list);
    return true;
  }

  async recordMatches(tenderId: string, matches: Array<{ userId: string; filterName: string }>): Promise<void> {
    const list = this.matches.get(tenderId) ?? [];
    for (const m of matches) {
      if (!list.some((x) => x.userId === m.userId && x.filterName === m.filterName)) {
        list.push({ ...m, createdAt: new Date().toISOString() });
      }
    }
    this.matches.set(tenderId, list);
  }

  async listMatches(userId: string): Promise<Array<{ tenderId: string; filterName: string; createdAt: string }>> {
    return [...this.matches.entries()].flatMap(([tenderId, list]) =>
      list.filter((m) => m.userId === userId).map((m) => ({ tenderId, ...m })),
    );
  }
}

type Db = Pick<PrismaClient, "tender" | "userInterest" | "tenderMatch">;

/** UUID determinístico (md5) para chaves compostas em colunas Uuid do DDL. */
function deterministicUuid(key: string): string {
  const h = createHash("md5").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class PrismaTenderStore implements TenderStore {
  constructor(private readonly db: Db) {}

  async upsertTender(t: TenderDto): Promise<TenderDto> {
    const data = {
      pncpId: t.pncpId,
      uasg: null,
      title: t.title,
      organ: t.organ,
      modality: t.modality ?? null,
      uf: t.uf ?? null,
      cityIbge: t.cityIbge ?? null,
      status: t.status ?? null,
      budgetCents: t.budgetCents != null ? BigInt(t.budgetCents) : null,
      propostaFrom: t.propostaFrom ?? null,
      propostaTo: t.propostaTo ?? null,
      sourceUrl: t.sourceUrl ?? null,
      raw: t.raw as object,
      updatedAt: new Date().toISOString(),
    };
    await this.db.tender.upsert({
      where: { pncpId: t.pncpId },
      create: { ...data, numeroControlePncp: t.numeroControlePncp, createdAt: data.updatedAt },
      update: data,
    });
    return t;
  }

  async getTender(pncpId: string): Promise<TenderDto | undefined> {
    const row = await this.db.tender.findUnique({ where: { pncpId } });
    return row ? rowToDto(row) : undefined;
  }

  async listTenders(filter: TenderFilter): Promise<TenderDto[]> {
    // filtro simples no banco (uf/city/modality) + refinamento em memória
    const rows = await this.db.tender.findMany({
      where: {
        ...(filter.uf ? { uf: filter.uf } : {}),
        ...(filter.cityIbge !== undefined ? { cityIbge: filter.cityIbge } : {}),
        ...(filter.modality !== undefined ? { modality: filter.modality } : {}),
      },
    });
    return rows.map(rowToDto).filter((t) => matchesFilter(t, filter));
  }

  async saveInterest(userId: string, name: string, filter: TenderFilter): Promise<void> {
    await this.db.userInterest.upsert({
      where: { id: deterministicUuid(`interest:${userId}:licitacao:${name}`) },
      create: {
        id: deterministicUuid(`interest:${userId}:licitacao:${name}`),
        userId,
        kind: "licitacao",
        name,
        filters: filter as object,
        createdAt: new Date().toISOString(),
      },
      update: { filters: filter as object, active: true },
    });
  }

  async listInterests(userId: string): Promise<SavedFilter[]> {
    const rows = await this.db.userInterest.findMany({ where: { userId, kind: "licitacao", active: true } });
    return rows.map((r) => ({ name: r.name, filter: r.filters as TenderFilter }));
  }

  async removeInterest(userId: string, name: string): Promise<boolean> {
    const r = await this.db.userInterest.updateMany({ where: { userId, kind: "licitacao", name }, data: { active: false } });
    return r.count > 0;
  }

  async recordMatches(tenderId: string, matches: Array<{ userId: string; filterName: string }>): Promise<void> {
    for (const m of matches) {
      await this.db.tenderMatch.upsert({
        where: { id: deterministicUuid(`match:${tenderId}:${m.userId}:${m.filterName}`) },
        create: {
          id: deterministicUuid(`match:${tenderId}:${m.userId}:${m.filterName}`),
          tenderId,
          userId: m.userId,
          filterName: m.filterName,
          createdAt: new Date().toISOString(),
        },
        update: {},
      });
    }
  }

  async listMatches(userId: string): Promise<Array<{ tenderId: string; filterName: string; createdAt: string }>> {
    const rows = await this.db.tenderMatch.findMany({ where: { userId } });
    return rows.map((r) => ({ tenderId: r.tenderId, filterName: r.filterName, createdAt: r.createdAt }));
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToDto(row: any): TenderDto {
  return {
    pncpId: row.pncpId,
    numeroControlePncp: row.numeroControlePncp,
    title: row.title,
    objeto: (row.raw?.objetoCompra ?? row.raw?.description ?? row.title) as string,
    organ: row.organ,
    cnpj: row.raw?.orgaoEntidade?.cnpj ?? row.raw?.orgao_cnpj ?? "sem-cnpj",
    modality: row.modality,
    modalityName: row.raw?.modalidadeNome ?? row.raw?.modalidade_licitacao_nome ?? null,
    uf: row.uf,
    cityIbge: row.cityIbge,
    status: row.status,
    budgetCents: row.budgetCents != null ? Number(row.budgetCents) : null,
    propostaFrom: row.propostaFrom,
    propostaTo: row.propostaTo,
    sourceUrl: row.sourceUrl,
    raw: row.raw,
  };
}

/** Filtro RF-C02 — puro e testável. */
export function matchesFilter(t: TenderDto, f: TenderFilter): boolean {
  if (f.uf && t.uf !== f.uf) return false;
  if (f.cityIbge !== undefined && t.cityIbge !== f.cityIbge) return false;
  if (f.modality !== undefined && t.modality !== f.modality) return false;
  if (f.minCents !== undefined && (t.budgetCents ?? 0) < f.minCents) return false;
  if (f.maxCents !== undefined && (t.budgetCents ?? Infinity) > f.maxCents) return false;
  if (f.palavra) {
    const needle = f.palavra.toLowerCase();
    // RF-C02: palavra-chave no OBJETO da contratação (+ título/órgão)
    const hay = `${t.objeto} ${t.title} ${t.organ}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (f.propostaAte && (!t.propostaTo || t.propostaTo.slice(0, 10) > f.propostaAte)) return false;
  if (f.somenteAbertos) {
    const hoje = new Date().toISOString().slice(0, 10);
    if (!t.propostaTo || t.propostaTo.slice(0, 10) < hoje) return false;
  }
  return true;
}

/** RF-C05 — "faltam ≤ X dias para encerrar propostas" (padrão T-3). */
export function prazoAlert(
  t: TenderDto,
  nowIso: string,
  days = 3,
): { kind: "prazo_proposta"; pncpId: string; detail: string; propostaTo: string } | undefined {
  if (!t.propostaTo) return undefined;
  const alvo = new Date(nowIso);
  const fim = new Date(t.propostaTo);
  const diffDays = (fim.getTime() - alvo.getTime()) / 86_400_000;
  if (diffDays < 0 || diffDays > days) return undefined;
  return {
    kind: "prazo_proposta",
    pncpId: t.pncpId,
    detail: `faltam ${Math.ceil(diffDays)} dia(s) para encerrar propostas — ${t.title.slice(0, 80)}`,
    propostaTo: t.propostaTo,
  };
}

export interface LicitacoesDeps {
  store: TenderStore;
  pncp?: PncpClientOpts;
  now?: () => Date;
}

export function makeLicitacoesService(deps: LicitacoesDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  /** RF-C01 — sync incremental com upsert por RC1. */
  async function sync(kind: ContratacaoKind, params: ContratacoesParams): Promise<{ upserted: number; pages: number }> {
    let pagina = 1;
    let upserted = 0;
    let pages = 0;
    for (;;) {
      const page = await fetchContratacoesPage(kind, { ...params, pagina }, deps.pncp ?? {});
      pages += 1;
      for (const raw of page.data) {
        await store.upsertTender(mapContratacao(raw));
        upserted += 1;
      }
      if (page.paginasRestantes <= 0 || page.empty) return { upserted, pages };
      pagina += 1;
    }
  }

  /** Busca full-text (RF-C02) — grava e retorna normalizado; + radar (RF-C03). */
  async function search(params: SearchParams): Promise<{ tenders: TenderDto[]; total: number; newMatches: Array<{ userId: string; filterName: string; pncpId: string }> }> {
    const page = await fetchSearch(params, deps.pncp ?? {});
    const tenders = page.items.map(mapSearchItem);
    const newMatches: Array<{ userId: string; filterName: string; pncpId: string }> = [];
    for (const t of tenders) {
      await store.upsertTender(t);
      // RF-C03: novo edital que casa com filtro salvo → alerta
      const interested = await matchInterests(t);
      if (interested.length > 0) {
        await store.recordMatches(
          t.pncpId,
          interested.map((m) => ({ userId: m.userId, filterName: m.filterName })),
        );
        for (const m of interested) newMatches.push({ ...m, pncpId: t.pncpId });
      }
    }
    return { tenders, total: page.total, newMatches };
  }

  async function matchInterests(t: TenderDto): Promise<Array<{ userId: string; filterName: string }>> {
    // interesses de todos os usuários: varre os de cada usuário registrado
    const out: Array<{ userId: string; filterName: string }> = [];
    for (const userId of knownInterestUsers) {
      const interests = await store.listInterests(userId);
      for (const i of interests) {
        if (matchesFilter(t, i.filter)) out.push({ userId, filterName: i.name });
      }
    }
    return out;
  }

  // usuários com interesse conhecidos (InMemory e Prisma podem varrer por join;
  // mantemos um índice simples — saveInterest registra)
  const knownInterestUsers = new Set<string>();
  const saveInterest = async (userId: string, name: string, filter: TenderFilter): Promise<void> => {
    knownInterestUsers.add(userId);
    await store.saveInterest(userId, name, filter);
  };

  /** RF-C05 — alertas de prazo do usuário (T-3) sobre seus matches. */
  async function alertsForUser(userId: string): Promise<Array<ReturnType<typeof prazoAlert> & object>> {
    const matches = await store.listMatches(userId);
    const out: Array<NonNullable<ReturnType<typeof prazoAlert>>> = [];
    const hoje = now().toISOString();
    for (const m of matches) {
      const t = await store.getTender(m.tenderId);
      if (!t) continue;
      const alert = prazoAlert(t, hoje, 3);
      if (alert) out.push(alert);
    }
    return out;
  }

  async function list(filter: TenderFilter): Promise<TenderDto[]> {
    return store.listTenders(filter);
  }

  async function get(pncpId: string): Promise<TenderDto | undefined> {
    return store.getTender(pncpId);
  }

  async function listSaved(userId: string): Promise<SavedFilter[]> {
    return store.listInterests(userId);
  }

  async function removeSaved(userId: string, name: string): Promise<boolean> {
    return store.removeInterest(userId, name);
  }

  return { sync, search, list, get, saveInterest, listSaved, removeSaved, alertsForUser, matchInterests };
}

export type LicitacoesService = ReturnType<typeof makeLicitacoesService>;
