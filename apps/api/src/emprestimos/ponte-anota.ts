/**
 * Ponte Empréstimo → AnotA (união pedida em 25/10).
 *
 * Direção da dependência: **empréstimo conhece o AnotA**, e não o contrário.
 * O AnotA é o livro-caixa do usuário e não pode depender das regras de
 * empréstimo (é a regra de arquitetura que mantém o AnotA isolado). Quem traduz
 * contrato em lançamento é este arquivo; a rota que o expõe vive em
 * `routes/emprestimos.ts` (mas sob o caminho `/api/anota/emprestimos`, onde a
 * tela do AnotA a procura).
 *
 * REGRA QUE NÃO SE QUEBRA: nada aqui inventa número. Principal, juros, meses e
 * tipo de juros vêm do `LoanRequestDto`; o total vem de `calcularEmprestimo`;
 * as parcelas de `parcelar` (a última fecha o centavo). Pagamento vem de
 * `PaymentDto` do próprio store.
 *
 * Idempotência: cada linha tem `fitId` determinístico (`loan:<matchId>:<n>` e
 * `loan-pay:<paymentId>`). Lançar duas vezes não duplica — o `AnotaStore` já
 * sabe checar (`existeFitId`).
 */
import { randomUUID } from "node:crypto";

import { calcularEmprestimo } from "./calculadora.js";
import type { LoanMatchDto, LoanRequestDto, PaymentDto } from "./service.js";
import { parcelar } from "../anota/dominio.js";
import type { LancamentoDto } from "../anota/tipos.js";

/** Lançamento derivado de contrato: `parcelaNum`/`parcelasTotal` preenchidos. */
export interface ContratoNoAnota {
  matchId: string;
  requestId: string;
  papel: "devedor" | "credor";
  tipo: "despesa" | "receita";
  principalCents: number;
  jurosCents: number;
  totalCents: number;
  formula: string;
  meses: number;
  jurosMesBps: number;
  motivo: string;
  /** data do match — é dela que saem os vencimentos (dado real, não "hoje") */
  baseEm: string;
  parcelaCents: number;
  parcelas: Array<{ n: number; vencimento: string; valorCents: number; fitId: string }>;
}

export const CATEGORIA_EMPRESTIMO = "empréstimos";
const MAX_PARCELAS = 48; // mesmo teto de `parcelar`

export function fitIdParcela(matchId: string, n: number): string {
  return `loan:${matchId}:${n}`;
}
export function fitIdPagamento(paymentId: string): string {
  return `loan-pay:${paymentId}`;
}

/**
 * Contrato visto pelos olhos de UM dos lados. Lança erro se o usuário não for
 * parte do contrato (a rota transforma em 404) ou se o match não estiver aceito.
 */
export function contratoParaAnotA(match: LoanMatchDto, pedido: LoanRequestDto, userId: string): ContratoNoAnota {
  if (match.requestUserId !== userId && match.offerUserId !== userId) {
    throw new Error("usuário não é parte deste contrato");
  }
  const papel: "devedor" | "credor" = match.requestUserId === userId ? "devedor" : "credor";
  const res = calcularEmprestimo({
    principalCents: pedido.valorCents,
    jurosMesBps: pedido.jurosMesBps,
    meses: pedido.meses,
    jurosTipo: pedido.jurosTipo,
  });
  // `parcelar` tem teto de 48; um pedido acima disso é fatiado no teto e o
  // contrato marca que houve limite (nunca silencia).
  const n = Math.min(pedido.meses, MAX_PARCELAS);
  const base = match.createdAt.slice(0, 10);
  const geradas = parcelar(res.totalCents, n, base);
  return {
    matchId: match.id,
    requestId: match.requestId,
    papel,
    tipo: papel === "devedor" ? "despesa" : "receita",
    principalCents: res.principalCents,
    jurosCents: res.jurosCents,
    totalCents: res.totalCents,
    formula: res.formula,
    meses: pedido.meses,
    jurosMesBps: pedido.jurosMesBps,
    motivo: pedido.motivo,
    baseEm: base,
    parcelaCents: geradas[0]?.amountCents ?? 0,
    parcelas: geradas.map((p) => ({
      n: p.num,
      vencimento: p.vencimento,
      valorCents: p.amountCents,
      fitId: fitIdParcela(match.id, p.num),
    })),
  };
}

export interface OpcoesLancamento {
  contaId?: string | null;
  categoriaId?: string | null;
  categoria?: string;
  agora?: string;
}

function lancamento(
  userId: string,
  base: Pick<LancamentoDto, "tipo" | "amountCents" | "description" | "data" | "status"> & {
    fitId: string;
    parcelaNum: number | null;
    parcelasTotal: number | null;
  },
  opts: OpcoesLancamento,
): LancamentoDto {
  return {
    id: randomUUID(),
    userId,
    tipo: base.tipo,
    amountCents: base.amountCents,
    description: base.description,
    category: opts.categoria ?? CATEGORIA_EMPRESTIMO,
    categoriaId: opts.categoriaId ?? null,
    contaId: opts.contaId ?? null,
    data: base.data,
    vencimento: base.data,
    status: base.status,
    photoRef: null,
    ocrText: null,
    ocrEngine: null,
    parcelaDe: null,
    parcelaNum: base.parcelaNum,
    parcelasTotal: base.parcelasTotal,
    recorrenteDe: null,
    fitId: base.fitId,
    origem: "emprestimo",
    createdAt: opts.agora ?? new Date().toISOString(),
  };
}

/**
 * As N parcelas do contrato como lançamentos do AnotA.
 * - devedor → despesa ("Empréstimo <motivo> n/N")
 * - credor  → receita ("Empréstimo concedido: <motivo> n/N")
 * Status `pendente`: o dinheiro ainda não saiu; pagamento é outro lançamento.
 */
export function lancamentosDoContrato(contrato: ContratoNoAnota, userId: string, opts: OpcoesLancamento = {}): LancamentoDto[] {
  const prefixo = contrato.papel === "devedor" ? "Empréstimo" : "Empréstimo concedido";
  const total = contrato.parcelas.length;
  return contrato.parcelas.map((p) =>
    lancamento(
      userId,
      {
        tipo: contrato.tipo,
        amountCents: p.valorCents,
        description: `${prefixo}: ${contrato.motivo} (${p.n}/${total})`,
        data: p.vencimento,
        status: "pendente",
        fitId: p.fitId,
        parcelaNum: p.n,
        parcelasTotal: total,
      },
      opts,
    ),
  );
}

/**
 * Pagamento declarado/confirmado como lançamento.
 * `declared` → pendente; `confirmed` → pago; `disputed` → pendente (contestado
 * continua pendente até alguém provar o contrário — nada de marcar pago).
 */
export function lancamentoDoPagamento(
  contrato: ContratoNoAnota,
  pagamento: PaymentDto,
  userId: string,
  opts: OpcoesLancamento = {},
): LancamentoDto {
  const prefixo = contrato.papel === "devedor" ? "Pagamento de empréstimo" : "Recebimento de empréstimo";
  return lancamento(
    userId,
    {
      tipo: contrato.tipo,
      amountCents: pagamento.valorCents,
      description: `${prefixo}: ${contrato.motivo}`,
      data: pagamento.declaredAt.slice(0, 10),
      status: pagamento.status === "confirmed" ? "pago" : "pendente",
      fitId: fitIdPagamento(pagamento.id),
      parcelaNum: null,
      parcelasTotal: null,
    },
    opts,
  );
}

/** Linha que a tela mostra: contrato + o que já existe no AnotA. */
export interface ContratoNaTela {
  matchId: string;
  papel: "devedor" | "credor";
  motivo: string;
  principalCents: number;
  jurosCents: number;
  totalCents: number;
  parcelaCents: number;
  meses: number;
  jurosMesBps: number;
  baseEm: string;
  proximoVencimento: string | null;
  parcelasLancadas: number;
  parcelasTotal: number;
  pagoCents: number;
  declaradoCents: number;
  /** o que falta pagar/receber da parte deste usuário */
  emAbertoCents: number;
  pagamentos: Array<{ id: string; valorCents: number; status: PaymentDto["status"]; declaredAt: string; noAnotA: boolean }>;
}

export function resumoContratos(
  contratos: ContratoNoAnota[],
  lancamentos: readonly LancamentoDto[],
  pagamentosPorMatch: Record<string, PaymentDto[]>,
): { contratos: ContratoNaTela[]; aPagarCents: number; aReceberCents: number } {
  const hoje = new Date().toISOString().slice(0, 10);
  let aPagar = 0;
  let aReceber = 0;
  const linhas = contratos.map((c) => {
    const fitIds = new Set(lancamentos.map((l) => l.fitId));
    const parcelasLancadas = c.parcelas.filter((p) => fitIds.has(p.fitId)).length;
    const pagamentos = pagamentosPorMatch[c.matchId] ?? [];
    const pagoCents = pagamentos.filter((p) => p.status === "confirmed").reduce((s, p) => s + p.valorCents, 0);
    const declaradoCents = pagamentos.filter((p) => p.status === "declared").reduce((s, p) => s + p.valorCents, 0);
    const emAbertoCents = Math.max(0, c.totalCents - pagoCents);
    if (c.papel === "devedor") aPagar += emAbertoCents;
    else aReceber += emAbertoCents;
    const futuras = c.parcelas.filter((p) => p.vencimento >= hoje);
    return {
      matchId: c.matchId,
      papel: c.papel,
      motivo: c.motivo,
      principalCents: c.principalCents,
      jurosCents: c.jurosCents,
      totalCents: c.totalCents,
      parcelaCents: c.parcelaCents,
      meses: c.meses,
      jurosMesBps: c.jurosMesBps,
      baseEm: c.baseEm,
      proximoVencimento: futuras[0]?.vencimento ?? c.parcelas[c.parcelas.length - 1]?.vencimento ?? null,
      parcelasLancadas,
      parcelasTotal: c.parcelas.length,
      pagoCents,
      declaradoCents,
      emAbertoCents,
      pagamentos: pagamentos.map((p) => ({
        id: p.id,
        valorCents: p.valorCents,
        status: p.status,
        declaredAt: p.declaredAt,
        noAnotA: fitIds.has(fitIdPagamento(p.id)),
      })),
    } satisfies ContratoNaTela;
  });
  return { contratos: linhas, aPagarCents: aPagar, aReceberCents: aReceber };
}

/**
 * Reflete UM pagamento no livro-caixa de UM dos lados.
 *
 * Duas decisões que evitam número dobrado:
 *
 * 1. **Só pagamento confirmado mexe no AnotA.** `declared` é a palavra do
 *    pagador; `confirmed` é quando a contraparte concorda que o dinheiro andou
 *    (RF-E06, dupla confirmação). Marcar pago antes seria mentir no saldo.
 * 2. **O pagamento paga a parcela, não cria linha paralela.** Se as parcelas do
 *    contrato já foram lançadas, o k-ésimo pagamento confirmado fecha a k-ésima
 *    parcela (`fitId loan:<matchId>:k`) e o valor vira o valor real pago. Só
 *    quando o usuário nunca lançou o contrato é que o pagamento ganha linha
 *    própria (`loan-pay:<paymentId>`) — sem isso o "a pagar" contaria duas vezes.
 */
export async function sincronizarPagamentoNoAnota(
  store: {
    existeFitId(userId: string, fitId: string): Promise<boolean>;
    criarLancamentos(ls: LancamentoDto[]): Promise<LancamentoDto[]>;
    listarLancamentos(userId: string, filtro?: { de?: string; ate?: string }): Promise<LancamentoDto[]>;
    atualizarLancamento(
      id: string,
      userId: string,
      patch: { status?: "pago" | "pendente"; amountCents?: number },
    ): Promise<LancamentoDto | null>;
  },
  contrato: ContratoNoAnota,
  pagamento: PaymentDto,
  userId: string,
  opts: OpcoesLancamento = {},
  ordemConfirmados = 1,
): Promise<{ acao: "criado" | "atualizado" | "sem-mudanca"; viaParcela: boolean; lancamentoId: string | null; motivo?: string }> {
  if (pagamento.status !== "confirmed") {
    return {
      acao: "sem-mudanca",
      viaParcela: false,
      lancamentoId: null,
      motivo:
        pagamento.status === "disputed"
          ? "pagamento contestado — o AnotA não marca como pago até a disputa resolver"
          : "pagamento declarado aguardando confirmação — o AnotA só muda quando a contraparte confirma",
    };
  }
  const desejado = lancamentoDoPagamento(contrato, pagamento, userId, opts);
  const existentes = await store.listarLancamentos(userId);

  // 1) a parcela correspondente já está no AnotA? então é ela que fica paga.
  const parcelaFit = fitIdParcela(contrato.matchId, ordemConfirmados);
  const parcela = existentes.find((l) => l.fitId === parcelaFit);
  if (parcela) {
    if (parcela.status === "pago" && parcela.amountCents === pagamento.valorCents) {
      return { acao: "sem-mudanca", viaParcela: true, lancamentoId: parcela.id };
    }
    const atualizada = await store.atualizarLancamento(parcela.id, userId, {
      status: "pago",
      amountCents: pagamento.valorCents,
    });
    return { acao: "atualizado", viaParcela: true, lancamentoId: atualizada?.id ?? parcela.id };
  }

  // 2) contrato nunca lançado: o pagamento vira linha própria, paga.
  if (!(await store.existeFitId(userId, desejado.fitId!))) {
    const [criado] = await store.criarLancamentos([desejado]);
    return { acao: "criado", viaParcela: false, lancamentoId: criado?.id ?? null };
  }
  const atual = existentes.find((l) => l.fitId === desejado.fitId);
  if (!atual) return { acao: "sem-mudanca", viaParcela: false, lancamentoId: null };
  if (atual.status === desejado.status && atual.amountCents === desejado.amountCents) {
    return { acao: "sem-mudanca", viaParcela: false, lancamentoId: atual.id };
  }
  const atualizado = await store.atualizarLancamento(atual.id, userId, {
    status: desejado.status,
    amountCents: desejado.amountCents,
  });
  return { acao: "atualizado", viaParcela: false, lancamentoId: atualizado?.id ?? atual.id };
}
