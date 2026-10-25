/**
 * Busca web REAL sem chave (DuckDuckGo HTML). Medido 24/10/2026:
 * `https://html.duckduckgo.com/html/?q=…` → 200, blocos `result__a` +
 * `result__snippet`, links via redirect `//duckduckgo.com/l/?uddg=<enc>`.
 * Fixture real: `test/fixtures/ddg/busca-cpc.html`. Sem resultados sintéticos.
 */
export interface FonteWeb {
  titulo: string;
  url: string;
  trecho: string;
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
    .replace(/\s+/g, " ").trim();
}

/** Parse do HTML do DDG (extraído da página real medida — não inventado). */
export function parseDdgHtml(html: string): FonteWeb[] {
  const out: FonteWeb[] = [];
  const links = html.matchAll(
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
  );
  const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => stripTags(m[1] ?? ""));
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

export async function buscarWeb(
  query: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<FonteWeb[]> {
  const f = opts.fetchImpl ?? fetch;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await f(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`duckduckgo http ${resp.status}`);
  return parseDdgHtml(await resp.text());
}
