/**
 * Motor de criticidade/risco — 100% DETERMINÍSTICO e auditável (inspirado no
 * "Motor de Decisão" do Jusbrasil: score + `audit` com justificativas/razões).
 * Regras explícitas, sem IA generativa, sem inferência oculta: cada ponto do
 * score tem uma justificativa rastreável (regra + processo).
 * Ver docs/plano-refatoracao-juridico-jusbrasil-escavador.md §6.6.
 */
export interface ProcessoParaRisco {
  numeroCnj: string;
  classe?: string | null;
  status?: string | null;
  valorCausa?: number | null;
  dataAjuizamento?: string | null;
  polo?: string | null;
  nivelSigilo?: number | null;
}

export interface Justificativa {
  regra: string;
  criticidade: number;
  motivo: string;
  processo: string | null;
}

export type Faixa = "baixo" | "medio" | "alto" | "critico";

export interface AvaliacaoRisco {
  criticidade: number;
  faixa: Faixa;
  justificativas: Justificativa[];
  totalProcessos: number;
  /** versão das regras — muda quando as regras mudam (auditoria) */
  versaoRegras: string;
}

export const VERSAO_REGRAS = "risco-v1";

const EXECUCAO = /execu[cç][aã]o|fal[eê]ncia|recupera[cç][aã]o judicial|cumprimento de senten[cç]a/i;
const CRIMINAL = /criminal|crime|roubo|furto|estelionato|homic[ií]dio|tr[aá]fico|recepta[cç][aã]o|les[aã]o corporal/i;
const PASSIVO = /passiv|r[eé]u|executad|reclamad|requerid|indiciad|denunciad/i;

const normalizar = (s: string | null | undefined): string =>
  (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/**
 * Avalia o risco de um conjunto de processos de uma pessoa/empresa.
 * Escala 0–10. Regras (cada uma gera justificativa própria):
 *  R1 execução/falência/cumprimento ....... até +3
 *  R2 matéria criminal .................... +2
 *  R3 figura no polo passivo .............. até +2
 *  R4 volume de processos ................. até +2
 *  R5 valor da causa agregado ............. até +2
 *  R6 processo ainda ativo ................ +1
 *  R7 processo sigiloso ................... +1
 *  R8 processo antigo (≥ 10 anos) ativo ... +1
 */
export function avaliarRisco(processos: ProcessoParaRisco[], hoje: Date = new Date()): AvaliacaoRisco {
  const just: Justificativa[] = [];
  const add = (regra: string, criticidade: number, motivo: string, processo: string | null) => {
    if (criticidade <= 0) return;
    just.push({ regra, criticidade, motivo, processo });
  };

  // R1 — execução/falência
  const execs = processos.filter((p) => EXECUCAO.test(normalizar(`${p.classe ?? ""}`)));
  for (const p of execs.slice(0, 3)) {
    add("R1_execucao", 1, `processo de execução/falência (${p.classe ?? "classe não informada"})`, p.numeroCnj);
  }

  // R2 — criminal
  const crim = processos.filter((p) => CRIMINAL.test(normalizar(`${p.classe ?? ""} ${p.polo ?? ""}`)));
  if (crim.length > 0) {
    add("R2_criminal", 2, `${crim.length} processo(s) de matéria criminal`, crim[0]!.numeroCnj);
  }

  // R3 — polo passivo
  const passivos = processos.filter((p) => PASSIVO.test(normalizar(p.polo)));
  if (passivos.length >= 1) add("R3_polo_passivo", 1, `${passivos.length} processo(s) no polo passivo`, passivos[0]!.numeroCnj);
  if (passivos.length >= 4) add("R3_polo_passivo_recorrente", 1, `${passivos.length} processos no polo passivo (recorrência)`, null);

  // R4 — volume
  if (processos.length >= 5) add("R4_volume", 1, `${processos.length} processos no conjunto`, null);
  if (processos.length >= 15) add("R4_volume_alto", 1, `${processos.length} processos no conjunto (volume alto)`, null);

  // R5 — valor agregado
  const soma = processos.reduce((acc, p) => acc + (typeof p.valorCausa === "number" ? p.valorCausa : 0), 0);
  if (soma >= 100_000) add("R5_valor", 1, `valor da causa somado acima de R$ 100 mil (R$ ${soma.toFixed(2)})`, null);
  if (soma >= 1_000_000) add("R5_valor_alto", 1, `valor da causa somado acima de R$ 1 milhão (R$ ${soma.toFixed(2)})`, null);

  // R6 — processo ativo
  const ativos = processos.filter((p) => {
    const s = normalizar(p.status).toLowerCase();
    return s === "" || s === "ativo" || s === "suspenso" || s === "desconhecido";
  });
  if (ativos.length > 0) add("R6_ativo", 1, `${ativos.length} processo(s) sem baixa/arquivamento`, ativos[0]!.numeroCnj);

  // R7 — sigilo
  const sigilosos = processos.filter((p) => (p.nivelSigilo ?? 0) > 0);
  if (sigilosos.length > 0) add("R7_sigilo", 1, `${sigilosos.length} processo(s) com nível de sigilo`, sigilosos[0]!.numeroCnj);

  // R8 — antigo e ainda ativo
  const limiteMs = 10 * 365 * 86400000;
  const antigos = ativos.filter((p) => {
    if (!p.dataAjuizamento) return false;
    const t = Date.parse(p.dataAjuizamento);
    return Number.isFinite(t) && hoje.getTime() - t >= limiteMs;
  });
  if (antigos.length > 0) add("R8_antigo_ativo", 1, `${antigos.length} processo(s) com 10+ anos ainda sem baixa`, antigos[0]!.numeroCnj);

  const bruto = just.reduce((acc, j) => acc + j.criticidade, 0);
  const criticidade = Math.max(0, Math.min(10, bruto));
  return {
    criticidade,
    faixa: criticidade <= 2 ? "baixo" : criticidade <= 5 ? "medio" : criticidade <= 8 ? "alto" : "critico",
    justificativas: just,
    totalProcessos: processos.length,
    versaoRegras: VERSAO_REGRAS,
  };
}
