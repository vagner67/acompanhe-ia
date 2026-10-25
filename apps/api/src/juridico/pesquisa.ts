/**
 * Orquestração da busca por NOME/CPF/CNPJ → processos de terceiros
 * (plano-busca-unificada.md §3.3). Tudo real: fontes e-SAJ verificadas +
 * cruzamento DataJud por CNJ. Estados honestos por fonte; nunca fabrica.
 */
import { consultarEsaj, COBERTURA_UFS, type ResultadoEsaj, type ProcessoTercero } from "./esaj.js";
import type { PerfilFonte } from "./autoaperfeicoamento.js";
import { parseCnj, aliasCandidatesFromCnj } from "./cnj.js";
import { mapDoc } from "./service.js";
import type { DatajudDoc } from "./types.js";
import type { DatajudClientOpts } from "./datajud.js";

export { COBERTURA_UFS };

export interface PesquisaTerceirosOpts {
  ufs?: string[]; // default: todas as verificadas
  pagina?: number;
  fetchImpl?: typeof fetch;
  /**
   * Perfis vigentes do auto-aperfeiçoamento por fonte (`esaj-sp`, ...).
   * É o que faz o ciclo MEDIDO valer na busca por nome/CPF que o usuário usa —
   * antes só a busca nacional consumia o perfil e esta ficava no padrão de fábrica.
   */
  perfis?: Record<string, PerfilFonte | undefined>;
}

/** 0 = termo exato · 1 = sem acento · 2 = sem acento e caixa alta (idem nacional). */
function aplicarVarianteNome(termo: string, variante: number): string {
  const limpo = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (variante === 1) return limpo(termo);
  if (variante === 2) return limpo(termo).toUpperCase();
  return termo;
}

export interface PesquisaTerceiros {
  tipo: "nome" | "cpf" | "cnpj";
  valor: string;
  fontes: ResultadoEsaj[];
  itens: ProcessoTercero[];
  rodape: string;
}

export const RODAPE_TERCEIROS =
  "Resultados das consultas públicas dos tribunais (e-SAJ). Homônimos são possíveis — confirme por CPF, idade ou endereço. Processos em segredo de justiça não aparecem. Cobertura atual: AL e SP (demais UFs: portal do tribunal). Conteúdo informativo, não é parecer jurídico.";

/** Busca por página em cada fonte/UF informada (1 requisição real por UF). */
export async function pesquisarTerceiros(
  tipo: "nome" | "cpf" | "cnpj",
  valor: string,
  opts: PesquisaTerceirosOpts = {},
): Promise<PesquisaTerceiros> {
  const ufs = (opts.ufs && opts.ufs.length ? opts.ufs : COBERTURA_UFS).map((u) => u.toLowerCase());
  const pagina = Math.min(Math.max(opts.pagina ?? 1, 1), 10);
  const tipoCampo = tipo === "nome" ? "NMPARTE" : "DOCPARTE";
  const fontes: ResultadoEsaj[] = [];
  for (const uf of ufs) {
    // o perfil desta UF decide termo e timeout — parâmetro que o ciclo aprendeu
    const perfil = opts.perfis?.[`esaj-${uf}`];
    const termo = tipo === "nome" ? aplicarVarianteNome(valor, perfil?.varianteNome ?? 0) : valor;
    const extra = {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(perfil?.timeoutMs ? { timeoutMs: perfil.timeoutMs } : {}),
      ...(perfil?.concorrencia ? {} : {}),
    };
    fontes.push(await consultarEsaj(uf, tipoCampo, termo, pagina, extra));
  }
  const itens = fontes.flatMap((f) => f.itens);
  return { tipo, valor, fontes, itens, rodape: RODAPE_TERCEIROS };
}

export interface DetalheTercero {
  numeroProcesso: string;
  status: string | null;
  classe: string | null;
  orgaoJulgador: string | null;
  valorDaCausa: number | null;
  ultimoMovimento: { nome: string; dataHora: string } | null;
  dataAjuizamento: string | null;
  fonte: string;
}

export type DatajudFetch = (alias: string, query: { numeroProcesso: string }, opts?: DatajudClientOpts) => Promise<DatajudDoc[]>;

/**
 * Cruzamento REAL com DataJud por CNJ achado na busca.
 * Sem dado → campo null honesto ("não informado" na UI); nunca estima.
 */
export async function detalharProcessos(
  cnjs: string[],
  deps: { datajud: DatajudFetch; datajudOpts?: DatajudClientOpts },
): Promise<DetalheTercero[]> {
  const unicos = [...new Set(cnjs.map((c) => c.trim()).filter(Boolean))].slice(0, 30);
  const saida: DetalheTercero[] = [];
  for (const numero of unicos) {
    const partes = parseCnj(numero);
    // 91 tribunais: candidatos = corte do (J,TR) + superior do ramo (superiores
    // guardam números de ORIGEM; 5.01 = TRT1 e TST convivem) — mapa verificado
    // empiricamente 24/10/2026 (plano-91-tribunais-ia §1.1).
    const candidatos = partes ? aliasCandidatesFromCnj(partes.justica, partes.tribunal) : [];
    const base: DetalheTercero = {
      numeroProcesso: numero,
      status: null,
      classe: null,
      orgaoJulgador: null,
      valorDaCausa: null,
      ultimoMovimento: null,
      dataAjuizamento: null,
      fonte: candidatos[0] ? `datajud-${candidatos[0]}` : "datajud",
    };
    if (!partes || candidatos.length === 0) {
      saida.push(base);
      continue;
    }
    try {
      let doc: DatajudDoc | undefined;
      let aliasUsado = candidatos[0]!;
      for (const alias of candidatos) {
        const docs = await deps.datajud(alias, { numeroProcesso: `${partes.sequencial}${partes.dd}${partes.ano}${partes.justica}${partes.tribunal}${partes.origem}` }, deps.datajudOpts ?? {});
        if (docs[0]) {
          doc = docs[0];
          aliasUsado = alias;
          base.fonte = `datajud-${alias}`;
          break;
        }
      }
      if (!doc) {
        saida.push(base);
        continue;
      }
      const c = mapDoc(doc, aliasUsado);
      saida.push({
        numeroProcesso: numero,
        status: c.status,
        classe: c.nivelSigilo > 0 ? null : c.classe,
        orgaoJulgador: c.nivelSigilo > 0 ? null : c.orgaoJulgador,
        valorDaCausa: c.valorDaCausa,
        ultimoMovimento: c.ultimoMovimento ? { nome: c.ultimoMovimento.nome, dataHora: c.ultimoMovimento.dataHora } : null,
        dataAjuizamento: c.dataAjuizamento,
        fonte: base.fonte,
      });
    } catch {
      saida.push(base); // erro de fonte → item honesto sem dados, sem derrubar o lote
    }
  }
  return saida;
}
