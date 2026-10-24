/**
 * Empréstimo — testes (plano.md §5). Casos de MESA com valores exatos
 * calculados externamente (não auto-referentes). RE4 = hash muda com 1 byte;
 * RE5 = fórmula impressa; A3 = sem V1 aprovada → erro 403; RE2 = aviso de usura.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  calcularEmprestimo,
  agendaParcelas,
  avisoUsura,
  MAX_PUBLISH_RATE_BPS,
} from "../src/emprestimos/calculadora.js";
import { emitirContrato, kitExecutivo, type ContratoInput } from "../src/emprestimos/contrato.js";
import {
  InMemoryVerificacaoStore,
  exigirV1,
  scoreConfianca,
  tetoPorNivel,
  V1NaoAprovadoError,
} from "../src/emprestimos/verificacao.js";

describe("RF-E03 — calculadora (3 casos de mesa com fórmula impressa)", () => {
  it("mesa 1 — juros simples: R$1.000, 2% a.m., 6m → juros R$120,00", () => {
    const r = calcularEmprestimo({ principalCents: 100_000, jurosMesBps: 200, meses: 6, jurosTipo: "simples" });
    expect(r.jurosCents).toBe(12_000);
    expect(r.totalCents).toBe(112_000);
    expect(r.formula).toContain("J = C × i × t");
    expect(r.formula).toContain("0.02"); // taxa declarada
  });

  it("mesa 2 — juros compostos: juros R$126,16 (1,02^6)", () => {
    const r = calcularEmprestimo({ principalCents: 100_000, jurosMesBps: 200, meses: 6, jurosTipo: "compostos" });
    expect(r.jurosCents).toBe(12_616);
    expect(r.totalCents).toBe(112_616);
  });

  it("mesa 3 — correção 1% a.m. + mora 0,5%/dia × 10d", () => {
    const r = calcularEmprestimo({
      principalCents: 100_000,
      jurosMesBps: 200,
      meses: 3,
      jurosTipo: "simples",
      correcaoTipo: "fixa",
      correcaoMesBps: 100,
      moraDiaBps: 50,
      diasAtraso: 10,
    });
    expect(r.jurosCents).toBe(6_000);
    expect(r.correcaoCents).toBe(3_212);
    expect(r.moraCents).toBe(5_461);
    expect(r.totalCents).toBe(114_673);
    expect(r.formula).toContain("Mora");
    expect(r.formula).toContain("Total = C + J + Corr + Mora");
  });

  it("agenda price: 6× R$178,53 com saldo zerando na última", () => {
    const a = agendaParcelas({ principalCents: 100_000, jurosMesBps: 200, meses: 6, jurosTipo: "compostos" }, 6);
    expect(a).toHaveLength(6);
    expect(a[0]!.valorCents).toBe(17_853);
    expect(a[0]!.saldoCents).toBe(84_147);
    expect(a[5]!.saldoCents).toBe(0);
    expect(new Set(a.map((x) => x.valorCents)).size).toBe(1); // parcela fixa
  });

  it("entrada inválida reprova (sem resultado mágico)", () => {
    expect(() => calcularEmprestimo({ principalCents: 0, jurosMesBps: 100, meses: 6, jurosTipo: "simples" })).toThrow();
    expect(() => calcularEmprestimo({ principalCents: 100, jurosMesBps: 100, meses: 0, jurosTipo: "simples" })).toThrow();
  });
});

describe("RE2 — aviso de usura (Lei 4.595/64 art. 4º §3º)", () => {
  it("acima do teto → aviso com a lei; no teto ou abaixo → null", () => {
    const aviso = avisoUsura(500, MAX_PUBLISH_RATE_BPS);
    expect(aviso).toContain("usura");
    expect(aviso).toContain("4.595/1964");
    expect(avisoUsura(400, MAX_PUBLISH_RATE_BPS)).toBeNull();
    expect(avisoUsura(100, MAX_PUBLISH_RATE_BPS)).toBeNull();
  });
});

describe("RE4 — contrato: hash muda com 1 byte; fórmula impressa (RE5)", () => {
  const base: ContratoInput = {
    numero: "2026/000123",
    versao: 1,
    partes: [
      { nome: "Credor", documento: "***.111.222-**", papel: "mutuante" },
      { nome: "Devedor", documento: "***.333.444-**", papel: "mutuario" },
    ],
    emprestimo: { principalCents: 100_000, jurosMesBps: 200, meses: 6, jurosTipo: "compostos" },
    resultado: calcularEmprestimo({ principalCents: 100_000, jurosMesBps: 200, meses: 6, jurosTipo: "compostos" }),
    dataAssinatura: "2026-10-23T12:00:00.000Z",
    vencimentos: ["2026-11-23", "2026-12-23", "2027-01-23", "2027-02-23", "2027-03-23", "2027-04-23"],
    observacoes: "cláusula padrão",
  };

  it("mesmo input → mesmo hash; 1 byte diferente → hash diferente", () => {
    const c1 = emitirContrato(base, "2026-10-23T12:00:00.000Z");
    const c2 = emitirContrato(base, "2026-10-23T12:00:00.000Z");
    expect(c1.sha256).toBe(c2.sha256); // determinístico

    const c3 = emitirContrato({ ...base, observacoes: "cláusula padrãp" }, "2026-10-23T12:00:00.000Z"); // 1 byte
    expect(c3.sha256).not.toBe(c1.sha256);
    expect(c3.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("contrato IMPRIME a fórmula (RE5) e a cláusula de liquidação (RE1)", () => {
    const c = emitirContrato(base, "2026-10-23T12:00:00.000Z");
    expect(c.texto).toContain("fórmula declarada");
    expect(c.texto).toContain(base.resultado.formula);
    expect(c.texto).toContain("NÃO transita pelo aplicativo");
    expect(c.texto).toContain("USDT/GRAM");
    expect(c.texto).toContain("SHA-256");
  });

  it("JUR-7 — kit executivo sai com o hash do contrato", () => {
    const c = emitirContrato(base, "2026-10-23T12:00:00.000Z");
    const k = kitExecutivo(c);
    expect(k.sha256Contrato).toBe(c.sha256);
    expect(k.itens.join(" ")).toContain("Notificação extrajudicial");
  });
});

describe("A3 — gate V1: sem aprovação NÃO passa", () => {
  it("403 quando V1 não aprovada; passa quando approved", async () => {
    const store = new InMemoryVerificacaoStore();
    await expect(exigirV1(store, "u1")).rejects.toBeInstanceOf(V1NaoAprovadoError);
    await store.setVerification({ userId: "u1", v1Status: "pending" });
    await expect(exigirV1(store, "u1")).rejects.toThrow(/V1/);
    await store.setVerification({ userId: "u1", v1Status: "approved", approvedAt: "2026-10-23T12:00:00.000Z" });
    await expect(exigirV1(store, "u1")).resolves.toBeUndefined();
  });

  it("score quente/fria: média dos sinais presentes; sem sinal → null (nunca inventar)", async () => {
    const store = new InMemoryVerificacaoStore();
    expect(await scoreConfianca(store, "u2")).toBeNull();
    await store.addSignal({ userId: "u2", kind: "serasa", value: 80, at: "2026-10-23T12:00:00.000Z" });
    await store.addSignal({ userId: "u2", kind: "device", value: 60, at: "2026-10-23T12:00:00.000Z" });
    expect(await scoreConfianca(store, "u2")).toBe(70);
  });

  it("A4 — escada: E1 = R$300,00; nível desconhecido não escala", () => {
    expect(tetoPorNivel("E1")).toBe(30_000);
    expect(tetoPorNivel("E5")).toBe(1_500_000);
    expect(tetoPorNivel("E9")).toBe(30_000); // fallback = E1 (conservador)
  });
});

describe("RE1 — Linha Vermelha BACEN: nenhuma rota move dinheiro (grep de arquitetura)", () => {
  it("fontes de empréstimos não contêm transferência de valores", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "emprestimos");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      // proibido: qualquer primitiva que mova dinheiro dentro do app
      expect(src).not.toMatch(/function\s+(transferir|enviarDinheiro|payOut|payout)\b/i);
      expect(src).not.toMatch(/\/api\/(pay|pagamento)s?\/(transfer|enviar|pix)/i);
    }
  });
});

// ---------------------------------------------------------------------------
import { InMemoryLoanStore, makeEmprestimosService, PRODUCT_LIMITS, RegraVioladaError } from "../src/emprestimos/service.js";

describe("doc 03 §3.3 — match anônimo, 72h, 3 rodadas, teto do par", () => {
  function svc(t0 = "2026-10-23T12:00:00.000Z") {
    let t = new Date(t0);
    const store = new InMemoryLoanStore();
    let n = 0;
    const s = makeEmprestimosService({ store, now: () => t, novoId: (p) => `${p}${++n}` });
    return { s, store, avancar: (h: number) => (t = new Date(t.getTime() + h * 3600_000)) };
  }

  it("card anônimo NÃO expõe userId nem motivo", async () => {
    const { s } = svc();
    const req = await s.publicarPedido("devedor1", { uf: "MT", valorCents: 50_000, jurosMesBps: 300, meses: 6, jurosTipo: "simples", motivo: "conta de luz" });
    const card = s.cardAnonimo(req);
    expect(JSON.stringify(card)).not.toContain("devedor1");
    expect(JSON.stringify(card)).not.toContain("conta de luz");
    expect(card.valorCents).toBe(50_000);
  });

  it("RE2 — publicação acima de 4% a.m. carrega o aviso de usura", async () => {
    const { s } = svc();
    const r = await s.publicarPedido("d1", { uf: "MT", valorCents: 50_000, jurosMesBps: 500, meses: 6, jurosTipo: "simples", motivo: "x" });
    expect(r.avisoUsura).toContain("usura");
    const ok = await s.publicarPedido("d2", { uf: "MT", valorCents: 50_000, jurosMesBps: 400, meses: 6, jurosTipo: "simples", motivo: "x" });
    expect(ok.avisoUsura).toBeNull();
  });

  it("match expira em 72h; rodada depois disso → erro", async () => {
    const { s, avancar } = svc();
    const req = await s.publicarPedido("d1", { uf: "MT", valorCents: 50_000, jurosMesBps: 300, meses: 6, jurosTipo: "simples", motivo: "x" });
    const m = await s.demonstrarInteresse("credor1", req.id);
    expect(new Date(m.expiraEm).getTime() - new Date(m.createdAt).getTime()).toBe(72 * 3600_000);
    avancar(73);
    await expect(s.proporRodada(m.id, "credor1", "6x com carência")).rejects.toThrow(/expirado/);
  });

  it("próprio dono não dá match; máx. 3 rodadas", async () => {
    const { s } = svc();
    const req = await s.publicarPedido("d1", { uf: "MT", valorCents: 50_000, jurosMesBps: 300, meses: 6, jurosTipo: "simples", motivo: "x" });
    await expect(s.demonstrarInteresse("d1", req.id)).rejects.toThrow(/próprio/);
    const m = await s.demonstrarInteresse("c1", req.id);
    await s.proporRodada(m.id, "c1", "p1");
    await s.proporRodada(m.id, "d1", "p2");
    await s.proporRodada(m.id, "c1", "p3");
    await expect(s.proporRodada(m.id, "d1", "p4")).rejects.toThrow(/3 rodadas/);
  });

  it("só o dono aceita; aceito é pré-requisito do pagamento", async () => {
    const { s } = svc();
    const req = await s.publicarPedido("d1", { uf: "MT", valorCents: 50_000, jurosMesBps: 300, meses: 6, jurosTipo: "simples", motivo: "x" });
    const m = await s.demonstrarInteresse("c1", req.id);
    await expect(s.aceitarMatch(m.id, "c1")).rejects.toThrow(/dono do pedido/);
    await expect(s.declararPagamento(m.id, "d1", 25_000)).rejects.toThrow(/match aceito/);
    const aceito = await s.aceitarMatch(m.id, "d1");
    expect(aceito!.status).toBe("aceito");
  });

  it("RF-E06 — dupla confirmação: declared→confirmed; quem declara não confirma; disputa transita", async () => {
    const { s, avancar } = svc();
    const req = await s.publicarPedido("d1", { uf: "MT", valorCents: 50_000, jurosMesBps: 300, meses: 6, jurosTipo: "simples", motivo: "x" });
    const m = await s.demonstrarInteresse("c1", req.id);
    await s.aceitarMatch(m.id, "d1");
    const p = await s.declararPagamento(m.id, "d1", 25_000);
    expect(p.status).toBe("declared");
    await expect(s.confirmarPagamento(p.id, "d1", true)).rejects.toThrow(/quem declara não confirma/);
    const conf = await s.confirmarPagamento(p.id, "c1", true);
    expect(conf!.status).toBe("confirmed");
    expect(conf!.confirmadoPor).toBe("c1");

    const p2 = await s.declararPagamento(m.id, "d1", 10_000);
    const disp = await s.confirmarPagamento(p2.id, "c1", false);
    expect(disp!.status).toBe("disputed");

    const p3 = await s.declararPagamento(m.id, "d1", 5_000);
    avancar(73);
    await expect(s.confirmarPagamento(p3.id, "c1", true)).rejects.toThrow(/TTL/);
  });

  it("RF-E05 — lembrete vai para OS DOIS lados", async () => {
    const { s } = svc();
    const req = await s.publicarPedido("d1", { uf: "MT", valorCents: 50_000, jurosMesBps: 300, meses: 6, jurosTipo: "simples", motivo: "x" });
    const m = await s.demonstrarInteresse("c1", req.id);
    const lembretes = s.lembretesVencimento(m, "2026-11-23");
    expect(lembretes.map((l) => l.para).sort()).toEqual(["c1", "d1"]);
  });
});

// ---------------------------------------------------------------------------
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { signInitData } from "../src/security/telegram-initdata.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";

describe("HTTP — /api/loan-requests (A3: 403 sem V1)", () => {
  const BOT = "123456789:TEST_TOKEN_AAA-BBB";

  const verificacao = new InMemoryVerificacaoStore();
  function makeApp() {
    const config = loadConfig({
      BOT_TOKEN: BOT,
      JWT_SECRET: "test-secret-0123456789abcdef",
      PUSHINPAY_WEBHOOK_SECRET: "whsec",
      NODE_ENV: "test",
      ADMIN_TOKEN: "adm-tok",
    } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
      emprestimos: { store: new InMemoryLoanStore(), verificacao },
    });
  }

  async function token(app: ReturnType<typeof makeApp>, id = 9): Promise<string> {
    const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id, first_name: "E" }) }, BOT);
    const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
    return res.json().token as string;
  }

  it("401 sem token; 403 sem V1; 201 com V1; feed anônimo; dupla confirmação por HTTP", async () => {
    const app = makeApp();
    expect((await app.inject({ method: "POST", url: "/api/loan-requests", payload: {} })).statusCode).toBe(401);

    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };
    const payload = { uf: "MT", valorCents: 50_000, jurosMesBps: 300, meses: 6, jurosTipo: "simples", motivo: "reforma da casa" };

    const semV1 = await app.inject({ method: "POST", url: "/api/loan-requests", headers: H, payload });
    expect(semV1.statusCode).toBe(403); // A3

    await verificacao.setVerification({ userId: "9", v1Status: "approved", approvedAt: "2026-10-23T12:00:00.000Z" });

    const ok = await app.inject({ method: "POST", url: "/api/loan-requests", headers: H, payload });
    expect(ok.statusCode).toBe(201);
    const pedidoId = ok.json().pedido.id;

    const feed = await app.inject({ method: "GET", url: "/api/feed/emprestimos?uf=MT", headers: H });
    expect(feed.json().cards[0].id).toBe(pedidoId);
    expect(JSON.stringify(feed.json().cards)).not.toContain('"userId"'); // anônimo: sem campo de usuário
    expect(JSON.stringify(feed.json().cards)).not.toContain("\"reforma\"");
    expect(JSON.stringify(feed.json().cards)).not.toContain("reforma");

    const t2 = await token(app, 77);
    const H2 = { authorization: `Bearer ${t2}` };
    const inter = await app.inject({ method: "POST", url: `/api/loan-requests/${pedidoId}/interesse`, headers: H2, payload: {} });
    expect(inter.statusCode).toBe(201);
    const matchId = inter.json().match.id;

    const aceitarDe = await app.inject({ method: "POST", url: `/api/loan-matches/${matchId}/aceitar`, headers: H2, payload: {} });
    expect(aceitarDe.statusCode).toBe(422); // só o dono

    const aceitar = await app.inject({ method: "POST", url: `/api/loan-matches/${matchId}/aceitar`, headers: H, payload: {} });
    expect(aceitar.statusCode).toBe(200);

    const decl = await app.inject({ method: "POST", url: "/api/payments/declare", headers: H, payload: { matchId, valorCents: 25_000 } });
    expect(decl.statusCode).toBe(201);
    const paymentId = decl.json().pagamento.id;

    const confirmErr = await app.inject({ method: "POST", url: "/api/payments/confirm", headers: H, payload: { paymentId, confirmar: true } });
    expect(confirmErr.statusCode).toBe(422); // quem declara não confirma

    const conf = await app.inject({ method: "POST", url: "/api/payments/confirm", headers: H2, payload: { paymentId, confirmar: true } });
    expect(conf.json().pagamento.status).toBe("confirmed");
    await app.close();
  });
});
