/**
 * Cliente e-SAJ — consulta pública por NOME/DOCUMENTO de parte (plano-busca-unificada.md §2.2/§3.2).
 * Contrato VERIFICADO ao vivo em 24/10/2026 (fixtures reais em test/fixtures/esaj/):
 *   GET {base}/cpopg/search.do?conversationId=&cbPesquisa=NMPARTE|DOCPARTE
 *       &dadosConsulta.valorConsulta={valor}&cdForo=1&paginaConsulta={n}
 * Estados REAIS mapeados (textos literais):
 *   resultados | multiplos ("Foram encontrados muitos processos... refine sua busca")
 *   | vazio ("Não existem informações disponíveis para os parâmetros informados.")
 *   | bloqueado (captcha/403) | erro (resposta não reconhecida — nunca inventa).
 * Linhas: divProcesso{id} · linkProcesso (CNJ) · tipoDeParticipacao · nomeParte ·
 * classeProcesso · assuntoPrincipalProcesso · dataLocalDistribuicaoProcesso ·
 * agrupamento por h2.foroDosProcessos · total "NN Processos" · paginação paginaConsulta.
 */

export type EstadoPesquisa = "resultados" | "multiplos" | "vazio" | "bloqueado" | "erro";

export interface ProcessoTercero {
  numeroProcesso: string;
  codigoInterno: string | null;
  uf: string;
  foro: string | null;
  classe: string | null;
  assunto: string | null;
  participacao: string | null;
  nomeParte: string | null;
  dataDistribuicao: string | null;
  localDistribuicao: string | null;
  fonte: string;
  url: string;
}

export interface ResultadoEsaj {
  estado: EstadoPesquisa;
  uf: string;
  fonte: string;
  total: number | null;
  pagina: number;
  ultimaPagina: number;
  itens: ProcessoTercero[];
}

/** Bases e-SAJ VERIFICADAS (abertas, sem captcha) em 24/10/2026. Extender só com verificação. */
export const ESAJ_BASES: Record<string, string> = {
  al: "https://www2.tjal.jus.br",
  sp: "https://esaj.tjsp.jus.br",
  ac: "https://esaj.tjac.jus.br", // verificado 24/10: cpopg 200 NMPARTE+DOCPARTE, sem captcha (fixtures tjac-*)
  ce: "https://esaj.tjce.jus.br", // verificado 24/10 via curl (TLS Python do sandbox falha; Node/curl alcançam)
};

export const COBERTURA_UFS = Object.keys(ESAJ_BASES);

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

export function montarUrlPesquisa(base: string, tipo: "NMPARTE" | "DOCPARTE", valor: string, pagina: number): string {
  const q = encodeURIComponent(valor);
  return `${base}/cpopg/search.do?conversationId=&cbPesquisa=${tipo}&dadosConsulta.valorConsulta=${q}&cdForo=1&paginaConsulta=${pagina}`;
}

const CNJ_RE = /(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})/;

/** Classifica o estado REAL da página pelos textos medidos; nunca supõe sucesso. */
export function classificarPagina(html: string): EstadoPesquisa {
  const low = html.toLowerCase();
  if (low.includes("foram encontrados muitos processos")) return "multiplos";
  if (low.includes("não existem informações disponíveis")) return "vazio";
  if (low.includes("captcha") || low.includes("acesso negado") || low.includes("access denied")) return "bloqueado";
  if (html.includes("divProcesso") || CNJ_RE.test(html)) return "resultados";
  return "erro";
}

function limpar(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&ccedil;/g, "ç")
    .replace(/&atilde;/g, "ã")
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&oacute;/g, "ó")
    .replace(/&uacute;/g, "ú")
    .replace(/&acirc;/g, "â")
    .replace(/&ecirc;/g, "ê")
    .replace(/&ocirc;/g, "ô")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extrai as linhas no formato medido (parser único AL/SP — estruturas idênticas). */
export function parseResultadosEsaj(html: string, uf: string, pagina: number): ResultadoEsaj {
  const estado = classificarPagina(html);
  const fonte = `esaj-${uf}`;
  const base = ESAJ_BASES[uf] ?? "";
  const vazio: ResultadoEsaj = { estado, uf, fonte, total: null, pagina, ultimaPagina: 1, itens: [] };

  if (estado !== "resultados") return vazio;

  const itens: ProcessoTercero[] = [];
  const blocos = html.split(/(?=<div id="divProcesso)/).slice(1);
  for (const bloco of blocos) {
    const fim = bloco.indexOf("</li>");
    const trecho = fim > 0 ? bloco.slice(0, fim + 5) : bloco.slice(0, 4000);
    const mCnj = CNJ_RE.exec(trecho);
    if (!mCnj) continue;
    const codigo = /id="divProcesso([^"]+)"/.exec(trecho)?.[1]?.trim() ?? null;
    const pega = (re: RegExp): string | null => {
      const m = re.exec(trecho);
      return m ? limpar(m[1] ?? "") || null : null;
    };
    const dataLocal = pega(/class="dataLocalDistribuicaoProcesso">([\s\S]*?)<\/div>/);
    let dataDistribuicao: string | null = null;
    let localDistribuicao: string | null = null;
    if (dataLocal) {
      const sep = dataLocal.indexOf(" - ");
      if (sep > 0) {
        dataDistribuicao = dataLocal.slice(0, sep).trim();
        localDistribuicao = dataLocal.slice(sep + 3).trim();
      } else {
        dataDistribuicao = dataLocal;
      }
    }
    // foro: último h2.foroDosProcessos ANTES do bloco
    const inicioAbs = html.indexOf(trecho.slice(0, 60));
    const antes = html.slice(0, inicioAbs > 0 ? inicioAbs : 0);
    const foros = [...antes.matchAll(/foroDosProcessos">\s*([\s\S]*?)<\/h2>/g)];
    const foro = foros.length ? limpar(foros[foros.length - 1]![1] ?? "") || null : null;

    itens.push({
      numeroProcesso: mCnj[1]!,
      codigoInterno: codigo,
      uf,
      foro,
      classe: pega(/class="classeProcesso">([\s\S]*?)<\/div>/),
      assunto: pega(/class="assuntoPrincipalProcesso">([\s\S]*?)<\/div>/),
      participacao: pega(/class="unj-label tipoDeParticipacao">([\s\S]*?)<\/label>/)?.replace(/:$/, "") ?? null,
      nomeParte: pega(/class="unj-base-alt nomeParte">([\s\S]*?)<\/div>/),
      dataDistribuicao,
      localDistribuicao,
      fonte,
      url: codigo ? `${base}/cpopg/show.do?processo.codigo=${codigo}&processo.foro=1` : `${base}/cpopg/open.do`,
    });
  }

  const mTotal = /(\d+)\s*Processos?\b/.exec(limpar(html));
  const total = mTotal ? Number(mTotal[1]) : itens.length;
  const paginas = [...html.matchAll(/paginaConsulta=(\d+)/g)].map((m) => Number(m[1]));
  const ultimaPagina = Math.max(1, ...paginas);

  return { estado: itens.length ? "resultados" : "erro", uf, fonte, total, pagina, ultimaPagina, itens };
}

export interface ConsultarEsajOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function consultarEsaj(
  uf: string,
  tipo: "NMPARTE" | "DOCPARTE",
  valor: string,
  pagina: number,
  opts: ConsultarEsajOpts = {},
): Promise<ResultadoEsaj> {
  const base = ESAJ_BASES[uf];
  const fonte = `esaj-${uf}`;
  if (!base) {
    return { estado: "erro", uf, fonte, total: null, pagina, ultimaPagina: 1, itens: [] };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const url = montarUrlPesquisa(base, tipo, valor, pagina);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45_000);
    try {
      const res = await fetchImpl(url, { method: "GET", headers: { "user-agent": UA, accept: "text/html" }, signal: ctrl.signal });
      if (res.status === 403 || res.status === 429) {
        return { estado: "bloqueado", uf, fonte, total: null, pagina, ultimaPagina: 1, itens: [] };
      }
      if (!res.ok) {
        last = new Error(`e-SAJ ${res.status}`);
        if (i < attempts - 1) {
          await sleep(600);
          continue;
        }
        return { estado: "erro", uf, fonte, total: null, pagina, ultimaPagina: 1, itens: [] };
      }
      const html = await res.text();
      return parseResultadosEsaj(html, uf, pagina);
    } catch (err) {
      last = err;
      if (i < attempts - 1) await sleep(600);
    } finally {
      clearTimeout(timer);
    }
  }
  void last;
  return { estado: "erro", uf, fonte, total: null, pagina, ultimaPagina: 1, itens: [] };
}
