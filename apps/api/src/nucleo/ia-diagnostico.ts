/**
 * IA de buscador que lê os erros e propõe a correção (plano.md §3.4).
 *
 * Camadas de IA (todas REAIS, nenhuma simulada):
 *  1. `AI_PROVIDER` + `AI_API_KEY` (tavily/perplexity/gemini) → `responderComBuscador`,
 *     que já é o modo IA do chat: busca + resposta com fontes.
 *  2. **Sem chave** → camada gratuita `pollinations` (endpoint compatível com a API
 *     da OpenAI, sem cadastro): o mesmo prompt é enviado e a resposta é interpretada.
 *     É o que faz o núcleo interpretar erros em produção hoje, sem chave paga.
 *  3. Em qualquer camada, a IA recebe evidência de BUSCA REAL (DuckDuckGo/Wikipédia
 *     via `buscarWebDetalhado`): título+URL+trecho do que existe publicado sobre o
 *     host/erro. Ela interpreta o que foi recuperado, não a própria memória.
 *  4. Se a IA não responder, não devolver JSON válido, ou propuser parâmetro fora do
 *     `espaco` do coletor → vale o diagnóstico determinístico e o registro diz
 *     `origem: "regras"` com o motivo. Nada de fingir IA.
 *
 * Regra de ouro: a IA **não** escolhe o que fazer no vácuo. Ela recebe um pacote de
 * evidências reais daquela fonte (http, latência medida, itens, erro técnico, histórico,
 * último desfecho de cada ação anterior) e devolve um JSON que só pode mexer em
 * parâmetros declarados no `espaco` do coletor, dentro dos limites declarados.
 * Tudo o que não passa na validação é **descartado com motivo registrado** — nada de
 * sintetizar correção que o código não sabe aplicar.
 *
 * A busca é real: usa `responderComBuscador` (tavily/perplexity/gemini com
 * `AI_PROVIDER`+`AI_API_KEY`, ou DDG público). Sem provedor de resposta, a busca
 * pública devolve só trechos e links: nesse caso o JSON não existe e o núcleo cai
 * no diagnóstico determinístico (`origem: "regras"`), que também é real — calculado
 * sobre o histórico medido, nunca inventado.
 */
import { responderComBuscador, provedorConfigurado, type RespostaBuscador } from "../juridico/buscaIA.js";
import type { MetricaColeta } from "./store.js";
import type { Coletor, ParamSpec, Params, ResultadoColeta } from "./tipos.js";

export interface EntradaDiagnostico {
  coletor: Coletor;
  params: Params;
  resultado: ResultadoColeta;
  historico: MetricaColeta[];
  versao: number;
  /** ação anterior e o que ela produziu, para a IA não repetir o que já falhou */
  ultimaAcao?: { acao: string; resultado: string; motivo: string } | null;
}

export interface Ajuste {
  chave: string;
  de: number;
  para: number;
  porque: string;
}

export interface Diagnostico {
  origem: "ia" | "regras";
  provedor: string;
  causa: string;
  acao: "ajustar" | "reverter" | "desativar" | "manter";
  ajustes: Ajuste[];
  confianca: number;
  evidencias: string[];
  fontes: { titulo: string; url: string }[];
  consulta: string;
  respostaBruta: string;
  descartado: string | null;
}

const MAX_AJUSTES = 3;

export function p95(valores: number[]): number {
  if (valores.length === 0) return 0;
  const ord = [...valores].sort((a, b) => a - b);
  return ord[Math.min(ord.length - 1, Math.ceil(0.95 * ord.length) - 1)] ?? 0;
}

function descreverSpec(spec: ParamSpec): string {
  if (spec.tipo === "enum") return `enum [${(spec.opcoes ?? []).join(", ")}]`;
  const min = spec.min ?? 0;
  const max = spec.max ?? 0;
  return `numero inteiro entre ${min} e ${max} (passo ${spec.passo ?? 1})`;
}

/** Valida a proposta contra o espaço declarado: nada fora do contrato entra. */
export function validarAjustes(
  brutos: unknown,
  espaco: Record<string, ParamSpec>,
  params: Params,
): { aceitos: Ajuste[]; descartados: string[] } {
  const aceitos: Ajuste[] = [];
  const descartados: string[] = [];
  if (!Array.isArray(brutos)) return { aceitos, descartados: ["ajustes não é uma lista"] };
  for (const raw of brutos.slice(0, MAX_AJUSTES + 2)) {
    const a = raw as { chave?: unknown; para?: unknown; porque?: unknown };
    const chave = typeof a.chave === "string" ? a.chave : "";
    const spec = espaco[chave];
    if (!spec) {
      descartados.push(`parâmetro "${chave || "?"}" não existe no coletor`);
      continue;
    }
    const para = Number(a.para);
    if (!Number.isFinite(para)) {
      descartados.push(`${chave}: valor não numérico`);
      continue;
    }
    if (spec.tipo === "enum") {
      const opcoes = spec.opcoes ?? [];
      if (!opcoes.includes(para)) {
        descartados.push(`${chave}: ${para} não está em [${opcoes.join(", ")}]`);
        continue;
      }
    } else {
      const min = spec.min ?? 0;
      const max = spec.max ?? 0;
      if (para < min || para > max) {
        descartados.push(`${chave}: ${para} fora de [${min}, ${max}]`);
        continue;
      }
    }
    const de = Number(params[chave] ?? (spec.opcoes ?? [])[0] ?? 0);
    if (para === de) {
      descartados.push(`${chave}: valor igual ao vigente (${de})`);
      continue;
    }
    if (aceitos.length >= MAX_AJUSTES) {
      descartados.push(`${chave}: limite de ${MAX_AJUSTES} ajustes por ciclo`);
      continue;
    }
    aceitos.push({ chave, de: Number.isFinite(de) ? de : 0, para, porque: String(a.porque ?? "").slice(0, 240) });
  }
  return { aceitos, descartados };
}

/** Extrai o primeiro objeto JSON de uma resposta em texto (a IA costuma enfeitar). */
export function extrairJson(texto: string): unknown | null {
  const cercado = texto.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidatos = [cercado?.[1], texto.slice(texto.indexOf("{"), texto.lastIndexOf("}") + 1)];
  for (const c of candidatos) {
    if (!c) continue;
    try {
      return JSON.parse(c) as unknown;
    } catch {
      /* segue */
    }
  }
  return null;
}

function resumoHistorico(h: MetricaColeta[]): string {
  const ult = h.slice(-12);
  if (ult.length === 0) return "sem histórico (primeira coleta)";
  return ult
    .map((m) => `${m.ts.slice(11, 16)} http=${m.http ?? "-"} itens=${m.itens} ms=${m.ms} score=${m.score.toFixed(1)}${m.erro ? ` erro="${m.erro.slice(0, 60)}"` : ""}`)
    .join(" | ");
}

export function montarConsulta(e: EntradaDiagnostico): string {
  const c = e.coletor;
  const params = Object.entries(e.params).map(([k, v]) => `${k}=${String(v)}`).join(", ") || "(nenhum)";
  return [
    `Fonte ${c.id} (${c.modulo}, família ${c.familia}, host ${c.host}): ${c.descricao}.`,
    `Coleta falhou agora: ${e.resultado.erro ?? (e.resultado.ok ? "sem erro técnico" : "sem itens")}.`,
    `Medido: http=${e.resultado.http ?? "sem resposta"} itens=${e.resultado.itens} ms=${e.resultado.ms} captcha=${e.resultado.captcha === true} bloqueio=${e.resultado.bloqueio === true} camposFaltando=${(e.resultado.camposFaltando ?? []).join(",") || "nenhum"}.`,
    `Parâmetros vigentes (v${e.versao}): ${params}.`,
    `Histórico: ${resumoHistorico(e.historico)}.`,
    e.ultimaAcao ? `Ação anterior: ${e.ultimaAcao.acao} → ${e.ultimaAcao.resultado} (${e.ultimaAcao.motivo}).` : "",
    "Qual a causa mais provável e qual prática pública o site documenta (limite de requisições, exigência de captcha, mudança de contrato) em 2026?",
  ]
    .filter(Boolean)
    .join(" ");
}

export function montarPrompt(e: EntradaDiagnostico): string {
  const espaco = Object.entries(e.coletor.espaco)
    .map(([k, s]) => `- ${k}: ${descreverSpec(s)}${s.descricao ? ` — ${s.descricao}` : ""}`)
    .join("\n") || "- (este coletor não aceita ajuste de parâmetro)";
  return [
    montarConsulta(e),
    "",
    "Responda SOMENTE com um JSON válido, sem texto em volta, no formato:",
    `{"causa":"<uma frase técnica em português, citando os números medidos e o que a evidência mostra>","confianca":0.0,"acao":"ajustar|reverter|desativar|manter","ajustes":[{"chave":"<uma das chaves abaixo>","para":<numero>,"porque":"..."}]}`,
    "A causa deve ser específica deste coletor e desta medição (ex.: \"HTTP 200 em 700 ms com 0 itens: a página pediu termo mais específico, não é queda de host\").",
    "Se as evidências web não sustentarem nada, escreva \"sem evidência pública\" na causa em vez de inventar explicação.",
    "Parâmetros que ESTE coletor aceita (nada fora desta lista é aplicável):",
    espaco,
    "Regras: no máximo 3 ajustes; se a causa é captcha, bloqueio geográfico ou mudança de contrato do site, use acao=manter ou desativar e NÃO proponha parâmetro (não existe parâmetro que resolva isso); se a falha é timeout, aumente timeoutMs; se é 429/rate limit, aumente tentativas e/ou timeoutMs; nunca invente fonte.",
  ].join("\n");
}

// ───────────────────────── Regras determinísticas (sempre disponíveis) ─────────────────────────

function numeroOu(spec: ParamSpec | undefined, atual: number, padrao: number): number {
  if (!spec) return atual;
  return Number.isFinite(atual) ? atual : padrao;
}

function subirChave(espaco: Record<string, ParamSpec>, params: Params, chave: string, fator: number): Ajuste[] {
  const spec = espaco[chave];
  if (!spec || spec.tipo !== "numero") return [];
  const atual = numeroOu(spec, Number(params[chave]), spec.min ?? 0);
  const passo = spec.passo ?? 1;
  const alvo = Math.min(spec.max ?? atual, atual + Math.max(passo, Math.round(atual * (fator - 1) / passo) * passo));
  if (alvo === atual) return [];
  return [{ chave, de: atual, para: alvo, porque: "escalonamento determinístico por falha medida" }];
}

/** Diagnóstico determinístico: só usa o que foi medido. Nunca inventa causa. */
export function diagnosticarPorRegras(e: EntradaDiagnostico): Diagnostico {
  const r = e.resultado;
  const espaco = e.coletor.espaco;
  const mets = e.historico.slice(-20);
  const lat = p95(mets.filter((m) => m.ok).map((m) => m.ms));
  const zerados = mets.slice(-5).filter((m) => m.itens === 0).length;
  const evidencias = [
    `http=${r.http ?? "sem resposta"} itens=${r.itens} ms=${Math.round(r.ms)}`,
    `histórico: ${mets.length} coletas, p95 ok=${Math.round(lat)}ms, últimas com 0 itens=${zerados}`,
  ];
  const base = {
    origem: "regras" as const,
    provedor: "deterministico",
    fontes: [] as { titulo: string; url: string }[],
    consulta: montarConsulta(e),
    respostaBruta: "",
    descartado: null as string | null,
    evidencias,
  };

  if (r.precisaRefinar === true) {
    // correção real e barata: variar o termo. Só propõe se o coletor expõe isso.
    const spec = espaco["varianteNome"];
    const atual = Number(e.params["varianteNome"] ?? 0);
    const opcoes = spec?.tipo === "enum" ? (spec.opcoes ?? []).map(Number) : [];
    const proxima = opcoes.find((o) => o !== atual);
    return {
      ...base,
      causa: "portal respondeu 200 pedindo termo mais específico (termo amplo demais para listar)",
      acao: proxima !== undefined ? "ajustar" : "manter",
      ajustes:
        proxima !== undefined
          ? [{ chave: "varianteNome", de: atual, para: proxima, porque: "refinar o termo reduz a lista e destrava o resultado" }]
          : [],
      confianca: 0.8,
      descartado: proxima === undefined ? "regra: coletor não expõe variação de termo" : null,
    };
  }
  if (r.semCredencial === true) {
    return {
      ...base,
      causa: `coletor sem credencial configurada (${r.erro ?? "chave ausente"}) — não é falha de rede nem de parâmetro`,
      acao: "manter",
      ajustes: [],
      confianca: 1,
      descartado: "regra: falta de chave é pendência de configuração — nenhum parâmetro resolve",
    };
  }
  if (r.captcha === true) {
    return {
      ...base,
      causa: "o portal passou a exigir captcha: nenhum parâmetro de requisição resolve isso",
      acao: zerados >= 3 ? "desativar" : "manter",
      ajustes: [],
      confianca: 0.95,
      descartado: "regra: captcha não é corrigível por parâmetro — evita correção fictícia",
    };
  }
  if (r.bloqueio === true || r.http === 429 || r.http === 403) {
    const ajustes = [
      ...subirChave(espaco, e.params, "retries", 2),
      ...subirChave(espaco, e.params, "attempts", 2),
      ...subirChave(espaco, e.params, "timeoutMs", 1.5),
    ].slice(0, MAX_AJUSTES);
    return {
      ...base,
      causa: `bloqueio do host (HTTP ${r.http ?? "sem resposta"}): reduzir pressão por requisição`,
      acao: ajustes.length > 0 ? "ajustar" : "manter",
      ajustes,
      confianca: 0.7,
      descartado: ajustes.length === 0 ? "regra: coletor não expõe parâmetro de retry/timeout" : null,
    };
  }
  if (r.http === null) {
    const ajustes = subirChave(espaco, e.params, "timeoutMs", 2);
    return {
      ...base,
      causa: "sem resposta do host (timeout/DNS/TLS) — ampliar janela antes de concluir que a fonte caiu",
      acao: ajustes.length > 0 ? "ajustar" : "manter",
      ajustes,
      confianca: 0.6,
      descartado: ajustes.length === 0 ? "regra: timeoutMs já no teto do espaço de busca" : null,
    };
  }
  if (!r.ok && r.itens === 0 && (r.http ?? 0) >= 200 && (r.http ?? 0) < 400) {
    return {
      ...base,
      causa: `HTTP ${r.http} sem itens e sem erro técnico: contrato da página/JSON mudou (${(r.camposFaltando ?? []).join(", ") || "campos esperados ausentes"})`,
      acao: zerados >= 3 ? "desativar" : "manter",
      ajustes: [],
      confianca: 0.75,
      descartado: "regra: mudança de contrato não se corrige girando parâmetro — sinalizado para inspeção",
    };
  }
  if (r.ok && lat > 6_000) {
    const ajustes: Ajuste[] = [];
    if (espaco["tamanhoPagina"]) {
      const spec = espaco["tamanhoPagina"];
      const atual = Number(e.params["tamanhoPagina"] ?? spec.min ?? 0);
      const passo = spec.passo ?? 10;
      const alvo = Math.max(spec.min ?? atual, atual - passo);
      if (alvo !== atual) ajustes.push({ chave: "tamanhoPagina", de: atual, para: alvo, porque: "p95 acima de 6s: página menor responde mais rápido" });
    }
    ajustes.push(...subirChave(espaco, e.params, "timeoutMs", 1.5));
    return {
      ...base,
      causa: `coleta funciona mas p95=${Math.round(lat)}ms — ajustar carga por requisição`,
      acao: ajustes.length > 0 ? "ajustar" : "manter",
      ajustes: ajustes.slice(0, MAX_AJUSTES),
      confianca: 0.65,
      descartado: null,
    };
  }
  if (r.ok) {
    return { ...base, causa: "coleta saudável: nada a corrigir", acao: "manter", ajustes: [], confianca: 0.9, descartado: null };
  }
  return {
    ...base,
    causa: `falha não classificada: ${r.erro ?? "sem erro informado"}`,
    acao: "manter",
    ajustes: [],
    confianca: 0.3,
    descartado: "regra: sem diagnóstico confiável, não altera nada",
  };
}

// ───────────────────────── Diagnóstico com IA de buscador ─────────────────────────

export interface OpcoesIA {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** desliga a IA (testes herméticos e ambientes sem rede) */
  usarIA?: boolean;
  /** modelo da camada gratuita (default `openai` no endpoint compatível) */
  modelo?: string;
  /** quantas evidências web injetar no prompt */
  maxEvidencias?: number;
  /** usa a IA mesmo quando a coleta está saudável (teste/inspeção) */
  forcarIA?: boolean;
  /** intervalo mínimo entre chamadas ao provedor gratuito (default 30 s) */
  espacoMs?: number;
}

export interface EvidenciaWeb {
  titulo: string;
  url: string;
  trecho: string;
}

/** Endpoint sem chave, compatível com a API da OpenAI (medido: 200 em ~2,5 s). */
export const POLLINATIONS_URL = "https://text.pollinations.ai/openai";
export const MODELO_GRATUITO = "openai";
/**
 * Alternativa quando o modelo principal devolve erro (mesmo endpoint, sem chave).
 * Medido em `GET https://text.pollinations.ai/models` (25/10): o catálogo anônimo
 * expõe `openai-fast` com os aliases `openai`/`gpt-oss`; `qwen-coder` e `mistral`
 * responderam 402/404 e foram removidos — apontar para modelo morto só gastava cota.
 */
export const MODELO_ALTERNATIVO = "openai-fast";
/**
 * O endpoint gratuito responde 402 FREE_LIMIT: **1 resposta a cada 30 s por IP**
 * (medido 25/10). O núcleo respeita o limite em vez de brigar com ele: espaça as
 * chamadas, avisa no registro quando foi limitado e nunca martela.
 */
export const ESPACO_MIN_IA_MS = 30_000;
let ultimaChamadaIA = 0;
/** Quando o provedor gratuito devolve FREE_LIMIT ficamos em cooldown real. */
let cooldownAte = 0;

export function emCooldownIA(agora = Date.now()): number {
  return Math.max(0, cooldownAte - agora);
}

/**
 * Fila da IA: o provedor gratuito aceita 1 resposta a cada 30 s **por IP**.
 * Duas chamadas paralelas viram dois 402 e nenhuma resposta. Aqui as chamadas
 * são serializadas: a segunda espera a primeira terminar + o intervalo.
 */
let filaIA: Promise<unknown> = Promise.resolve();
function serializar<T>(tarefa: () => Promise<T>): Promise<T> {
  const proxima = filaIA.then(tarefa, tarefa);
  filaIA = proxima.catch(() => undefined);
  return proxima;
}

/** A IA só é acionada quando há falha/degradação — coleta saudável não gasta cota. */
export function precisaDiagnosticoIA(r: ResultadoColeta): boolean {
  return !r.ok || r.captcha === true || r.bloqueio === true || r.precisaRefinar === true || r.semCredencial === true || r.camposFaltando !== undefined;
}

/**
 * Busca REAL de evidência sobre o erro/host (DuckDuckGo/Wikipédia).
 * Serve para a IA interpretar o que está publicado, não a própria memória —
 * e o que ela citar fica gravado com URL no histórico do coletor.
 */
export async function buscarEvidencias(
  e: EntradaDiagnostico,
  opts: OpcoesIA = {},
): Promise<EvidenciaWeb[]> {
  const max = opts.maxEvidencias ?? 4;
  const { buscarWebDetalhado } = await import("../juridico/buscaWeb.js");
  const consulta = `${e.coletor.host} ${e.resultado.captcha ? "captcha" : e.resultado.http ? `HTTP ${e.resultado.http}` : "timeout indisponível"} ${e.coletor.descricao} limite de requisições consulta pública`;
  try {
    const r = await buscarWebDetalhado(consulta, {
      tentativas: 1,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    return r.fontes
      .slice(0, max)
      .map((f) => ({ titulo: f.titulo, url: f.url, trecho: (f.trecho ?? "").slice(0, 300) }))
      .filter((f) => f.url);
  } catch {
    return []; // sem evidência não é erro fatal: a IA decide com o que foi medido
  }
}

interface RespostaProvedor {
  provedor: string;
  texto: string;
  fontes: EvidenciaWeb[];
}

/**
 * Camada gratuita sem chave: prompt → texto (JSON pedido explicitamente).
 * Medido: o endpoint alterna respostas de ~0,3 s (cache) e falhas transitórias —
 * por isso 2 tentativas no modelo principal e 1 no alternativo, com o motivo
 * REAL da falha devolvido (nada de "indisponível" sem causa).
 */
async function pollinations(prompt: string, opts: OpcoesIA): Promise<RespostaProvedor | null> {
  const principal = opts.modelo ?? opts.env?.["NUCLEO_IA_MODELO"] ?? MODELO_GRATUITO;
  // `NUCLEO_IA_MODELOS` (lista separada por vírgula) permite trocar de provedor
  // sem deploy de código quando o catálogo gratuito mudar de novo.
  const doEnv = (opts.env?.["NUCLEO_IA_MODELOS"] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const modelos = [...new Set(doEnv.length > 0 ? doEnv : [principal, MODELO_ALTERNATIVO])];
  // em paralelo: o endpoint gratuito alterna 0,3 s e 20 s+; correr os dois modelos
  // corta a espera para o mais rápido e sobrevive a um deles estar limitado.
  const resultado = await serializar(async () => {
    // dentro da fila: o primeiro modelo livre responde; o alternativo é o plano B
    const falhas: string[] = [];
    for (const m of modelos) {
      const r = await chamarPollinations(prompt, m, opts);
      if ("texto" in r) return { ok: { provedor: `pollinations:${m}`, texto: r.texto, fontes: [] }, falhas };
      falhas.push(`${m}: ${r.erro}`);
      if (r.erro.includes("cooldown")) break; // não insiste durante o bloqueio
    }
    return { ok: null, falhas };
  });
  if (resultado.ok) return resultado.ok;
  const falhas = resultado.falhas;
  ultimoErroIA = falhas.join(" · ");
  return null;
}

/** Última falha da camada de IA — vai para o registro da ação, não para o lixo. */
export let ultimoErroIA = "";

/**
 * Cache de diagnóstico por (coletor + assinatura do resultado + params).
 * A camada gratuita tem limite de uso: repetir a MESMA pergunta em ciclos
 * seguidos só gasta cota e não traz informação nova.
 */
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { em: number; diagnostico: Diagnostico }>();

function chaveCache(e: EntradaDiagnostico, modo: string): string {
  return JSON.stringify([
    modo,
    e.coletor.id,
    e.versao,
    e.params,
    e.resultado.http,
    e.resultado.itens,
    e.resultado.ok,
    Boolean(e.resultado.captcha),
    Boolean(e.resultado.bloqueio),
    Boolean(e.resultado.precisaRefinar),
    (e.resultado.erro ?? "").slice(0, 60),
  ]);
}

export function limparCacheIA(): void {
  cache.clear();
  ultimaChamadaIA = 0;
  cooldownAte = 0;
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function chamarPollinations(
  prompt: string,
  modelo: string,
  opts: OpcoesIA,
): Promise<{ texto: string } | { erro: string }> {
  const f = opts.fetchImpl ?? fetch;
  // em cooldown (FREE_LIMIT recente): não espera, devolve na hora — quem decide
  // é o diagnóstico determinístico, sem travar o ciclo por 30 s por coletor.
  if (Date.now() < cooldownAte) {
    return { erro: `limite gratuito em cooldown (${Math.ceil((cooldownAte - Date.now()) / 1000)} s)` };
  }
  // espera o intervalo mínimo desde a última chamada (limite de 1/30 s do serviço)
  const espaco = opts.espacoMs ?? Number(opts.env?.["NUCLEO_IA_ESPACO_MS"] ?? ESPACO_MIN_IA_MS);
  const espera = espaco - (Date.now() - ultimaChamadaIA);
  if (espaco > 0 && ultimaChamadaIA > 0 && espera > 0 && espera <= espaco) {
    await new Promise<void>((r) => setTimeout(r, espera));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(opts.env?.["NUCLEO_IA_TIMEOUT_MS"] ?? 30_000));
  try {
    const res = await f(POLLINATIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: modelo,
        // temperatura baixa: diagnóstico técnico, não criatividade
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "Você é engenheiro de dados que diagnostica falhas de coleta web e responde SOMENTE JSON válido. Nunca invente fonte, parâmetro ou número que não esteja no enunciado.",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal: ctrl.signal,
    });
    if (res.status === 402) {
      cooldownAte = Date.now() + ESPACO_MIN_IA_MS;
      return { erro: "limite gratuito (1 resposta/30 s)" };
    }
    if (!res.ok) return { erro: `HTTP ${res.status}` };
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const texto = j.choices?.[0]?.message?.content ?? "";
    if (!texto.trim()) return { erro: "resposta vazia" };
    return { texto };
  } catch (e) {
    return { erro: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message.slice(0, 80) };
  } finally {
    clearTimeout(timer);
    // o limite do provedor é por RESPOSTA: a janela de 30 s conta do fim da
    // chamada. Contando do início, uma resposta de 11 s fazia a seguinte cair
    // 19 s depois e tomar 402 — era a causa real dos FREE_LIMIT persistentes.
    ultimaChamadaIA = Date.now();
  }
}

/** Prompt completo: medição real + evidência web recuperada + contrato do coletor. */
export function montarPromptComEvidencia(e: EntradaDiagnostico, evidencias: EvidenciaWeb[], base = montarPrompt(e)): string {
  if (evidencias.length === 0) return base;
  const lista = evidencias
    .map((f, i) => `[${i + 1}] ${f.titulo} — ${f.url}${f.trecho ? ` :: "${f.trecho}"` : ""}`)
    .join("\n");
  return [
    base,
    "",
    "Evidências REAIS recuperadas agora na web (use só elas para justificar a causa; se não ajudarem, diga isso):",
    lista,
    "Inclua no JSON o campo \"evidencia_usada\" com o número [n] da evidência que sustenta a causa, ou null.",
  ].join("\n");
}

export async function diagnosticar(
  e: EntradaDiagnostico,
  opts: OpcoesIA = {},
): Promise<Diagnostico> {
  const regras = diagnosticarPorRegras(e);
  if (opts.usarIA === false) {
    return { ...regras, descartado: regras.descartado ?? "IA desligada por configuração (usarIA=false)" };
  }

  // cota do provedor é escassa: só gasta com quem falhou (a menos que se force)
  if (!opts.forcarIA && !precisaDiagnosticoIA(e.resultado)) {
    return {
      ...regras,
      provedor: "deterministico",
      descartado: "coleta saudável: IA não acionada (economiza a cota do provedor; ajuste fino é medido no canário)",
    };
  }

  const { provedor: provCache, key: keyCache } = provedorConfigurado(opts.env);
  const modo = provCache !== "publico" && keyCache ? `chave:${provCache}` : "gratis";
  const chave = chaveCache(e, modo);
  const emCache = cache.get(chave);
  if (emCache && Date.now() - emCache.em < CACHE_TTL_MS) {
    return { ...emCache.diagnostico, evidencias: [...emCache.diagnostico.evidencias, "diagnóstico reaproveitado do cache (10 min)"] };
  }

  const provedor = provCache;
  const key = keyCache;
  const comChave = provedor !== "publico" && Boolean(key);

  // 1) evidência de busca real (serve às duas camadas)
  const evidencias = await buscarEvidencias(e, opts);
  const prompt = montarPromptComEvidencia(e, evidencias);

  // 2) camada de resposta: chave configurada OU camada gratuita sem chave
  let resposta: RespostaProvedor | null = null;
  if (comChave) {
    const analise: RespostaBuscador | null = await responderComBuscador(prompt, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    }).catch(() => null);
    if (analise?.geradaPorIA) {
      resposta = {
        provedor: analise.provedor,
        texto: analise.resposta,
        fontes: analise.fontes.slice(0, 5).map((f) => ({ titulo: f.titulo, url: f.url, trecho: (f.trecho ?? "").slice(0, 300) })),
      };
    }
  } else {
    resposta = await pollinations(prompt, opts);
  }

  const fontes = [...(resposta?.fontes ?? []), ...evidencias]
    .filter((f, i, arr) => f.url && arr.findIndex((x) => x.url === f.url) === i)
    .slice(0, 5)
    .map((f) => ({ titulo: f.titulo, url: f.url }));

  if (!resposta) {
    return {
      ...regras,
      provedor: comChave ? `${provedor} (sem resposta)` : "deterministico",
      ...(fontes.length > 0 ? { fontes } : {}),
      descartado:
        (regras.descartado ? `${regras.descartado} · ` : "") +
        (comChave
          ? `IA ${provedor} não respondeu (${ultimoErroIA || "sem detalhe"}): aplicado o diagnóstico determinístico`
          : `IA de buscador não respondeu (${ultimoErroIA || "camada gratuita"}): diagnóstico determinístico sobre o histórico medido`),
    };
  }

  const bruto = resposta.texto;
  const json = extrairJson(bruto) as
    | { causa?: unknown; confianca?: unknown; acao?: unknown; ajustes?: unknown; evidencia_usada?: unknown }
    | null;
  if (!json) {
    return {
      ...regras,
      origem: "ia",
      provedor: resposta.provedor,
      fontes,
      respostaBruta: bruto.slice(0, 1200),
      descartado: "resposta da IA não continha JSON válido: aplicado o diagnóstico determinístico",
    };
  }

  const { aceitos, descartados } = validarAjustes(json.ajustes, e.coletor.espaco, e.params);
  const acaoPedida = String(json.acao ?? "");
  const acao: Diagnostico["acao"] =
    acaoPedida === "reverter" || acaoPedida === "desativar" || acaoPedida === "ajustar" || acaoPedida === "manter"
      ? acaoPedida
      : aceitos.length > 0
        ? "ajustar"
        : "manter";
  const causa = String(json.causa ?? "").slice(0, 400);
  const confianca = Math.max(0, Math.min(1, Number(json.confianca ?? 0.5)));
  const citada = Number(json.evidencia_usada);
  const evidenciaCitada =
    Number.isFinite(citada) && citada >= 1 && citada <= evidencias.length ? evidencias[citada - 1] : undefined;

  const descartado =
    descartados.length > 0
      ? `IA propôs ${descartados.length} ajuste(s) inválido(s): ${descartados.join("; ")}`
      : null;

  const guardar = (d: Diagnostico): Diagnostico => {
    cache.set(chave, { em: Date.now(), diagnostico: d });
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    return d;
  };

  const tracoIa = [
    `IA (${resposta.provedor}): ${causa.slice(0, 200)}`,
    `evidências web recuperadas: ${evidencias.length}`,
    ...(evidenciaCitada ? [`evidência citada [${citada}]: ${evidenciaCitada.url}`] : []),
  ];

  // A IA nunca "resolve" falha estrutural com parâmetro: se ela mesma aponta
  // captcha/contrato, o núcleo ignora ajuste e mantém a fonte como está.
  const estrutural = /captcha|geo|bloqueio permanente|contrato|layout|descontinuad/i.test(causa);
  if (estrutural && acao === "ajustar") {
    return guardar({
      origem: "ia",
      provedor: resposta.provedor,
      causa: causa || regras.causa,
      acao: "manter",
      ajustes: [],
      confianca,
      evidencias: [...regras.evidencias, ...tracoIa],
      fontes,
      consulta: montarConsulta(e),
      respostaBruta: bruto.slice(0, 1200),
      descartado: "IA apontou causa estrutural (captcha/contrato): ajuste de parâmetro descartado",
    });
  }

  return guardar({
    origem: "ia",
    provedor: resposta.provedor,
    causa: causa || regras.causa,
    acao: aceitos.length > 0 ? "ajustar" : acao === "ajustar" ? "manter" : acao,
    ajustes: aceitos,
    confianca,
    evidencias: [...regras.evidencias, ...tracoIa],
    fontes,
    consulta: montarConsulta(e),
    respostaBruta: bruto.slice(0, 1200),
    descartado,
  });
}
