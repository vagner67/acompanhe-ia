/**
 * "Modo IA de buscador" para o chat — pesquisa web REAL com fontes citadas.
 * Camadas (24/10/2026, contratos oficiais pesquisados; ver
 * docs/plano-91-tribunais-ia.md):
 *  1. Sem `AI_PROVIDER`/`AI_API_KEY` → `duckduckgo`: resultados REAIS do DDG
 *     (fixture testada), resposta montada só com os trechos das fontes + links;
 *     `geradaPorIA=false` (nada de resposta inventada).
 *  2. `AI_PROVIDER=tavily` (1.000 créditos grátis/mês, sem cartão) →
 *     `POST https://api.tavily.com/search {query, include_answer:true, max_results}`
 *     → `{answer, results:[{title,url,content}]}` — resposta IA + fontes.
 *  3. `AI_PROVIDER=perplexity` → `POST https://api.perplexity.ai/chat/completions`
 *     model `sonar` (Sonar migrou para Agent API em 27/09/2026; `search_results`
 *     substituiu `citations` deprecado) → resposta + search_results.
 *  4. `AI_PROVIDER=gemini` → `generateContent` + tool `google_search` → texto +
 *     groundingMetadata.groundingChunks (fontes reais do Google).
 * Sempre retorna `fontes` reais; nunca resposta sem fonte.
 */
import { buscarWebDetalhado, type DiagnosticoBusca, type FonteWeb } from "./buscaWeb.js";

export interface RespostaBuscador {
  provedor: "publico" | "tavily" | "perplexity" | "gemini";
  geradaPorIA: boolean;
  resposta: string;
  fontes: FonteWeb[];
  /** tentativas reais da busca pública (backend/status/motivo) — nada opaco */
  diagnostico: DiagnosticoBusca[];
}

export function provedorConfigurado(env: Record<string, string | undefined> = process.env): {
  provedor: "publico" | "tavily" | "perplexity" | "gemini";
  key: string | undefined;
} {
  const key = env["AI_API_KEY"];
  const p = (env["AI_PROVIDER"] ?? "").toLowerCase();
  if (key && (p === "tavily" || p === "perplexity" || p === "gemini")) return { provedor: p, key };
  return { provedor: "publico", key: undefined };
}

function montarRespostaDasFontes(fontes: FonteWeb[], pergunta: string): string {
  if (fontes.length === 0) {
    return [
      `A busca pública não devolveu resultados para “${pergunta}” agora.`,
      "Os buscadores gratuitos (DuckDuckGo e Wikipédia) não responderam a partir deste servidor — não é erro seu, e eu não invento resultados.",
      "Para a busca web com respostas garantidas e citações (modo IA), configure AI_PROVIDER=tavily e AI_API_KEY com a chave gratuita de tavily.com (1.000 consultas/mês, sem cartão).",
      "Enquanto isso, a busca por nº de processo (91 tribunais) e por nome/CPF nas fontes verificadas continua funcionando normalmente.",
    ].join("\n\n");
  }
  const linhas = fontes.slice(0, 6).map((f, i) => {
    const trecho = f.trecho ? ` — “${f.trecho.slice(0, 220)}${f.trecho.length > 220 ? "…" : ""}”` : "";
    return `${i + 1}. ${f.titulo}${trecho}\n   ${f.url}`;
  });
  return [
    `Resultados reais da busca pública para “${pergunta}” (DDG e/ou Wikipédia, sem resposta gerada por IA):`,
    ...linhas,
    "",
    "Para ativar respostas geradas com citações (modo IA do buscador), configure AI_PROVIDER=tavily (1.000 consultas grátis/mês em tavily.com) e AI_API_KEY no ambiente.",
  ].join("\n");
}

async function tavily(pergunta: string, key: string, f: typeof fetch): Promise<Omit<RespostaBuscador, "diagnostico">> {
  const resp = await f("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query: pergunta, include_answer: true, max_results: 8 }),
  });
  if (!resp.ok) throw new Error(`tavily http ${resp.status}`);
  const j = (await resp.json()) as {
    answer?: string;
    results?: { title?: string; url?: string; content?: string }[];
  };
  const fontes: FonteWeb[] = (j.results ?? []).map((r) => ({
    titulo: r.title ?? r.url ?? "(sem título)",
    url: r.url ?? "",
    trecho: r.content ?? "",
  }));
  return {
    provedor: "tavily",
    geradaPorIA: Boolean(j.answer),
    resposta: j.answer ?? montarRespostaDasFontes(fontes, pergunta),
    fontes,
  };
}

async function perplexity(pergunta: string, key: string, f: typeof fetch): Promise<Omit<RespostaBuscador, "diagnostico">> {
  const resp = await f("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: pergunta }] }),
  });
  if (!resp.ok) throw new Error(`perplexity http ${resp.status}`);
  const j = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
    search_results?: { title?: string; url?: string; snippet?: string }[];
  };
  const fontes: FonteWeb[] = (j.search_results ?? []).map((r) => ({
    titulo: r.title ?? r.url ?? "(sem título)",
    url: r.url ?? "",
    trecho: r.snippet ?? "",
  }));
  const resposta = j.choices?.[0]?.message?.content ?? "";
  return {
    provedor: "perplexity",
    geradaPorIA: Boolean(resposta),
    resposta: resposta || montarRespostaDasFontes(fontes, pergunta),
    fontes,
  };
}

async function gemini(pergunta: string, key: string, f: typeof fetch): Promise<Omit<RespostaBuscador, "diagnostico">> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`;
  const resp = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: pergunta }] }],
      tools: [{ google_search: {} }],
    }),
  });
  if (!resp.ok) throw new Error(`gemini http ${resp.status}`);
  const j = (await resp.json()) as {
    candidates?: {
      content?: { parts?: { text?: string }[] };
      groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
    }[];
  };
  const cand = j.candidates?.[0];
  const resposta = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const fontes: FonteWeb[] = (cand?.groundingMetadata?.groundingChunks ?? []).map((c) => ({
    titulo: c.web?.title ?? c.web?.uri ?? "(sem título)",
    url: c.web?.uri ?? "",
    trecho: "",
  }));
  return {
    provedor: "gemini",
    geradaPorIA: Boolean(resposta),
    resposta: resposta || montarRespostaDasFontes(fontes, pergunta),
    fontes,
  };
}

export async function responderComBuscador(
  pergunta: string,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<RespostaBuscador> {
  const f = opts.fetchImpl ?? fetch;
  const { provedor, key } = provedorConfigurado(opts.env);
  const base = await buscarWebDetalhado(pergunta, { fetchImpl: f }).catch(() => ({
    fontes: [] as FonteWeb[],
    diagnostico: [] as DiagnosticoBusca[],
  }));
  const fontesBase = base.fontes;
  try {
    if (provedor === "tavily" && key) return { ...(await tavily(pergunta, key, f)), diagnostico: base.diagnostico };
    if (provedor === "perplexity" && key) return { ...(await perplexity(pergunta, key, f)), diagnostico: base.diagnostico };
    if (provedor === "gemini" && key) return { ...(await gemini(pergunta, key, f)), diagnostico: base.diagnostico };
  } catch {
    // provedor pago falhou → cai nos resultados REAIS do DDG (nunca inventar)
  }
  return {
    provedor: "publico",
    geradaPorIA: false,
    resposta: montarRespostaDasFontes(fontesBase, pergunta),
    fontes: fontesBase,
    diagnostico: base.diagnostico,
  };
}
