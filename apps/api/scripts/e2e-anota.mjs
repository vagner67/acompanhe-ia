/**
 * E2E do AnotA —sobe a API DE VERDADE (dist/server.js) contra o Postgres local,
 * com um servidor SMTP também de verdade (socket TCP em 127.0.0.1), e exercita o
 * fluxo inteiro por HTTP:
 *
 *   login (initData assinado) → contas → categorias → lançamentos (à vista,
 *   parcelado, recorrente) → import CSV/OFX → resumo → orçamento → cartão+fatura
 *   → meta → relatório → export.csv → OCR (honesto) → backup por e-mail → ZIP
 *
 * O que NÃO existe aqui: mock de fetch, provider falso de e-mail, resposta
 * gravada em disco. Tudo passa por HTTP e por socket.
 *
 * Rodar:  node scripts/e2e-anota.mjs    (da pasta apps/api, depois de tsc -b)
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { signInitData } from "../dist/security/telegram-initdata.js";

const PORTA_API = 3917;
const PORTA_SMTP = 2526;
const BOT_TOKEN = "777000:E2E-TOKEN-DO-SCRIPT-DE-TESTE";
const API = `http://127.0.0.1:${PORTA_API}`;
const USA_BD = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/acompanhe";

const passos = [];
function ok(nome, detalhe) {
  passos.push({ nome, detalhe, ok: true });
  console.log(`  ✓ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
}
function falhou(nome, detalhe) {
  passos.push({ nome, detalhe, ok: false });
  console.error(`  ✗ ${nome} — ${detalhe}`);
}
async function passo(nome, fn) {
  try {
    const detalhe = await fn();
    ok(nome, detalhe);
    return detalhe;
  } catch (e) {
    falhou(nome, e instanceof Error ? e.message : String(e));
    return null;
  }
}
function exigir(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ————————————————————— SMTP de verdade (socket TCP) —————————————————————
const recebidas = [];
function subirSmtp() {
  return new Promise((resolve) => {
    const servidor = net.createServer((socket) => {
      let emDados = false;
      let buffer = "";
      let de = "";
      let para = [];
      socket.write("220 e2e.local ESMTP\r\n");
      socket.on("data", (pedaco) => {
        buffer += pedaco.toString("utf8");
        if (emDados) {
          const fim = buffer.indexOf("\r\n.\r\n");
          if (fim === -1) return;
          const corpo = buffer.slice(0, fim);
          recebidas.push({ de, para, corpo, bytes: Buffer.byteLength(corpo) });
          buffer = buffer.slice(fim + 5);
          emDados = false;
          socket.write("250 2.0.0 Ok: recebido\r\n");
          return;
        }
        while (buffer.includes("\r\n")) {
          const linha = buffer.slice(0, buffer.indexOf("\r\n"));
          buffer = buffer.slice(buffer.indexOf("\r\n") + 2);
          const cmd = linha.slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") socket.write("250-e2e.local\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
          else if (cmd === "AUTH") socket.write("235 2.7.0 autenticado\r\n");
          else if (cmd === "MAIL") {
            de = linha;
            socket.write("250 2.1.0 Ok\r\n");
          } else if (cmd === "RCPT") {
            para.push(linha);
            socket.write("250 2.1.5 Ok\r\n");
          } else if (cmd === "DATA") {
            emDados = true;
            socket.write("354 manda os dados\r\n");
          } else if (cmd === "QUIT") {
            socket.write("221 tchau\r\n");
            socket.end();
          } else socket.write("250 OK\r\n");
        }
      });
      socket.on("error", () => void 0);
    });
    servidor.listen(PORTA_SMTP, "127.0.0.1", () => resolve(servidor));
  });
}

// ————————————————————— API de verdade (processo filho) —————————————————————
function subirApi() {
  const filho = spawn(process.execPath, ["dist/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORTA_API),
      HOST: "127.0.0.1",
      DATABASE_URL: USA_BD,
      BOT_TOKEN,
      JWT_SECRET: "e2e-jwt-secret-com-mais-de-16-chars",
      ADMIN_TOKEN: "e2e-admin-token",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(PORTA_SMTP),
      SMTP_USER: "nao-usa@e2e.local",
      SMTP_PASS: "irrelevante",
      SMTP_FROM: "AnotA <anota@e2e.local>",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  filho.stdout.on("data", (d) => log.push(d.toString()));
  filho.stderr.on("data", (d) => log.push(d.toString()));
  return { filho, log };
}

async function esperarSaude(filho) {
  for (let i = 0; i < 120; i++) {
    if (filho.exitCode !== null) throw new Error(`API morreu no boot (código ${filho.exitCode})`);
    try {
      const r = await fetch(`${API}/health`);
      if (r.ok) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("API não respondeu /health em 30 s");
}

let token = "";
async function http(method, caminho, corpo, bruto = false) {
  const r = await fetch(`${API}${caminho}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(corpo ? { "content-type": "application/json" } : {}) },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  });
  if (bruto) return { status: r.status, headers: r.headers, corpo: Buffer.from(await r.arrayBuffer()) };
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

async function main() {
  const smtp = await subirSmtp();
  console.log(`SMTP de teste ouvindo em 127.0.0.1:${PORTA_SMTP}`);
  const { filho, log } = subirApi();
  try {
    await esperarSaude(filho);
    console.log(`API de verdade no ar em ${API}\n`);

    const sufixo = Date.now();
    const userId = 900000000 + (sufixo % 100000);

    await passo("login por initData assinado", async () => {
      const initData = signInitData(
        { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "E2E", username: `e2e${sufixo}` }) },
        BOT_TOKEN,
      );
      const r = await fetch(`${API}/api/auth/telegram`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData }) });
      const j = await r.json();
      exigir(r.status === 200 && typeof j.token === "string", `login ${r.status}: ${JSON.stringify(j)}`);
      token = j.token;
      return `usuário ${userId}`;
    });
    exigir(token, "sem token não dá para continuar");

    const conta = await passo("criar conta bancária", async () => {
      const r = await http("POST", "/api/anota/contas", { nome: `Nubank E2E ${sufixo}`, tipo: "banco", saldoInicialCents: 250000 });
      exigir(r.status === 201, `status ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json.conta;
    });

    const cat = await passo("criar categoria personalizada", async () => {
      const r = await http("POST", "/api/anota/categorias", { nome: `Pets ${sufixo}`, tipo: "despesa" });
      exigir(r.status === 201, `status ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json.categoria;
    });

    await passo("lançamento à vista 5990", async () => {
      const r = await http("POST", "/api/anota/lancamentos", {
        tipo: "despesa", amountCents: 5990, description: "feira e2e", category: "mercado",
        categoriaId: cat?.id ?? null, contaId: conta?.id ?? null, data: "2026-10-05", status: "pago",
      });
      exigir(r.status === 201, `status ${r.status}: ${JSON.stringify(r.json)}`);
      return `id ${r.json.lancamento.id.slice(0, 8)}`;
    });

    await passo("compra parcelada 100000 em 3x (soma exata)", async () => {
      const r = await http("POST", "/api/anota/lancamentos", {
        tipo: "despesa", amountCents: 100000, description: "geladeira e2e", category: "casa",
        contaId: conta?.id ?? null, data: "2026-10-10", status: "pendente", parcelas: 3,
      });
      exigir(r.status === 201, `status ${r.status}: ${JSON.stringify(r.json)}`);
      const soma = r.json.lancamentos.reduce((s, l) => s + l.amountCents, 0);
      exigir(soma === 100000, `parcelas somam ${soma}, esperado 100000`);
      return `3 parcelas somando ${soma} centavos`;
    });

    await passo("despesa recorrente por 3 meses", async () => {
      const r = await http("POST", "/api/anota/lancamentos", {
        tipo: "despesa", amountCents: 4590, description: "internet e2e", category: "casa",
        contaId: conta?.id ?? null, data: "2026-10-15", status: "pago", repeticoes: 3,
      });
      exigir(r.status === 201, `status ${r.status}: ${JSON.stringify(r.json)}`);
      exigir(r.json.lancamentos.length === 3, `esperava 3 ocorrências, veio ${r.json.lancamentos.length}`);
      const meses = r.json.lancamentos.map((l) => l.data.slice(0, 7));
      exigir(meses[1] === "2026-11" && meses[2] === "2026-12", `meses errados: ${meses.join(",")}`);
      return `2026-10 → ${meses.join(" → ")}`;
    });

    await passo("receita de salário", async () => {
      const r = await http("POST", "/api/anota/lancamentos", {
        tipo: "receita", amountCents: 450000, description: "salário e2e", category: "salario",
        contaId: conta?.id ?? null, data: "2026-10-01", status: "pago",
      });
      exigir(r.status === 201, `status ${r.status}: ${JSON.stringify(r.json)}`);
      return "R$ 4.500,00";
    });

    await passo("importar CSV com coluna fitid: reimportar não duplica", async () => {
      const csv = [
        "data,descricao,valor,categoria,fitid",
        "2026-10-20,Padaria E2E,-18.50,mercado,CSV0001",
        "2026-10-21,Feira E2E,-42.00,mercado,CSV0002",
      ].join("\n");
      const r1 = await http("POST", "/api/anota/importar", { formato: "csv", conteudo: csv, contaId: conta?.id });
      exigir(r1.status === 200, `status ${r1.status}: ${JSON.stringify(r1.json)}`);
      exigir(r1.json.importados === 2, `esperava 2 importados, veio ${r1.json.importados}`);
      const r2 = await http("POST", "/api/anota/importar", { formato: "csv", conteudo: csv, contaId: conta?.id });
      exigir(r2.json.importados === 0 && r2.json.ignorados === 2, `dedupe falhou: ${JSON.stringify(r2.json)}`);
      return "2 importados na 1ª, 2 ignorados na 2ª (FITID)";
    });

    await passo("importar CSV SEM fitid: chave natural impede duplicar", async () => {
      const csv = ["data;descricao;valor", "2026-10-23;Padaria sem id;-9,90", "2026-10-23;Café sem id;-4,50"].join("\n");
      const r1 = await http("POST", "/api/anota/importar", { formato: "csv", conteudo: csv, contaId: conta?.id });
      exigir(r1.status === 200 && r1.json.importados === 2, `1ª importação: ${JSON.stringify(r1.json)}`);
      const r2 = await http("POST", "/api/anota/importar", { formato: "csv", conteudo: csv, contaId: conta?.id });
      exigir(r2.json.importados === 0 && r2.json.ignorados === 2, `2ª importação duplicou: ${JSON.stringify(r2.json)}`);
      return "2 na 1ª, 0 na 2ª (chave natural)";
    });

    await passo("importar OFX 1.x SGML", async () => {
      const ofx = [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "VERSION:102",
        "",
        "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>",
        "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261022<TRNAMT>-73.40<FITID>OFX0001<NAME>Posto E2E",
        "</STMTTRN>",
        "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
      ].join("\n");
      const r = await http("POST", "/api/anota/importar", { formato: "ofx", conteudo: ofx, contaId: conta?.id });
      exigir(r.status === 200, `status ${r.status}: ${JSON.stringify(r.json)}`);
      exigir(r.json.importados === 1, `esperava 1, veio ${JSON.stringify(r.json)}`);
      return "1 transação OFX lida";
    });

    await passo("resumo do mês fecha as contas", async () => {
      const r = await http("GET", "/api/anota/resumo?ym=2026-10");
      exigir(r.status === 200, `status ${r.status}`);
      // pagas em outubro: 5990 (feira) + 4590 (internet) + 1850 + 4200 (CSV)
      //                  + 990 + 450 (CSV sem fitid) + 7340 (OFX)
      exigir(r.json.resumo.despesasCents === 25410, `despesas pagas de outubro = ${r.json.resumo.despesasCents}, esperado 25410`);
      exigir(r.json.resumo.receitasCents === 450000, `receitas = ${r.json.resumo.receitasCents}`);
      // pendente: a compra de 100000 em 3x (33333 + 33333 + 33334 — a última fecha o centavo)
      exigir(r.json.resumo.apagarCents === 33333, `a pagar de outubro = ${r.json.resumo.apagarCents}, esperado 33333`);
      exigir(r.json.resumo.saldoCents === 450000 - 25410, `saldo do mês = ${r.json.resumo.saldoCents}`);
      // saldo em contas: inicial + receitas pagas − despesas pagas − parcelas já vencidas
      const esperadoSaldo = 250000 + 450000 - 25410;
      exigir(
        Math.abs(r.json.saldoConsolidadoCents - esperadoSaldo) <= 33334,
        `saldo consolidado = ${r.json.saldoConsolidadoCents}, esperado ~${esperadoSaldo}`,
      );
      return `pagas ${r.json.resumo.despesasCents} · receitas ${r.json.resumo.receitasCents} · a pagar ${r.json.resumo.apagarCents}`;
    });

    await passo("orçamento por categoria (limite 20000)", async () => {
      const r = await http("POST", "/api/anota/orcamentos", { categoriaId: cat.id, ym: "2026-10", limiteCents: 20000 });
      exigir(r.status === 201 || r.status === 200, `status ${r.status}: ${JSON.stringify(r.json)}`);
      const v = await http("GET", "/api/anota/orcamentos?ym=2026-10");
      const o = (v.json.orcamentos ?? []).find((x) => x.categoriaId === cat.id);
      exigir(o, "orçamento não apareceu na listagem");
      return `limite ${o.limiteCents}, gasto ${o.gastoCents}, estado ${o.estado}`;
    });

    const cartao = await passo("cartão de crédito + fatura", async () => {
      const r = await http("POST", "/api/anota/cartoes", { contaId: conta.id, nome: `Visa E2E ${sufixo}`, limiteCents: 300000, fechamentoDia: 25, vencimentoDia: 5 });
      exigir(r.status === 201, `status ${r.status}: ${JSON.stringify(r.json)}`);
      const f = await http("GET", `/api/anota/cartoes/${r.json.cartao.id}/fatura?ym=2026-10`);
      exigir(f.status === 200, `fatura status ${f.status}`);
      exigir(typeof f.json.fatura?.totalCents === "number", `fatura sem totalCents: ${JSON.stringify(f.json)}`);
      return `fatura: total ${f.json.fatura.totalCents}, fecha ${f.json.fatura.fechaEm}, vence ${f.json.fatura.venceEm}`;
    });

    const meta = await passo("meta com aporte (PATCH)", async () => {
      const r = await http("POST", "/api/anota/metas", { nome: `Reserva E2E ${sufixo}`, alvoCents: 300000, guardadoCents: 0 });
      exigir(r.status === 201, `status ${r.status}: ${JSON.stringify(r.json)}`);
      const e = await http("PATCH", `/api/anota/metas/${r.json.meta.id}`, { guardadoCents: 120000 });
      exigir(e.status === 200, `aporte status ${e.status}: ${JSON.stringify(e.json)}`);
      exigir(e.json.meta.guardadoCents === 120000, `guardado = ${e.json.meta.guardadoCents}`);
      return "40% da reserva";
    });

    await passo("relatório de 6 meses", async () => {
      const r = await http("GET", "/api/anota/relatorio?ym=2026-10&meses=6");
      exigir(r.status === 200, `status ${r.status}`);
      exigir(r.json.linhas.length === 6, `linhas = ${r.json.linhas.length}`);
      const out = r.json.linhas.find((l) => l.ym === "2026-10");
      return `out/2026: despesas ${out?.despesasCents}`;
    });

    await passo("export.csv baixa com cabeçalho", async () => {
      const r = await http("GET", "/api/anota/export.csv", null, true);
      exigir(r.status === 200, `status ${r.status}`);
      const texto = r.corpo.toString("utf8");
      exigir(texto.split("\n")[0].includes("descricao"), `cabeçalho inesperado: ${texto.slice(0, 60)}`);
      return `${texto.trim().split("\n").length - 1} linhas de dados`;
    });

    await passo("OCR honesto: sem tesseract não inventa texto", async () => {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      const r = await http("POST", "/api/anota/ocr", { imageBase64: png.toString("base64") });
      exigir(r.status === 200, `status ${r.status}: ${JSON.stringify(r.json)}`);
      if (r.json.engine !== "tesseract") exigir(r.json.texto === "", `engine ${r.json.engine} devolveu texto inventado: ${JSON.stringify(r.json.texto)}`);
      return `engine ${r.json.engine}, ${r.json.chars} caracteres`;
    });

    await passo("backup: estado antes do envio", async () => {
      const r = await http("GET", "/api/anota/backup");
      exigir(r.status === 200, `status ${r.status}`);
      exigir(r.json.envioConfigurado === true, `envioConfigurado = ${r.json.envioConfigurado} (SMTP deveria estar configurado)`);
      return `provedor ${r.json.provedor}, ${r.json.historico.length} backups anteriores`;
    });

    const emailDestino = `usuario.${sufixo}@exemplo.com.br`;
    await passo(`backup: envia para ${emailDestino}`, async () => {
      const antes = recebidas.length;
      const r = await http("POST", "/api/anota/backup", { email: emailDestino });
      exigir(r.status === 200, `status ${r.status}: ${JSON.stringify(r.json)}`);
      exigir(r.json.status === "enviado", `status do envio = ${r.json.status}`);
      exigir(recebidas.length === antes + 1, `SMTP recebeu ${recebidas.length - antes} mensagens`);
      const msg = recebidas[recebidas.length - 1];
      exigir(msg.para.join(" ").includes(emailDestino), `RCPT não tem o e-mail do usuário: ${msg.para.join(" ")}`);
      exigir(msg.corpo.includes("Content-Type: application/zip") || msg.corpo.includes("application/zip"), "anexo ZIP ausente no MIME");
      return `SMTP recebeu ${msg.bytes} bytes para ${emailDestino}`;
    });

    await passo("backup: ZIP baixável com MANIFEST + CSV", async () => {
      const r = await http("GET", "/api/anota/backup/arquivo", null, true);
      exigir(r.status === 200, `status ${r.status}`);
      exigir(r.corpo.length > 500, `ZIP com ${r.corpo.length} bytes`);
      exigir(r.corpo[0] === 0x50 && r.corpo[1] === 0x4b, "assinatura PK do ZIP ausente");
      const { readFile, writeFile } = await import("node:fs/promises");
      await writeFile("/tmp/anota-e2e-backup.zip", r.corpo);
      const { execFileSync } = await import("node:child_process");
      const lista = execFileSync("unzip", ["-l", "/tmp/anota-e2e-backup.zip"]).toString();
      for (const esperado of ["MANIFEST.json", "lancamentos.csv", "contas.json", "categorias.json", "metas.json"]) {
        exigir(lista.includes(esperado), `${esperado} não está no ZIP`);
      }
      await readFile("/tmp/anota-e2e-backup.zip");
      return `${r.corpo.length} bytes, ${lista.trim().split("\n").length} entradas no unzip -l`;
    });

    await passo("histórico do backup registra o envio", async () => {
      const r = await http("GET", "/api/anota/backup");
      const h = r.json.historico[0];
      exigir(h && h.email === emailDestino, `histórico = ${JSON.stringify(r.json.historico[0])}`);
      exigir(h.status === "enviado", `status = ${h.status}`);
      return `${h.email} · ${h.itens} registros · ${h.bytes} bytes · ${h.provedor}`;
    });

    await passo("segurança: sem Bearer → 401", async () => {
      const r = await fetch(`${API}/api/anota/resumo?ym=2026-10`);
      exigir(r.status === 401, `status ${r.status}`);
      const r2 = await fetch(`${API}/api/anota/backup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@y.com" }) });
      exigir(r2.status === 401, `backup sem token status ${r2.status}`);
      return "resumo e backup exigem sessão";
    });

    const falhas = passos.filter((p) => !p.ok);
    console.log(`\n${passos.length - falhas.length}/${passos.length} passos verdes · SMTP recebeu ${recebidas.length} mensagem(ns)`);
    if (falhas.length) {
      console.log(`\n--- log da API (últimas 40 linhas) ---\n${log.join("").split("\n").slice(-40).join("\n")}`);
      process.exitCode = 1;
    }
  } finally {
    filho.kill("SIGTERM");
    smtp.close();
  }
}

main().catch((e) => {
  console.error("E2E abortou:", e);
  process.exitCode = 1;
});
