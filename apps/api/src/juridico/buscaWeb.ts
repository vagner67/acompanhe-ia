/**
 * Busca web REAL sem chave (DuckDuckGo HTML/Lite parses) — medido 24/10/2026:
 *  - `html.duckduckgo.com/html/?q=…` com SÓ User-Agent → 200 + blocos
 *    `result__a`/`result__snippet` (fixture `busca-cpc.html`, 10 resultados).
 *  - Headers "de navegador" (Accept-Language etc.) → 202 anomaly
 *    (fixture `anomalia-202.html`); IPs de datacenter são limitados
 *    intermitentemente → retry com backoff e fallback para o endpoint Lite
 *    (`lite.duckduckgo.com/lite/` com `result-link`/`result-snippet`).
 *  - NUNCA inventa: quando bloqueado, devolve fontes vazias + diagnóstico
 *    honesto (backend, status, bytes, motivo) — o chamador informa o usuário.
 */
export interface FonteWeb {
  titulo: string;
  url: string;
  trecho: string;
}

export interface DiagnosticoBusca {
  backend: string;
  status: number;
  bytes: number;
  motivo?: string;
}

export interface ResultadoBuscaWeb {
  fontes: FonteWeb[];
  diagnostico: DiagnosticoBusca[];
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

function decodeDdgRedirect(href: string): string {
  try {
    const m = /[?&]uddg=([^&]+)/.exec(href);
    if (m) return decodeURIComponent(m[1]!);
    return href;
  } catch {
    return href;
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** Parse do HTML "completo" (result__a + result__snippet) — extraído da página real. */
export function parseDdgHtml(html: string): FonteWeb[] {
  const out: FonteWeb[] = [];
  const links = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1] ?? ""));
  let i = 0;
  for (const m of links) {
    const url = decodeDdgRedirect(m[1] ?? "");
    const titulo = stripTags(m[2] ?? "");
    if (!url || !titulo) continue;
    out.push({ titulo, url, trecho: snips[i] ?? "" });
    i += 1;
    if (out.length >= 10) break;
  }
  return out;
}

/** Parse do endpoint Lite (result-link + td.result-snippet). */
export function parseDdgLite(html: string): FonteWeb[] {
  const out: FonteWeb[] = [];
  const links = [...html.matchAll(/<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  if (links.length === 0) {
    // variação de ordem dos atributos
    links.push(...[...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/g)]);
  }
  const snips = [...html.matchAll(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1] ?? ""));
  let i = 0;
  for (const m of links) {
    const url = decodeDdgRedirect(m[1] ?? "");
    const titulo = stripTags(m[2] ?? "");
    if (!url || !titulo) continue;
    out.push({ titulo, url, trecho: snips[i] ?? "" });
    i += 1;
    if (out.length >= 10) break;
  }
  return out;
}

/** Parse da API oficial da Wikipédia pt (action=query&list=search) — JSON real. */
export function parseWikipediaJson(json: string): FonteWeb[] {
  try {
    const j = JSON.parse(json) as { query?: { search?: { title?: string; snippet?: string }[] } };
    return (j.query?.search ?? [])
      .filter((h) => h.title)
      .slice(0, 8)
      .map((h) => ({
        titulo: h.title!,
        url: `https://pt.wikipedia.org/wiki/${encodeURIComponent(h.title!.replace(/ /g, "_"))}`,
        trecho: stripTags(h.snippet ?? ""),
      }));
  } catch {
    return [];
  }
}

/** Página de bloqueio/anomalia do DDG (medida: 202 com "anomaly"/"challenge"). */
export function ehAnomalia(html: string): boolean {
  return /anomaly-modal|challenge-form|challenge\b|unusual traffic/i.test(html);
}

const espera = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const UA_WIKI = `${UA} (Acompanhe.IA; contato@acompanhe.app)`;

/**
 * Cadeia de backends SEM CHAVE. Ordem medida em 24/10/2026:
 * DDG html/lite (bloqueiam IPs de datacenter com frequência) e, por último,
 * a API oficial da Wikipédia pt — estável de servidor e com trechos citáveis
 * (fonte real, nunca conteúdo gerado).
 */
const BACKENDS = [
  { nome: "ddg-html", url: (q: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDdgHtml, ua: UA },
  { nome: "ddg-lite", url: (q: string) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDdgLite, ua: UA },
  {
    nome: "wikipedia-pt",
    url: (q: string) =>
      `https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=8&utf8=1`,
    parse: parseWikipediaJson,
    ua: UA_WIKI,
  },
];

export async function buscarWebDetalhado(
  query: string,
  opts: { fetchImpl?: typeof fetch; tentativas?: number; pausaMs?: number } = {},
): Promise<ResultadoBuscaWeb> {
  const f = opts.fetchImpl ?? fetch;
  const tentativas = Math.max(1, opts.tentativas ?? 2);
  const pausa = opts.pausaMs ?? 700;
  const diagnostico: DiagnosticoBusca[] = [];
  for (let t = 0; t < tentativas; t++) {
    for (const b of BACKENDS) {
      try {
        const resp = await f(b.url(query), { headers: { "User-Agent": b.ua } });
        const html = await resp.text();
        const anomalia = resp.status === 202 || ehAnomalia(html);
        const fontes = anomalia ? [] : b.parse(html);
        diagnostico.push({
          backend: b.nome,
          status: resp.status,
          bytes: html.length,
          ...(anomalia ? { motivo: "limite anti-robô do buscador (202/anomaly)" } : fontes.length === 0 ? { motivo: "página sem blocos de resultado" } : {}),
        });
        if (fontes.length > 0) return { fontes, diagnostico };
      } catch (e) {
        diagnostico.push({ backend: b.nome, status: 0, bytes: 0, motivo: (e as Error).message.slice(0, 80) });
      }
    }
    if (t < tentativas - 1) await espera(pausa);
  }
  return { fontes: [], diagnostico };
}

export async function buscarWeb(query: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<FonteWeb[]> {
  const r = await buscarWebDetalhado(query, opts);
  return r.fontes;
}
