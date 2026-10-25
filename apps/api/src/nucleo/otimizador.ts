/**
 * Motor do Núcleo: mede, diagnostica com IA de buscador, aplica e reverte
 * (plano.md §3.5 — hill-climbing com ε=3, canário e rollback).
 *
 * Ciclo de UM coletor:
 *   1. disjuntor decide se vale tentar (orçamento e recuo) — nenhum request à toa;
 *   2. mede o vigente e grava métrica (telemetria real de todos os módulos);
 *   3. mede se houve regressão de algo já aplicado → rollback imediato;
 *   4. pede diagnóstico (IA de buscador; sem provedor, regras determinísticas);
 *   5. se o diagnóstico propõe ajuste válido: CANÁRIO mede antes de aplicar —
 *      só entra se o ganho passar de ε; senão a proposta é rejeitada e registrada;
 *   6. se está saudável e não há proposta: testa vizinhos do espaço de busca
 *      (hill-climbing) com orçamento duro de requisições.
 *
 * Regra que o código impõe: nada é aplicado sem medição. Nenhuma correção
 * "porque a IA disse" entra sem antes ser medida contra o vigente.
 */
import { diagnosticar, diagnosticarPorRegras, type Diagnostico } from "./ia-diagnostico.js";
import { assinatura, avaliarIncidente, podeColetar } from "./incidentes.js";
import { EPS, ganhoReal, pontuarColeta } from "./pontuar.js";
import { estadoInicial, type EstadoColetor, type MetricaColeta, type RegistroAcao, type StoreNucleo } from "./store.js";
import type { Coletor, CtxColeta, Params, ResultadoColeta } from "./tipos.js";

export interface VizinhoMedido {
  params: Params;
  score: number;
  itens: number;
  ok: boolean;
  erro: string | null;
}

export interface ResultadoCicloColetor {
  coletorId: string;
  modulo: string;
  acao: "promovida" | "mantida" | "revertida" | "desativada" | "pausada" | "erro";
  origem: "ia" | "regras" | "nenhuma";
  score: number | null;
  scoreAnterior: number | null;
  versao: number;
  motivo: string;
  diagnostico: Diagnostico | null;
  vizinhos: VizinhoMedido[];
  resultado: ResultadoColeta | null;
  ms: number;
}

export interface OpcoesNucleo {
  store: StoreNucleo;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  agora?: Date;
  /** override do canário (default = canário nº1 do coletor) */
  consulta?: string;
  /** vizinhos medidos por ciclo quando está saudável (orçamento duro) */
  maxVizinhos?: number;
  /** desliga a chamada de IA (testes e ambientes sem rede) */
  usarIA?: boolean;
  /**
   * Pede o diagnóstico da IA mesmo quando a falha é "parcial": é o que a fase
   * de IA do ciclo usa para revisitar só as fontes que falharam.
   */
  forcarIA?: boolean;
  /**
   * Ignora o recuo do disjuntor neste ciclo. Usado pela fase de IA: o recuo
   * gravado agora vale para o PRÓXIMO ciclo, não pode bloquear a revisão do
   * mesmo ciclo (senão a IA nunca roda justamente após a falha).
   */
  ignorarRecuo?: boolean;
  /** modelo da camada gratuita de IA (default: `openai`) */
  modeloIA?: string;
  /**
   * Cota compartilhada de diagnósticos com IA no ciclo (o provedor gratuito
   * entrega 1 resposta/30 s). Esgotou → o resto segue no determinístico.
   */
  orcamentoIA?: { restante: number };
  /** pausa entre requests do MESMO coletor (orçamento rpm) */
  pausaMs?: number;
  dormir?: (ms: number) => Promise<void>;
  registrarEvento?: (e: { tipo: string; detalhe: string; gravidade: "info" | "alerta" }) => void;
  /** espelha a promoção em quem serve a consulta do usuário (ponte-juridico) */
  aoPromover?: (p: { coletorId: string; params: Params; versao: number; score: number; motivo: string }) => Promise<boolean | void>;
}

/** Vizinhos do espaço de busca: um passo em cada direção de cada parâmetro. */
export function gerarVizinhos(coletor: Coletor, params: Params, limite: number): Params[] {
  const saida: Params[] = [];
  for (const [chave, spec] of Object.entries(coletor.espaco)) {
    if (spec.tipo === "enum") {
      for (const op of spec.opcoes ?? []) {
        if (op !== params[chave]) saida.push({ ...params, [chave]: op });
      }
      continue;
    }
    const atual = Number(params[chave] ?? spec.min ?? 0);
    const passo = spec.passo ?? 1;
    const min = spec.min ?? atual;
    const max = spec.max ?? atual;
    for (const alvo of [atual + passo, atual - passo]) {
      if (alvo >= min && alvo <= max && alvo !== atual) saida.push({ ...params, [chave]: alvo });
    }
  }
  const vistos = new Set<string>();
  const unicos = saida.filter((v) => {
    const k = JSON.stringify(v);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  return unicos.slice(0, Math.max(0, limite));
}

function evidenciaJson(d: Diagnostico, score: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    causa: d.causa,
    acao: d.acao,
    confianca: d.confianca,
    // proveniência: quem decidiu (ia/regras), qual camada e o que foi descartado
    origem: d.origem,
    provedor: d.provedor,
    descartado: d.descartado,
    score: Math.round(score * 100) / 100,
    fontes: d.fontes.slice(0, 3).map((f) => f.url).filter(Boolean),
    evidencias: d.evidencias.slice(0, 3),
    ...extra,
  }).slice(0, 1400);
}

export async function cicloColetor(coletor: Coletor, opts: OpcoesNucleo): Promise<ResultadoCicloColetor> {
  const t0 = Date.now();
  const agora = opts.agora ?? new Date();
  const dormir = opts.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pausaMs = opts.pausaMs ?? Math.min(2_000, Math.ceil(60_000 / Math.max(1, coletor.orcamento.rpm)));
  const maxVizinhos = opts.maxVizinhos ?? 2;

  const estado = (await opts.store.obter(coletor.id)) ?? estadoInicial(coletor.id, coletor.padrao, agora.toISOString());
  const liberado = opts.ignorarRecuo ? { pode: true, motivo: "recuo ignorado (fase de IA do mesmo ciclo)" } : podeColetar(estado, agora);
  if (!liberado.pode) {
    return {
      coletorId: coletor.id,
      modulo: coletor.modulo,
      acao: estado.ativo ? "pausada" : "desativada",
      origem: "nenhuma",
      score: estado.scoreAtual,
      scoreAnterior: estado.scoreAtual,
      versao: estado.versao,
      motivo: liberado.motivo,
      diagnostico: null,
      vizinhos: [],
      resultado: null,
      ms: Date.now() - t0,
    };
  }

  const canario = coletor.canarios[0];
  const consulta = opts.consulta ?? canario?.consulta;
  const ctx: CtxColeta = {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(consulta ? { consulta } : {}),
    agora,
    env: opts.env ?? process.env,
  };

  const medir = async (params: Params): Promise<{ r: ResultadoColeta; score: number }> => {
    let r: ResultadoColeta;
    try {
      r = await coletor.executar(params, ctx);
    } catch (e) {
      r = { ok: false, http: null, ms: Date.now() - t0, itens: 0, erro: (e as Error).message.slice(0, 200) };
    }
    return { r, score: pontuarColeta(r, canario) };
  };

  const gravarMetrica = async (r: ResultadoColeta, score: number): Promise<void> => {
    await opts.store
      .registrarMetrica({
        coletorId: coletor.id,
        ts: new Date().toISOString(),
        http: r.http,
        ms: r.ms,
        itens: r.itens,
        ok: r.ok,
        erro: r.erro ?? null,
        captcha: r.captcha === true,
        bloqueio: r.bloqueio === true,
        score,
      })
      .catch(() => {});
  };

  // 1) vigente
  const vigente = await medir(estado.params);
  await gravarMetrica(vigente.r, vigente.score);

  const historico: MetricaColeta[] = await opts.store.metricas(coletor.id, 20).catch(() => []);
  const acoes = await opts.store.acoes(coletor.id, 10).catch(() => []);
  // Só existe rollback PENDENTE se a última decisão aplicada ainda não foi
  // revertida. Antes, o histórico guardava a promoção para sempre e o ciclo
  // reencontrava a MESMA promoção antiga em toda execução: revertia de novo,
  // subia a versão e registrava "rollback aplicado" eternamente (medido em
  // produção: esaj-sp/sp-ce "revertida" em todos os ciclos).
  const ultimaDecisao = [...acoes]
    .reverse()
    .find((a) => a.resultado === "aplicada" || a.resultado === "revertida");
  const ultimaAplicada =
    ultimaDecisao && ultimaDecisao.resultado === "aplicada" && ultimaDecisao.paramsAntes
      ? ultimaDecisao
      : undefined;

  const atualizarEstado = async (patch: Partial<EstadoColetor>): Promise<EstadoColetor> => {
    const novo: EstadoColetor = {
      ...estado,
      itensUltimaColeta: vigente.r.itens,
      scoreAtual: vigente.score,
      ...patch,
      atualizadoEm: new Date().toISOString(),
    };
    await opts.store.salvar(novo).catch(() => {});
    return novo;
  };

  const registrar = async (a: Omit<RegistroAcao, "coletorId" | "ts">): Promise<void> => {
    await opts.store.registrarAcao({ coletorId: coletor.id, ts: new Date().toISOString(), ...a }).catch(() => {});
  };

  // 2) rollback de ajuste que degradou
  if (ultimaAplicada?.paramsAntes) {
    let scoreDaPromocao = Number.POSITIVE_INFINITY;
    try {
      scoreDaPromocao = Number((JSON.parse(ultimaAplicada.evidencia) as { score?: number }).score ?? Infinity);
    } catch {
      /* evidência antiga em texto: usa o pior caso */
    }
    const piorou = numeroFinito(scoreDaPromocao) ? vigente.score < scoreDaPromocao - EPS : !vigente.r.ok;
    if (piorou) {
      const novo = await atualizarEstado({
        params: ultimaAplicada.paramsAntes,
        versao: estado.versao + 1,
        ciclosZerados: 0,
      });
      await registrar({
        origem: "regras",
        tipo: "reverter",
        acao: `revertido para ${JSON.stringify(ultimaAplicada.paramsAntes)} (v${estado.versao} → v${novo.versao})`,
        evidencia: JSON.stringify({
          scoreAgora: vigente.score,
          scorePromocao: numeroFinito(scoreDaPromocao) ? scoreDaPromocao : null,
          motivo: vigente.r.erro ?? `itens=${vigente.r.itens}`,
        }),
        resultado: "revertida",
        motivo: `ajuste anterior degradou a coleta (${vigente.score.toFixed(1)} < ${numeroFinito(scoreDaPromocao) ? scoreDaPromocao.toFixed(1) : "promoção"} − ε)`,
        versaoAntes: estado.versao,
        versaoDepois: novo.versao,
        paramsAntes: estado.params,
        paramsDepois: novo.params,
      });
      opts.registrarEvento?.({
        tipo: "nucleo.rollback",
        detalhe: `${coletor.id} revertido para ${JSON.stringify(novo.params)} (score ${vigente.score.toFixed(1)})`,
        gravidade: "alerta",
      });
      return {
        coletorId: coletor.id,
        modulo: coletor.modulo,
        acao: "revertida",
        origem: "regras",
        score: vigente.score,
        scoreAnterior: estado.scoreAtual,
        versao: novo.versao,
        motivo: "ajuste anterior degradou a coleta — rollback aplicado",
        diagnostico: null,
        vizinhos: [],
        resultado: vigente.r,
        ms: Date.now() - t0,
      };
    }
  }

  // 3) diagnóstico (IA de buscador ou regras) — sempre com a evidência medida
  const podeIA = opts.usarIA !== false && (!opts.orcamentoIA || opts.orcamentoIA.restante > 0);
  // reserva a cota ANTES de chamar: com coletores em paralelo, decrementar depois
  // deixaria todos passarem no mesmo ciclo (corrida real, medida no teste)
  if (podeIA && opts.orcamentoIA) opts.orcamentoIA.restante -= 1;
  const diagnostico: Diagnostico = await diagnosticar(
    {
      coletor,
      params: estado.params,
      resultado: vigente.r,
      historico,
      versao: estado.versao,
      ultimaAcao: acoes.at(-1)
        ? { acao: acoes.at(-1)!.acao, resultado: acoes.at(-1)!.resultado, motivo: acoes.at(-1)!.motivo }
        : null,
    },
    {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(podeIA ? {} : { usarIA: false }),
      ...(opts.modeloIA ? { modelo: opts.modeloIA } : {}),
      ...(opts.forcarIA ? { forcarIA: true } : {}),
    },
  ).catch((e: Error) => diagnosticarPorRegrasSeguro(coletor, estado, vigente.r, historico, e.message));

  const diag: Diagnostico = diagnostico;

  // 4) disjuntor: decide recuo/desligamento com base no resultado real
  const incidente = avaliarIncidente(
    {
      ativo: estado.ativo,
      // a falha DESTE ciclo conta: sem isso o disjuntor fica sempre um ciclo atrás
      ciclosZerados: estado.ciclosZerados + (vigente.r.ok ? 0 : 1),
      proximaExecucaoEm: estado.proximaExecucaoEm,
    },
    vigente.r,
    agora,
  );

  // Desligar uma fonte é irreversível sem humano: a IA pode PROPOR, mas a
  // proposta precisa de corroboração. Medido em produção: a IA pediu
  // "desativar" o e-SAJ/SP porque o portal respondeu "muitos processos" (termo
  // amplo do NOSSO canário) e a fonte ficou OFF por uma única observação, com o
  // disjuntor dizendo o contrário. Regras agora:
  //   · assinatura "refinar" (termo do canário) NUNCA desativa;
  //   · desativa se o disjuntor determinístico já desistiu;
  //   · ou se a IA insiste E a falha se repete (≥2 ciclos seguidos).
  const falhasAgora = estado.ciclosZerados + (vigente.r.ok ? 0 : 1);
  const sigAtual = assinatura(vigente.r);
  const iaQuerDesativar = diag.acao === "desativar" && sigAtual !== "refinar";
  const desativarPorIA = iaQuerDesativar && !incidente.desativar && falhasAgora >= 2;
  const recusaDesativar =
    iaQuerDesativar && !incidente.desativar && !desativarPorIA
      ? `IA propôs desativar (${sigAtual}), mas é a 1ª falha desta natureza — desligar exige corroboração (2 ciclos seguidos)`
      : diag.acao === "desativar" && sigAtual === "refinar"
        ? "IA propôs desativar, mas o portal pediu termo mais específico: o defeito é do termo do canário, não da fonte"
        : null;

  if (incidente.desativar || desativarPorIA) {
    const novo = await atualizarEstado({
      ativo: false,
      ciclosZerados: estado.ciclosZerados + (vigente.r.ok ? 0 : 1),
      proximaExecucaoEm: null,
      ultimoErro: vigente.r.erro ?? diag.causa,
    });
    await registrar({
      origem: diag.origem,
      tipo: "desativar",
      acao: `coletor desativado: ${diag.causa}`,
      evidencia: evidenciaJson(diag, vigente.score, { incidente: incidente.motivo, params: estado.params }),
      resultado: "desativada",
      motivo: incidente.desativar ? incidente.motivo : diag.causa,
      versaoAntes: estado.versao,
      versaoDepois: novo.versao,
      paramsAntes: estado.params,
      paramsDepois: novo.params,
    });
    opts.registrarEvento?.({
      tipo: "nucleo.desativado",
      detalhe: `${coletor.id}: ${diag.causa}`,
      gravidade: "alerta",
    });
    return {
      coletorId: coletor.id,
      modulo: coletor.modulo,
      acao: "desativada",
      origem: diag.origem,
      score: vigente.score,
      scoreAnterior: estado.scoreAtual,
      versao: novo.versao,
      motivo: incidente.desativar ? incidente.motivo : diag.causa,
      diagnostico: diag,
      vizinhos: [],
      resultado: vigente.r,
      ms: Date.now() - t0,
    };
  }

  // 5) proposta de ajuste da IA/regras: canário mede antes de aplicar
  const candidatos: Array<{ params: Params; porque: string }> = [];
  if (diag.acao === "ajustar" && diag.ajustes.length > 0) {
    const novos: Params = { ...estado.params };
    for (const a of diag.ajustes) novos[a.chave] = a.para;
    candidatos.push({ params: novos, porque: diag.causa });
  }
  // 6) hill-climbing apenas quando a fonte está saudável (não martela portal caído)
  if (vigente.r.ok && candidatos.length === 0) {
    for (const v of gerarVizinhos(coletor, estado.params, maxVizinhos)) {
      candidatos.push({ params: v, porque: "vizinho do espaço de busca" });
    }
  }

  // 6b) não repetir o que já foi revertido. Sem isto, o ajuste revertido
  // voltava na proposta seguinte e oscilava para sempre (medido em produção:
  // osint-dominio promovido 8000→12000 ms e revertido no ciclo seguinte, em
  // loop). Memória do próprio histórico de ações, sem parâmetro novo.
  // atenção ao snapshot: numa ação `revertida`, `paramsAntes` é o ajuste que
  // degradou e `paramsDepois` é o que voltou a valer. O candidato a bloquear é
  // o que degradou (`paramsAntes`).
  const jaRevertidos = new Set(
    acoes.filter((a) => a.resultado === "revertida" && a.paramsAntes).map((a) => chaveParams(a.paramsAntes!)),
  );
  const bloqueados = candidatos.filter((c) => jaRevertidos.has(chaveParams(c.params)));
  if (bloqueados.length > 0) {
    const mantidos = candidatos.filter((c) => !jaRevertidos.has(chaveParams(c.params)));
    candidatos.splice(0, candidatos.length, ...mantidos);
  }
  const notaBloqueio =
    bloqueados.length > 0
      ? ` · ${bloqueados.length} candidato(s) ignorado(s) por já ter(em) sido revertido(s) antes`
      : "";

  const vizinhos: VizinhoMedido[] = [];
  let melhor: { params: Params; score: number; porque: string } | null = null;
  for (const [i, cand] of candidatos.entries()) {
    if (i > 0 && pausaMs > 0) await dormir(pausaMs);
    const m = await medir(cand.params);
    await gravarMetrica(m.r, m.score);
    vizinhos.push({ params: cand.params, score: m.score, itens: m.r.itens, ok: m.r.ok, erro: m.r.erro ?? null });
    if (m.r.ok && ganhoReal(vigente.score, m.score) && (!melhor || m.score > melhor.score)) {
      melhor = { params: cand.params, score: m.score, porque: cand.porque };
    }
  }

  if (melhor) {
    const novo = await atualizarEstado({ params: melhor.params, versao: estado.versao + 1, ciclosZerados: 0, ultimoErro: null });
    await registrar({
      origem: diag.origem,
      tipo: "ajuste-parametro",
      acao: `v${estado.versao}→v${novo.versao}: ${JSON.stringify(estado.params)} → ${JSON.stringify(melhor.params)}`,
      evidencia: evidenciaJson(diag, melhor.score, {
        scoreVigente: Math.round(vigente.score * 100) / 100,
        porque: melhor.porque,
        vizinhos: vizinhos.map((v) => ({ p: v.params, s: v.score, ok: v.ok })),
      }),
      resultado: "aplicada",
      motivo: `${diag.origem === "ia" ? "IA de buscador" : "regras"}: ${diag.causa}`,
      versaoAntes: estado.versao,
      versaoDepois: novo.versao,
      paramsAntes: estado.params,
      paramsDepois: melhor.params,
    });
    await opts.aoPromover?.({
      coletorId: coletor.id,
      params: melhor.params,
      versao: novo.versao,
      score: melhor.score,
      motivo: diag.causa,
    }).catch(() => undefined);
    opts.registrarEvento?.({
      tipo: "nucleo.promocao",
      detalhe: `${coletor.id} v${estado.versao}→v${novo.versao} (${vigente.score.toFixed(1)}→${melhor.score.toFixed(1)}, ε=${EPS})`,
      gravidade: "info",
    });
    return {
      coletorId: coletor.id,
      modulo: coletor.modulo,
      acao: "promovida",
      origem: diag.origem,
      score: melhor.score,
      scoreAnterior: vigente.score,
      versao: novo.versao,
      motivo: `${diag.causa} — ganho medido ${(melhor.score - vigente.score).toFixed(2)} pts`,
      diagnostico: diag,
      vizinhos,
      resultado: vigente.r,
      ms: Date.now() - t0,
    };
  }

  // 7) nada passou: registra a proposta rejeitada (com o motivo medido) e recua se falhou
  const novosZerados = vigente.r.ok ? 0 : estado.ciclosZerados + 1;
  const novo = await atualizarEstado({
    ciclosZerados: novosZerados,
    proximaExecucaoEm: incidente.pausarAte,
    ultimoOkEm: vigente.r.ok ? new Date().toISOString() : estado.ultimoOkEm,
    ultimoErro: vigente.r.ok ? null : (vigente.r.erro ?? diag.causa),
  });
  if (candidatos.length > 0) {
    await registrar({
      origem: diag.origem,
      tipo: "ajuste-parametro",
      acao: `mantido ${JSON.stringify(estado.params)} (candidatos rejeitados)`,
      evidencia: evidenciaJson(diag, vigente.score, {
        vizinhos: vizinhos.map((v) => ({ p: v.params, s: v.score, ok: v.ok, erro: v.erro })),
        exigencia: `ganho > ε=${EPS}`,
      }),
      resultado: "rejeitada",
      motivo: vizinhos.every((v) => !v.ok)
        ? "nenhum candidato respondeu — nada aplicado"
        : `ganho insuficiente para ε=${EPS} (melhor candidato não superou o vigente)`,
      versaoAntes: estado.versao,
      versaoDepois: novo.versao,
      paramsAntes: estado.params,
      paramsDepois: estado.params,
    });
  } else if (recusaDesativar || diag.acao !== "manter" || diag.origem === "ia") {
    await registrar({
      origem: diag.origem,
      tipo: "diagnostico",
      acao: `mantido ${JSON.stringify(estado.params)}`,
      evidencia: evidenciaJson(diag, vigente.score, { incidente: incidente.motivo }),
      resultado: "mantida",
      motivo: `${recusaDesativar ?? diag.descartado ?? diag.causa}${notaBloqueio}`,
      versaoAntes: estado.versao,
      versaoDepois: novo.versao,
      paramsAntes: estado.params,
      paramsDepois: estado.params,
    });
  }

  return {
    coletorId: coletor.id,
    modulo: coletor.modulo,
    acao: "mantida",
    origem: diag.origem,
    score: vigente.score,
    scoreAnterior: estado.scoreAtual,
    versao: novo.versao,
    motivo: `${recusaDesativar ?? diag.causa}${notaBloqueio}`,
    diagnostico: diag,
    vizinhos,
    resultado: vigente.r,
    ms: Date.now() - t0,
  };
}

/** chave canônica de params (ordem de chaves não importa, nem no JSON do banco). */
function chaveParams(p: Params): string {
  return JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]));
}

function numeroFinito(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** Atalho para o fallback determinístico quando a IA falha ou está desligada. */
function diagnosticarPorRegrasSeguro(
  coletor: Coletor,
  estado: EstadoColetor,
  resultado: ResultadoColeta,
  historico: MetricaColeta[],
  erroIA?: string,
): Diagnostico {
  const d = diagnosticarPorRegras({
    coletor,
    params: estado.params,
    resultado,
    historico,
    versao: estado.versao,
  });
  return erroIA ? { ...d, descartado: `IA falhou (${erroIA.slice(0, 120)}): ${d.descartado ?? "diagnóstico determinístico"}` } : d;
}
