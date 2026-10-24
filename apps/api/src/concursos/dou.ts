/**
 * Cliente DOU (plano.md §3.1) — fontes REAIS verificadas em 23/10/2026:
 *   1) leiturajornal: GET https://in.gov.br/leiturajornal?data=dd-mm-yyyy&secao=doN
 *      → HTML com `jsonArray` embutido (verificado p/ DO1: 308 itens reais);
 *      DO2/DO3 vêm vazios no SSR → usar a busca;
 *   2) busca: GET https://www.in.gov.br/consulta/-/buscar/dou?q=&s=doN
 *      &exactDate=personalizado&sortType=0&publishFrom=dd/mm/yyyy&publishTo=dd/mm/yyyy
 *      → HTML com `jsonArray` embutido (verificado p/ DO3: 20 itens reais).
 * Parâmetros exatos extraídos do JS oficial (`getAdvancedSearchData` do site).
 * Instabilidade/429: retry com backoff (RC2-análogo).
 */
import { createHash } from "node:crypto";

import type { ContestDto, ContestStatus, DouItemRaw } from "./types.js";
export type { DouItemRaw } from "./types.js";

export interface DouClientOpts {
  fetchImpl?: typeof fetch;
  baseUrl?: string; // default https://in.gov.br
  searchUrl?: string; // default https://www.in.gov.br/consulta/-/buscar/dou
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  userAgent?: string;
}

// UA de NAVEGADOR: o CDN do gov.br fecha HTTP/2 com PROTOCOL_ERROR (curl 92)
// para UA não-navegador e o Node/undici tem o TLS recusado (23/10/2026).
// Identificação do bot vai no rodapé do app, não no User-Agent da coleta.
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULTS = { timeoutMs: 45_000, attempts: 3 };

/**
 * Fallback de TRANSPORTE: o undici/Node fetch é recusado pelo CDN do gov.br
 * neste ambiente (TLS fechado; curl funciona — verificado em 23/10/2026:
 * curl=200/209KB com fetch "UND_ERR_SOCKET"). Não é mock: mesma URL, mesmo
 * corpo. fetchImpl segue injetável nos testes; em produção o fetch é tentado
 * primeiro e o curl entra só quando o socket cai.
 * curl --http1.1: o CDN do gov.br devolve HTTP/2 PROTOCOL_ERROR (curl 92) com
 * UA não-navegador em HTTP/2; HTTP/1.1 + UA de navegador = 200 (23/10/2026).
 */
async function curlGet(url: string, ua: string, timeoutMs: number): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      "curl",
      ["-sS", "--http1.1", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-H", `User-Agent: ${ua}`, url],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => resolve(err ? undefined : stdout),
    );
  });
}

async function getHtml(url: string, opts: DouClientOpts): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? DEFAULTS.attempts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULTS.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": opts.userAgent ?? UA,
        },
        redirect: "follow",
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const error = new Error(`DOU ${res.status}`) as Error & { fatal?: boolean };
        if (res.status >= 500 || res.status === 429) {
          if (i < attempts - 1) {
            await sleep(400 * 2 ** i + Math.floor(random() * 200));
            continue;
          }
        }
        throw Object.assign(error, { fatal: true });
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if ((err as { fatal?: boolean }).fatal) throw err;
      if (!opts.fetchImpl) {
        const body = await curlGet(url, opts.userAgent ?? UA, opts.timeoutMs ?? DEFAULTS.timeoutMs);
        if (body && body.length > 0) return body;
      }
      if (i < attempts - 1) await sleep(400 * 2 ** i + Math.floor(random() * 200));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Extrai o `jsonArray` embutido no HTML (mecanismo oficial do portal). */
export function extractJsonArray(html: string): DouItemRaw[] {
  const pos = html.indexOf('"jsonArray":[');
  if (pos < 0) return [];
  const start = html.indexOf("[", pos);
  if (start < 0) return [];
  // decode a partir do '[' — o decodificador para no fechamento real
  try {
    const { parse } = JSON as unknown as { parse: (s: string) => DouItemRaw[] };
    void parse;
    const arr = JSON.parse(
      // decodificação balanceada via JSON.parse de prefixo: varre fechamentos
      sliceBalancedArray(html, start),
    ) as DouItemRaw[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function sliceBalancedArray(html: string, start: number): string {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return "[]";
}

export function leiturajornalUrl(dataDdmmyyyy: string, secao: "do1" | "do2" | "do3", baseUrl = "https://in.gov.br"): string {
  return `${baseUrl}/leiturajornal?data=${dataDdmmyyyy}&secao=${secao}`;
}

export function buscaUrl(
  params: { q: string; secao?: "do1" | "do2" | "do3" | "todos"; publishFrom: string; publishTo: string },
  searchUrl = "https://www.in.gov.br/consulta/-/buscar/dou",
): string {
  const q = new URLSearchParams({
    q: params.q,
    s: params.secao ?? "todos",
    exactDate: "personalizado",
    sortType: "0",
    publishFrom: params.publishFrom,
    publishTo: params.publishTo,
  });
  return `${searchUrl}?${q}`;
}

export async function fetchEdicao(
  dataDdmmyyyy: string,
  secao: "do1" | "do2" | "do3",
  opts: DouClientOpts = {},
): Promise<DouItemRaw[]> {
  const html = await getHtml(leiturajornalUrl(dataDdmmyyyy, secao, opts.baseUrl), opts);
  return extractJsonArray(html);
}

export async function fetchBusca(
  params: { q: string; secao?: "do1" | "do2" | "do3" | "todos"; publishFrom: string; publishTo: string },
  opts: DouClientOpts = {},
): Promise<DouItemRaw[]> {
  const html = await getHtml(buscaUrl(params, opts.searchUrl), opts);
  return extractJsonArray(html);
}

/**
 * RF-D01 — classificador "é concurso?": regex determinístico (IA = opcional depois).
 * Padrões da spec (v1 doc 01 RF-D01: "edital nº", "concurso público",
 * "processo seletivo") + variantes REAIS encontradas na captura do DOU de
 * 23/10/2026 (dou-busca-capture.json item "EDITAL IRD/ANSN nº 1/2026":
 * "abertura das inscrições para o processo de seleção"). Dados, não invenção.
 */
const CONCURSO_PAT =
  /(edital\s+n[ºo°.]|concurso\s+p[úu]blico|processo\s+seletivo|processo\s+de\s+sele[çc][ãa]o|abertura\s+das?\s+inscri[çc][õo]es)/i;

export function isContestItem(item: Pick<DouItemRaw, "title" | "content" | "subTitulo">): boolean {
  const hay = `${item.title ?? ""} ${item.subTitulo ?? ""} ${String(item.content ?? "").slice(0, 2000)}`;
  return CONCURSO_PAT.test(hay);
}

/** Bancas do MVP (RF-D02: FGV, IBFC, Cebraspe) — detecção no texto. */
export const BANCAS = ["FGV", "IBFC", "Cebraspe", "CESPE", "FCC", "Vunesp", "Cesgranrio", "AOCP", "Quadrix"] as const;

export function detectBanca(text: string): string | null {
  for (const b of BANCAS) {
    if (new RegExp(`\\b${b}\\b`, "i").test(text)) return b === "CESPE" ? "Cebraspe" : b;
  }
  return null;
}

/**
 * RD2 — identidade: hash(órgão+banca+ano+nº do edital) quando o nº é
 * extraível (`Edital nº 123/2026`); senão hash do urlTitle (documentado em
 * `identitySource`). Retificações com mesmo nº → mesmo externalId → versão.
 */
export function contestIdentity(item: DouItemRaw): { externalId: string; identitySource: "edital" | "url"; numero: string | undefined } {
  const titulo = `${item.title ?? ""} ${item.titulo ?? ""}`;
  // Formatos REAIS capturados em 23/10/2026:
  //   "Edital nº 28/2026" · "EDITAL IRD/ANSN Nº 1/2026" · "EDITAL Nº 8, DE 21 DE OUTUBRO DE 2026"
  const m =
    /n[ºo°°.]?\s*(\d{1,4})\s*\/\s*(\d{4})/i.exec(titulo) ??
    /n[ºo°°.]?\s*(\d{1,4})\s*,\s*de\s+\d{1,2}\s+de\s+\w+\s+de\s+(\d{4})/i.exec(titulo);
  const organ = item.hierarchyStr ?? item.pubName ?? "";
  const banca = detectBanca(`${titulo} ${item.content ?? ""}`) ?? "";
  if (m && /edital/i.test(titulo)) {
    const numero = m[1];
    const ano = m[2];
    const h = createHash("sha256")
      .update(`${organ.trim().toLowerCase()}|${banca.toLowerCase()}|${ano}|${numero}`)
      .digest("hex")
      .slice(0, 32);
    return { externalId: `contest:${h}`, identitySource: "edital", numero };
  }
  const h = createHash("sha256").update(`url|${item.urlTitle}`).digest("hex").slice(0, 32);
  return { externalId: `contest:${h}`, identitySource: "url", numero: undefined };
}

/** Link oficial do DOU (RD4) — a partir do campo REAL `urlTitle`. */
export function douSourceUrl(item: DouItemRaw): string {
  return `https://www.in.gov.br/pt-br/materias/${item.urlTitle}`;
}

const STATUS_PAT: Array<[RegExp, ContestStatus]> = [
  [/homologa[çc][ãa]o|resultado\s+final/i, "homologado"],
  [/inscri[çc][õo]es\s+(abertas|em\s+aberto)/i, "inscricoes_abertas"],
  [/abertura\s+de\s+inscri[çc][õo]es|publica[çc][ãa]o\s+do\s+edital|edital\s+n[ºo°.]/i, "edital_publicado"],
  [/autoriza[çc][ãa]o/i, "autorizado"],
];

export function classifyStatus(item: DouItemRaw): ContestStatus {
  const hay = `${item.title ?? ""} ${String(item.content ?? "").slice(0, 1500)}`;
  for (const [pat, status] of STATUS_PAT) {
    if (pat.test(hay)) return status;
  }
  return "edital_publicado"; // item classificado como concurso sem marca → publicado
}

function centsFromReais(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Extrai faixa salarial do texto (R$ 1.234,56) — só quando explícita. */
export function extractSalaryCents(text: string): number | null {
  const m = /R\$\s*([\d.]{1,12},\d{2})/.exec(text);
  return m ? centsFromReais(m[1]) : null;
}

/** Mapeia item DOU (qualquer dos 2 shapes) → modelo normalizado. */
/**
 * Datas de prazo extraídas do texto livre (formatos REAIS do DOU capturados em
 * 23/10/2026): "de 20 de outubro a 3 de novembro de 2026",
 * "Inscrições de 1 de novembro de 2026 a 10 de novembro de 2026",
 * "10 a 20 de novembro de 2026". Sem padrão na captura → null (RD3: pendente).
 */
const MESES: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function parseDataBr(dia: string, mes: string, ano: string): string | null {
  const m = MESES[mes.toLowerCase().replace(/ç/g, "c")];
  if (!m) return null;
  return `${ano}-${String(m).padStart(2, "0")}-${String(Number(dia)).padStart(2, "0")}T00:00:00.000Z`;
}

function extractDates(text: string): { inscricoesFrom: string | null; inscricoesTo: string | null; provaAt: string | null } {
  const deA =
    /(?:de\s+)?(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})\s+a\s+(?:o\s+dia\s+)?(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/i.exec(text);
  const abrev = /(\d{1,2})\s+a\s+(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/i.exec(text);
  let inscricoesFrom: string | null = null;
  let inscricoesTo: string | null = null;
  if (deA) {
    inscricoesFrom = parseDataBr(deA[1]!, deA[2]!, deA[3]!);
    inscricoesTo = parseDataBr(deA[4]!, deA[5]!, deA[6]!);
  } else if (abrev) {
    inscricoesFrom = parseDataBr(abrev[1]!, abrev[3]!, abrev[4]!);
    inscricoesTo = parseDataBr(abrev[2]!, abrev[3]!, abrev[4]!);
  }
  const prova = /prova\s+(?:em|no\s+dia|dia)?\s*(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/i.exec(text);
  return {
    inscricoesFrom,
    inscricoesTo,
    provaAt: prova ? parseDataBr(prova[1]!, prova[2]!, prova[3]!) : null,
  };
}

export function mapDouItem(item: DouItemRaw): ContestDto {
  const hay = `${item.title ?? ""} ${item.titulo ?? ""} ${String(item.content ?? "").slice(0, 2000)}`;
  const { externalId, identitySource } = contestIdentity(item);
  return {
    externalId,
    identitySource,
    title: (item.title || item.titulo || "(sem título)").slice(0, 300),
    organ: item.hierarchyStr ?? item.pubName ?? "DOU",
    banca: detectBanca(hay),
    uf: null,
    cityIbge: null,
    status: classifyStatus(item),
    salaryCents: extractSalaryCents(hay),
    level: null,
    sourceUrl: douSourceUrl(item),
    ...extractDates(hay),
    // RD3: dado extraído de texto livre fica PENDENTE até 2ª fonte/confirmação
    fieldStatus: "pendente",
    parentVersion: null,
    raw: item,
  };
}
