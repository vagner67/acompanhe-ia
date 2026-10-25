/**
 * DJEN / Comunica (CNJ) — a ÚNICA fonte NACIONAL por NOME de parte.
 * Contrato lido do swagger oficial `cnj/pcp 1.0.0` em 25/10/2026:
 *   GET {base}/comunicacao?nomeParte=&numeroProcesso=&siglaTribunal=&dataDisponibilizacaoInicio/Fim=&pagina=&itensPorPagina=
 *   → { status, message, count, items:[{ numero_processo, numeroprocessocommascara, siglaTribunal,
 *        data_disponibilizacao, tipoComunicacao, nomeOrgao, nomeClasse, texto, link, hash,
 *        destinatarios:[{nome,polo}], destinatarioadvogados:[{advogado:{nome,numero_oab,uf_oab}}] }] }
 *
 * MEDIDO (25/10/2026): a API responde 403 (CloudFront) para IP fora do Brasil — inclusive quando
 * requisitada por um leitor terceiro, o que prova bloqueio por origem. Por isso:
 *   - `DJEN_RELAY_URL` permite apontar um relay que saia do Brasil (o adapter apenas prefixa a URL);
 *   - sem relay, o estado é `geo_bloqueado` — nunca "sem resultados" (mentira) nem erro genérico.
 * Não há captcha nesse caminho: é uma API pública feita pelo CNJ para terceiros (Res. 455/2022).
 */
import { formatarNumero } from "./cnj.js";

export const DJEN_BASE_PADRAO = "https://comunicaapi.pje.jus.br/api/v1";

export type EstadoDjen = "ok" | "geo_bloqueado" | "rate_limit" | "indisponivel" | "sem_resultados" | "erro";

export interface PublicacaoDjen {
  id: number | null;
  tribunal: string | null;
  numeroProcesso: string | null; // sempre CNJ canônico quando derivável
  dataDisponibilizacao: string | null;
  tipoComunicacao: string | null;
  orgao: string | null;
  classe: string | null;
  texto: string | null;
  link: string | null;
  destinatarios: Array<{ nome: string; polo: "A" | "P" | null }>;
  advogados: Array<{ nome: string; oab: string | null; uf: string | null }>;
}

export interface ResultadoDjen {
  estado: EstadoDjen;
  http: number | null;
  ms: number;
  count: number | null;
  itens: PublicacaoDjen[];
  motivo?: string;
}

export interface BuscaDjen {
  nomeParte?: string;
  numeroProcesso?: string;
  siglaTribunal?: string;
  de?: string; // AAAA-MM-DD
  ate?: string; // AAAA-MM-DD
  pagina?: number;
  limite?: number;
}

export interface DjenOpts {
  base?: string;
  /** Proxy que faz a requisição sair do Brasil. Recebe a URL final como sufixo. */
  relay?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** tentativas extras em 429/5xx (backoff de 400 ms × tentativa) */
  retries?: number;
}

const LIMITE_TETO = 50; // itensPorPagina aceito pela API
export const DJEN_TETO_RESULTADOS = 10_000; // corte silencioso documentado pelo CNJ

function limpar(s: unknown, max = 600): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function polo(v: unknown): "A" | "P" | null {
  const s = String(v ?? "").toUpperCase();
  if (s === "A") return "A";
  if (s === "P") return "P";
  return null;
}

/** Converte um item do payload no nosso DTO. Tolerante a snake_case e camelCase. */
export function mapearItem(raw: Record<string, unknown>): PublicacaoDjen {
  const numeroBruto =
    (raw["numero_processo"] as string | undefined) ??
    (raw["numeroprocessocommascara"] as string | undefined) ??
    (raw["numeroProcesso"] as string | undefined) ??
    null;
  const destinatarios = Array.isArray(raw["destinatarios"])
    ? (raw["destinatarios"] as Array<Record<string, unknown>>).map((d) => ({
        nome: limpar(d["nome"], 120) ?? "",
        polo: polo(d["polo"]),
      }))
    : [];
  const advogadosRaw = Array.isArray(raw["destinatarioadvogados"]) ? (raw["destinatarioadvogados"] as Array<Record<string, unknown>>) : [];
  const advogados = advogadosRaw
    .map((a) => (a["advogado"] ?? a) as Record<string, unknown>)
    .map((a) => ({
      nome: limpar(a["nome"], 120) ?? "",
      oab: (a["numero_oab"] as string | undefined) ?? null,
      uf: (a["uf_oab"] as string | undefined) ?? null,
    }))
    .filter((a) => a.nome);
  return {
    id: typeof raw["id"] === "number" ? (raw["id"] as number) : null,
    tribunal: ((raw["siglaTribunal"] as string | undefined) ?? null)?.toUpperCase() ?? null,
    numeroProcesso: numeroBruto ? (formatarNumero(numeroBruto) ?? numeroBruto) : null,
    dataDisponibilizacao:
      (raw["data_disponibilizacao"] as string | undefined) ?? (raw["datadisponibilizacao"] as string | undefined) ?? null,
    tipoComunicacao: (raw["tipoComunicacao"] as string | undefined) ?? null,
    orgao: limpar(raw["nomeOrgao"], 120),
    classe: limpar(raw["nomeClasse"], 120),
    texto: limpar(raw["texto"]),
    link: (raw["link"] as string | undefined) ?? null,
    destinatarios,
    advogados,
  };
}

export function montarUrlDjen(busca: BuscaDjen, opts: { base?: string; relay?: string | null; pagina?: number } = {}): string {
  const base = (opts.base ?? DJEN_BASE_PADRAO).replace(/\/$/, "");
  const p = new URLSearchParams();
  if (busca.nomeParte) p.set("nomeParte", busca.nomeParte.trim());
  if (busca.numeroProcesso) p.set("numeroProcesso", busca.numeroProcesso.replace(/\D+/g, ""));
  if (busca.siglaTribunal) p.set("siglaTribunal", busca.siglaTribunal.toUpperCase());
  if (busca.de) p.set("dataDisponibilizacaoInicio", busca.de);
  if (busca.ate) p.set("dataDisponibilizacaoFim", busca.ate);
  p.set("pagina", String(opts.pagina ?? busca.pagina ?? 1));
  p.set("itensPorPagina", String(Math.min(Math.max(1, busca.limite ?? 20), LIMITE_TETO)));
  const alvo = `${base}/comunicacao?${p.toString()}`;
  return opts.relay ? `${opts.relay.replace(/\/$/, "")}/${alvo}` : alvo;
}

/** Classifica a resposta HTTP no estado honesto correspondente. */
export function classificarHttp(status: number): EstadoDjen {
  if (status === 200) return "ok";
  if (status === 403) return "geo_bloqueado";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "indisponivel";
  return "erro";
}

export async function buscarDjen(busca: BuscaDjen, opts: DjenOpts = {}): Promise<ResultadoDjen> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const relay = opts.relay ?? process.env.DJEN_RELAY_URL ?? null;
  const base = opts.base ?? process.env.DJEN_BASE_URL ?? DJEN_BASE_PADRAO;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const retries = opts.retries ?? 2;
  const url = montarUrlDjen(busca, { base, relay });

  let ultimoHttp: number | null = null;
  let motivo: string | undefined;
  const t0 = Date.now();
  for (let tentativa = 0; tentativa <= retries; tentativa++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { Accept: "application/json", "User-Agent": "AcompanheIA/1.0 (+https://acompanhe.onrender.com)" },
      });
      ultimoHttp = r.status;
      const estadoHttp = classificarHttp(r.status);
      if (estadoHttp === "ok") {
        const corpo = (await r.json()) as { count?: number; items?: Array<Record<string, unknown>>; message?: string };
        const itens = (corpo.items ?? []).map(mapearItem);
        return {
          estado: itens.length ? "ok" : "sem_resultados",
          http: r.status,
          ms: Date.now() - t0,
          count: typeof corpo.count === "number" ? corpo.count : itens.length,
          itens,
        };
      }
      motivo = estadoHttp === "geo_bloqueado" ? "403 CloudFront: a API bloqueia IP fora do Brasil (configure DJEN_RELAY_URL com egress brasileiro)" : `HTTP ${r.status}`;
      // 403 não melhora com retry; 429/5xx sim
      if (estadoHttp === "geo_bloqueado" || estadoHttp === "erro") break;
      await new Promise((res) => setTimeout(res, 400 * (tentativa + 1)));
    } catch (e) {
      motivo = `falha de rede: ${(e as Error).message}`;
      ultimoHttp = ultimoHttp ?? 0;
      await new Promise((res) => setTimeout(res, 400 * (tentativa + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    estado: ultimoHttp === null ? "erro" : (classificarHttp(ultimoHttp) === "ok" ? "erro" : classificarHttp(ultimoHttp)),
    http: ultimoHttp,
    ms: Date.now() - t0,
    count: null,
    itens: [],
    ...(motivo ? { motivo } : {}),
  };
}

export interface ProcessoDjen {
  numeroProcesso: string;
  tribunal: string | null;
  partes: Array<{ nome: string; polo: "A" | "P" | null }>;
  ultimaPublicacao: string | null;
  tipoUltima: string | null;
  orgao: string | null;
  classe: string | null;
  link: string | null;
  publicacoes: number;
}

/**
 * Agrupa publicações por processo — é assim que o DJEN vira índice de NOME:
 * a intimação diz "quem" está naquele processo, e aí o número resolve o resto no DataJud.
 */
export function agruparDjenPorProcesso(itens: PublicacaoDjen[]): ProcessoDjen[] {
  const mapa = new Map<string, ProcessoDjen>();
  for (const p of itens) {
    if (!p.numeroProcesso) continue;
    const atual = mapa.get(p.numeroProcesso);
    if (!atual) {
      mapa.set(p.numeroProcesso, {
        numeroProcesso: p.numeroProcesso,
        tribunal: p.tribunal,
        partes: [...p.destinatarios],
        ultimaPublicacao: p.dataDisponibilizacao,
        tipoUltima: p.tipoComunicacao,
        orgao: p.orgao,
        classe: p.classe,
        link: p.link,
        publicacoes: 1,
      });
      continue;
    }
    atual.publicacoes += 1;
    for (const d of p.destinatarios) {
      if (d.nome && !atual.partes.some((x) => x.nome === d.nome)) atual.partes.push(d);
    }
    if (p.dataDisponibilizacao && (!atual.ultimaPublicacao || p.dataDisponibilizacao > atual.ultimaPublicacao)) {
      atual.ultimaPublicacao = p.dataDisponibilizacao;
      atual.tipoUltima = p.tipoComunicacao;
      atual.orgao = p.orgao ?? atual.orgao;
      atual.link = p.link ?? atual.link;
    }
  }
  return [...mapa.values()];
}

/** Janela retroativa padrão (o DJEN só publica; não guarda "tudo desde sempre" na consulta). */
export function janelaPadrao(agora = new Date(), dias = 30): { de: string; ate: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const de = new Date(agora.getTime() - dias * 86_400_000);
  return { de: iso(de), ate: iso(agora) };
}
