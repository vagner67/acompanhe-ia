/**
 * Assistente jurídico conversacional — testes (plano-assistente-juridico.md §6).
 * Motor GROUNDED: fixture REAL DataJud 23/10/2026 (tjmt; 94 movimentos) ×
 * tabela oficial CNJ × glossário com base legal. Regra de ouro: toda resposta
 * tem rodapé; nenhuma resposta inventa dado do processo; fora do escopo =
 * fallback honesto.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { responderPergunta, resumoProcesso, explicarMovimentoGrounded, fmtBrl, type PerguntaCtx } from "../src/juridico/assistente.js";
import { mapDoc, InMemoryLegalStore, makeJuridicoService, RODAPE_INFORMATIVO, SIGILO_MSG } from "../src/juridico/service.js";
import { nomeMovimentoCnj, TABELA_MOVIMENTOS_CNJ } from "../src/juridico/tabela-movimentos.js";
import { EXPLICACOES_MOVIMENTO } from "../src/juridico/glossario.js";
import { InMemoryAlertSink, alertDedupeKey } from "../src/jobs/dispatcher.js";
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { InMemoryEntitlementsStore } from "../src/entitlements.js";
import { signInitData } from "../src/security/telegram-initdata.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";
import type { DatajudDoc, LegalEventDto } from "../src/juridico/types.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const capture = JSON.parse(readFileSync(join(dir, "datajud-capture.json"), "utf8")) as { hit: DatajudDoc };
const REAL = capture.hit;

function ctxDe(doc: DatajudDoc = REAL): PerguntaCtx {
  const caso = mapDoc(doc, "tjmt");
  const movimentos: LegalEventDto[] = (doc.movimentos ?? []).map((m) => ({
    numeroProcesso: doc.numeroProcesso,
    codigo: m.codigo,
    nome: m.nome,
    dataHora: m.dataHora,
    tribunal: "tjmt",
  }));
  return { caso, movimentos };
}

const CTX = ctxDe();

describe("tabela oficial CNJ (grounding)", () => {
  it("975 códigos literais; 26=Distribuição, 51=Conclusão, 60=Expedição de documento", () => {
    expect(Object.keys(TABELA_MOVIMENTOS_CNJ).length).toBeGreaterThanOrEqual(900);
    expect(nomeMovimentoCnj(26)).toBe("Distribuição");
    expect(nomeMovimentoCnj(51)).toBe("Conclusão");
    expect(nomeMovimentoCnj(60)).toBe("Expedição de documento");
    expect(nomeMovimentoCnj(999999)).toBeNull();
  });
});

describe("motor grounded — intenções com dados REAIS da fixture", () => {
  it("toda resposta sai com o rodapé RF-B08 e nunca parece parecer", () => {
    const perguntas = [
      "qual o status?",
      "qual o valor da causa?",
      "quais os movimentos?",
      "o que significa distribuição?",
      "resuma o processo",
      "quando foi ajuizado?",
      "quais prazos devo observar?",
      "e agora, qual o próximo passo?",
      "onde tramita o processo?",
      "posso falar com advogado?",
      "como configurar alertas?",
      "isso é sigiloso?",
      "qual o sentido da vida?",
    ];
    for (const p of perguntas) {
      const r = responderPergunta(p, CTX);
      expect(r.rodape).toBe(RODAPE_INFORMATIVO);
      expect(r.resposta.toLowerCase()).not.toMatch(/(meu|nosso) parecer/);
      expect(r.resposta.toLowerCase()).not.toMatch(/recomendo ajuizar|garanto que|com certeza o juiz/);
    }
  });

  it("resumo cita dados REAIS: classe do doc, órgão, data e último movimento", () => {
    const r = responderPergunta("resuma o processo", CTX);
    expect(r.intencao).toBe("resumo");
    expect(r.resposta).toContain(REAL.classe.nome.toLowerCase());
    expect(r.resposta).toContain("2014"); // dataAjuizamento real
    expect(r.resposta).toContain(CTX.caso.ultimoMovimento!.nome);
  });

  it("status descreve a situação derivada dos movimentos reais", () => {
    const r = responderPergunta("qual o status do processo agora?", CTX);
    expect(r.intencao).toBe("status");
    expect(r.resposta).toContain(CTX.caso.status.toUpperCase());
    expect(r.fontes.join(" ")).toContain("DataJud");
  });

  it("último movimento: nome, data real e explicação grounded", () => {
    const r = responderPergunta("o que aconteceu por último?", CTX);
    const ult = [...CTX.movimentos].sort((a, b) => (a.dataHora < b.dataHora ? 1 : -1))[0]!;
    expect(r.resposta).toContain(ult.nome);
    expect(r.resposta).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it("movimento 51 (Conclusão) → explicação curada com base citada", () => {
    const r = responderPergunta("o que significa o movimento Conclusão?", CTX);
    expect(r.intencao).toBe("explicar_movimento");
    expect(r.resposta).toContain("juízo");
    expect(r.resposta + r.fontes.join(" ")).toMatch(/CPC|CNJ|Tabela|Res\./);
  });

  it("movimento FORA do glossário → usa nome oficial da tabela e admite falta de detalhe (nunca inventa)", () => {
    const exp = explicarMovimentoGrounded("Movimento exótico qualquer", 60140);
    expect(exp.explicacao).toContain("Não tenho uma explicação detalhada");
    expect(exp.explicacao).toContain("tabela do CNJ");
    expect(exp.explicacao).toContain("advogado");
  });

  it("valor: cita o valor real formatado e explica o que NÃO significa", () => {
    const r = responderPergunta("qual o valor da causa?", CTX);
    expect(r.intencao).toBe("valor");
    if (CTX.caso.valorDaCausa != null) {
      expect(r.resposta).toContain(fmtBrl(CTX.caso.valorDaCausa));
      expect(r.resposta).toMatch(/não significa|não informado/);
    } else {
      expect(r.resposta.toLowerCase()).toContain("não há valor");
      expect(r.resposta).toContain("petição inicial");
    }
  });

  it("prazos: nunca afirma prazo processual como certo — aponta intimação/DJEN e base", () => {
    const r = responderPergunta("quais prazos devo observar?", CTX);
    expect(r.resposta).toContain("DJEN");
    expect(r.resposta.toLowerCase()).not.toMatch(/seu prazo vence em \d/);
  });

  it("fallback honesto para pergunta fora do escopo — e sugere advogado", () => {
    const r = responderPergunta("qual o sentido da vida?", CTX);
    expect(r.intencao).toBe("fallback");
    expect(r.resposta).toContain("Não consegui fundamentar");
    expect(r.resposta).toContain("advogado");
  });

  it("sigilo > 0 → só SIGILO_MSG, sem vazar classe/movimentos", () => {
    const sigiloso = ctxDe({ ...REAL, nivelSigilo: 3 });
    const r = responderPergunta("resuma o processo", sigiloso);
    expect(r.resposta).toContain(SIGILO_MSG);
    expect(r.resposta).not.toContain(REAL.classe.nome);
  });

  it("resumoProcesso é o mesmo texto usado pelo card (fonte única)", () => {
    expect(resumoProcesso(CTX)).toContain(REAL.classe.nome.toLowerCase());
  });
});

describe("RF-B04 — alertas de movimentação (pipeline real)", () => {
  it("sync com alertasAtivos emite novo_movimento; sem o flag NÃO emite; dedupe por janela", async () => {
    const sink = new InMemoryAlertSink();
    const store = new InMemoryLegalStore();
    let doc: DatajudDoc = REAL;
    const svc = makeJuridicoService({ store, alertSink: sink, datajud: async () => [doc] });
    const CNJ = "0006903-69.2014.8.11.0037";
    // u1 — flag OFF: sincroniza tudo, NENHUM alerta
    await svc.acompanhar("u1", CNJ, "outro", "tjmt");
    await svc.sincronizar("u1", CNJ, "tjmt");
    expect((await sink.list("u1", "novo_movimento")).length).toBe(0);
    // u2 — flag ON desde o início: primeira sincronização emite o alerta
    await svc.acompanhar("u2", CNJ, "outro", "tjmt");
    await store.updateCase("u2", CNJ, { alertasAtivos: true });
    await svc.sincronizar("u2", CNJ, "tjmt");
    const alertas = await sink.list("u2", "novo_movimento");
    expect(alertas.length).toBe(1);
    expect(alertas[0]!.detail).toContain(CNJ);
    // movimento NOVO na fonte + sync de novo → emite, mas a janela horária deduplica
    const extra = { codigo: 9999, dataHora: "2026-10-24T12:00:00.000Z", nome: "Movimento Novo Teste" };
    doc = { ...REAL, movimentos: [...(REAL.movimentos ?? []), extra] };
    await svc.sincronizar("u2", CNJ, "tjmt");
    expect((await sink.list("u2", "novo_movimento")).length).toBe(1);
  });

  it("alertasAtivos sobrevive ao sync (mapDoc não zera o flag)", async () => {
    const store = new InMemoryLegalStore();
    const svc = makeJuridicoService({ store, datajud: async () => [REAL] });
    await svc.acompanhar("u1", "0006903-69.2014.8.11.0037", "outro", "tjmt");
    await store.updateCase("u1", "0006903-69.2014.8.11.0037", { alertasAtivos: true });
    await svc.sincronizar("u1", "0006903-69.2014.8.11.0037", "tjmt");
    const caso = await store.getCase("u1", "0006903-69.2014.8.11.0037");
    expect(caso!.alertasAtivos).toBe(true);
    expect(caso!.movimentosCount).toBeGreaterThan(0);
  });
});

describe("HTTP — buscar / perguntar / alertar", () => {
  const BOT = "123456789:TEST_TOKEN_AAA-BBB";
  const CNJ = "0006903-69.2014.8.11.0037";

  function makeApp() {
    const config = loadConfig({
      BOT_TOKEN: BOT,
      JWT_SECRET: "test-secret-0123456789abcdef",
      PUSHINPAY_WEBHOOK_SECRET: "whsec",
      NODE_ENV: "test",
      ADMIN_TOKEN: "adm-tok",
    } as NodeJS.ProcessEnv);
    const ents = new InMemoryEntitlementsStore();
    const app = buildApp({
      config,
      payments: new InMemoryPaymentStore(),
      pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
      juridico: { store: new InMemoryLegalStore(), oabVerified: new Set<string>(), datajud: async () => [REAL] },
      osint: { entitlements: ents },
    });
    return { app, ents };
  }

  async function login(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
    const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 42, first_name: "T" }) }, BOT);
    const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
    return res.json().token as string;
  }

  it("buscar: 403 sem plano; 200 com plano e NÃO cria caso; CNJ inválido → 422", async () => {
    const { app, ents } = makeApp();
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    expect((await app.inject({ method: "GET", url: `/api/processos/buscar?cnj=${CNJ}&alias=tjmt`, headers: H })).statusCode).toBe(403);
    await ents.grant("42", "juridica");
    const ok = await app.inject({ method: "GET", url: `/api/processos/buscar?cnj=${CNJ}&alias=tjmt`, headers: H });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.processo.classe).toBe(REAL.classe.nome);
    expect(body.movimentos.length).toBe(94);
    expect(body.resumo).toContain("2014");
    expect(body.rodape).toBe(RODAPE_INFORMATIVO);
    // NÃO registrou
    const lista = await app.inject({ method: "GET", url: "/api/processos", headers: H });
    expect(lista.json().processos.length).toBe(0);
    const inv = await app.inject({ method: "GET", url: `/api/processos/buscar?cnj=0006903-99.2014.8.11.0037&alias=tjmt`, headers: H });
    expect(inv.statusCode).toBe(422);
    await app.close();
  });

  it("perguntar: 403 sem plano; 200 grounded com plano (sem acompanhar — consulta live); resposta com rodapé", async () => {
    const { app, ents } = makeApp();
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    const paywalled = await app.inject({ method: "POST", url: `/api/processos/${CNJ}/perguntar`, headers: H, payload: { question: "qual o status?" } });
    expect(paywalled.statusCode).toBe(403);
    await ents.grant("42", "juridica");
    const r = await app.inject({ method: "POST", url: `/api/processos/${CNJ}/perguntar`, headers: H, payload: { question: "qual o status?" } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.acompanhado).toBe(false);
    expect(b.rodape).toBe(RODAPE_INFORMATIVO);
    expect(b.resposta).toContain(CTX.caso.status.toUpperCase());
    // pergunta curta demais → 422 (zod)
    expect((await app.inject({ method: "POST", url: `/api/processos/${CNJ}/perguntar`, headers: H, payload: { question: "?" } })).statusCode).toBe(422);
    await app.close();
  });

  it("alertar: 404 sem acompanhar; com caso liga o flag, emite confirmação e devolve histórico", async () => {
    const { app, ents } = makeApp();
    const t = await login(app);
    const H = { authorization: `Bearer ${t}` };
    await ents.grant("42", "juridica");
    const semCaso = await app.inject({ method: "POST", url: `/api/processos/${CNJ}/alertar`, headers: H, payload: {} });
    expect(semCaso.statusCode).toBe(404);
    expect(semCaso.json().error).toContain("acompanhe");
    await app.inject({ method: "POST", url: `/api/processos/${CNJ}/acompanhar`, headers: H, payload: {} });
    const ok = await app.inject({ method: "POST", url: `/api/processos/${CNJ}/alertar`, headers: H, payload: {} });
    expect(ok.statusCode).toBe(200);
    const b = ok.json();
    expect(b.alertasAtivos).toBe(true);
    expect(b.alertas.some((a: { detail: string }) => a.detail.includes("ativados"))).toBe(true);
    // GET reflete o flag persistido
    const caso = await app.inject({ method: "GET", url: `/api/processos/${CNJ}`, headers: H });
    expect(caso.json().processo.alertasAtivos).toBe(true);
    expect(caso.json().resumo.length).toBeGreaterThan(20);
    await app.close();
  });
});
