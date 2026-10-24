/**
 * Serviço de Concursos (plano.md §3) — RF-D01…D05/D07 + regras RD1–RD4.
 * RD2: retificação = VERSÃO vinculada (parentVersion), NUNCA substitui o
 * original. RD3: vagas/salário `pendente|validado`. RD1: PCI/pdf nunca
 * baixados (o módulo só lê HTML/JSON do DOU).
 */
import type { PrismaClient } from "@acompanhe/db";

import {
  classifyStatus,
  detectBanca,
  fetchBusca,
  fetchEdicao,
  isContestItem,
  mapDouItem,
  type DouClientOpts,
} from "./dou.js";
import type { ContestDto, ContestStatus } from "./types.js";

export interface ContestFilter {
  uf?: string | undefined;
  banca?: string | undefined;
  status?: ContestStatus | undefined;
  palavra?: string | undefined;
}

/** Porta de persistência (padrão do doc 13). */
export interface ContestStore {
  /** Upsert com RD2: se o registro existe com conteúdos diferentes → nova versão. */
  upsertContest(c: ContestDto): Promise<{ contest: ContestDto; novaVersao: boolean }>;
  getContest(externalId: string): Promise<ContestDto | undefined>;
  listContests(filter: ContestFilter): Promise<ContestDto[]>;
  listVersions(externalId: string): Promise<ContestDto[]>;
  saveAlert(userId: string, contestId: string, kind: string, sentAt: string): Promise<void>;
  listAlerts(userId: string): Promise<Array<{ contestId: string; kind: string; sentAt: string }>>;
}

/**
 * Serialização ESTÁVEL (chaves ordenadas) — o jsonb do Postgres reordena chaves
 * no round-trip, então JSON.stringify direto difere do objeto original.
 */
function stableStringify(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/**
 * Campos VOLÁTEIS que mudam entre requisições sem mudança de conteúdo
 * (achado do E2E 23/10/2026: `score` = relevância ES do /buscar/dou) —
 * não podem disparar retificação.
 */
const RAW_VOLATIL = new Set(["score"]);

function stableRaw(c: ContestDto): string {
  const raw = c.raw as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object") return stableStringify(raw ?? null);
  const limpo: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!RAW_VOLATIL.has(k)) limpo[k] = v;
  return stableStringify(limpo);
}

function versionKey(c: ContestDto): string {
  // chave de RETIFICAÇÃO (RD2): qualquer mudança relevante — inclusive o texto
  // bruto do DOU (content) — gera nova versão; nunca sobrescreve o original
  return `${c.title}|${c.organ}|${c.banca ?? ""}|${c.status}|${c.salaryCents ?? ""}|${c.inscricoesFrom ?? ""}|${c.inscricoesTo ?? ""}|${c.provaAt ?? ""}|${c.sourceUrl}|${stableRaw(c)}`;
}

export class InMemoryContestStore implements ContestStore {
  private rows = new Map<string, ContestDto>();
  private versions = new Map<string, ContestDto[]>();
  private alerts = new Map<string, Array<{ contestId: string; kind: string; sentAt: string }>>();

  async upsertContest(c: ContestDto): Promise<{ contest: ContestDto; novaVersao: boolean }> {
    const existing = this.rows.get(c.externalId);
    if (!existing) {
      this.rows.set(c.externalId, c);
      return { contest: c, novaVersao: false };
    }
    if (versionKey(existing) === versionKey(c)) return { contest: existing, novaVersao: false };
    // RD2 — retificação vira versão vinculada; original permanece
    const versao: ContestDto = { ...c, externalId: `${c.externalId}#v${(this.versions.get(c.externalId)?.length ?? 0) + 1}`, parentVersion: existing.externalId };
    const list = this.versions.get(existing.externalId) ?? [];
    list.push(versao);
    this.versions.set(existing.externalId, list);
    return { contest: versao, novaVersao: true };
  }

  async getContest(externalId: string): Promise<ContestDto | undefined> {
    return this.rows.get(externalId);
  }

  async listContests(filter: ContestFilter): Promise<ContestDto[]> {
    return [...this.rows.values()].filter((c) => {
      if (filter.uf && c.uf !== filter.uf) return false;
      if (filter.banca && c.banca !== filter.banca) return false;
      if (filter.status && c.status !== filter.status) return false;
      if (filter.palavra) {
        const hay = `${c.title} ${c.organ}`.toLowerCase();
        if (!hay.includes(filter.palavra.toLowerCase())) return false;
      }
      return true;
    });
  }

  async listVersions(externalId: string): Promise<ContestDto[]> {
    return this.versions.get(externalId) ?? [];
  }

  async saveAlert(userId: string, contestId: string, kind: string, sentAt: string): Promise<void> {
    const list = this.alerts.get(userId) ?? [];
    if (!list.some((a) => a.contestId === contestId && a.kind === kind)) list.push({ contestId, kind, sentAt });
    this.alerts.set(userId, list);
  }

  async listAlerts(userId: string): Promise<Array<{ contestId: string; kind: string; sentAt: string }>> {
    return this.alerts.get(userId) ?? [];
  }
}

type Db = Pick<PrismaClient, "contest" | "contestAlert">;

export class PrismaContestStore implements ContestStore {
  constructor(private readonly db: Db) {}

  async upsertContest(c: ContestDto): Promise<{ contest: ContestDto; novaVersao: boolean }> {
    const existing = await this.db.contest.findUnique({ where: { externalId: c.externalId } });
    const data = {
      title: c.title,
      organ: c.organ,
      banca: c.banca ?? null,
      uf: c.uf ?? null,
      cityIbge: c.cityIbge ?? null,
      status: c.status,
      salaryCents: c.salaryCents != null ? BigInt(c.salaryCents) : null,
      level: c.level ?? null,
      sourceUrl: c.sourceUrl,
      inscricoesFrom: c.inscricoesFrom ?? null,
      inscricoesTo: c.inscricoesTo ?? null,
      provaAt: c.provaAt ?? null,
      fieldStatus: c.fieldStatus,
      parentVersion: c.parentVersion ?? null,
      raw: c.raw as object,
      updatedAt: new Date().toISOString(),
    };
    if (!existing) {
      await this.db.contest.create({
        data: { externalId: c.externalId, createdAt: data.updatedAt, ...data },
      });
      return { contest: c, novaVersao: false };
    }
    if (versionKey(rowToDto(existing)) === versionKey(c)) return { contest: c, novaVersao: false };
    // RD2 — versão vinculada; NUNCA sobrescrever o original
    const versaoId = `${c.externalId}#v${Date.now()}`;
    await this.db.contest.create({
      data: {
        externalId: versaoId,
        createdAt: data.updatedAt,
        ...data,
        parentVersion: existing.externalId,
      },
    });
    return { contest: { ...c, externalId: versaoId, parentVersion: existing.externalId }, novaVersao: true };
  }

  async getContest(externalId: string): Promise<ContestDto | undefined> {
    const row = await this.db.contest.findUnique({ where: { externalId } });
    return row ? rowToDto(row) : undefined;
  }

  async listContests(filter: ContestFilter): Promise<ContestDto[]> {
    const rows = await this.db.contest.findMany({
      where: {
        ...(filter.uf ? { uf: filter.uf } : {}),
        ...(filter.banca ? { banca: filter.banca } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
    });
    return rows.map(rowToDto).filter((c) => {
      if (filter.palavra) {
        const hay = `${c.title} ${c.organ}`.toLowerCase();
        if (!hay.includes(filter.palavra.toLowerCase())) return false;
      }
      return true;
    });
  }

  async listVersions(externalId: string): Promise<ContestDto[]> {
    const rows = await this.db.contest.findMany({ where: { parentVersion: externalId } });
    return rows.map(rowToDto);
  }

  async saveAlert(userId: string, contestId: string, kind: string, sentAt: string): Promise<void> {
    const existing = await this.db.contestAlert.findFirst({ where: { userId, contestId, kind } });
    if (existing) return;
    await this.db.contestAlert.create({ data: { userId, contestId, kind, sentAt, read: false } });
  }

  async listAlerts(userId: string): Promise<Array<{ contestId: string; kind: string; sentAt: string }>> {
    const rows = await this.db.contestAlert.findMany({ where: { userId }, orderBy: { sentAt: "desc" } });
    return rows.map((r) => ({ contestId: r.contestId, kind: r.kind, sentAt: r.sentAt }));
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToDto(row: any): ContestDto {
  return {
    externalId: row.externalId,
    identitySource: (row.raw?.identitySource as "edital" | "url") ?? "url",
    title: row.title,
    organ: row.organ,
    banca: row.banca,
    uf: row.uf,
    cityIbge: row.cityIbge,
    status: row.status as ContestStatus,
    salaryCents: row.salaryCents != null ? Number(row.salaryCents) : null,
    level: row.level,
    sourceUrl: row.sourceUrl,
    inscricoesFrom: row.inscricoesFrom,
    inscricoesTo: row.inscricoesTo,
    provaAt: row.provaAt,
    fieldStatus: row.fieldStatus === "validado" ? "validado" : "pendente",
    parentVersion: row.parentVersion,
    raw: row.raw,
  };
}

/** RF-D07 — alerta de prazo de inscrição (T-7/T-3/T-1). */
export function inscricaoAlert(
  c: Pick<ContestDto, "externalId" | "title" | "inscricoesTo">,
  nowIso: string,
): { kind: "prazo_inscricao"; contestId: string; detail: string; dias: number } | undefined {
  if (!c.inscricoesTo) return undefined;
  const diff = (new Date(c.inscricoesTo).getTime() - new Date(nowIso).getTime()) / 86_400_000;
  for (const dias of [1, 3, 7]) { // menor janela que engloba: 2,6d → T-3
    if (diff >= 0 && diff <= dias) {
      return {
        kind: "prazo_inscricao",
        contestId: c.externalId,
        detail: `inscrições de "${c.title.slice(0, 60)}" encerram em ${Math.ceil(diff)} dia(s)`,
        dias,
      };
    }
  }
  return undefined;
}

export interface ConcursosDeps {
  store: ContestStore;
  dou?: DouClientOpts;
  now?: () => Date;
}

export function makeConcursosService(deps: ConcursosDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  /** RF-D01 — ingere edição do DOU e classifica "é concurso?" (regex). */
  async function ingestEdicao(dataDdmmyyyy: string, secao: "do1" | "do2" | "do3"): Promise<{ lidos: number; concursos: number; versoes: number }> {
    const items = await fetchEdicao(dataDdmmyyyy, secao, deps.dou ?? {});
    return classifyAndStore(items);
  }

  /** Busca do DOU (contrato real de 23/10/2026) — mesma classificação. */
  async function ingestBusca(params: { q: string; secao?: "do1" | "do2" | "do3" | "todos"; publishFrom: string; publishTo: string }): Promise<{ lidos: number; concursos: number; versoes: number }> {
    const items = await fetchBusca(params, deps.dou ?? {});
    return classifyAndStore(items);
  }

  async function classifyAndStore(items: Array<Parameters<typeof mapDouItem>[0]>): Promise<{ lidos: number; concursos: number; versoes: number }> {
    let concursos = 0;
    let versoes = 0;
    for (const item of items) {
      if (!isContestItem(item)) continue;
      concursos += 1;
      const dto = mapDouItem(item);
      const r = await store.upsertContest(dto);
      if (r.novaVersao) versoes += 1;
    }
    return { lidos: items.length, concursos, versoes };
  }

  async function list(filter: ContestFilter): Promise<ContestDto[]> {
    return store.listContests(filter);
  }

  async function timeline(externalId: string): Promise<{ original: ContestDto | undefined; versoes: ContestDto[] }> {
    return { original: await store.getContest(externalId), versoes: await store.listVersions(externalId) };
  }

  /** RF-D04/D07 — concursos acompanhados → alertas de prazo. */
  async function alertsForUser(userId: string, acompanhados: string[]): Promise<Array<NonNullable<ReturnType<typeof inscricaoAlert>>>> {
    const out: Array<NonNullable<ReturnType<typeof inscricaoAlert>>> = [];
    const iso = now().toISOString();
    for (const id of acompanhados) {
      const c = await store.getContest(id);
      if (!c) continue;
      const a = inscricaoAlert(c, iso);
      if (a) {
        out.push(a);
        await store.saveAlert(userId, a.contestId, a.kind, iso);
      }
    }
    return out;
  }

  return { ingestEdicao, ingestBusca, list, timeline, alertsForUser };
}

export type ConcursosService = ReturnType<typeof makeConcursosService>;

// re-exports úteis para as rotas/testes
export { classifyStatus, detectBanca, isContestItem, mapDouItem };
