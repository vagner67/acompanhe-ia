/**
 * Ingestão do índice (pipeline P1): puxa do DataJud (por número, 91 tribunais)
 * e converte resultados e-SAJ em registros. Puro e testável — o job/rota só
 * orquestra. Nunca inventa parte: o DataJud não publica nomes.
 */
import { parseCnj, aliasCandidatesFromCnj } from "./cnj.js";
import { processoDaBuscaEsaj, processoDoDatajud, type ProcessoIndiceDto } from "./indice.js";
import type { DatajudDoc } from "./types.js";
import type { ProcessoTercero } from "./esaj.js";

export type DatajudFetch = (
  alias: string,
  query: { numeroProcesso: string },
  opts?: import("./datajud.js").DatajudClientOpts,
) => Promise<DatajudDoc[]>;

export interface ResultadoIngestao {
  ingeridos: ProcessoIndiceDto[];
  naoEncontrados: string[];
  invalidos: string[];
}

/**
 * Ingestão por número(s) CNJ: consulta a corte do (J,TR) e, se necessário, a
 * superior do ramo (mesma regra verificada da busca). Registros inválidos
 * (DV errado) vão para `invalidos` — nunca para o índice.
 */
export async function ingerirPorNumeros(
  numeros: string[],
  deps: { datajud: DatajudFetch; datajudOpts?: import("./datajud.js").DatajudClientOpts },
  agora: Date = new Date(),
): Promise<ResultadoIngestao> {
  const out: ResultadoIngestao = { ingeridos: [], naoEncontrados: [], invalidos: [] };
  const vistos = new Set<string>();
  for (const bruto of numeros.map((n) => n.trim()).filter(Boolean)) {
    if (vistos.has(bruto)) continue;
    vistos.add(bruto);
    const partes = parseCnj(bruto);
    if (!partes) {
      out.invalidos.push(bruto);
      continue;
    }
    const candidatos = aliasCandidatesFromCnj(partes.justica, partes.tribunal);
    if (candidatos.length === 0) {
      out.naoEncontrados.push(bruto);
      continue;
    }
    const digits = `${partes.sequencial}${partes.dd}${partes.ano}${partes.justica}${partes.tribunal}${partes.origem}`;
    let achou: { doc: DatajudDoc; alias: string } | null = null;
    for (const alias of candidatos) {
      try {
        const docs = await deps.datajud(alias, { numeroProcesso: digits }, deps.datajudOpts ?? {});
        if (docs[0]) {
          achou = { doc: docs[0], alias };
          break;
        }
      } catch {
        // fonte instável → tenta o próximo candidato; se nada, vira naoEncontrado
      }
    }
    if (!achou) {
      out.naoEncontrados.push(bruto);
      continue;
    }
    out.ingeridos.push(processoDoDatajud(achou.doc, achou.alias, agora));
  }
  return out;
}

/** Converte resultados de uma busca e-SAJ em registros do índice. */
export function ingerirDaBuscaEsaj(
  itens: ProcessoTercero[],
  tipoBusca: "nome" | "documento",
  agora: Date = new Date(),
  documento?: string,
): ProcessoIndiceDto[] {
  return itens.map((it) => processoDaBuscaEsaj(it, tipoBusca, agora, documento));
}
