/**
 * Cliente PNCP (plano.md §2.1–2.2) — endpoints REAIS verificados em 23/10/2026:
 *   GET https://pncp.gov.br/api/consulta/v1/contratacoes/{publicacao|atualizacao|proposta}
 *     params: dataInicial=dataFinal=yyyyMMdd · codigoModalidadeContratacao*
 *             (OBRIGATÓRIO — a API devolve 400 sem ele) · pagina · tamanhoPagina
 *             (mínimo 10 — a API devolve 400 "must be greater than or equal to 10")
 *     envelope: { data, totalRegistros, totalPaginas, numeroPagina, paginasRestantes, empty }
 *   GET https://pncp.gov.br/api/search?q=&tipos_documento= (OBRIGATÓRIO — 400 sem
 *     ele; edital|ata|contrato|pca) &status=&pagina=&tamanhoPagina=
 *     envelope: { items, total } (Elasticsearch, index catalog2)
 * Instabilidade observada na captura (SSL unexpected eof intermitente) → RC2:
 * retry exponencial com jitter, timeout 30 s, 3 tentativas, sem assumir página
 * fixa (paginação por paginasRestantes).
 */
import type {
  ContratacaoKind,
  PncpContratacaoRaw,
  PncpPage,
  PncpSearchItemRaw,
  TenderDto,
} from "./types.js";
export type { ContratacaoKind, PncpContratacaoRaw, PncpPage, PncpSearchItemRaw, TenderDto } from "./types.js";

export interface PncpClientOpts {
  /** fetch injetável nos testes (fixtures = captura real de 23/10/2026). */
  fetchImpl?: typeof fetch;
  baseUrl?: string; // default https://pncp.gov.br
  timeoutMs?: number; // default 30000 (RC2)
  attempts?: number; // default 3 (RC2)
  sleep?: (ms: number) => Promise<void>; // injetável nos testes
  random?: () => number; // jitter determinístico nos testes
}

const DEFAULTS = {
  baseUrl: "https://pncp.gov.br",
  timeoutMs: 30_000,
  attempts: 3,
};

function sleepDefault(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry exponencial com jitter (RC2): 3 tentativas, backoff 400ms*2^n + jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: PncpClientOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? DEFAULTS.attempts;
  const sleep = opts.sleep ?? sleepDefault;
  const random = opts.random ?? Math.random;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if ((err as { fatal?: boolean }).fatal) throw err; // 4xx do contrato: sem retry
      if (i < attempts - 1) {
        const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
        // 429: espera o Retry-After da fonte (mín. backoff exponencial)
        const backoff = retryAfterMs ?? 400 * 2 ** i;
        await sleep(backoff + Math.floor(random() * 200)); // jitter 0–200 ms
      }
    }
  }
  throw lastErr;
}

async function getJson<T>(url: string, opts: PncpClientOpts): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  return withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const error = new Error(`PNCP ${res.status}: ${body.slice(0, 200)}`) as Error & {
          retryAfterMs?: number;
        };
        if (res.status === 429) {
          // 429 real observado em 23/10/2026 ("Limite de Requisições Excedido") —
          // retentável respeitando Retry-After (RC2).
          const ra = Number(res.headers.get("retry-after"));
          const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0;
          if (ms > 0) error.retryAfterMs = ms;
          throw error;
        }
        if (res.status >= 500) throw error; // transitório
        // 4xx do contrato (400/422) NÃO são retryáveis — devolve o erro real.
        throw Object.assign(error, { fatal: true });
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }, { ...opts, attempts: opts.attempts ?? DEFAULTS.attempts });
}

export interface ContratacoesParams {
  dataInicial: string; // yyyyMMdd
  dataFinal: string; // yyyyMMdd
  codigoModalidadeContratacao: number; // obrigatório (contrato real)
  tamanhoPagina?: number | undefined; // default 50; mínimo 10 (contrato real)
  pagina?: number | undefined;
}

export function contratacoesUrl(kind: ContratacaoKind, params: ContratacoesParams, baseUrl = DEFAULTS.baseUrl): string {
  const q = new URLSearchParams({
    dataInicial: params.dataInicial,
    dataFinal: params.dataFinal,
    codigoModalidadeContratacao: String(params.codigoModalidadeContratacao),
    tamanhoPagina: String(Math.max(10, params.tamanhoPagina ?? 50)),
    pagina: String(params.pagina ?? 1),
  });
  return `${baseUrl}/api/consulta/v1/contratacoes/${kind}?${q}`;
}

export async function fetchContratacoesPage(
  kind: ContratacaoKind,
  params: ContratacoesParams,
  opts: PncpClientOpts = {},
): Promise<PncpPage<PncpContratacaoRaw>> {
  return getJson<PncpPage<PncpContratacaoRaw>>(contratacoesUrl(kind, params, opts.baseUrl ?? DEFAULTS.baseUrl), opts);
}

/**
 * Paginação completa até `paginasRestantes == 0` (RC3 — nunca assumir página
 * fixa). Guarda defensiva: no máximo 500 páginas por sincronização (5k itens)
 * para nunca laçar contra um envelope repetido.
 */
export const MAX_SYNC_PAGES = 500;

export async function* iterateContratacoes(
  kind: ContratacaoKind,
  params: ContratacoesParams,
  opts: PncpClientOpts = {},
): AsyncGenerator<PncpContratacaoRaw[]> {
  let pagina = 1;
  for (; pagina <= MAX_SYNC_PAGES; pagina += 1) {
    const page = await fetchContratacoesPage(kind, { ...params, pagina }, opts);
    if (page.data.length > 0) yield page.data;
    if (page.paginasRestantes <= 0 || page.empty) return;
  }
}

export interface SearchParams {
  q?: string | undefined;
  tiposDocumento: string | string[]; // obrigatório (contrato real): edital|ata|contrato|pca
  status?: string | undefined; // ex.: recebendo_proposta
  ufs?: string | undefined;
  pagina?: number | undefined;
  tamanhoPagina?: number | undefined;
}

export function searchUrl(params: SearchParams, baseUrl = DEFAULTS.baseUrl): string {
  const td = Array.isArray(params.tiposDocumento) ? params.tiposDocumento.join(",") : params.tiposDocumento;
  const q = new URLSearchParams({
    tipos_documento: td,
    pagina: String(params.pagina ?? 1),
    tamanhoPagina: String(Math.max(1, params.tamanhoPagina ?? 50)),
  });
  if (params.q) q.set("q", params.q);
  if (params.status) q.set("status", params.status);
  if (params.ufs) q.set("ufs", params.ufs);
  return `${baseUrl}/api/search?${q}`;
}

export async function fetchSearch(
  params: SearchParams,
  opts: PncpClientOpts = {},
): Promise<{ items: PncpSearchItemRaw[]; total: number }> {
  return getJson<{ items: PncpSearchItemRaw[]; total: number }>(
    searchUrl(params, opts.baseUrl ?? DEFAULTS.baseUrl),
    opts,
  );
}

/** RC1 — id estável `pncp:{cnpjOrgao}:{ano}:{sequencial}` (3 campos oficiais do path). */
export function pncpTenderId(cnpj: string, ano: number | string, sequencial: number | string): string {
  return `pncp:${cnpj}:${ano}:${sequencial}`;
}

/** RC1 via `numeroControlePNCP` real: `{cnpj}-{poder}-{seq6}/{ano}` (captura). */
export function pncpTenderIdFromControle(controle: string): string | undefined {
  const m = /^(\d+)-\d+-(\d+)\/(\d{4})$/.exec(controle.trim());
  const cnpj = m?.[1];
  const seq = m?.[2];
  const ano = m?.[3];
  if (!cnpj || !seq || !ano) return undefined;
  return pncpTenderId(cnpj, ano, Number(seq));
}

function centsFromReais(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Math.round(v * 100); // RA2-análogo: centavos INTEGER
}

function ibgeToNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function emptyToNull(v: string | null | undefined): string | null {
  return v === null || v === undefined || v === "" ? null : v;
}

function toInt(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Mapeia o item camelCase de /contratacoes/* para o modelo normalizado. */
export function mapContratacao(raw: PncpContratacaoRaw): TenderDto {
  const pncpId = pncpTenderId(raw.orgaoEntidade.cnpj, raw.anoCompra, raw.sequencialCompra);
  return {
    pncpId,
    numeroControlePncp: raw.numeroControlePNCP,
    title: raw.objetoCompra,
    objeto: raw.objetoCompra,
    organ: raw.orgaoEntidade.razaoSocial,
    cnpj: raw.orgaoEntidade.cnpj,
    modality: raw.modalidadeId ?? null,
    modalityName: raw.modalidadeNome ?? null,
    uf: raw.unidadeOrgao?.ufSigla ?? null,
    cityIbge: ibgeToNumber(raw.unidadeOrgao?.codigoIbge),
    status: raw.situacaoCompraNome ?? null,
    budgetCents: centsFromReais(raw.valorTotalEstimado),
    propostaFrom: raw.dataAberturaProposta ?? null,
    propostaTo: raw.dataEncerramentoProposta ?? null,
    // RC4: link SÓ de campo real da API (linkSistemaOrigem); sem campo → null.
    sourceUrl: raw.linkSistemaOrigem ?? null,
    raw,
  };
}

/** Mapeia o item snake_case de /api/search para o MESMO modelo. */
export function mapSearchItem(raw: PncpSearchItemRaw): TenderDto {
  const controle = raw.numero_controle_pncp ?? "";
  const pncpId =
    pncpTenderIdFromControle(controle) ??
    pncpTenderId(raw.orgao_cnpj ?? "sem-cnpj", raw.ano ?? 0, raw.numero_sequencial ?? 0);
  return {
    pncpId,
    numeroControlePncp: controle,
    title: raw.title ?? raw.description ?? "(sem título)",
    objeto: raw.description ?? raw.title ?? "(sem objeto)",
    organ: raw.orgao_nome ?? "(sem órgão)",
    cnpj: raw.orgao_cnpj ?? "sem-cnpj",
    modality: toInt(raw.modalidade_licitacao_id),
    modalityName: raw.modalidade_licitacao_nome ?? null,
    uf: raw.uf ?? null,
    cityIbge: ibgeToNumber(raw.codigo_ibge),
    status: raw.situacao_nome ?? null,
    budgetCents: centsFromReais(raw.valor_total_estimado),
    propostaFrom: emptyToNull(raw.data_inicio_recebimento_propostas),
    propostaTo: emptyToNull(raw.data_fim_recebimento_propostas),
    // item_url é caminho relativo real (ex.: "/compras/18092825000149/2024/21").
    sourceUrl: raw.item_url
      ? raw.item_url.startsWith("http")
        ? raw.item_url
        : `https://pncp.gov.br${raw.item_url}`
      : null,
    raw,
  };
}
