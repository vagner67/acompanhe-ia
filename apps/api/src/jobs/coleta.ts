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

  const medirUm = async (coletor: Coletor): Promise<void> => {
    const bucket = (porModulo[coletor.modulo] ??= { coletores: 0, medidos: 0, itens: 0, erros: 0 });
    bucket.coletores++;
    if (Date.now() - t0 > prazoMs) {
      truncado = true; // o resto fica para o próximo ciclo — nada de ciclo infinito
      return;
    }
    const inicio = new Date().toISOString();
    const r = await cicloColetor(coletor, opts).catch((e: Error) => ({
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

  return {
    ok: resultados.every((r) => r.acao !== "erro"),
    medidoEm: agora.toISOString(),
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
