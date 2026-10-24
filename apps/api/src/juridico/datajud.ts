/**
 * Cliente DataJud/CNJ — contrato REAL verificado em 23/10/2026
 * (fixture test/fixtures/datajud-capture.json):
 *   POST https://api-publica.datajud.cnj.jus.br/api_publica_{alias}/_search
 *   Authorization: APIKey <chave pública do CNJ>
 *   body: { "query": { ... } } → { took, hits: { total: { value }, hits: [ {_source} ] } }
 * Observações medidas: match_all/amplo → 504/timeout (cluster lento) — usar
 * query dirigida; timeout 90 s. 401 sem chave = fatal (sem retry).
 * DJEN/Comunica (comunicaapi.pje.jus.br): 403 CloudFront neste sandbox em
 * 23/10/2026 — cliente por contrato, live-unverified (declarado).
 */
import type { DatajudDoc, DatajudSearchResponse } from "./types.js";

export interface DatajudClientOpts {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Chave PÚBLICA documentada pelo CNJ para a API pública (não é credencial nossa).
export const DATAJUD_PUBLIC_KEY =
  "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==";

const BASE = "https://api-publica.datajud.cnj.jus.br";

export interface DatajudQuery {
  numeroProcesso?: string; // 20 dígitos
  classe?: string;
  orgao?: string;
  dataDe?: string; // ISO
  dataAte?: string;
}

/** Query dirigida (match_all derruba o cluster — verificado). */
export function buildSearchQuery(q: DatajudQuery): Record<string, unknown> {
  const must: Array<Record<string, unknown>> = [];
  if (q.numeroProcesso) must.push({ term: { numeroProcesso: q.numeroProcesso } });
  if (q.classe) must.push({ term: { "classe.nome": q.classe } });
  if (q.orgao) must.push({ term: { "orgaoJulgador.nome": q.orgao } });
  if (q.dataDe || q.dataAte) {
    must.push({
      range: {
        dataAjuizamento: {
          ...(q.dataDe ? { gte: q.dataDe } : {}),
          ...(q.dataAte ? { lte: q.dataAte } : {}),
        },
      },
    });
  }
  return {
    query: must.length ? { bool: { must } } : { match_all: {} },
    size: 50,
    sort: [{ dataAjuizamento: { order: "desc" } }],
  };
}

export async function fetchProcessos(
  alias: string,
  query: DatajudQuery,
  opts: DatajudClientOpts = {},
): Promise<DatajudDoc[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const url = `${opts.baseUrl ?? BASE}/api_publica_${alias}/_search`;
  const body = JSON.stringify(buildSearchQuery(query));
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90_000);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `APIKey ${opts.apiKey ?? DATAJUD_PUBLIC_KEY}`,
          "content-type": "application/json",
        },
        body,
        signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw Object.assign(new Error(`DataJud ${res.status}`), { fatal: true });
      }
      if (!res.ok) {
        lastErr = new Error(`DataJud ${res.status}`);
        if (i < attempts - 1) {
          await sleep(600 * 2 ** i);
          continue;
        }
        throw lastErr;
      }
      const json = (await res.json()) as DatajudSearchResponse;
      return json.hits.hits.map((h) => h._source);
    } catch (err) {
      lastErr = err;
      if ((err as { fatal?: boolean }).fatal) throw err;
      if (i < attempts - 1) await sleep(600 * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
