/**
 * AnotA — contratos do controle financeiro.
 *
 * Regra de ouro do módulo: **dinheiro é inteiro em centavos** em todo o domínio
 * (nada de float), e data de competência é string `YYYY-MM-DD` — comparável como
 * texto, sem fuso horário no meio. Os nomes em português são intencionais: é o
 * vocabulário do usuário (conta, lançamento, orçamento, fatura).
 */

export type TipoConta = "caixa" | "banco" | "cartao" | "poupanca";
export type TipoCategoria = "despesa" | "receita";
export type TipoLancamento = "despesa" | "receita";
export type StatusLancamento = "pago" | "pendente";
export type OrigemLancamento = "manual" | "csv" | "ofx" | "emprestimo";

export const TIPOS_CONTA: readonly TipoConta[] = ["caixa", "banco", "cartao", "poupanca"];

export interface ContaDto {
  id: string;
  userId: string;
  nome: string;
  tipo: TipoConta;
  /** saldo no momento em que a conta foi cadastrada (centavos, pode ser negativo) */
  saldoInicialCents: number;
  arquivada: boolean;
  criadaEm: string;
}

export interface CategoriaDto {
  id: string;
  userId: string;
  nome: string;
  tipo: TipoCategoria;
  cor: string | null;
  icone: string | null;
  arquivada: boolean;
}

/**
 * Lançamento = uma linha de dinheiro que entrou ou saiu.
 * `Gasto` (despesas, tabela que já existia) e `AnotaReceita` (entradas, tabela nova)
 * são persistidos em tabelas diferentes por compatibilidade com os dados em
 * produção, mas o domínio só conhece esta forma única.
 */
export interface LancamentoDto {
  id: string;
  userId: string;
  tipo: TipoLancamento;
  amountCents: number;
  description: string;
  /** nome da categoria (compatível com o modelo antigo, que só tinha string) */
  category: string;
  categoriaId: string | null;
  contaId: string | null;
  /** data de competência — `YYYY-MM-DD` */
  data: string;
  /** vencimento quando é conta a pagar/receber */
  vencimento: string | null;
  status: StatusLancamento;
  photoRef: string | null;
  ocrText: string | null;
  ocrEngine: string | null;
  /** parcelamento: id do lançamento-pai, número da parcela e total */
  parcelaDe: string | null;
  parcelaNum: number | null;
  parcelasTotal: number | null;
  /** recorrência: id do lançamento que se repete todo mês */
  recorrenteDe: string | null;
  /** deduplicação de importação bancária */
  fitId: string | null;
  origem: OrigemLancamento;
  createdAt: string;
}

export interface OrcamentoDto {
  id: string;
  userId: string;
  categoriaId: string;
  /** mês de competência `YYYY-MM` */
  ym: string;
  limiteCents: number;
}

export interface CartaoDto {
  id: string;
  userId: string;
  contaId: string;
  nome: string;
  limiteCents: number;
  /** dia do mês em que a fatura fecha (1–28) */
  fechamentoDia: number;
  /** dia do mês em que a fatura vence (1–28) */
  vencimentoDia: number;
}

export interface MetaDto {
  id: string;
  userId: string;
  nome: string;
  alvoCents: number;
  guardadoCents: number;
  prazo: string | null;
}

/** Categoria inicial de cada usuário — espelha exatamente a lista que estava
 *  hardcoded na tela antiga (`screens.tsx`), agora em dados. */
export const CATEGORIAS_INICIAIS: ReadonlyArray<{ nome: string; tipo: TipoCategoria }> = [
  { nome: "mercado", tipo: "despesa" },
  { nome: "aluguel", tipo: "despesa" },
  { nome: "transporte", tipo: "despesa" },
  { nome: "saúde", tipo: "despesa" },
  { nome: "educação", tipo: "despesa" },
  { nome: "lazer", tipo: "despesa" },
  { nome: "outros", tipo: "despesa" },
  { nome: "salário", tipo: "receita" },
  { nome: "extra", tipo: "receita" },
];

export function ymDe(dataIso: string): string {
  return dataIso.slice(0, 7);
}

export function ehYmValido(ym: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(ym);
}

export function ehDataValida(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [a, m, dia] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(a!, m! - 1, dia!));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === dia;
}
