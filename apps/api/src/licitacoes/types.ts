/**
 * Licitação — tipos do módulo (plano.md §2). Campos espelham os fatos reais
 * capturados da API do PNCP em 23/10/2026 (fixtures/pncp-capture.json):
 * - consulta (publicacao|atualizacao|proposta): itens camelCase;
 * - busca (/api/search): itens snake_case (Elasticsearch, index catalog2).
 * Nada aqui é inventado: cada campo existe na captura.
 */

export type ContratacaoKind = "publicacao" | "atualizacao" | "proposta";

/** Item camelCase do endpoint /api/consulta/v1/contratacoes/* (captura real). */
export interface PncpContratacaoRaw {
  numeroControlePNCP: string;
  anoCompra: number;
  sequencialCompra: number;
  numeroCompra: string;
  processo: string;
  objetoCompra: string;
  informacaoComplementar?: string | null;
  modalidadeId: number;
  modalidadeNome: string;
  situacaoCompraId?: number | null;
  situacaoCompraNome?: string | null;
  dataAberturaProposta?: string | null;
  dataEncerramentoProposta?: string | null;
  dataPublicacaoPncp?: string | null;
  dataAtualizacao?: string | null;
  valorTotalEstimado?: number | null;
  valorTotalHomologado?: number | null;
  orgaoEntidade: { cnpj: string; razaoSocial: string; poderId?: string; esferaId?: string };
  unidadeOrgao?: {
    ufSigla?: string;
    ufNome?: string;
    municipioNome?: string;
    codigoIbge?: string | number | null;
    nomeUnidade?: string;
    codigoUnidade?: string;
  };
  linkSistemaOrigem?: string | null;
  linkProcessoEletronico?: string | null;
  srp?: boolean;
}

/** Envelope REAL de paginação (captura 23/10/2026): NÃO tem `last:true`;
 *  a paginação é totalPaginas/paginasRestantes. */
export interface PncpPage<T> {
  data: T[];
  totalRegistros: number;
  totalPaginas: number;
  numeroPagina: number;
  paginasRestantes: number;
  empty: boolean;
}

/** Item snake_case de /api/search (captura real, tipos_documento=edital). */
export interface PncpSearchItemRaw {
  id: string;
  document_type?: string;
  title?: string;
  description?: string | null;
  item_url?: string | null;
  numero_controle_pncp?: string | null;
  orgao_cnpj?: string | null;
  orgao_nome?: string | null;
  ano?: string | number | null;
  numero_sequencial?: string | number | null;
  uf?: string | null;
  municipio_nome?: string | null;
  codigo_ibge?: string | number | null;
  modalidade_licitacao_id?: number | null;
  modalidade_licitacao_nome?: string | null;
  situacao_nome?: string | null;
  valor_total_estimado?: number | null;
  data_inicio_recebimento_propostas?: string | null;
  data_fim_recebimento_propostas?: string | null;
  data_publicacao_pncp?: string | null;
  [k: string]: unknown;
}

/** Modelo normalizado persistido em `Tender` (Prisma) e servido na API. */
export interface TenderDto {
  /** id estável RC1: `pncp:{cnpjOrgao}:{ano}:{sequencial}` (3 campos oficiais). */
  pncpId: string;
  numeroControlePncp: string;
  title: string;
  /** objeto da contratação (RF-C02: palavra-chave busca AQUI). */
  objeto: string;
  organ: string;
  cnpj: string;
  modality?: number | null;
  modalityName?: string | null;
  uf?: string | null;
  cityIbge?: number | null;
  status?: string | null;
  /** centavos (INTEGER) — a API do PNCP devolve reais (441560.04). */
  budgetCents?: number | null;
  propostaFrom?: string | null;
  propostaTo?: string | null;
  /** link oficial: item_url (pncp.gov.br) ou linkSistemaOrigem — NUNCA inventado. */
  sourceUrl?: string | null;
  raw: unknown;
}
