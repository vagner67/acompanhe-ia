/**
 * União AnotA × Empréstimo (25/10) — testes de fato, sem mock de dinheiro.
 *
 * Camadas: (1) ponte pura com valores conferidos na mão; (2) HTTP real via
 * `inject` com `LoanStore` + `AnotaStore` em memória; (3) idempotência pelo
 * `fitId`; (4) espelho automático no declare/confirm.
 */
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";
import { InMemoryLoanStore, type LoanMatchDto, type LoanRequestDto } from "../src/emprestimos/service.js";
import { InMemoryVerificacaoStore } from "../src/emprestimos/verificacao.js";
import { InMemoryAnotaStore } from "../src/anota/store.js";
import {
  CATEGORIA_EMPRESTIMO,
  contratoParaAnotA,
  fitIdParcela,
  lancamentoDoPagamento,
  lancamentosDoContrato,
  resumoContratos,
} from "../src/emprestimos/ponte-anota.js";
import type { PaymentDto } from "../src/emprestimos/service.js";
import { signInitData } from "../src/security/telegram-initdata.js";

const BOT = "123456:TEST-TOKEN-UNIAO-ANOTA";
const DEVEDOR = "9";
const CREDOR = "77";

function pedido(over: Partial<LoanRequestDto> = {}): LoanRequestDto {
  return {
    id: "req-1",
    userId: DEVEDOR,
    uf: "MT",
    valorCents: 100_000,
    jurosMesBps: 300, // 3% a.m.
    meses: 4,
    jurosTipo: "simples",
    motivo: "reforma do telhado",
    status: "aberta",
    createdAt: "2026-10-01T12:00:00.000Z",
    avisoUsura: null,
    ...over,
  };
}

function match(over: Partial<LoanMatchDto> = {}): LoanMatchDto {
  return {
    id: "match-1",
    requestId: "req-1",
    offerUserId: CREDOR,
    requestUserId: DEVEDOR,
    status: "aceito",
    rodadas: 1,
    createdAt: "2026-10-02T15:00:00.000Z",
    expiraEm: "2026-10-05T15:00:00.000Z",
    ...over,
  };
}

function pagamento(over: Partial<PaymentDto> = {}): PaymentDto {
  return {
    id: "pay-1",
    matchId: "match-1",
    valorCents: 28_000,
    declaredBy: DEVEDOR,
    confirmadoPor: null,
    status: "declared",
    declaredAt: "2026-11-02T10:00:00.000Z",
    ttlEm: "2026-11-05T10:00:00.000Z",
    ...over,
  };
}

describe("ponte — contrato aceito vira lançamento com número da calculadora", () => {
  it("R$ 1.000 em 4× a 3% a.m. (simples): total R$ 1.120 e parcelas somando exatamente isso", () => {
    const c = contratoParaAnotA(match(), pedido(), DEVEDOR);
    // conferido na mão: J = C × i × t = 100000 × 0,03 × 4 = 12000
    expect(c.jurosCents).toBe(12_000);
    expect(c.totalCents).toBe(112_000);
    expect(c.papel).toBe("devedor");
    expect(c.tipo).toBe("despesa");
    expect(c.parcelas).toHaveLength(4);
    expect(c.parcelas.reduce((s, p) => s + p.valorCents, 0)).toBe(112_000);
    expect(c.parcelaCents).toBe(28_000);
    // vencimentos mensais a partir da data do match (dado real, não "hoje")
    expect(c.parcelas.map((p) => p.vencimento)).toEqual(["2026-10-02", "2026-11-02", "2026-12-02", "2027-01-02"]);
    expect(c.parcelas.map((p) => p.fitId)).toEqual([
      fitIdParcela("match-1", 1),
      fitIdParcela("match-1", 2),
      fitIdParcela("match-1", 3),
      fitIdParcela("match-1", 4),
    ]);
  });

  it("o mesmo contrato pelo lado do credor é receita, com o mesmo total", () => {
    const c = contratoParaAnotA(match(), pedido(), CREDOR);
    expect(c.papel).toBe("credor");
    expect(c.tipo).toBe("receita");
    expect(c.totalCents).toBe(112_000);
  });

  it("quem não é parte do contrato não recebe contrato (erro, não número inventado)", () => {
    expect(() => contratoParaAnotA(match(), pedido(), "999")).toThrow(/não é parte/);
  });

  it("parcelas nascem pendentes e com categoria de empréstimo", () => {
    const c = contratoParaAnotA(match(), pedido(), DEVEDOR);
    const ls = lancamentosDoContrato(c, DEVEDOR);
    expect(ls).toHaveLength(4);
    expect(ls.every((l) => l.status === "pendente")).toBe(true);
    expect(ls.every((l) => l.origem === "emprestimo")).toBe(true);
    expect(ls.every((l) => l.category === CATEGORIA_EMPRESTIMO)).toBe(true);
    expect(ls[0]!.description).toBe("Empréstimo: reforma do telhado (1/4)");
    expect(ls[3]!.description).toBe("Empréstimo: reforma do telhado (4/4)");
    expect(ls[2]!.parcelaNum).toBe(3);
    expect(ls[2]!.parcelasTotal).toBe(4);
  });

  it("pagamento declarado é pendente; confirmado é pago (contestado segue pendente)", () => {
    const c = contratoParaAnotA(match(), pedido(), DEVEDOR);
    expect(lancamentoDoPagamento(c, pagamento(), DEVEDOR).status).toBe("pendente");
    expect(lancamentoDoPagamento(c, pagamento({ status: "confirmed" }), DEVEDOR).status).toBe("pago");
    expect(lancamentoDoPagamento(c, pagamento({ status: "disputed" }), DEVEDOR).status).toBe("pendente");
    expect(lancamentoDoPagamento(c, pagamento(), DEVEDOR).fitId).toBe("loan-pay:pay-1");
  });

  it("resumo: saldo em aberto desconta o que já foi confirmado", () => {
    const c = contratoParaAnotA(match(), pedido(), DEVEDOR);
    const r = resumoContratos([c], [], { "match-1": [pagamento({ status: "confirmed", valorCents: 28_000 })] });
    expect(r.contratos[0]!.pagoCents).toBe(28_000);
    expect(r.contratos[0]!.emAbertoCents).toBe(84_000);
    expect(r.aPagarCents).toBe(84_000);
    expect(r.aReceberCents).toBe(0);
  });
});

// ══════════════════════ HTTP: o fluxo inteiro ══════════════════════
function makeApp() {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "adm-tok",
  } as NodeJS.ProcessEnv);
  const verificacao = new InMemoryVerificacaoStore();
  const anotaStore = new InMemoryAnotaStore();
  const app = buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
    emprestimos: { store: new InMemoryLoanStore(), verificacao },
    anota: { store: anotaStore },
  });
  return { app, verificacao, anotaStore };
}

async function token(app: ReturnType<typeof makeApp>["app"], id: number): Promise<string> {
  const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id, first_name: "U" }) }, BOT);
  const r = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
  return r.json().token as string;
}

/** Cria pedido (devedor), interesse + aceite → match aceito. */
async function contratoAceito(ctx: ReturnType<typeof makeApp>) {
  const tDev = await token(ctx.app, Number(DEVEDOR));
  const tCre = await token(ctx.app, Number(CREDOR));
  const Hd = { authorization: `Bearer ${tDev}` };
  const Hc = { authorization: `Bearer ${tCre}` };
  await ctx.verificacao.setVerification({ userId: DEVEDOR, v1Status: "approved", approvedAt: "2026-10-01T12:00:00.000Z" });
  const ped = await ctx.app.inject({
    method: "POST",
    url: "/api/loan-requests",
    headers: Hd,
    payload: { uf: "MT", valorCents: 100_000, jurosMesBps: 300, meses: 4, jurosTipo: "simples", motivo: "reforma do telhado" },
  });
  expect(ped.statusCode).toBe(201);
  const requestId = ped.json().pedido.id as string;
  const inter = await ctx.app.inject({ method: "POST", url: `/api/loan-requests/${requestId}/interesse`, headers: Hc, payload: {} });
  expect(inter.statusCode).toBe(201);
  const matchId = inter.json().match.id as string;
  const aceite = await ctx.app.inject({ method: "POST", url: `/api/loan-matches/${matchId}/aceitar`, headers: Hd, payload: {} });
  expect(aceite.statusCode).toBe(200);
  return { matchId, requestId, Hd, Hc };
}

describe("HTTP — lançar contrato no AnotA", () => {
  it("contrato aceito aparece com papel, parcela e total; lançar cria N parcelas; repetir não duplica", async () => {
    const ctx = makeApp();
    const { matchId, Hd } = await contratoAceito(ctx);

    const lista = await ctx.app.inject({ method: "GET", url: "/api/anota/emprestimos", headers: Hd });
    expect(lista.statusCode).toBe(200);
    expect(lista.json().contratos).toHaveLength(1);
    const c = lista.json().contratos[0];
    expect(c.papel).toBe("devedor");
    expect(c.totalCents).toBe(112_000);
    expect(c.parcelaCents).toBe(28_000);
    expect(c.parcelasLancadas).toBe(0);

    const l1 = await ctx.app.inject({ method: "POST", url: `/api/anota/emprestimos/${matchId}/lancar`, headers: Hd, payload: {} });
    expect(l1.statusCode).toBe(201);
    expect(l1.json().criados).toBe(4);
    expect(l1.json().jaExistiam).toBe(0);

    const l2 = await ctx.app.inject({ method: "POST", url: `/api/anota/emprestimos/${matchId}/lancar`, headers: Hd, payload: {} });
    expect(l2.statusCode).toBe(200); // idempotente
    expect(l2.json().criados).toBe(0);
    expect(l2.json().jaExistiam).toBe(4);

    const lista2 = await ctx.app.inject({ method: "GET", url: "/api/anota/emprestimos", headers: Hd });
    expect(lista2.json().contratos[0].parcelasLancadas).toBe(4);
    expect(lista2.json().aPagarCents).toBe(112_000);

    // as parcelas entram no livro-caixa de verdade: aparecem em lançamentos e no resumo
    const lanc = await ctx.app.inject({ method: "GET", url: "/api/anota/lancamentos", headers: Hd });
    const meus = lanc.json().lancamentos.filter((l: { origem: string }) => l.origem === "emprestimo");
    expect(meus).toHaveLength(4);
    const resumo = await ctx.app.inject({ method: "GET", url: "/api/anota/resumo?ym=2026-10", headers: Hd });
    expect(resumo.json().resumo.apagarCents).toBeGreaterThanOrEqual(28_000);
    await ctx.app.close();
  });

  it("o credor vê o mesmo contrato como receita e lança as parcelas dele", async () => {
    const ctx = makeApp();
    const { matchId, Hc } = await contratoAceito(ctx);
    const lista = await ctx.app.inject({ method: "GET", url: "/api/anota/emprestimos", headers: Hc });
    expect(lista.json().contratos[0].papel).toBe("credor");
    expect(lista.json().aReceberCents).toBe(112_000);
    const l = await ctx.app.inject({ method: "POST", url: `/api/anota/emprestimos/${matchId}/lancar`, headers: Hc, payload: {} });
    expect(l.statusCode).toBe(201);
    expect(l.json().lancamentos.every((x: { tipo: string }) => x.tipo === "receita")).toBe(true);
    await ctx.app.close();
  });

  it("declarado NÃO mexe no AnotA; confirmado fecha a 1ª parcela nos dois livros", async () => {
    const ctx = makeApp();
    const { matchId, Hd, Hc } = await contratoAceito(ctx);

    // contrato lançado: 4 parcelas pendentes
    const lanc = await ctx.app.inject({ method: "POST", url: `/api/anota/emprestimos/${matchId}/lancar`, headers: Hd, payload: {} });
    expect(lanc.json().criados).toBe(4);

    const decl = await ctx.app.inject({ method: "POST", url: "/api/payments/declare", headers: Hd, payload: { matchId, valorCents: 28_000 } });
    expect(decl.statusCode).toBe(201);
    expect(decl.json().anotA.sincronizado).toBe(true);
    // declared é a palavra do pagador: o AnotA ainda não marca pago
    expect(decl.json().anotA.partes.every((p: { acao: string }) => p.acao === "sem-mudanca")).toBe(true);
    expect(String(decl.json().anotA.partes[0].motivo)).toContain("aguardando confirmação");
    const paymentId = decl.json().pagamento.id as string;

    const antes = await ctx.app.inject({ method: "GET", url: "/api/anota/lancamentos", headers: Hd });
    expect(antes.json().lancamentos.filter((l: { fitId: string }) => String(l.fitId).startsWith("loan:")).every((l: { status: string }) => l.status === "pendente")).toBe(true);

    const conf = await ctx.app.inject({ method: "POST", url: "/api/payments/confirm", headers: Hc, payload: { paymentId, confirmar: true } });
    expect(conf.statusCode).toBe(200);
    const dev = conf.json().anotA.partes.find((p: { papel: string }) => p.papel === "devedor");
    const cre = conf.json().anotA.partes.find((p: { papel: string }) => p.papel === "credor");
    expect(dev.acao).toBe("atualizado");
    expect(dev.viaParcela).toBe(true); // pagou a parcela, não criou linha paralela
    // o credor não lançou o contrato dele: o recebimento entra como linha própria (paga)
    expect(cre.acao).toBe("criado");
    expect(cre.viaParcela).toBe(false);

    const depois = await ctx.app.inject({ method: "GET", url: "/api/anota/lancamentos", headers: Hd });
    const parcela1 = depois.json().lancamentos.find((l: { fitId: string }) => l.fitId === `loan:${matchId}:1`);
    expect(parcela1.status).toBe("pago");
    const pendentes = depois.json().lancamentos.filter((l: { fitId: string }) => String(l.fitId).startsWith("loan:") && l.status === "pendente");
    expect(pendentes).toHaveLength(3);
    // sem número dobrado: nenhuma linha "loan-pay:" foi criada
    expect(depois.json().lancamentos.some((l: { fitId: string }) => String(l.fitId).startsWith("loan-pay:"))).toBe(false);

    const lista = await ctx.app.inject({ method: "GET", url: "/api/anota/emprestimos", headers: Hd });
    expect(lista.json().contratos[0].pagoCents).toBe(28_000);
    expect(lista.json().contratos[0].emAbertoCents).toBe(84_000);
    await ctx.app.close();
  });

  it("sem contrato lançado, o pagamento confirmado vira linha própria (paga)", async () => {
    const ctx = makeApp();
    const { matchId, Hd, Hc } = await contratoAceito(ctx);
    const decl = await ctx.app.inject({ method: "POST", url: "/api/payments/declare", headers: Hd, payload: { matchId, valorCents: 30_000 } });
    const paymentId = decl.json().pagamento.id as string;
    const conf = await ctx.app.inject({ method: "POST", url: "/api/payments/confirm", headers: Hc, payload: { paymentId, confirmar: true } });
    const dev = conf.json().anotA.partes.find((p: { papel: string }) => p.papel === "devedor");
    expect(dev.acao).toBe("criado");
    expect(dev.viaParcela).toBe(false);
    const lanc = await ctx.app.inject({ method: "GET", url: "/api/anota/lancamentos", headers: Hd });
    const linha = lanc.json().lancamentos.find((l: { fitId: string }) => l.fitId === `loan-pay:${paymentId}`);
    expect(linha.status).toBe("pago");
    expect(linha.amountCents).toBe(30_000);
    await ctx.app.close();
  });

  it("contrato pendente (não aceito) recusa lançamento com motivo escrito", async () => {
    const ctx = makeApp();
    const tDev = await token(ctx.app, Number(DEVEDOR));
    const tCre = await token(ctx.app, Number(CREDOR));
    const Hd = { authorization: `Bearer ${tDev}` };
    const Hc = { authorization: `Bearer ${tCre}` };
    await ctx.verificacao.setVerification({ userId: DEVEDOR, v1Status: "approved", approvedAt: "2026-10-01T12:00:00.000Z" });
    const ped = await ctx.app.inject({
      method: "POST",
      url: "/api/loan-requests",
      headers: Hd,
      payload: { uf: "MT", valorCents: 100_000, jurosMesBps: 300, meses: 4, jurosTipo: "simples", motivo: "reforma" },
    });
    const inter = await ctx.app.inject({ method: "POST", url: `/api/loan-requests/${ped.json().pedido.id}/interesse`, headers: Hc, payload: {} });
    const matchId = inter.json().match.id as string;

    const lista = await ctx.app.inject({ method: "GET", url: "/api/anota/emprestimos", headers: Hd });
    expect(lista.json().contratos).toHaveLength(0); // nada aceito ainda
    expect(lista.json().matchesTotal).toBe(1);

    const lancar = await ctx.app.inject({ method: "POST", url: `/api/anota/emprestimos/${matchId}/lancar`, headers: Hd, payload: {} });
    expect(lancar.statusCode).toBe(422);
    expect(String(lancar.json().error)).toContain("só contrato aceito");
    await ctx.app.close();
  });

  it("sem token → 401 nas três rotas da união", async () => {
    const ctx = makeApp();
    for (const [method, url] of [
      ["GET", "/api/anota/emprestimos"],
      ["POST", "/api/anota/emprestimos/match-1/lancar"],
      ["POST", "/api/anota/emprestimos/match-1/pagamentos/pay-1/lancar"],
    ] as const) {
      const r = await ctx.app.inject({ method, url, payload: {} });
      expect(r.statusCode).toBe(401);
    }
    await ctx.app.close();
  });
});
