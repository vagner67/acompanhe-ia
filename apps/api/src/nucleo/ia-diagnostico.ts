/**
 * IA de buscador que lê os erros e propõe a correção (plano.md §3.4).
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
    `{"causa":"...","confianca":0.0,"acao":"ajustar|reverter|desativar|manter","ajustes":[{"chave":"<uma das chaves abaixo>","para":<numero>,"porque":"..."}]}`,
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
}

export async function diagnosticar(
  e: EntradaDiagnostico,
  opts: OpcoesIA = {},
): Promise<Diagnostico> {
  const regras = diagnosticarPorRegras(e);
  const { provedor, key } = provedorConfigurado(opts.env);
  const podeResponder = provedor !== "publico" && Boolean(key);
  const analise: RespostaBuscador | null = podeResponder
    ? await responderComBuscador(montarPrompt(e), {
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      }).catch(() => null)
    : null;

  const fontes = (analise?.fontes ?? []).slice(0, 5).map((f) => ({ titulo: f.titulo, url: f.url }));

  if (!podeResponder) {
    return {
      ...regras,
      provedor: "deterministico",
      descartado:
        "IA de buscador não configurada (AI_PROVIDER/AI_API_KEY): diagnóstico determinístico sobre o histórico medido",
    };
  }

  if (!analise || !analise.geradaPorIA) {
    return {
      ...regras,
      provedor: analise ? `${analise.provedor} (sem resposta gerada)` : provedor,
      fontes: fontes.length > 0 ? fontes : regras.fontes,
      descartado:
        regras.descartado ??
        (analise
          ? `buscador ${analise.provedor} devolveu ${analise.fontes.length} fontes sem resposta sintetizada: nada a interpretar, mantido o diagnóstico determinístico`
          : "IA de buscador não configurada (AI_PROVIDER/AI_API_KEY): diagnóstico determinístico sobre o histórico medido"),
    };
  }

  const bruto = analise.resposta;
  const json = extrairJson(bruto) as
    | { causa?: unknown; confianca?: unknown; acao?: unknown; ajustes?: unknown }
    | null;
  if (!json) {
    return {
      ...regras,
      origem: "ia",
      provedor: analise.provedor,
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

  const descartado =
    descartados.length > 0
      ? `IA propôs ${descartados.length} ajuste(s) inválido(s): ${descartados.join("; ")}`
      : null;

  // A IA nunca "resolve" falha estrutural com parâmetro: se ela mesma aponta
  // captcha/contrato, o núcleo ignora ajuste e mantém a fonte como está.
  const estrutural = /captcha|geo|bloqueio permanente|contrato|layout|descontinuad/i.test(causa);
  if (estrutural && acao === "ajustar") {
    return {
      origem: "ia",
      provedor: analise.provedor,
      causa: causa || regras.causa,
      acao: "manter",
      ajustes: [],
      confianca,
      evidencias: [...regras.evidencias, `IA: ${causa.slice(0, 200)}`],
      fontes,
      consulta: montarConsulta(e),
      respostaBruta: bruto.slice(0, 1200),
      descartado: "IA apontou causa estrutural (captcha/contrato): ajuste de parâmetro descartado",
    };
  }

  return {
    origem: "ia",
    provedor: analise.provedor,
    causa: causa || regras.causa,
    acao: aceitos.length > 0 ? "ajustar" : acao === "ajustar" ? "manter" : acao,
    ajustes: aceitos,
    confianca,
    evidencias: [...regras.evidencias, `IA (${analise.provedor}): ${causa.slice(0, 200)}`, `fontes consultadas: ${fontes.length}`],
    fontes,
    consulta: montarConsulta(e),
    respostaBruta: bruto.slice(0, 1200),
    descartado,
  };
}
