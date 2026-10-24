/**
 * Empréstimo — match, negociação e pagamento (plano.md §5.5/§5.6).
 * doc 03 §3.3: cards ANÔNIMOS, match 72h, negociação 3 rodadas (PRODUCT_LIMITS),
 * juros de publicação ≤ 4% a.m. (MAX_PUBLISH_RATE_BPS), teto R$15.000/par
 * (MAX_PAIR_TOTAL_CENTS). RE2: aviso de usura acima do parâmetro do diretor.
 * RF-E05/E06: agenda + lembretes AOS DOIS lados; dupla confirmação de pagamento
 * (declared→confirmed→disputed, TTL 72h).
 */
export const PRODUCT_LIMITS = {
  matchHoras: 72,
  rodadasNegociacao: 3,
  maxPairTotalCents: 1_500_000, // R$ 15.000 por par
  confirmacaoTtlHoras: 72,
} as const;

import { avisoUsura, MAX_PUBLISH_RATE_BPS, type JurosTipo } from "./calculadora.js";

export interface LoanRequestDto {
  id: string;
  userId: string; // dono — nunca vai no card
  uf: string;
  valorCents: number;
  jurosMesBps: number;
  meses: number;
  jurosTipo: JurosTipo;
  motivo: string;
  status: "aberta" | "em_match" | "fechada" | "cancelada";
  createdAt: string;
  avisoUsura: string | null; // RE2
}

export interface LoanMatchDto {
  id: string;
  requestId: string;
  offerUserId: string; // credor
  requestUserId: string; // devedor
  status: "pendente" | "aceito" | "recusado" | "expirado";
  rodadas: number;
  createdAt: string;
  expiraEm: string; // +72h
}

export interface PaymentDto {
  id: string;
  matchId: string;
  valorCents: number;
  declaredBy: string; // pagador declara
  confirmadoPor: string | null; // contraparte confirma
  status: "declared" | "confirmed" | "disputed";
  declaredAt: string;
  ttlEm: string; // +72h
}

export interface LoanStore {
  createRequest(r: LoanRequestDto): Promise<void>;
  getRequest(id: string): Promise<LoanRequestDto | undefined>;
  listRequests(filter: { uf?: string }): Promise<LoanRequestDto[]>;
  createMatch(m: LoanMatchDto): Promise<void>;
  getMatch(id: string): Promise<LoanMatchDto | undefined>;
  listMatches(userId: string): Promise<LoanMatchDto[]>;
  updateMatch(id: string, patch: Partial<LoanMatchDto>): Promise<void>;
  addRodada(matchId: string, rodada: { by: string; proposta: string; at: string }): Promise<number>;
  listRodadas(matchId: string): Promise<Array<{ by: string; proposta: string; at: string }>>;
  createPayment(p: PaymentDto): Promise<void>;
  getPayment(id: string): Promise<PaymentDto | undefined>;
  updatePayment(id: string, patch: Partial<PaymentDto>): Promise<void>;
  listPayments(matchId: string): Promise<PaymentDto[]>;
}

export class InMemoryLoanStore implements LoanStore {
  private requests = new Map<string, LoanRequestDto>();
  private matches = new Map<string, LoanMatchDto>();
  private rodadas = new Map<string, Array<{ by: string; proposta: string; at: string }>>();
  private payments = new Map<string, PaymentDto>();
  private seq = 0;

  async createRequest(r: LoanRequestDto) {
    this.requests.set(r.id, r);
  }

  async getRequest(id: string) {
    return this.requests.get(id);
  }

  async listRequests(filter: { uf?: string }) {
    return [...this.requests.values()].filter((r) => (filter.uf ? r.uf === filter.uf : true));
  }

  async createMatch(m: LoanMatchDto) {
    this.matches.set(m.id, m);
  }

  async getMatch(id: string) {
    return this.matches.get(id);
  }

  async listMatches(userId: string) {
    return [...this.matches.values()].filter((m) => m.offerUserId === userId || m.requestUserId === userId);
  }

  async updateMatch(id: string, patch: Partial<LoanMatchDto>) {
    const m = this.matches.get(id);
    if (m) this.matches.set(id, { ...m, ...patch });
  }

  async addRodada(matchId: string, rodada: { by: string; proposta: string; at: string }) {
    const l = this.rodadas.get(matchId) ?? [];
    l.push(rodada);
    this.rodadas.set(matchId, l);
    return l.length;
  }

  async listRodadas(matchId: string) {
    return this.rodadas.get(matchId) ?? [];
  }

  async createPayment(p: PaymentDto) {
    this.payments.set(p.id, p);
  }

  async getPayment(id: string) {
    return this.payments.get(id);
  }

  async updatePayment(id: string, patch: Partial<PaymentDto>) {
    const p = this.payments.get(id);
    if (p) this.payments.set(id, { ...p, ...patch });
  }

  async listPayments(matchId: string) {
    return [...this.payments.values()].filter((p) => p.matchId === matchId);
  }
}

export class RegraVioladaError extends Error {
  readonly statusCode: number;
  constructor(msg: string, status = 422) {
    super(msg);
    this.statusCode = status;
  }
}

export interface EmprestimosDeps {
  store: LoanStore;
  now?: () => Date;
  novoId?: (prefix: string) => string;
}

export function makeEmprestimosService(deps: EmprestimosDeps) {
  const now = deps.now ?? (() => new Date());
  const novoId = deps.novoId ?? ((prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`);

  /** doc 03 §3.3 — publicar pedido (V1 já exigido na rota — A3). */
  async function publicarPedido(userId: string, dados: Omit<LoanRequestDto, "id" | "userId" | "status" | "createdAt" | "avisoUsura">) {
    const aviso = dados.jurosMesBps > MAX_PUBLISH_RATE_BPS ? avisoUsura(dados.jurosMesBps, MAX_PUBLISH_RATE_BPS) : null;
    const r: LoanRequestDto = {
      ...dados,
      id: novoId("lr"),
      userId,
      status: "aberta",
      createdAt: now().toISOString(),
      avisoUsura: aviso,
    };
    await deps.store.createRequest(r);
    return r;
  }

  /** Card ANÔNIMO: nunca expõe userId/motivo identificável. */
  function cardAnonimo(r: LoanRequestDto) {
    return {
      id: r.id,
      uf: r.uf,
      valorCents: r.valorCents,
      jurosMesBps: r.jurosMesBps,
      meses: r.meses,
      jurosTipo: r.jurosTipo,
      avisoUsura: r.avisoUsura,
    };
  }

  /** Match: 72h e teto R$15.000/par (soma dos envolvidos). */
  async function demonstrarInteresse(userId: string, requestId: string) {
    const req = await deps.store.getRequest(requestId);
    if (!req || req.status !== "aberta") throw new RegraVioladaError("pedido indisponível", 404);
    if (req.userId === userId) throw new RegraVioladaError("não pode dar match no próprio pedido");
    const matches = await deps.store.listMatches(userId);
    const soma = matches
      .filter((m) => m.status === "aceito")
      .reduce((a, m) => a + (req.valorCents ?? 0), 0);
    if (soma + req.valorCents > PRODUCT_LIMITS.maxPairTotalCents) {
      throw new RegraVioladaError(`teto por par: R$ ${(PRODUCT_LIMITS.maxPairTotalCents / 100).toFixed(2)} (MAX_PAIR_TOTAL_CENTS)`);
    }
    const at = now();
    const m: LoanMatchDto = {
      id: novoId("lm"),
      requestId,
      offerUserId: userId,
      requestUserId: req.userId,
      status: "pendente",
      rodadas: 0,
      createdAt: at.toISOString(),
      expiraEm: new Date(at.getTime() + PRODUCT_LIMITS.matchHoras * 3600_000).toISOString(),
    };
    await deps.store.createMatch(m);
    await deps.store.updateMatch(requestId, { status: "pendente" });
    return m;
  }

  /** Dono do pedido aceita a oferta → match aceito (pré-requisito de pagamento). */
  async function aceitarMatch(matchId: string, by: string) {
    const m = await deps.store.getMatch(matchId);
    if (!m) throw new RegraVioladaError("match inexistente", 404);
    if (m.requestUserId !== by) throw new RegraVioladaError("só o dono do pedido aceita a oferta");
    if (m.status !== "pendente") throw new RegraVioladaError(`match ${m.status} não pode ser aceito`);
    if (new Date(m.expiraEm).getTime() < now().getTime()) {
      await deps.store.updateMatch(matchId, { status: "expirado" });
      throw new RegraVioladaError("match expirado (72h)");
    }
    await deps.store.updateMatch(matchId, { status: "aceito" });
    return deps.store.getMatch(matchId);
  }

  /** Negociação: máx. 3 rodadas (PRODUCT_LIMITS). */
  async function proporRodada(matchId: string, by: string, proposta: string) {
    const m = await deps.store.getMatch(matchId);
    if (!m) throw new RegraVioladaError("match inexistente", 404);
    if (m.status === "expirado" || new Date(m.expiraEm).getTime() < now().getTime()) {
      await deps.store.updateMatch(matchId, { status: "expirado" });
      throw new RegraVioladaError("match expirado (72h)");
    }
    const n = await deps.store.addRodada(matchId, { by, proposta, at: now().toISOString() });
    if (n > PRODUCT_LIMITS.rodadasNegociacao) throw new RegraVioladaError("máximo de 3 rodadas de negociação");
    await deps.store.updateMatch(matchId, { rodadas: n });
    return n;
  }

  /** RF-E06 — dupla confirmação: declared → confirmed | disputed (TTL 72h). */
  async function declararPagamento(matchId: string, by: string, valorCents: number) {
    const m = await deps.store.getMatch(matchId);
    if (!m || m.status !== "aceito") throw new RegraVioladaError("pagamento só em match aceito");
    const at = now();
    const p: PaymentDto = {
      id: novoId("pay"),
      matchId,
      valorCents,
      declaredBy: by,
      confirmadoPor: null,
      status: "declared",
      declaredAt: at.toISOString(),
      ttlEm: new Date(at.getTime() + PRODUCT_LIMITS.confirmacaoTtlHoras * 3600_000).toISOString(),
    };
    await deps.store.createPayment(p);
    return p;
  }

  async function confirmarPagamento(paymentId: string, by: string, confirmar: boolean) {
    const p = await deps.store.getPayment(paymentId);
    if (!p) throw new RegraVioladaError("pagamento inexistente", 404);
    if (p.declaredBy === by) throw new RegraVioladaError("quem declara não confirma (dupla confirmação)");
    if (p.status !== "declared") throw new RegraVioladaError(`estado ${p.status} não permite transição`);
    if (new Date(p.ttlEm).getTime() < now().getTime()) throw new RegraVioladaError("TTL de 72h expirado");
    await deps.store.updatePayment(paymentId, {
      status: confirmar ? "confirmed" : "disputed",
      confirmadoPor: confirmar ? by : null,
    });
    return deps.store.getPayment(paymentId);
  }

  /** RF-E05 — lembretes aos DOIS lados. */
  function lembretesVencimento(match: LoanMatchDto, vencimento: string): Array<{ para: string; msg: string }> {
    return [
      { para: match.requestUserId, msg: `Parcela de ${vencimento} vence em breve — regularize para manter sua escada (A4).` },
      { para: match.offerUserId, msg: `Parcela de ${vencimento} do seu empréstimo vence em breve — acompanhe a confirmação dupla.` },
    ];
  }

  return { publicarPedido, cardAnonimo, demonstrarInteresse, aceitarMatch, proporRodada, declararPagamento, confirmarPagamento, lembretesVencimento };
}

export type EmprestimosService = ReturnType<typeof makeEmprestimosService>;
