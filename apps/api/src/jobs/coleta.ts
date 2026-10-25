/**
 * Coleta contínua do app inteiro (plano.md §3.7 / lacuna G5).
 *
 * Antes: Licitações, Concursos, DOU e OSINT só rodavam quando alguém abria a tela.
 * Agora o núcleo varre todos os coletores registrados, mede, corrige e grava
 * `SyncRun` — a tabela que existia no schema desde o começo e nunca teve escritor.
 *
 * Orçamento duro por ciclo: `prazoMs` (default 5 min) e `maxVizinhos` por coletor.
 * Estourou o prazo → o ciclo termina com o que já mediu; nada fica pela metade.
 */
import { COLETORES } from "../nucleo/registro.js";
import { cicloColetor, type OpcoesNucleo, type ResultadoCicloColetor } from "../nucleo/otimizador.js";
import type { Coletor, Modulo } from "../nucleo/tipos.js";

export interface SyncRunRegistro {
  source: string;
  region: string | null;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "error";
  error: string | null;
  items: number;
}

export interface OpcoesCicloNucleo extends OpcoesNucleo {
  coletores?: Coletor[];
  modulos?: Modulo[];
  prazoMs?: number;
  /** coletores medidos em paralelo (default 3) */
  concorrencia?: number;
  /**
   * Quantos coletores podem ter diagnóstico por IA por ciclo (default 3).
   * O provedor gratuito responde 1 vez a cada 30 s — cota explícita é o que
   * impede o ciclo de virar uma fila de 6 minutos.
   */
  maxDiagnosticosIA?: number;
  /**
   * Orçamento de tempo SÓ da fase de IA (default 150 s). A fase roda após a
   * medição e nunca segura a coleta: estourou, o resto fica para o próximo ciclo.
   */
  prazoIaMs?: number;
  gravarSyncRun?: (r: SyncRunRegistro) => Promise<void>;
}

export interface ResumoNucleo {
  ok: boolean;
  medidoEm: string;
  ms: number;
  resultados: ResultadoCicloColetor[];
  promovidos: string[];
  revertidos: string[];
  desativados: string[];
  pausados: string[];
  porModulo: Record<string, { coletores: number; medidos: number; itens: number; erros: number }>;
  truncadoPorPrazo: boolean;
  /** coletores que receberam diagnóstico da IA nesta execução */
  comDiagnosticoIA: string[];
}

export async function rodarCicloNucleo(opts: OpcoesCicloNucleo): Promise<ResumoNucleo> {
  const t0 = Date.now();
  const agora = opts.agora ?? new Date();
  const prazoMs = opts.prazoMs ?? Number(process.env.NUCLEO_PRAZO_MS ?? 300_000);
  const lista = (opts.coletores ?? COLETORES).filter(
    (c) => !opts.modulos || opts.modulos.includes(c.modulo),
  );

  const resultados: ResultadoCicloColetor[] = [];
  const porModulo: ResumoNucleo["porModulo"] = {};
  let truncado = false;
  // concorrência limitada (default 3): um host lento não consome o ciclo do resto.
  const concorrencia = Math.max(1, Math.min(opts.concorrencia ?? 3, lista.length));
  const fila = [...lista];
  const orcamentoIA = {
    restante: opts.usarIA === false ? 0 : Math.max(0, opts.maxDiagnosticosIA ?? Number(process.env.NUCLEO_IA_MAX ?? 3)),
  };

  const medirUm = async (coletor: Coletor): Promise<void> => {
    const bucket = (porModulo[coletor.modulo] ??= { coletores: 0, medidos: 0, itens: 0, erros: 0 });
    bucket.coletores++;
    if (Date.now() - t0 > prazoMs) {
      truncado = true; // o resto fica para o próximo ciclo — nada de ciclo infinito
      return;
    }
    const inicio = new Date().toISOString();
    // a IA é aplicada na fase de IA (série, respeitando o ritmo do provedor):
    // gastar cota aqui em paralelo só geraria 402 e nenhum diagnóstico
    const r = await cicloColetor(coletor, { ...opts, usarIA: false, orcamentoIA }).catch((e: Error) => ({
      coletorId: coletor.id,
      modulo: coletor.modulo,
      acao: "erro" as const,
      origem: "nenhuma" as const,
      score: null,
      scoreAnterior: null,
      versao: 0,
      motivo: e.message,
      diagnostico: null,
      vizinhos: [],
      resultado: null,
      ms: 0,
    }));
    resultados.push(r);
    if (r.resultado) {
      bucket.medidos++;
      bucket.itens += r.resultado.itens;
      if (!r.resultado.ok) bucket.erros++;
    } else if (r.acao === "erro") {
      bucket.erros++;
    }
    await opts.gravarSyncRun?.({
      source: coletor.id.slice(0, 24),
      region: coletor.modulo,
      startedAt: inicio,
      finishedAt: new Date().toISOString(),
      status: r.acao === "erro" ? "error" : "ok",
      error: r.acao === "erro" ? r.motivo.slice(0, 300) : null,
      items: r.resultado?.itens ?? 0,
    }).catch(() => {});
  };

  await Promise.all(
    Array.from({ length: concorrencia }, async () => {
      for (let c = fila.shift(); c; c = fila.shift()) {
        if (Date.now() - t0 > prazoMs) {
          truncado = true;
          return;
        }
        await medirUm(c);
      }
    }),
  );

  // ── fase de IA: revisita SÓ as fontes que falharam e ainda não tiveram IA ──
  // Roda depois da medição, em série, respeitando a cota e o limite de ritmo do
  // provedor. Um host lento não atrasa a coleta, e a IA continua interpretando.
  const iaRestante = opts.usarIA === false ? 0 : Math.max(0, opts.maxDiagnosticosIA ?? Number(process.env.NUCLEO_IA_MAX ?? 3));
  // Um coletor em recuo é uma FALHA conhecida: a IA tem de interpretá-la agora,
  // não depois que o backoff expirar (senão o recuo esconde o erro por horas e o
  // ciclo termina sem nenhum diagnóstico, como já aconteceu em produção).
  const alvos = resultados
    .filter(
      (r) =>
        r.diagnostico?.origem !== "ia" &&
        (r.acao === "pausada" || (r.acao === "mantida" && r.resultado !== null && !r.resultado.ok)),
    )
    .sort((a, b) => Number(b.acao === "pausada") - Number(a.acao === "pausada"));
  const prazoIa = opts.prazoIaMs ?? Number(process.env.NUCLEO_IA_PRAZO_MS ?? 150_000);
  const tIa = Date.now();
  const comIA: string[] = [];
  for (const alvo of alvos.slice(0, iaRestante)) {
    if (Date.now() - tIa > prazoIa) break;
    const coletor = lista.find((c) => c.id === alvo.coletorId);
    if (!coletor) continue;
    const r = await cicloColetor(coletor, {
      ...opts,
      forcarIA: true,
      usarIA: true,
      ignorarRecuo: true,
      maxVizinhos: 0,
      orcamentoIA,
    }).catch(() => null);
    if (!r) continue;
    if (r.diagnostico?.origem === "ia") {
      comIA.push(coletor.id);
      // substitui o resultado determinístico pelo enriquecido com IA
      const idx = resultados.findIndex((x) => x.coletorId === coletor.id);
      if (idx >= 0) resultados[idx] = r;
      await opts.gravarSyncRun?.({
        source: coletor.id.slice(0, 24),
        region: `${coletor.modulo}:ia`,
        startedAt: new Date(tIa).toISOString(),
        finishedAt: new Date().toISOString(),
        status: r.acao === "erro" ? "error" : "ok",
        error: null,
        items: r.resultado?.itens ?? 0,
      }).catch(() => {});
    }
  }

  return {
    ok: resultados.every((r) => r.acao !== "erro"),
    medidoEm: agora.toISOString(),
    comDiagnosticoIA: comIA,
    ms: Date.now() - t0,
    resultados,
    promovidos: resultados.filter((r) => r.acao === "promovida").map((r) => r.coletorId),
    revertidos: resultados.filter((r) => r.acao === "revertida").map((r) => r.coletorId),
    desativados: resultados.filter((r) => r.acao === "desativada").map((r) => r.coletorId),
    pausados: resultados.filter((r) => r.acao === "pausada").map((r) => r.coletorId),
    porModulo,
    truncadoPorPrazo: truncado,
  };
}

export interface AgendadorNucleoOpts extends OpcoesCicloNucleo {
  horas?: number;
  onResultado?: (r: ResumoNucleo) => void;
}

/**
 * Agenda a varredura contínua. `NUCLEO_HABILITADO=0` desliga (usado nos testes e
 * em deploy de diagnóstico). O primeiro ciclo começa em 30 s para não competir
 * com o boot, e o intervalo mínimo é 1 h.
 */
export function iniciarColetaContinua(opts: AgendadorNucleoOpts): { parar: () => void } {
  const horas = Math.max(opts.horas ?? Number(process.env.NUCLEO_HORAS ?? 6), 1);
  const intervalo = horas * 3_600_000;
  let rodando = false;
  let parado = false;

  const executar = async (): Promise<void> => {
    if (rodando || parado) return;
    rodando = true;
    try {
      const r = await rodarCicloNucleo(opts);
      opts.onResultado?.(r);
      if (!r.ok) {
        opts.registrarEvento?.({
          tipo: "nucleo.ciclo_com_erro",
          detalhe: `${r.resultados.filter((x) => x.acao === "erro").length} coletor(es) falharam`,
          gravidade: "alerta",
        });
      }
    } catch (e) {
      opts.registrarEvento?.({ tipo: "nucleo.ciclo_falhou", detalhe: (e as Error).message, gravidade: "alerta" });
    } finally {
      rodando = false;
    }
  };

  const inicial = setTimeout(() => void executar(), 30_000);
  const timer = setInterval(() => void executar(), intervalo);
  if (typeof timer.unref === "function") timer.unref();
  if (typeof inicial.unref === "function") inicial.unref();

  return {
    parar: () => {
      parado = true;
      clearTimeout(inicial);
      clearInterval(timer);
    },
  };
}
