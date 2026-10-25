/**
 * E2E das UNIÕES (25/10) — sobe a API de verdade (`dist/server.js`) contra o
 * Postgres local e exercita por HTTP, com dois usuários reais:
 *
 *   1) AnotA × Empréstimo: pedido → match → aceite → lançar no AnotA →
 *      declarar pagamento → confirmar → parcela vira paga (sem linha dobrada).
 *   2) Jurídico × Investiga: caso OSINT com alvo nome → busca jurídica real →
 *      achado com proveniência; e processo com parte → caso OSINT criado.
 *
 * Sem mock de fetch, sem provider falso. A busca jurídica bate na fonte real:
 * se o tribunal bloquear, o E2E mostra "bloqueado/unavailable" — e isso é
 * resultado aceito (o que não se aceita é inventar processo).
 *
 * Rodar: node scripts/e2e-uniao.mjs   (depois de `tsc -b`)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

import { signInitData } from "../dist/security/telegram-initdata.js";

const PORTA = 3918;
const API = `http://127.0.0.1:${PORTA}`;
const ADMIN_TOKEN = "e2e-admin-token-uniao";
const BOT = "777000:E2E-UNIAO-TOKEN";
const BD = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/acompanhe_e2e";

const passos = [];
const ok = (nome, detalhe) => {
  passos.push({ nome, ok: true });
  console.log(`  ✓ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
};
const falhou = (nome, erro) => {
  passos.push({ nome, ok: false });
  console.error(`  ✗ ${nome} — ${erro}`);
};
const exigir = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
async function passo(nome, fn) {
  try {
    const d = await fn();
    ok(nome, d);
    return d;
  } catch (e) {
    falhou(nome, e instanceof Error ? e.message : String(e));
    return null;
  }
}

function subirApi() {
  const filho = spawn(process.execPath, ["dist/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      // development (e não test) para o diretor ser criado e o admin poder
      // aprovar V1/conceder plano — é o caminho real de operação.
      NODE_ENV: "development",
      PORT: String(PORTA),
      HOST: "127.0.0.1",
      DATABASE_URL: BD,
      BOT_TOKEN: BOT,
      JWT_SECRET: "e2e-uniao-secret-com-mais-de-16",
      ADMIN_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  filho.stdout.on("data", (d) => log.push(String(d)));
  filho.stderr.on("data", (d) => log.push(String(d)));
  return { filho, log };
}

async function esperarSaude(filho) {
  for (let i = 0; i < 120; i++) {
    if (filho.exitCode !== null) throw new Error(`API morreu no boot (${filho.exitCode})`);
    try {
      const r = await fetch(`${API}/health`);
      if (r.ok) return;
    } catch {
      /* subindo */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("API não respondeu /health");
}

async function login(uid, nome) {
  const initData = signInitData(
    { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: uid, first_name: nome }) },
    BOT,
  );
  const r = await fetch(`${API}/api/auth/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData }),
  });
  const j = await r.json();
  if (!j.token) throw new Error(`login ${uid} falhou: ${JSON.stringify(j)}`);
  return j.token;
}

async function http(token, method, caminho, corpo) {
  const r = await fetch(`${API}${caminho}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(corpo ? { "content-type": "application/json" } : {}) },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function main() {
  const { filho, log } = subirApi();
  try {
    await esperarSaude(filho);
    const sufixo = Date.now() % 100000;
    const DEVEDOR = 910000000 + sufixo;
    const CREDOR = 920000000 + sufixo;

    console.log(`API de verdade em ${API}\n\n— União AnotA × Empréstimo —`);

    const admin = await passo("admin entra e aprova V1 do devedor", async () => {
      const r = await fetch(`${API}/v1/admin/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "diretor@acompanhe.app", password: ADMIN_TOKEN }),
      });
      const j = await r.json();
      exigir(r.status === 200 && j.token, `login admin ${r.status}: ${JSON.stringify(j)}`);
      const H = { authorization: `Bearer ${j.token}`, "content-type": "application/json" };
      const ap = await fetch(`${API}/v1/admin/verificacoes/${DEVEDOR}/aprovar`, { method: "POST", headers: H });
      exigir(ap.status === 200, `aprovar V1 ${ap.status}`);
      return j.token;
    });
    exigir(admin, "sem admin não há V1 nem plano");

    const tDev = await login(DEVEDOR, "Devedor");
    const tCre = await login(CREDOR, "Credor");

    const matchId = await passo("pedido → interesse → aceite (contrato aceito)", async () => {
      const ped = await http(tDev, "POST", "/api/loan-requests", {
        uf: "MT",
        valorCents: 100_000,
        jurosMesBps: 300,
        meses: 4,
        jurosTipo: "simples",
        motivo: "uniao e2e telhado",
      });
      exigir(ped.status === 201, `pedido ${ped.status}: ${JSON.stringify(ped.json)}`);
      const requestId = ped.json.pedido.id;
      const inter = await http(tCre, "POST", `/api/loan-requests/${requestId}/interesse`, {});
      exigir(inter.status === 201, `interesse ${inter.status}: ${JSON.stringify(inter.json)}`);
      const m = inter.json.match.id;
      const aceite = await http(tDev, "POST", `/api/loan-matches/${m}/aceitar`, {});
      exigir(aceite.status === 200, `aceite ${aceite.status}: ${JSON.stringify(aceite.json)}`);
      return m;
    });

    await passo("contrato aparece no AnotA com parcela e total da calculadora", async () => {
      const r = await http(tDev, "GET", "/api/anota/emprestimos");
      exigir(r.status === 200, `status ${r.status}: ${JSON.stringify(r.json)}`);
      const c = r.json.contratos.find((x) => x.matchId === matchId);
      exigir(c, "contrato não apareceu na lista");
      exigir(c.totalCents === 112_000, `total ${c.totalCents}, esperado 112000`);
      exigir(c.parcelaCents === 28_000, `parcela ${c.parcelaCents}`);
      exigir(c.papel === "devedor", `papel ${c.papel}`);
      return `${c.parcelasTotal}× de ${c.parcelaCents} centavos`;
    });

    await passo("lançar no AnotA cria 4 parcelas e repetir não duplica", async () => {
      const l1 = await http(tDev, "POST", `/api/anota/emprestimos/${matchId}/lancar`, {});
      exigir(l1.status === 201 && l1.json.criados === 4, `1ª: ${JSON.stringify(l1.json)}`);
      const l2 = await http(tDev, "POST", `/api/anota/emprestimos/${matchId}/lancar`, {});
      exigir(l2.json.criados === 0 && l2.json.jaExistiam === 4, `2ª: ${JSON.stringify(l2.json)}`);
      return "4 criadas, depois 0 criadas / 4 já existiam";
    });

    const paymentId = await passo("declarar pagamento: AnotA avisa que aguarda confirmação", async () => {
      const d = await http(tDev, "POST", "/api/payments/declare", { matchId, valorCents: 28_000 });
      exigir(d.status === 201, `declare ${d.status}: ${JSON.stringify(d.json)}`);
      exigir(d.json.anotA.sincronizado === true, `espelho não sincronizou: ${JSON.stringify(d.json.anotA)}`);
      const mov = d.json.anotA.partes.every((p) => p.acao === "sem-mudanca");
      exigir(mov, `declarado mexeu no AnotA: ${JSON.stringify(d.json.anotA.partes)}`);
      return d.json.pagamento.id;
    });

    await passo("confirmar fecha a 1ª parcela nos dois lados, sem linha duplicada", async () => {
      const c = await http(tCre, "POST", "/api/payments/confirm", { paymentId, confirmar: true });
      exigir(c.status === 200, `confirm ${c.status}: ${JSON.stringify(c.json)}`);
      const dev = c.json.anotA.partes.find((p) => p.papel === "devedor");
      exigir(dev?.acao === "atualizado" && dev?.viaParcela === true, `devedor: ${JSON.stringify(dev)}`);
      const lanc = await http(tDev, "GET", "/api/anota/lancamentos");
      const doContrato = lanc.json.lancamentos.filter((l) => String(l.fitId).startsWith(`loan:${matchId}:`));
      exigir(doContrato.length === 4, `parcelas no AnotA: ${doContrato.length}`);
      const pagas = doContrato.filter((l) => l.status === "pago");
      exigir(pagas.length === 1, `parcelas pagas: ${pagas.length}`);
      const paralelas = lanc.json.lancamentos.filter((l) => String(l.fitId).startsWith("loan-pay:"));
      exigir(paralelas.length === 0, `linha duplicada criada: ${paralelas.length}`);
      const resumo = await http(tDev, "GET", `/api/anota/emprestimos`);
      const contrato = resumo.json.contratos.find((x) => x.matchId === matchId);
      exigir(contrato.pagoCents === 28_000, `pago ${contrato.pagoCents}`);
      exigir(contrato.emAbertoCents === 84_000, `em aberto ${contrato.emAbertoCents}`);
      return "1 parcela paga · 3 pendentes · saldo 84.000";
    });

    console.log("\n— União Jurídico × Investiga —");

    await passo("admin concede os planos investiga e juridica", async () => {
      const H = { authorization: `Bearer ${admin}`, "content-type": "application/json" };
      for (const planCode of ["investiga", "juridica"]) {
        const r = await fetch(`${API}/v1/admin/assinaturas/conceder`, {
          method: "POST",
          headers: H,
          body: JSON.stringify({ tgUserId: String(DEVEDOR), planCode, days: 30 }),
        });
        exigir(r.status === 200, `conceder ${planCode}: ${r.status}`);
      }
      return "investiga + juridica por 30 dias";
    });

    const casoId = await passo("cria caso OSINT com alvo nome", async () => {
      const r = await http(tDev, "POST", "/v1/investiga/cases", {
        title: "E2E união — fornecedor",
        targets: [{ kind: "name", value: "JOAO CARLOS DA SILVA" }],
        legalBasis: "LGPD art. 7º, §3º — exercício regular de direitos",
        purpose: "Conferir processos públicos antes de contratar",
      });
      exigir(r.status === 201, `caso ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json.case.id;
    });

    await passo("busca jurídica real roda e o resultado é honesto", async () => {
      const r = await http(tDev, "POST", `/v1/investiga/cases/${casoId}/juridico`, {});
      exigir(r.status === 200, `juridico ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
      const alvo = r.json.porAlvo?.[0];
      exigir(alvo, "sem retorno por alvo");
      const estados = ["resultados", "vazio", "multiplos", "bloqueado", "erro"];
      exigir(estados.includes(alvo.estado), `estado inesperado: ${alvo.estado}`);
      for (const a of r.json.achados ?? []) {
        exigir(typeof a.sourceId === "string" && a.sourceId.startsWith("juridico:"), `fonte sem carimbo: ${a.sourceId}`);
        if (a.status === "found") exigir(a.evidenceUrl, "achado 'found' sem URL de evidência");
      }
      const lista = await http(tDev, "GET", `/v1/investiga/cases/${casoId}/juridico`);
      exigir(lista.status === 200 && lista.json.total === (r.json.achados ?? []).length, "listagem divergente");
      return `estado ${alvo.estado} · ${r.json.gravados} achado(s) gravados · fontes: ${alvo.fontes.map((f) => `${f.fonte}:${f.estado}`).join(", ") || "nenhuma"}`;
    });

    await passo("processo com parte vira caso OSINT (Jurídico → Investiga)", async () => {
      const r = await http(tDev, "POST", "/v1/investiga/cases/from-processo", {
        numeroProcesso: "0724866-89.2026.8.02.0001",
        nomeParte: "JOAO CARLOS DA SILVA",
        uf: "SP",
        participacao: "Requerido",
      });
      exigir(r.status === 201, `from-processo ${r.status}: ${JSON.stringify(r.json)}`);
      exigir(JSON.stringify(r.json.case.targets).includes("JOAO CARLOS DA SILVA"), "alvo não foi o nome da parte");
      return `caso ${r.json.case.id.slice(0, 8)} criado`;
    });

    await passo("sem nome de parte → 422 e nenhum caso novo", async () => {
      const antes = await http(tDev, "GET", "/v1/investiga/cases");
      const r = await http(tDev, "POST", "/v1/investiga/cases/from-processo", {
        numeroProcesso: "0724866-89.2026.8.02.0001",
        nomeParte: "   ",
      });
      exigir(r.status === 422, `status ${r.status}`);
      const depois = await http(tDev, "GET", "/v1/investiga/cases");
      exigir(depois.json.cases.length === antes.json.cases.length, "criou caso mesmo sem nome");
      return "nenhum caso criado";
    });

    const falhas = passos.filter((p) => !p.ok);
    console.log(`\n${passos.length - falhas.length}/${passos.length} passos verdes`);
    if (falhas.length > 0) {
      console.log(`\n--- log da API (últimas 40 linhas) ---\n${log.join("").split("\n").slice(-40).join("\n")}`);
      process.exitCode = 1;
    }
  } finally {
    filho.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error("E2E abortou:", e);
  process.exitCode = 1;
});
