/**
 * Assessoria jurídica (plano.md §4) — tipos do cliente DataJud/CNJ.
 * Contrato REAL verificado em 23/10/2026 contra api-publica.datajud.cnj.jus.br
 * (fixture test/fixtures/datajud-capture.json). Nada inventado.
 */

export interface DatajudDoc {
  numeroProcesso: string; // 20 dígitos CNJ (ex.: 00069036920148110037)
  dataAjuizamento: string; // "20140805000000" (yyyyMMddHHmmss)
  grau: string; // "G1"
  nivelSigilo: number;
  orgaoJulgador: { codigo: number; nome: string; codigoMunicipioIBGE: number };
  classe: { codigo: number; nome: string };
  assunto?: { codigo: number; nome: string };
  movimentos: Array<{
    codigo: number;
    dataHora: string; // ISO
    nome: string;
    complementosTabelados?: Array<{
      codigo: number;
      nome: string;
      valor: string;
      descricao: string;
    }>;
  }>;
  valores?: { valorDaCausa?: number };
  [k: string]: unknown;
}

export interface DatajudSearchResponse {
  took: number;
  hits: { total: { value: number }; hits: Array<{ _source: DatajudDoc }> };
}

/** Alias do tribunal (ex.: "tjmt"). Confirmado vivo: tjmt responde 200. */
export type TribunalAlias = string;

export interface LegalCaseDto {
  numeroProcesso: string;
  grau: string;
  classe: string;
  assunto: string | null;
  orgaoJulgador: string;
  orgaoCodigo: number | null;
  municipioIbge: number | null;
  dataAjuizamento: string; // ISO
  valorDaCausa: number | null;
  nivelSigilo: number;
  status: "ativo" | "suspenso" | "arquivado" | "baixado" | "desconhecido";
  tribunal: string; // alias
  /** Últimos movimentos (ordem decrescente de data) — para o alerta F2/F3. */
  ultimoMovimento: { codigo: number; nome: string; dataHora: string } | null;
  movimentosCount: number;
  fieldStatus: "pendente" | "validado"; // RD3 — dado só de texto livre não valida
  /** RF-B04 — alertas de movimentação ligados (botão Alertar). */
  alertasAtivos: boolean;
  raw: unknown;
}

export interface ProcessoFilter {
  numeroProcesso?: string;
  orgao?: string;
  classe?: string;
  tribunal?: string;
}

export interface LegalEventDto {
  numeroProcesso: string;
  codigo: number;
  nome: string;
  dataHora: string;
  tribunal: string;
}
