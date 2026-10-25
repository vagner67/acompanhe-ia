/**
 * AnotA — controle financeiro: domínio, rotas e backup.
 *
 * Três camadas testadas de propósito:
 *  1. funções puras (dinheiro, fatura, parcelamento, CSV/OFX) — determinísticas;
 *  2. rotas HTTP reais via `app.inject` (401, validação, isolamento por usuário);
 *  3. backup por e-mail com provedor injetado + o caso "sem provedor = 503".
 */
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { signInitData } from "../src/security/telegram-initdata.js";
import {
  exportarCsv,
  faturaCartao,
  importarCsv,
  ocorrenciasRecorrentes,
  orcamentoVsRealizado,
  parcelar,
  parseOfx,
  relatorioMensal,
  resumoMes,
  saldoConsolidado,
  saldoConta,
  ultimosMeses,
  valorParaCents,
  dataParaIso,
} from "../src/anota/dominio.js";
import { InMemoryAnotaStore } from "../src/anota/store.js";
import { InMemoryPaymentStore } from "../src/store.js";
import type { CartaoDto, ContaDto, LancamentoDto, OrcamentoDto } from "../src/anota/tipos.js";
import { criarZip, crc32 } from "../src/anota/zip.js";
import { emailValido, provedorDeEmail, type EmailProvider, type PedidoEmail } from "../src/anota/email.js";

const BOT = "123456789:TEST_TOKEN_AAA-BBB";

function conta(id: string, saldoInicialCents = 0): ContaDto {
  return { id, userId: "u1", nome: `conta ${id}`, tipo: "banco", saldoInicialCents, arquivada: false, criadaEm: "2026-01-01T00:00:00.000Z" };
}

function lanc(over: Partial<LancamentoDto> & { tipo: "despesa" | "receita"; amountCents: number; data: string }): LancamentoDto {
  return {
    id: over.id ?? `l-${Math.random().toString(36).slice(2, 8)}`,
    userId: "u1",
    tipo: over.tipo,
    amountCents: over.amountCents,
    description: over.description ?? "lançamento",
    category: over.category ?? "mercado",
    categoriaId: over.categoriaId ?? null,
    contaId: over.contaId ?? null,
    data: over.data,
    vencimento: over.vencimento ?? null,
    status: over.status ?? "pago",
    photoRef: null,
    ocrText: null,
    ocrEngine: null,
    parcelaDe: over.parcelaDe ?? null,
    parcelaNum: over.parcelaNum ?? null,
    parcelasTotal: over.parcelasTotal ?? null,
    recorrenteDe: over.recorrenteDe ?? null,
    fitId: over.fitId ?? null,
    origem: over.origem ?? "manual",
    createdAt: over.createdAt ?? `${over.data}T00:00:00.000Z`,
  };
}

describe("AnotA domínio — dinheiro sem float", () => {
  it("saldo da conta soma só o que foi pago; pendente não mexe no bolso", () => {
    const c = conta("c1", 10_000);
    const l = [
      lanc({ tipo: "receita", amountCents: 500_00, data: "2026-01-05", contaId: "c1" }),
      lanc({ tipo: "despesa", amountCents: 120_50, data: "2026-01-06", contaId: "c1" }),
      lanc({ tipo: "despesa", amountCents: 999_00, data: "2026-01-07", contaId: "c1", status: "pendente" }),
      lanc({ tipo: "despesa", amountCents: 50_00, data: "2026-01-08", contaId: "c2" }),
    ];
    expect(saldoConta(c, l)).toBe(10_000 + 50_000 - 12_050);
    expect(saldoConsolidado([c, conta("c2", 1_000)], l)).toBe(10_000 + 50_000 - 12_050 + 1_000 - 5_000);
  });

  it("resumo do mês separa receitas, despesas pagas e o que ainda vai sair", () => {
    const r = resumoMes(
      [
        lanc({ tipo: "receita", amountCents: 300_00, data: "2026-02-01", category: "salário" }),
        lanc({ tipo: "despesa", amountCents: 100_00, data: "2026-02-03", category: "mercado" }),
        lanc({ tipo: "despesa", amountCents: 50_00, data: "2026-02-10", category: "mercado" }),
        lanc({ tipo: "despesa", amountCents: 70_00, data: "2026-02-20", category: "lazer", status: "pendente" }),
        lanc({ tipo: "despesa", amountCents: 999_00, data: "2026-03-01", category: "mercado" }), // outro mês
      ],
      "2026-02",
    );
    expect(r.receitasCents).toBe(30_000);
    expect(r.despesasCents).toBe(15_000);
    expect(r.saldoCents).toBe(15_000);
    expect(r.apagarCents).toBe(7_000);
    expect(r.porCategoria.find((c) => c.categoria === "mercado")!.totalCents).toBe(15_000);
    expect(r.porCategoria.find((c) => c.categoria === "mercado")!.count).toBe(2);
  });

  it("mês inválido é erro explícito, não resultado vazio", () => {
    expect(() => resumoMes([], "2026-13")).toThrow(/mês inválido/);
  });

  it("orçamento: ok < 80% ≤ atenção ≤ 100% < estourou", () => {
    const orc: OrcamentoDto[] = [
      { id: "o1", userId: "u1", categoriaId: "cat1", ym: "2026-02", limiteCents: 100_00 },
      { id: "o2", userId: "u1", categoriaId: "cat2", ym: "2026-02", limiteCents: 100_00 },
      { id: "o3", userId: "u1", categoriaId: "cat3", ym: "2026-02", limiteCents: 100_00 },
    ];
    const ls = [
      lanc({ tipo: "despesa", amountCents: 50_00, data: "2026-02-02", categoriaId: "cat1", category: "mercado" }),
      lanc({ tipo: "despesa", amountCents: 85_00, data: "2026-02-02", categoriaId: "cat2", category: "lazer" }),
      lanc({ tipo: "despesa", amountCents: 120_00, data: "2026-02-02", categoriaId: "cat3", category: "transporte" }),
    ];
    const st = orcamentoVsRealizado(orc, ls, "2026-02");
    expect(st.map((s) => s.estado)).toEqual(["estourou", "atencao", "ok"]); // ordenado por pct
    expect(st[0]!.restanteCents).toBe(-20_00);
    expect(st[1]!.pct).toBe(85);
  });

  it("parcelamento fecha o total no centavo e não estoura o dia do mês", () => {
    const p = parcelar(100_00, 3, "2026-01-31");
    expect(p.map((x) => x.amountCents)).toEqual([33_33, 33_33, 33_34]);
    expect(p.reduce((s, x) => s + x.amountCents, 0)).toBe(100_00);
    expect(p.map((x) => x.vencimento)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(() => parcelar(0, 3, "2026-01-01")).toThrow();
    expect(() => parcelar(100, 49, "2026-01-01")).toThrow();
  });

  it("recorrência mensal projeta as ocorrências do período", () => {
    const oc = ocorrenciasRecorrentes({ data: "2026-01-10", amountCents: 120_00 }, "2026-04");
    expect(oc.map((o) => o.competencia)).toEqual(["2026-01-10", "2026-02-10", "2026-03-10", "2026-04-10"]);
    expect(oc.every((o) => o.amountCents === 12_000)).toBe(true);
  });

  it("relatório mês a mês calcula variação das despesas", () => {
    const ls = [
      lanc({ tipo: "despesa", amountCents: 100_00, data: "2026-01-05" }),
      lanc({ tipo: "despesa", amountCents: 150_00, data: "2026-02-05" }),
      lanc({ tipo: "receita", amountCents: 400_00, data: "2026-02-06" }),
    ];
    const r = relatorioMensal(ls, ["2026-01", "2026-02"]);
    expect(r[0]!.variacaoDespesaPct).toBeNull();
    expect(r[1]!.variacaoDespesaPct).toBe(50); // 100 → 150
    expect(r[1]!.saldoCents).toBe(40_000 - 15_000);
    expect(ultimosMeses("2026-02", 3)).toEqual(["2025-12", "2026-01", "2026-02"]);
  });

  it("fatura do cartão: ciclo até o fechamento e vencimento no mês certo", () => {
    const cartao: CartaoDto = { id: "k1", userId: "u1", contaId: "c1", nome: "Visa", limiteCents: 500_00, fechamentoDia: 25, vencimentoDia: 5 };
    const ls = [
      lanc({ tipo: "despesa", amountCents: 100_00, data: "2026-02-10", contaId: "c1" }),
      lanc({ tipo: "despesa", amountCents: 50_00, data: "2026-02-25", contaId: "c1", status: "pendente" }),
      lanc({ tipo: "despesa", amountCents: 999_00, data: "2026-02-26", contaId: "c1" }), // já é o próximo ciclo
      lanc({ tipo: "despesa", amountCents: 77_00, data: "2026-02-10", contaId: "outra" }), // outra conta
    ];
    const f = faturaCartao(cartao, ls, "2026-02");
    expect(f.fechaEm).toBe("2026-02-25");
    expect(f.venceEm).toBe("2026-03-05"); // vence depois de fechar → mês seguinte
    expect(f.totalCents).toBe(150_00);
    expect(f.pagoCents).toBe(100_00);
    expect(f.abertoCents).toBe(50_00);
    expect(f.disponivelCents).toBe(500_00 - 50_00);
  });

  it("valor e data aceitam o formato brasileiro e o internacional", () => {
    expect(valorParaCents("1.234,56")).toBe(123_456);
    expect(valorParaCents("1234.56")).toBe(123_456);
    expect(valorParaCents("-R$ 42,50")).toBe(-4_250);
    expect(valorParaCents("abc")).toBeNull();
    expect(dataParaIso("31/12/2026")).toBe("2026-12-31");
    expect(dataParaIso("2026-12-31")).toBe("2026-12-31");
    expect(dataParaIso("31/02/2026")).toBeNull();
  });
});

describe("AnotA importação/exportação", () => {
  it("CSV com ponto e vírgula, aspas e valor pt-BR", () => {
    const csv = [
      "Data;Descrição;Valor;Categoria",
      '05/01/2026;"Mercado, do mês";-250,90;mercado',
      '10/01/2026;Salário;3000,00;salário',
      "sem data;;10,00;outros",
    ].join("\n");
    const r = importarCsv(csv);
    expect(r.linhas.length).toBe(2);
    expect(r.linhas[0]).toMatchObject({ tipo: "despesa", data: "2026-01-05", amountCents: 25_090, description: "Mercado, do mês" });
    expect(r.linhas[1]).toMatchObject({ tipo: "receita", amountCents: 300_000 });
    expect(r.erros.length).toBe(1);
    expect(r.erros[0]!.linha).toBe(4);
  });

  it("CSV sem cabeçalho usa a ordem data,descrição,valor", () => {
    const r = importarCsv("2026-01-05,Padaria,12.50");
    expect(r.linhas[0]).toMatchObject({ data: "2026-01-05", amountCents: 1_250, category: "outros" });
  });

  it("OFX SGML: lê STMTTRN, respeita o sinal e deduplica por FITID", () => {
    const ofx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-1250.00
<FITID>202601150001
<NAME>Aluguel janeiro
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260110
<TRNAMT>8500.00
<FITID>202601100002
<NAME>Pagamento cliente
<MEMO>nota 2048
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-1250.00
<FITID>202601150001
<NAME>Aluguel janeiro (repetido)
</STMTTRN>
</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;
    const r = parseOfx(ofx);
    expect(r.formato).toBe("sgml");
    expect(r.transacoes.length).toBe(2);
    expect(r.duplicadasNoArquivo).toBe(1);
    expect(r.transacoes[0]).toMatchObject({ fitId: "202601150001", data: "2026-01-15", valorCents: -125_000, descricao: "Aluguel janeiro" });
    expect(r.transacoes[1]).toMatchObject({ valorCents: 850_000, descricao: "Pagamento cliente" });
  });

  it("OFX 2.x em XML e transação sem FITID é descartada (nada inventado)", () => {
    const xml = `<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260203</DTPOSTED><TRNAMT>-42.50</TRNAMT><FITID>A1</FITID><NAME>Café</NAME></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260204</DTPOSTED><TRNAMT>-10.00</TRNAMT><NAME>sem id</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const r = parseOfx(xml);
    expect(r.formato).toBe("xml");
    expect(r.transacoes.length).toBe(1);
    expect(r.transacoes[0]).toMatchObject({ fitId: "A1", valorCents: -4_250 });
  });

  it("exportar CSV escreve cabeçalho e escapa aspas", () => {
    const csv = exportarCsv([lanc({ tipo: "despesa", amountCents: 1_234, data: "2026-01-02", description: 'Nota "fiscal"', category: "mercado" })]);
    expect(csv.split("\n")[0]).toContain("tipo,data,vencimento,status,descricao");
    expect(csv).toContain('"Nota ""fiscal"""');
    expect(csv).toContain("12.34");
  });
});

describe("AnotA importação — reimportar o mesmo arquivo não duplica", () => {
  it("CSV com coluna fitid expõe o identificador de cada linha", () => {
    const r = importarCsv(["data,descricao,valor,fitid", "2026-10-20,Padaria,-18.50,ABC123", "2026-10-21,Feira,-42.00,"].join("\n"));
    expect(r.linhas.length).toBe(2);
    expect(r.linhas[0]!.fitId).toBe("ABC123");
    expect(r.linhas[1]!.fitId).toBeNull();
  });

  it("CSV sem fitid ainda importa, com fitId nulo (chave fica para a rota)", () => {
    const r = importarCsv(["data;descricao;valor", "2026-10-20;Padaria;-18,50"].join("\n"));
    expect(r.linhas[0]!.fitId).toBeNull();
    expect(r.linhas[0]!.amountCents).toBe(1850);
  });

  it("rota /importar: 1ª vez importa, 2ª ignora (fitid do arquivo)", async () => {
    const { app } = makeApp();
    const t = await token(app);
    const H = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    const csv = ["data,descricao,valor,fitid", "2026-10-20,Padaria,-18.50,FIT-A", "2026-10-21,Feira,-42.00,FIT-B"].join("\n");
    const r1 = await app.inject({ method: "POST", url: "/api/anota/importar", headers: H, payload: { formato: "csv", conteudo: csv } });
    expect(r1.json().importados).toBe(2);
    const r2 = await app.inject({ method: "POST", url: "/api/anota/importar", headers: H, payload: { formato: "csv", conteudo: csv } });
    expect(r2.json().importados).toBe(0);
    expect(r2.json().ignorados).toBe(2);
  });

  it("rota /importar: CSV sem fitid usa chave natural e não engole repetição legítima", async () => {
    const { app } = makeApp();
    const t = await token(app);
    const H = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    // dois cafés iguais no mesmo dia são dois lançamentos de verdade
    const csv = ["data;descricao;valor", "2026-10-20;Café;-4,50", "2026-10-20;Café;-4,50"].join("\n");
    const r1 = await app.inject({ method: "POST", url: "/api/anota/importar", headers: H, payload: { formato: "csv", conteudo: csv } });
    expect(r1.json().importados).toBe(2);
    const r2 = await app.inject({ method: "POST", url: "/api/anota/importar", headers: H, payload: { formato: "csv", conteudo: csv } });
    expect(r2.json().importados).toBe(0);
    expect(r2.json().ignorados).toBe(2);
    const lista = await app.inject({ method: "GET", url: "/api/anota/lancamentos?ym=2026-10", headers: H });
    expect(lista.json().lancamentos.length).toBe(2);
  });
});

describe("AnotA — ZIP do backup", () => {
  it("gera um ZIP com assinatura PK, CRC correto e entradas na pasta central", () => {
    const zip = criarZip([
      { nome: "a.txt", conteudo: "olá" },
      { nome: "b.json", conteudo: '{"x":1}' },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from("PK\x05\x06", "binary"))).toBe(true);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(2); // total de entradas
    expect(crc32(Buffer.from("olá"))).toBe(crc32(Buffer.from("olá")));
    expect(crc32(Buffer.from("a"))).not.toBe(crc32(Buffer.from("b")));
  });
});

describe("AnotA e-mail — provedor honesto", () => {
  it("valida endereço sem adivinhar", () => {
    expect(emailValido("fulano@exemplo.com.br")).toBe(true);
    expect(emailValido("fulano@exemplo")).toBe(false);
    expect(emailValido("fulano exemplo.com")).toBe(false);
    expect(emailValido("@exemplo.com")).toBe(false);
  });

  it("sem SMTP/RESEND configurado não existe provedor (nem 'enviado' falso)", () => {
    expect(provedorDeEmail({})).toBeNull();
    const soUsuario = { SMTP_HOST: "smtp.x", SMTP_USER: "u" };
    expect(provedorDeEmail(soUsuario)).toBeNull(); // falta senha/from
    expect(provedorDeEmail({ SMTP_HOST: "smtp.x", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "a@b.co" })?.nome).toBe("smtp:smtp.x");
    expect(provedorDeEmail({ RESEND_API_KEY: "k", RESEND_FROM: "a@b.co" })?.nome).toBe("resend");
  });
});

// ───────────────────────────── rotas HTTP ─────────────────────────────

function makeApp(opts: { emailProvider?: EmailProvider | null } = {}) {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    NODE_ENV: "test",
    ADMIN_TOKEN: "adm-tok",
    PUBLIC_BASE_URL: "https://app.example",
  } as NodeJS.ProcessEnv);
  const store = new InMemoryAnotaStore();
  const app = buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    anota: { store, emailProvider: opts.emailProvider ?? null, env: {} },
  });
  return { app, store };
}

async function token(app: ReturnType<typeof makeApp>["app"], uid = 9): Promise<string> {
  const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: uid, first_name: "A" }) }, BOT);
  return (await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } })).json().token as string;
}

describe("AnotA rotas — fluxo real", () => {
  it("sem token: 401 em todas as rotas do módulo", async () => {
    const { app } = makeApp();
    for (const url of ["/api/anota/resumo", "/api/anota/lancamentos", "/api/anota/contas", "/api/anota/backup"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
  });

  it("cria conta, lança despesa e receita e vê o saldo refletido", async () => {
    const { app } = makeApp();
    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };

    const c = await app.inject({ method: "POST", url: "/api/anota/contas", headers: H, payload: { nome: "Nubank", tipo: "banco", saldoInicialCents: 100_00 } });
    expect(c.statusCode).toBe(201);
    const contaId = c.json().conta.id as string;

    const cat = await app.inject({ method: "GET", url: "/api/anota/categorias", headers: H });
    const mercado = cat.json().categorias.find((x: { nome: string }) => x.nome === "mercado");

    const d = await app.inject({ method: "POST", url: "/api/anota/lancamentos", headers: H, payload: { tipo: "despesa", amountCents: 30_00, description: "Feira", category: "mercado", categoriaId: mercado.id, contaId, data: "2026-02-03" } });
    expect(d.statusCode).toBe(201);
    expect(d.json().lancamento.categoriaId).toBe(mercado.id);

    const r = await app.inject({ method: "POST", url: "/api/anota/lancamentos", headers: H, payload: { tipo: "receita", amountCents: 500_00, description: "Salário", category: "salário", contaId, data: "2026-02-05" } });
    expect(r.statusCode).toBe(201);

    const contas = await app.inject({ method: "GET", url: "/api/anota/contas", headers: H });
    expect(contas.json().contas[0].saldoCents).toBe(100_00 + 500_00 - 30_00);
    expect(contas.json().saldoConsolidadoCents).toBe(570_00);
  });

  it("parcelamento pela rota grava N linhas cuja soma é o total", async () => {
    const { app, store } = makeApp();
    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };
    const res = await app.inject({
      method: "POST",
      url: "/api/anota/lancamentos",
      headers: H,
      payload: { tipo: "despesa", amountCents: 100_00, description: "Notebook", category: "outros", data: "2026-01-31", parcelas: 3, vencimento: "2026-01-31" },
    });
    expect(res.statusCode).toBe(201);
    const criados = res.json().lancamentos as Array<{ amountCents: number; parcelaNum: number; data: string; description: string }>;
    expect(criados.length).toBe(3);
    expect(criados.reduce((s, l) => s + l.amountCents, 0)).toBe(100_00);
    expect(criados.map((l) => l.data)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(criados[0]!.description).toContain("(1/3)");
    expect((await store.listarLancamentos("9")).length).toBe(3);
  });

  it("recorrência cria as ocorrências mensais pedidas", async () => {
    const { app } = makeApp();
    const t = await token(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/anota/lancamentos",
      headers: { authorization: `Bearer ${t}` },
      payload: { tipo: "despesa", amountCents: 120_00, description: "Aluguel", category: "aluguel", data: "2026-01-10", repeticoes: 3, status: "pendente" },
    });
    expect(res.statusCode).toBe(201);
    const criados = res.json().lancamentos as Array<{ data: string; status: string }>;
    expect(criados.map((c) => c.data)).toEqual(["2026-01-10", "2026-02-10", "2026-03-10"]);
    expect(criados.every((c) => c.status === "pendente")).toBe(true);
  });

  it("orçamento da rota aparece no resumo com estado", async () => {
    const { app } = makeApp();
    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };
    const cats = (await app.inject({ method: "GET", url: "/api/anota/categorias", headers: H })).json().categorias as Array<{ id: string; nome: string }>;
    const mercado = cats.find((c) => c.nome === "mercado")!;
    await app.inject({ method: "POST", url: "/api/anota/orcamentos", headers: H, payload: { categoriaId: mercado.id, ym: "2026-02", limiteCents: 100_00 } });
    await app.inject({ method: "POST", url: "/api/anota/lancamentos", headers: H, payload: { tipo: "despesa", amountCents: 90_00, description: "Compras", category: "mercado", categoriaId: mercado.id, data: "2026-02-10" } });
    const resumo = await app.inject({ method: "GET", url: "/api/anota/resumo?ym=2026-02", headers: H });
    expect(resumo.statusCode).toBe(200);
    const j = resumo.json();
    expect(j.resumo.despesasCents).toBe(90_00);
    expect(j.orcamentos[0]).toMatchObject({ limiteCents: 100_00, gastoCents: 90_00, restanteCents: 10_00, estado: "atencao" });
  });

  it("importação OFX pela rota deduplica o que já entrou", async () => {
    const { app } = makeApp();
    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };
    const ofx = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260210<TRNAMT>-88.90<FITID>X1<NAME>Farmácia</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260211<TRNAMT>1000.00<FITID>X2<NAME>Freela</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const primeira = await app.inject({ method: "POST", url: "/api/anota/importar", headers: H, payload: { formato: "ofx", conteudo: ofx } });
    expect(primeira.statusCode).toBe(200);
    expect(primeira.json().importados).toBe(2);

    const segunda = await app.inject({ method: "POST", url: "/api/anota/importar", headers: H, payload: { formato: "ofx", conteudo: ofx } });
    expect(segunda.json().importados).toBe(0);
    expect(segunda.json().ignorados).toBe(2);

    const ls = await app.inject({ method: "GET", url: "/api/anota/lancamentos", headers: H });
    expect((ls.json().lancamentos as unknown[]).length).toBe(2);
  });

  it("importação CSV reporta erro de linha sem inventar lançamento", async () => {
    const { app } = makeApp();
    const t = await token(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/anota/importar",
      headers: { authorization: `Bearer ${t}` },
      payload: { formato: "csv", conteudo: "data;descricao;valor\n2026-02-01;Ok;10,00\nxx/xx/2026;Ruim;5,00" },
    });
    expect(res.json().importados).toBe(1);
    expect(res.json().erros.length).toBe(1);
    expect(res.json().erros[0].linha).toBe(3);
  });

  it("cada usuário só enxerga o próprio dinheiro", async () => {
    const { app } = makeApp();
    const t9 = await token(app, 9);
    const t10 = await token(app, 10);
    await app.inject({ method: "POST", url: "/api/anota/lancamentos", headers: { authorization: `Bearer ${t9}` }, payload: { tipo: "despesa", amountCents: 10_00, description: "do 9", category: "outros", data: "2026-02-01" } });
    const do10 = await app.inject({ method: "GET", url: "/api/anota/lancamentos", headers: { authorization: `Bearer ${t10}` } });
    expect(do10.json().lancamentos).toEqual([]);
  });

  it("edição e exclusão de lançamento funcionam e respeitam o dono", async () => {
    const { app } = makeApp();
    const t9 = await token(app, 9);
    const t10 = await token(app, 10);
    const H9 = { authorization: `Bearer ${t9}` };
    const criado = await app.inject({ method: "POST", url: "/api/anota/lancamentos", headers: H9, payload: { tipo: "despesa", amountCents: 10_00, description: "café", category: "outros", data: "2026-02-01" } });
    const id = criado.json().lancamento.id as string;
    const editado = await app.inject({ method: "PUT", url: `/api/anota/lancamentos/${id}`, headers: H9, payload: { amountCents: 12_00, status: "pendente" } });
    expect(editado.json().lancamento).toMatchObject({ amountCents: 12_00, status: "pendente" });
    const outro = await app.inject({ method: "PUT", url: `/api/anota/lancamentos/${id}`, headers: { authorization: `Bearer ${t10}` }, payload: { amountCents: 1 } });
    expect(outro.statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/anota/lancamentos/${id}`, headers: H9 })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/anota/lancamentos/${id}`, headers: H9 })).statusCode).toBe(404);
  });

  it("validação: valor negativo, mês torto e categoria de outro usuário são recusados", async () => {
    const { app } = makeApp();
    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };
    const negativo = await app.inject({ method: "POST", url: "/api/anota/lancamentos", headers: H, payload: { tipo: "despesa", amountCents: -1, description: "x", data: "2026-02-01" } });
    expect(negativo.statusCode).toBe(422); // ZodError → 422 (handler do app)
    const mesTorto = await app.inject({ method: "GET", url: "/api/anota/resumo?ym=2026-13", headers: H });
    expect(mesTorto.statusCode).toBe(422);
    const orc = await app.inject({ method: "POST", url: "/api/anota/orcamentos", headers: H, payload: { categoriaId: "00000000-0000-4000-8000-000000000000", ym: "2026-02", limiteCents: 1000 } });
    expect(orc.statusCode).toBe(422);
  });

  it("apelidos antigos (/api/minhas/*) continuam respondendo no formato antigo", async () => {
    const { app } = makeApp();
    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };
    await app.inject({ method: "POST", url: "/api/anota/notas", headers: H, payload: { title: "lembrete", body: "pagar luz" } });
    await app.inject({ method: "POST", url: "/api/anota/lancamentos", headers: H, payload: { tipo: "despesa", amountCents: 42_00, description: "luz", category: "outros", data: "2026-02-01" } });

    const notas = await app.inject({ method: "GET", url: "/api/minhas/notas", headers: H });
    expect(notas.json().notas[0].title).toBe("lembrete");
    const gastos = await app.inject({ method: "GET", url: "/api/minhas/gastos?mes=2026-02", headers: H });
    expect(gastos.json().gastos[0]).toMatchObject({ description: "luz", spentAt: "2026-02-01", amountCents: 42_00 });
    const resumo = await app.inject({ method: "GET", url: "/api/minhas/resumo?mes=2026-02", headers: H });
    expect(resumo.json().resumo.totalCents).toBe(42_00);
    expect(resumo.json().totalCents).toBe(42_00); // cliente antigo lia assim
    const csv = await app.inject({ method: "GET", url: "/api/minhas/export.csv", headers: H });
    expect(csv.headers["content-type"]).toContain("text/csv");
  });
});

describe("AnotA backup por e-mail", () => {
  it("sem provedor: 503 com instrução e o ZIP continua baixável", async () => {
    const { app } = makeApp({ emailProvider: null });
    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };
    await app.inject({ method: "POST", url: "/api/anota/lancamentos", headers: H, payload: { tipo: "despesa", amountCents: 10_00, description: "x", category: "outros", data: "2026-02-01" } });

    const envio = await app.inject({ method: "POST", url: "/api/anota/backup", headers: H, payload: { email: "fulano@exemplo.com" } });
    expect(envio.statusCode).toBe(503);
    expect(envio.json().status).toBe("nao_configurado");
    expect(envio.json().instrucao).toContain("SMTP_HOST");

    const zip = await app.inject({ method: "GET", url: "/api/anota/backup/arquivo", headers: H });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers["content-type"]).toBe("application/zip");
    expect(zip.rawPayload.length).toBeGreaterThan(200);

    const estado = await app.inject({ method: "GET", url: "/api/anota/backup", headers: H });
    expect(estado.json()).toMatchObject({ envioConfigurado: false, emailSugerido: "fulano@exemplo.com" });
    expect(estado.json().historico[0].status).toBe("nao_configurado");
  });

  it("com provedor: envia o anexo ZIP e registra o envio", async () => {
    const enviados: PedidoEmail[] = [];
    const fake: EmailProvider = {
      nome: "fake-smtp",
      async enviar(p) {
        enviados.push(p);
        return { status: "enviado", provedor: "fake-smtp" };
      },
    };
    const { app } = makeApp({ emailProvider: fake });
    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };
    await app.inject({ method: "POST", url: "/api/anota/notas", headers: H, payload: { title: "nota", body: "conteúdo" } });

    const res = await app.inject({ method: "POST", url: "/api/anota/backup", headers: H, payload: { email: "Fulano@Exemplo.com" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "enviado", email: "fulano@exemplo.com", provedor: "fake-smtp" });
    expect(enviados.length).toBe(1);
    expect(enviados[0]!.para).toBe("fulano@exemplo.com");
    expect(enviados[0]!.anexo.nomeArquivo).toMatch(/^anota-backup-/);
    expect(enviados[0]!.anexo.conteudo.readUInt32LE(0)).toBe(0x04034b50); // ZIP de verdade
    expect(enviados[0]!.texto).toContain("MANIFEST.json");

    const estado = await app.inject({ method: "GET", url: "/api/anota/backup", headers: H });
    expect(estado.json().historico[0]).toMatchObject({ status: "enviado", provedor: "fake-smtp", email: "fulano@exemplo.com" });
  });

  it("e-mail inválido é 422 e provedor que falha vira 502 com o motivo", async () => {
    const falho: EmailProvider = { nome: "smtp:teste", async enviar() { return { status: "falhou", provedor: "smtp:teste", erro: "535 auth" }; } };
    const { app } = makeApp({ emailProvider: falho });
    const t = await token(app);
    const H = { authorization: `Bearer ${t}` };
    expect((await app.inject({ method: "POST", url: "/api/anota/backup", headers: H, payload: { email: "sem-arroba" } })).statusCode).toBe(422);
    const r = await app.inject({ method: "POST", url: "/api/anota/backup", headers: H, payload: { email: "a@b.com" } });
    expect(r.statusCode).toBe(502);
    expect(r.json().erro).toBe("535 auth");
  });
});

// ────────────── SMTP de verdade (servidor local) + Prisma/Postgres ──────────────

import { createServer, type Socket } from "node:net";
import { createDb } from "@acompanhe/db";
import { PrismaAnotaStore } from "../src/anota/prisma.js";

describe("AnotA e-mail — conversa SMTP real (sem mock de transporte)", () => {
  it("envia o anexo para um servidor SMTP local e o servidor recebe o ZIP", async () => {
    const recebidas: string[] = [];
    const servidor = createServer((socket: Socket) => {
      socket.setEncoding("utf8");
      let emDados = false;
      let buffer = "";
      socket.write("220 teste.local ESMTP\r\n");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\r\n")) >= 0) {
          const linha = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (emDados) {
            if (linha === ".") {
              emDados = false;
              recebidas.push("<<FIM>>");
              socket.write("250 2.0.0 Ok: mensagem aceita\r\n");
            } else {
              recebidas.push(linha);
            }
            continue;
          }
          recebidas.push(`CMD ${linha}`); // comandos do protocolo também importam
          const cmd = linha.split(" ")[0]!.toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") socket.write("250-teste.local\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
          else if (cmd === "AUTH") socket.write("235 2.7.0 Authentication successful\r\n");
          else if (cmd === "MAIL" || cmd === "RCPT") socket.write("250 2.1.0 Ok\r\n");
          else if (cmd === "DATA") {
            emDados = true;
            socket.write("354 Vá em frente\r\n");
          } else if (cmd === "QUIT") {
            socket.write("221 2.0.0 Bye\r\n");
            socket.end();
          } else socket.write("250 OK\r\n");
        }
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", () => ok()));
    const porta = (servidor.address() as { port: number }).port;

    try {
      const provedor = provedorDeEmail({
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(porta),
        SMTP_USER: "usuario",
        SMTP_PASS: "senha",
        SMTP_FROM: "anota@acompanhe.app",
        SMTP_TLS_INSECURE: "1",
      });
      expect(provedor).not.toBeNull();
      const zip = criarZip([{ nome: "MANIFEST.json", conteudo: '{"ok":true}' }]);
      const r = await provedor!.enviar({
        para: "fulano@exemplo.com",
        assunto: "Seu backup do AnotA",
        texto: "segue o backup",
        anexo: { nomeArquivo: "anota-backup.zip", conteudo: zip, contentType: "application/zip" },
      });
      expect(r).toEqual({ status: "enviado", provedor: `smtp:127.0.0.1` });
      const tudo = recebidas.join("\n");
      expect(tudo).toContain("CMD RCPT TO:<fulano@exemplo.com>");
      expect(tudo).toContain("CMD MAIL FROM:<anota@acompanhe.app>");
      expect(tudo).toContain("Subject: Seu backup do AnotA");
      expect(tudo).toContain("anota-backup.zip");
      expect(tudo).toContain("<<FIM>>");
    } finally {
      await new Promise<void>((ok) => servidor.close(() => ok()));
    }
  }, 20_000);
});

describe("AnotA Prisma — persistência real", () => {
  const URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/acompanhe_test";
  const vivo = (async () => {
    const db = createDb(URL);
    try {
      await db.$queryRaw`select 1`;
      return true;
    } catch {
      return false;
    } finally {
      await db.$disconnect();
    }
  })();

  it("grava e lê lançamentos em ordem cronológica, isolando por usuário", async () => {
    if (!(await vivo)) {
      console.warn("[anota] sem Postgres local — teste de persistência não executado");
      return;
    }
    const db = createDb(URL);
    const store = new PrismaAnotaStore(db);
    const uid = `anota_${Date.now() % 1_000_000}`;
    try {
      const cat = await store.criarCategoria({ id: crypto.randomUUID(), userId: uid, nome: "mercado", tipo: "despesa", cor: null, icone: null, arquivada: false });
      const conta = await store.criarConta({ id: crypto.randomUUID(), userId: uid, nome: "Carteira", tipo: "caixa", saldoInicialCents: 5_000, arquivada: false, criadaEm: new Date().toISOString() });
      const base = {
        userId: uid,
        description: "x",
        category: "mercado",
        categoriaId: cat.id,
        contaId: conta.id,
        vencimento: null,
        status: "pago" as const,
        photoRef: null,
        ocrText: null,
        ocrEngine: null,
        parcelaDe: null,
        parcelaNum: null,
        parcelasTotal: null,
        recorrenteDe: null,
        fitId: null,
        origem: "manual" as const,
        createdAt: new Date().toISOString(),
      };
      await store.criarLancamentos([
        { ...base, id: crypto.randomUUID(), tipo: "despesa", amountCents: 2_000, data: "2026-02-10" },
        { ...base, id: crypto.randomUUID(), tipo: "receita", amountCents: 9_000, data: "2026-02-01" },
      ]);
      const lista = await store.listarLancamentos(uid);
      expect(lista.map((l) => l.data)).toEqual(["2026-02-01", "2026-02-10"]); // ordem cronológica (contrato)
      expect(lista.map((l) => l.tipo)).toEqual(["receita", "despesa"]);
      expect(saldoConsolidado([conta], lista)).toBe(5_000 + 9_000 - 2_000);

      const outro = await store.listarLancamentos(`${uid}_outro`);
      expect(outro).toEqual([]);

      // orçamento com upsert: salvar duas vezes não duplica
      const o1 = await store.salvarOrcamento({ id: crypto.randomUUID(), userId: uid, categoriaId: cat.id, ym: "2026-02", limiteCents: 10_000 });
      await store.salvarOrcamento({ id: crypto.randomUUID(), userId: uid, categoriaId: cat.id, ym: "2026-02", limiteCents: 20_000 });
      const orcs = await store.listarOrcamentos(uid, "2026-02");
      expect(orcs.length).toBe(1);
      expect(orcs[0]!.limiteCents).toBe(20_000);
      expect(orcs[0]!.id).toBe(o1.id);

      // backup registrado
      await store.registrarBackup({ id: crypto.randomUUID(), userId: uid, email: "a@b.com", criadoEm: new Date().toISOString(), bytes: 10, itens: 2, status: "enviado", erro: null, provedor: "smtp:teste" });
      expect((await store.listarBackups(uid))[0]).toMatchObject({ status: "enviado", email: "a@b.com" });
    } finally {
      await db.gasto.deleteMany({ where: { userId: uid } });
      await db.anotaReceita.deleteMany({ where: { userId: uid } });
      await db.anotaOrcamento.deleteMany({ where: { userId: uid } });
      await db.anotaConta.deleteMany({ where: { userId: uid } });
      await db.anotaCategoria.deleteMany({ where: { userId: uid } });
      await db.anotaBackup.deleteMany({ where: { userId: uid } });
      await db.$disconnect();
    }
  }, 30_000);
});
