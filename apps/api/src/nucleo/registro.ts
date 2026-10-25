/**
 * Registro único de coletores (plano.md §3.2).
 *
 * Antes existiam três catálogos (juridico/fontes.ts, osint/sources.ts, juridico/frota.ts)
 * e o motor só enxergava os cinco do Jurídico. Aqui cada coletor REAL do app se declara
 * com a mesma forma; o núcleo mede todos, diagnostica e corrige sem código por fonte.
 *
 * Nenhum adapter inventa endpoint: todos chamam a função que já existe no produto
 * (consultarEsaj, buscarDjen, fetchProcessos, fetchContratacoesPage, fetchBusca) ou o
 * host oficial declarado na própria fonte (rdap.org, crt.sh, archive.org).
 */
import { fetchBusca as douBusca } from "../concursos/dou.js";
import { fetchProcessos } from "../juridico/datajud.js";
import { buscarDjen } from "../juridico/djen.js";
import { consultarEsaj, ESAJ_BASES } from "../juridico/esaj.js";
import { variarNome } from "../juridico/nacional.js";
import { fetchContratacoesPage } from "../licitacoes/pncp.js";
import {
  bool,
  num,
  texto,
  type Coletor,
  type CtxColeta,
  type Params,
  type ResultadoColeta,
} from "./tipos.js";

const TRECHO_MAX = 400;
/** UA identificado: rdap.org e crt.sh respondem 403/502 para user-agent vazio (medido). */
const UA_NUCLEO = "Mozilla/5.0 (compatible; acompanhe.ia/1.0; +https://acompanhe.onrender.com)";

/** Sanitiza o que vai como evidência: sem HTML, sem credencial, sem CPF em claro. */
export function amostra(v: unknown): string {
  const bruto = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return bruto
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "***.***.***-**")
    .trim()
    .slice(0, TRECHO_MAX);
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function buscarComTimeout(
  url: string,
  ctx: CtxColeta | undefined,
  timeoutMs = 10_000,
  headers: Record<string, string> = {},
): Promise<{ http: number | null; corpo: string; ms: number; erro?: string }> {
  const f = ctx?.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await f(url, { headers: { accept: "*/*", "user-agent": UA_NUCLEO, ...headers }, signal: ctrl.signal });
    const corpo = await res.text();
    return { http: res.status, corpo, ms: Date.now() - t0 };
  } catch (e) {
    return { http: null, corpo: "", ms: Date.now() - t0, erro: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── Jurídico: e-SAJ (4 UFs abertas) ─────────────────────────

function coletorEsaj(uf: string): Coletor {
  return {
    id: `esaj-${uf}`,
    modulo: "juridico",
    host: `esaj.tj${uf}.jus.br`,
    familia: "html",
    descricao: `e-SAJ ${uf.toUpperCase()} — consulta pública por nome da parte`,
    padrao: { varianteNome: 0 },
    espaco: {
      varianteNome: {
        tipo: "enum",
        opcoes: [0, 1, 2],
        descricao: "0 = termo exato, 1 = sem acento, 2 = sobrenome + primeiro nome",
      },
    },
    canarios: [{ id: "nome-comum", consulta: "João Carlos", esperaMinItens: 1 }],
    orcamento: { rpm: 6, rpd: 400 },
    async executar(p: Params, ctx?: CtxColeta): Promise<ResultadoColeta> {
      const t0 = Date.now();
      const variante = (num(p, "varianteNome", 0) === 1 ? 1 : num(p, "varianteNome", 0) === 2 ? 2 : 0) as 0 | 1 | 2;
      const termo = variarNome(ctx?.consulta ?? "João Carlos", variante);
      const r = await consultarEsaj(uf, "NMPARTE", termo, 1);
      const itens = r.itens.length;
      const ok = r.estado === "resultados" || (r.estado === "multiplos" && itens > 0);
      return {
        ok,
        http: 200,
        ms: Date.now() - t0,
        itens,
        ...(r.estado === "bloqueado" ? { captcha: true, erro: "portal exige captcha" } : {}),
        ...(r.estado === "erro" ? { erro: "portal respondeu com erro" } : {}),
        ...(r.estado === "multiplos" && itens === 0
          ? { erro: "muitos processos — portal pede refinamento do termo", precisaRefinar: true }
          : {}),
        amostra: amostra(`${r.estado}; ${itens} itens; termo=${termo}`),
      };
    },
  };
}

// ───────────────────────── Jurídico: DJEN/Comunica (nacional por nome) ─────────────────────────

const coletorDjen: Coletor = {
  id: "djen",
  modulo: "juridico",
  host: "comunicaapi.pje.jus.br",
  familia: "api-json",
  descricao: "DJEN/Comunica (CNJ) — publicações nacionais por nome",
  padrao: { timeoutMs: 12_000, retries: 1 },
  espaco: {
    timeoutMs: { tipo: "numero", min: 3_000, max: 30_000, passo: 3_000, descricao: "timeout por requisição" },
    retries: { tipo: "numero", min: 0, max: 3, passo: 1, descricao: "tentativas em 429/5xx" },
  },
  canarios: [{ id: "nome-comum", consulta: "João Carlos", esperaMinItens: 1 }],
  orcamento: { rpm: 4, rpd: 200 },
  async executar(p: Params, ctx?: CtxColeta): Promise<ResultadoColeta> {
    const r = await buscarDjen(
      { nomeParte: ctx?.consulta ?? "João Carlos", pagina: 1, limite: 20 },
      {
        timeoutMs: num(p, "timeoutMs", 12_000),
        retries: num(p, "retries", 1),
        ...(ctx?.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        ...(bool(p, "usaRelay", false) ? {} : { relay: null }),
      },
    );
    return {
      ok: r.estado === "ok" || r.estado === "sem_resultados",
      http: r.http,
      ms: r.ms,
      itens: r.itens.length,
      ...(r.estado === "geo_bloqueado" ? { http: 403, bloqueio: true, erro: r.motivo ?? "geo-bloqueado (403)" } : {}),
      ...(r.estado === "rate_limit" ? { http: 429, bloqueio: true, erro: "rate limit (429)" } : {}),
      ...(r.estado === "indisponivel" ? { erro: r.motivo ?? "indisponível (5xx)" } : {}),
      ...(r.estado === "erro" ? { erro: r.motivo ?? "erro na consulta" } : {}),
      ...(r.estado === "ok" && r.itens.length === 0 ? { camposFaltando: ["items"] } : {}),
      amostra: amostra(`${r.estado}; ${r.itens.length} itens; ${r.motivo ?? ""}`),
    };
  },
};

// ───────────────────────── Jurídico: DataJud (número, 91 tribunais) ─────────────────────────

const coletorDatajud: Coletor = {
  id: "datajud",
  modulo: "juridico",
  host: "api-publica.datajud.cnj.jus.br",
  familia: "api-json",
  descricao: "DataJud (CNJ) — metadados por número em 91 tribunais (sem partes)",
  padrao: { attempts: 3, timeoutMs: 15_000 },
  espaco: {
    attempts: { tipo: "numero", min: 1, max: 5, passo: 1 },
    timeoutMs: { tipo: "numero", min: 5_000, max: 30_000, passo: 5_000 },
  },
  // processo REAL da fixture de produção (tjmt) — se este some, o contrato mudou
  canarios: [{ id: "cnj-real", consulta: "0006903-69.2014.8.11.0037", esperaMinItens: 1 }],
  orcamento: { rpm: 10, rpd: 600 },
  async executar(p: Params, ctx?: CtxColeta): Promise<ResultadoColeta> {
    const t0 = Date.now();
    try {
      const docs = await fetchProcessos(
        "tjmt",
        { numeroProcesso: (ctx?.consulta ?? "0006903-69.2014.8.11.0037").replace(/\D/g, "") },
        {
          attempts: num(p, "attempts", 3),
          timeoutMs: num(p, "timeoutMs", 15_000),
          ...(ctx?.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
          ...(ctx?.env?.["DATAJUD_API_KEY"] ? { apiKey: ctx.env["DATAJUD_API_KEY"] } : {}),
        },
      );
      return {
        ok: docs.length > 0,
        http: 200,
        ms: Date.now() - t0,
        itens: docs.length,
        ...(docs.length === 0 ? { camposFaltando: ["hits.hits"] } : {}),
        amostra: amostra(`${docs.length} documentos; campos=${docs[0] ? Object.keys(docs[0]).slice(0, 8).join(",") : "—"}`),
      };
    } catch (e) {
      const msg = (e as Error).message;
      const http = Number(msg.match(/\b(4\d\d|5\d\d)\b/)?.[1] ?? 0) || null;
      return {
        ok: false,
        http,
        ms: Date.now() - t0,
        itens: 0,
        erro: msg.slice(0, 200),
        ...(http === 401 || http === 403 ? { bloqueio: true } : {}),
        amostra: amostra(msg),
      };
    }
  },
};

// ───────────────────────── Licitações: PNCP ─────────────────────────

const coletorPncp: Coletor = {
  id: "pncp-contratacoes",
  modulo: "licitacoes",
  host: "pncp.gov.br",
  familia: "api-json",
  descricao: "PNCP — contratações publicadas (janela de 7 dias)",
  padrao: { tamanhoPagina: 50, attempts: 1 },
  espaco: {
    tamanhoPagina: { tipo: "numero", min: 10, max: 100, passo: 10, descricao: "itens por página (mínimo 10 no contrato)" },
    attempts: { tipo: "numero", min: 1, max: 3, passo: 1 },
  },
  canarios: [{ id: "janela-7d", consulta: "contratacoes-7d", esperaMinItens: 1 }],
  orcamento: { rpm: 10, rpd: 500 },
  async executar(p: Params, ctx?: CtxColeta): Promise<ResultadoColeta> {
    const t0 = Date.now();
    const agora = ctx?.agora ?? new Date();
    const inicio = new Date(agora.getTime() - 7 * 86_400_000);
    try {
      const page = await fetchContratacoesPage(
        "publicacao", // contratações publicadas (rota real /contratacoes/publicacao)
        {
          dataInicial: ymd(inicio),
          dataFinal: ymd(agora),
          codigoModalidadeContratacao: 6,
          tamanhoPagina: num(p, "tamanhoPagina", 50),
          pagina: 1,
        },
        { attempts: num(p, "attempts", 1), timeoutMs: 20_000, ...(ctx?.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) },
      );
      const itens = page.data?.length ?? 0;
      return {
        ok: itens > 0,
        http: 200,
        ms: Date.now() - t0,
        itens,
        ...(itens === 0 ? { camposFaltando: ["data"] } : {}),
        amostra: amostra(`total=${page.totalRegistros ?? "?"}; itens=${itens}`),
      };
    } catch (e) {
      const msg = (e as Error).message;
      const http = Number(msg.match(/\b(4\d\d|5\d\d)\b/)?.[1] ?? 0) || null;
      return {
        ok: false,
        http,
        ms: Date.now() - t0,
        itens: 0,
        erro: msg.slice(0, 200),
        ...(http === 429 ? { bloqueio: true } : {}),
        amostra: amostra(msg),
      };
    }
  },
};

// ───────────────────────── Concursos: DOU / in.gov.br ─────────────────────────

const coletorDou: Coletor = {
  id: "dou-busca",
  modulo: "concursos",
  host: "www.in.gov.br",
  familia: "html",
  descricao: "DOU (in.gov.br) — busca de editais de concurso",
  // 1 tentativa + timeout curto: retry é papel do próximo ciclo, não deste
  padrao: { attempts: 1, timeoutMs: 15_000 },
  espaco: {
    attempts: { tipo: "numero", min: 1, max: 3, passo: 1 },
    timeoutMs: { tipo: "numero", min: 5_000, max: 30_000, passo: 5_000 },
  },
  canarios: [{ id: "edital", consulta: "edital concurso", esperaMinItens: 1 }],
  orcamento: { rpm: 4, rpd: 120 },
  async executar(p: Params, ctx?: CtxColeta): Promise<ResultadoColeta> {
    const t0 = Date.now();
    const agora = ctx?.agora ?? new Date();
    const de = new Date(agora.getTime() - 7 * 86_400_000);
    try {
      const itens = await douBusca(
        { q: ctx?.consulta ?? "edital concurso", secao: "do3", publishFrom: iso(de), publishTo: iso(agora) },
        {
          attempts: num(p, "attempts", 1),
          timeoutMs: num(p, "timeoutMs", 15_000),
          ...(ctx?.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        },
      );
      return {
        ok: itens.length > 0,
        http: 200,
        ms: Date.now() - t0,
        itens: itens.length,
        ...(itens.length === 0 ? { camposFaltando: ["jsonArray"] } : {}),
        amostra: amostra(`${itens.length} itens; 1º=${itens[0]?.title ?? "—"}`),
      };
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false, http: Number(msg.match(/\b(4\d\d|5\d\d)\b/)?.[1] ?? 0) || null, ms: Date.now() - t0, itens: 0, erro: msg.slice(0, 200), amostra: amostra(msg) };
    }
  },
};

// ───────────────────────── Investiga: OSINT (3 fontes abertas + 1 com credencial) ─────────────────────────

function coletorHttpOsint(opts: {
  id: string;
  host: string;
  descricao: string;
  url: (consulta: string) => string;
  interpretar: (http: number | null, corpo: string) => { itens: number; camposFaltando?: string[]; erro?: string };
  canario: string;
  familia?: "registro" | "api-json" | "html";
}): Coletor {
  return {
    id: opts.id,
    modulo: "investiga",
    host: opts.host,
    familia: opts.familia ?? "registro",
    descricao: opts.descricao,
    padrao: { timeoutMs: 8_000 },
    espaco: { timeoutMs: { tipo: "numero", min: 3_000, max: 20_000, passo: 2_000 } },
    canarios: [{ id: "dominio-publico", consulta: opts.canario, esperaMinItens: 1 }],
    orcamento: { rpm: 6, rpd: 300 },
    async executar(p: Params, ctx?: CtxColeta): Promise<ResultadoColeta> {
      const url = opts.url(ctx?.consulta ?? opts.canario);
      const r = await buscarComTimeout(url, ctx, num(p, "timeoutMs", 8_000));
      if (r.erro) {
        return { ok: false, http: null, ms: r.ms, itens: 0, erro: r.erro, amostra: amostra(r.erro) };
      }
      const lido = opts.interpretar(r.http, r.corpo);
      const bloqueio = r.http === 403 || r.http === 429;
      return {
        ok: (r.http ?? 0) < 400 && lido.itens > 0,
        http: r.http,
        ms: r.ms,
        itens: lido.itens,
        ...(bloqueio ? { bloqueio: true, erro: `HTTP ${r.http}` } : {}),
        ...(lido.erro ? { erro: lido.erro } : {}),
        ...(lido.camposFaltando?.length ? { camposFaltando: lido.camposFaltando } : {}),
        amostra: amostra(r.corpo.slice(0, TRECHO_MAX)),
      };
    },
  };
}

const coletorRdap = coletorHttpOsint({
  id: "osint-rdap",
  host: "rdap.org",
  descricao: "RDAP — registro de domínio (fonte primária)",
  canario: "example.com",
  url: (d) => `https://rdap.org/domain/${encodeURIComponent(d)}`,
  interpretar: (http, corpo) => {
    if (http !== 200) return { itens: 0, erro: `HTTP ${http}` };
    try {
      const j = JSON.parse(corpo) as { ldhName?: string; events?: unknown[] };
      return j.ldhName ? { itens: 1 } : { itens: 0, camposFaltando: ["ldhName"] };
    } catch {
      return { itens: 0, camposFaltando: ["json"], erro: "resposta não é JSON" };
    }
  },
});

const coletorCrtsh = coletorHttpOsint({
  id: "osint-crtsh",
  host: "crt.sh",
  descricao: "Certificate Transparency (crt.sh) — subdomínios por certificado",
  canario: "example.com",
  url: (d) => `https://crt.sh/?q=${encodeURIComponent(`%.${d}`)}&output=json`,
  interpretar: (http, corpo) => {
    if (http !== 200) return { itens: 0, erro: `HTTP ${http}` };
    try {
      const arr = JSON.parse(corpo) as unknown[];
      return Array.isArray(arr) ? { itens: arr.length } : { itens: 0, camposFaltando: ["array"] };
    } catch {
      return { itens: 0, camposFaltando: ["json"], erro: "crt.sh devolveu HTML em vez de JSON" };
    }
  },
});

const coletorWayback = coletorHttpOsint({
  id: "osint-wayback",
  host: "archive.org",
  descricao: "Wayback Machine — snapshots históricos",
  canario: "example.com",
  familia: "api-json",
  url: (d) => `https://archive.org/wayback/available?url=${encodeURIComponent(d)}`,
  interpretar: (http, corpo) => {
    if (http !== 200) return { itens: 0, erro: `HTTP ${http}` };
    try {
      const j = JSON.parse(corpo) as { archived_snapshots?: { closest?: unknown } };
      return j.archived_snapshots?.closest ? { itens: 1 } : { itens: 0, camposFaltando: ["archived_snapshots.closest"] };
    } catch {
      return { itens: 0, camposFaltando: ["json"], erro: "resposta não é JSON" };
    }
  },
});

const coletorHibp: Coletor = {
  id: "osint-hibp",
  modulo: "investiga",
  host: "haveibeenpwned.com",
  familia: "api-json",
  descricao: "Have I Been Pwned — exige chave paga; sem chave fica declarado",
  padrao: { timeoutMs: 8_000 },
  espaco: {},
  canarios: [{ id: "email-publico", consulta: "test@example.com", esperaMinItens: 0 }],
  orcamento: { rpm: 2, rpd: 50 },
  exigirCredencial: "HIBP_API_KEY",
  async executar(p: Params, ctx?: CtxColeta): Promise<ResultadoColeta> {
    const key = ctx?.env?.["HIBP_API_KEY"];
    if (!key) {
      return {
        ok: false,
        http: null,
        ms: 0,
        itens: 0,
        erro: "sem credencial HIBP_API_KEY",
        semCredencial: true,
        amostra: "coletor não executado: falta HIBP_API_KEY",
      };
    }
    const email = encodeURIComponent(ctx?.consulta ?? "test@example.com");
    const r = await buscarComTimeout(`https://haveibeenpwned.com/api/v3/breachedaccount/${email}?truncateResponse=true`, ctx, num(p, "timeoutMs", 8_000), { "hibp-api-key": key, "user-agent": "acompanhe.ia" });
    return {
      ok: r.http === 200 || r.http === 404,
      http: r.http,
      ms: r.ms,
      itens: r.http === 200 ? (JSON.parse(r.corpo || "[]") as unknown[]).length : 0,
      ...(r.http === 404 ? { itens: 0 } : {}),
      ...(r.http === 401 ? { bloqueio: true, erro: "chave recusada (401)" } : {}),
      amostra: amostra(`${r.http}; ${r.corpo.slice(0, 120)}`),
    };
  },
};

// ───────────────────────── Registro ─────────────────────────

const UFS_ESAJ = Object.keys(ESAJ_BASES);

export const COLETORES: Coletor[] = [
  ...UFS_ESAJ.map(coletorEsaj),
  coletorDjen,
  coletorDatajud,
  coletorPncp,
  coletorDou,
  coletorRdap,
  coletorCrtsh,
  coletorWayback,
  coletorHibp,
];

export function coletorPorId(id: string): Coletor | undefined {
  return COLETORES.find((c) => c.id === id);
}

/** Visão para a UI/rotas: o que existe, em que módulo e com que orçamento. */
export function catalogo(): Array<{
  id: string;
  modulo: string;
  host: string;
  familia: string;
  descricao: string;
  parametros: string[];
  canarios: number;
  orcamento: { rpm: number; rpd: number };
  credencial: string | null;
}> {
  return COLETORES.map((c) => ({
    id: c.id,
    modulo: c.modulo,
    host: c.host,
    familia: c.familia,
    descricao: c.descricao,
    parametros: Object.keys(c.espaco),
    canarios: c.canarios.length,
    orcamento: c.orcamento,
    credencial: c.exigirCredencial ?? null,
  }));
}

export { texto };
