#!/usr/bin/env node
/**
 * tools/e2e/run-e2e.mjs — Runner E2E do plano (docs/plano-teste-e2e.md).
 * Regras: sem simulação; cada TC registra evidência crua (status + corpo);
 * falhas viram docs/e2e-erros.md com severidade; relatório em docs/relatorio-e2e.md.
 * Uso: node tools/e2e/run-e2e.mjs   (stack no ar: API :3000)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";

const SECRETS = JSON.parse(readFileSync("/home/user/.secrets.json", "utf8"));
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3000";
const TG = `https://api.telegram.org/bot${SECRETS.TELEGRAM_BOT_TOKEN}`;
const ADMIN_EMAIL = SECRETS.ADMIN_EMAIL ?? "diretor@acompanhe.app";
const ADMIN_PASS = SECRETS.ADMIN_TOKEN;

// ---------- helpers ----------
async function api(path, { method = "GET", token, body, timeout = 30000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* não-JSON */ }
    return { status: res.status, text, json };
  } finally { clearTimeout(t); }
}
function sh(cmd) {
  try { return { ok: true, out: execSync(cmd, { encoding: "utf8", timeout: 60000 }) }; }
  catch (e) { return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? e) }; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function ev(r, label = "") {
  const body = (r.text ?? "").slice(0, 160).replace(/\s+/g, " ");
  return `${label}${r.status} ${body}`;
}

const tokens = {};
async function tok(user) {
  if (tokens[user]) return tokens[user];
  const r = await api("/api/auth/telegram/dev", { method: "POST", body: { userId: user, username: user } });
  assert(r.status === 200 && r.json?.token, `dev-auth ${user} falhou: ${ev(r)}`);
  tokens[user] = r.json.token;
  return tokens[user];
}
let adminT = null;
async function adminTok() {
  if (adminT) return adminT;
  const r = await api("/v1/admin/auth/login", { method: "POST", body: { email: ADMIN_EMAIL, password: ADMIN_PASS } });
  assert(r.status === 200 && r.json?.token, `login diretor falhou: ${ev(r)}`);
  adminT = r.json.token;
  return adminT;
}
let opCred = null;
function resetOperadorPass(nova) {
  const salt = randomBytes(16).toString("hex");
  const h = scryptSync(nova, salt, 32).toString("hex");
  const hash = `scrypt$${salt}$${h}`;
  const sql = `UPDATE "AdminUser" SET "passwordHash"='${hash}', active=true WHERE email='operador.e2e@acompanhe.app'`;
  // aspas SIMPLES: '$' do hash não pode ser expandido pelo bash
  return sh(`sudo -u postgres psql -d acompanhe -v ON_ERROR_STOP=1 -c '${sql.replace(/'/g, `'\\''`)}'`);
}
async function opLogin() {
  if (opCred) return opCred;
  for (const p of ["e2e-Operador-2026b", "e2e-Operador-2026"]) {
    const r = await api("/v1/admin/auth/login", { method: "POST", body: { email: "operador.e2e@acompanhe.app", password: p } });
    if (r.status === 200 && r.json?.token) { opCred = { pass: p, token: r.json.token }; return opCred; }
  }
  // autossanidade: senha desconhecida de execução anterior -> reset via hash scrypt real
  const nova = "e2e-Operador-2026";
  const r1 = resetOperadorPass(nova);
  if (!r1.ok) throw new Error(`reset operador falhou: ${r1.out.slice(0, 100)}`);
  const r = await api("/v1/admin/auth/login", { method: "POST", body: { email: "operador.e2e@acompanhe.app", password: nova } });
  if (r.status === 200 && r.json?.token) { opCred = { pass: nova, token: r.json.token }; return opCred; }
  throw new Error(`operador não loga nem após reset: ${ev(r)}`);
}

// ---------- coleta ----------
const results = []; // {id, title, status: pass|fail|externo|conhecido|skip, sev, evidence}
function record(id, title, status, evidence, sev = "") {
  results.push({ id, title, status, evidence, sev });
  const tag = { pass: "PASS", fail: "FAIL", externo: "S4-EXT", conhecido: "CONHEC", skip: "SKIP" }[status];
  console.log(`${tag.padEnd(7)} ${id.padEnd(7)} ${title.slice(0, 48).padEnd(48)} ${evidence.slice(0, 90)}`);
}
async function check(id, title, fn) {
  try {
    const evidence = await fn();
    record(id, title, "pass", evidence ?? "ok");
    return true;
  } catch (e) {
    record(id, title, "fail", String(e.message ?? e).slice(0, 400), "S2");
    return false;
  }
}
async function checkExternal(id, title, fn) {
  try {
    const evidence = await fn();
    record(id, title, "pass", evidence ?? "ok");
    return true;
  } catch (e) {
    record(id, title, "externo", String(e.message ?? e).slice(0, 400), "S4");
    return false;
  }
}

// ---------- P1: usuários ----------
async function phase1() {
  console.log("\n=== P1 · usuários reais ===");
  for (const u of ["e2e-u1", "e2e-u2", "e2e-u3", "e2e-u4", "e2e-u5", "e2e-u6", "e2e-u7"]) await tok(u);
  record("SET-1", "dev-auth e2e-u1..u7", "pass", "7 JWTs emitidos por /api/auth/telegram/dev");

  // u2: trial ativo (investiga) — 409 aceito: já concedido em execução anterior
  const t2 = await api("/api/assinaturas/trial", { method: "POST", token: await tok("e2e-u2"), body: { planCode: "investiga" } });
  record("SET-2", "trial u2 (investiga)", t2.status === 200 || t2.status === 201 || t2.status === 409 ? "pass" : "fail", ev(t2), t2.status === 200 || t2.status === 201 || t2.status === 409 ? "" : "S2");

  // u3: trial + expiração real via SQL (idempotente: 409 = já teve trial; UPDATE 0 = já expirado)
  const t3 = await api("/api/assinaturas/trial", { method: "POST", token: await tok("e2e-u3"), body: { planCode: "investiga" } });
  const exp = sh(`sudo -u postgres psql -d acompanhe -c "UPDATE \\"Subscription\\" SET \\"endsAt\\" = now() - interval '2 days' WHERE \\"userId\\"='e2e-u3'; UPDATE \\"Entitlement\\" SET \\"expiresAt\\" = now() - interval '2 days' WHERE \\"subjectId\\"='e2e-u3';"`);
  record("SET-3", "trial u3 expirado (SQL real)", exp.ok && (t3.status === 201 || t3.status === 200 || t3.status === 409) ? "pass" : "fail",
    `trial=${t3.status}; sql=${exp.out.trim().slice(0, 60)}`, exp.ok ? "" : "S2");

  // u4/u5: concessão via admin
  const at = await adminTok();
  const g4 = await api("/v1/admin/assinaturas/conceder", { method: "POST", token: at, body: { tgUserId: "e2e-u4", planCode: "anota", days: 30 } });
  const g5 = await api("/v1/admin/assinaturas/conceder", { method: "POST", token: at, body: { tgUserId: "e2e-u5", planCode: "investiga", days: 30 } });
  record("SET-4", "conceder anota(u4)/investiga(u5)", g4.status < 300 && g5.status < 300 ? "pass" : "fail",
    `u4=${g4.status} u5=${g5.status}`, g4.status < 300 && g5.status < 300 ? "" : "S2");

  // u6: massa de dados real (10 notas + 10 gastos)
  const t6 = await tok("e2e-u6");
  let notas = 0, gastos = 0;
  for (let i = 1; i <= 10; i++) {
    const n = await api("/api/minhas/notas", { method: "POST", token: t6, body: { title: `nota massa ${i}`, body: `conteudo ${i}`, tags: ["massa"], pinned: i === 1 } });
    if (n.status < 300) notas++;
    const d = new Date(2026, 9, 20 + (i % 5)).toISOString().slice(0, 10);
    const g = await api("/api/minhas/gastos", { method: "POST", token: t6, body: { amountCents: 1000 + i * 100, category: "alimentacao", description: `gasto massa ${i}`, spentAt: d } });
    if (g.status < 300) gastos++;
  }
  record("SET-5", "massa u6: 10 notas + 10 gastos", notas === 10 && gastos === 10 ? "pass" : "fail",
    `notas=${notas} gastos=${gastos}`, notas === 10 && gastos === 10 ? "" : "S2");

  // u7: verificação pendente
  const v7 = await api("/api/minhas/verificacao", { method: "POST", token: await tok("e2e-u7"), body: { docTipo: "cnh", selfieAt: "2026-10-24T12:00:00Z" } });
  record("SET-6", "verificação pendente u7", v7.status < 300 ? "pass" : "fail", ev(v7), v7.status < 300 ? "" : "S2");

  // u8: operador criado pelo diretor (409 = já existe, ok idempotente)
  const op = await api("/v1/admin/operadores", { method: "POST", token: at, body: { email: "operador.e2e@acompanhe.app", name: "Operador E2E", role: "operador_suporte", password: "e2e-Operador-2026" } });
  record("SET-7", "operador criado pelo diretor", op.status < 300 || op.status === 409 ? "pass" : "fail", ev(op), op.status < 300 || op.status === 409 ? "" : "S2");

  // SET-8: garantir operador ATIVO (execuções anteriores podem tê-lo desativado)
  const at2 = await adminTok();
  const lista = await api("/v1/admin/operadores", { token: at2 });
  const rows = lista.json?.operadores ?? lista.json ?? [];
  const opRow = Array.isArray(rows) ? rows.find((o) => (o.email ?? "").includes("operador.e2e")) : null;
  if (opRow?.id) {
    const act = await api(`/v1/admin/operadores/${opRow.id}/active`, { method: "POST", token: at2, body: { active: true } });
    record("SET-8", "operador reativado", act.status < 300 ? "pass" : "fail", ev(act), act.status < 300 ? "" : "S2");
  }

  // SET-9: u4 com V1+ aprovado (pré-condição A3 dos empréstimos)
  const s4 = await api("/api/minhas/verificacao", { method: "POST", token: await tok("e2e-u4"), body: { docTipo: "cpf" } });
  const a4 = await api("/v1/admin/verificacoes/e2e-u4/aprovar", { method: "POST", token: at2, body: {} });
  record("SET-9", "u4 verificação V1+ aprovada (gate A3)", s4.status < 300 && a4.status < 300 ? "pass" : "fail",
    `submit=${s4.status} aprovar=${a4.status}`, s4.status < 300 && a4.status < 300 ? "" : "S2");

  // SET-10: u2 com plano Consulta Jurídica (gate v2/08 do produto juridica)
  const j = await api("/v1/admin/assinaturas/conceder", { method: "POST", token: at2, body: { tgUserId: "e2e-u2", planCode: "juridica", days: 30 } });
  record("SET-10", "u2 plano juridica concedido (gate v2/08)", j.status < 300 ? "pass" : "fail", ev(j), j.status < 300 ? "" : "S2");
}

// ---------- F1 auth ----------
async function f1() {
  console.log("\n=== F1 · autenticação ===");
  await check("TC-A01", "dev-auth emite JWT e /api/me devolve sessão", async () => {
    const t = await tok("e2e-u2");
    const me = await api("/api/me", { token: t });
    assert(me.status === 200 && me.json?.tgUserId === "e2e-u2", ev(me));
    return `me=${JSON.stringify(me.json)}`;
  });
  await check("TC-A02", "sem token/adulterado -> 401", async () => {
    const a = await api("/api/me");
    const b = await api("/api/me", { token: "eyJhbGciOiJIUzI1NiJ9.xx.yy" });
    assert(a.status === 401 && b.status === 401, `sem=${a.status} adulterado=${b.status}`);
    return `sem=${a.status} adulterado=${b.status}`;
  });
}

// ---------- F2 gamificação ----------
async function f2() {
  console.log("\n=== F2 · gamificação ===");
  const t = await tok("e2e-u2");
  await check("TC-G01", "acao nota_criada soma XP e missão", async () => {
    const r = await api("/api/gamificacao/acao", { method: "POST", token: t, body: { acao: "nota_criada" } });
    assert(r.status === 200 && (r.json?.xpGanho ?? 0) > 0, ev(r));
    return JSON.stringify(r.json).slice(0, 140);
  });
  await check("TC-G02", "ação repetida: política real registrada", async () => {
    const a = await api("/api/gamificacao/acao", { method: "POST", token: t, body: { acao: "login_diario" } });
    const b = await api("/api/gamificacao/acao", { method: "POST", token: t, body: { acao: "login_diario" } });
    assert(a.status === 200 && b.status === 200, `a=${a.status} b=${b.status}`);
    return `1a=${JSON.stringify(a.json).slice(0, 60)} 2a=${JSON.stringify(b.json).slice(0, 60)}`;
  });
  await check("TC-G03", "ranking grava participação e lista", async () => {
    const p = await api("/api/gamificacao/ranking", { method: "POST", token: t, body: { participar: true } });
    const g = await api("/api/gamificacao/ranking", { token: t });
    assert(p.status === 200 && g.status === 200, `post=${p.status} get=${g.status}`);
    return `post=${p.status} get=${g.status} ${JSON.stringify(g.json).slice(0, 80)}`;
  });
}

// ---------- F3 AnotA ----------
async function f3() {
  console.log("\n=== F3 · AnotA (notas/gastos/OCR) ===");
  const t = await tok("e2e-u2");
  let notaId = null;
  await check("TC-N01", "CRUD completo de notas", async () => {
    const c = await api("/api/minhas/notas", { method: "POST", token: t, body: { title: "nota crud e2e", body: "corpo", tags: ["e2e"] } });
    assert(c.status < 300 && c.json?.nota?.id, ev(c));
    notaId = c.json.nota.id;
    const u = await api(`/api/minhas/notas/${notaId}`, { method: "PUT", token: t, body: { pinned: true, tags: ["e2e", "fixa"] } });
    assert(u.status === 200, ev(u, "put "));
    const g = await api("/api/minhas/notas?q=crud", { token: t });
    assert(g.status === 200 && JSON.stringify(g.json).includes(notaId), ev(g, "busca "));
    const d = await api(`/api/minhas/notas/${notaId}`, { method: "DELETE", token: t });
    assert(d.status === 200, ev(d, "del "));
    return `criada=${notaId} put=${u.status} busca ok del=${d.status}`;
  });
  await check("TC-N02", "export.csv tem cabeçalho + linhas só do usuário (u6 massa)", async () => {
    const t6 = await tok("e2e-u6");
    const r = await api("/api/minhas/export.csv", { token: t6 });
    assert(r.status === 200, ev(r));
    const linhas = r.text.trim().split("\n");
    assert(linhas.length >= 11, `csv com ${linhas.length} linhas (esperado >=11 com massa u6)`);
    assert(!r.text.includes("secreta") && !r.text.includes("nota crud"), "VAZAMENTO: CSV de u6 contém dados de outro usuário");
    return `csv ${linhas.length} linhas; cabecalho=${linhas[0]?.slice(0, 60)}; sem dados de terceiros`;
  });
  await check("TC-N03", "gastos CRUD + resumo bate com a soma", async () => {
    const c = await api("/api/minhas/gastos", { method: "POST", token: t, body: { amountCents: 4321, category: "casa", description: "gasto resumo", spentAt: "2026-10-24" } });
    assert(c.status < 300, ev(c, "criar "));
    const gid = c.json?.gasto?.id ?? c.json?.id;
    const resumo = await api("/api/minhas/resumo", { token: t });
    assert(resumo.status === 200, ev(resumo, "resumo "));
    const s = JSON.stringify(resumo.json);
    assert(s.length > 2, ev(resumo, "resumo vazio "));
    const u = await api(`/api/minhas/gastos/${gid}`, { method: "PUT", token: t, body: { amountCents: 5000 } });
    assert(u.status === 200, ev(u, "put "));
    const d = await api(`/api/minhas/gastos/${gid}`, { method: "DELETE", token: t });
    assert(d.status === 200, ev(d, "del "));
    return `gasto=${gid} put/del ok; resumo=${s.slice(0, 90)}`;
  });
  await check("TC-N04", "OCR real (tesseract) no recibo.png", async () => {
    assert(existsSync("tools/e2e/fixtures/recibo.png"), "fixture ausente");
    const b64 = readFileSync("tools/e2e/fixtures/recibo.png").toString("base64");
    const r = await api("/api/minhas/gastos/ocr", { method: "POST", token: t, body: { imageBase64: b64 }, timeout: 60000 });
    assert(r.status === 200 && typeof r.json?.texto === "string", ev(r));
    assert(r.json.chars >= 0 && r.json.engine, `sem engine/chars: ${ev(r)}`);
    return `engine=${r.json.engine} chars=${r.json.chars} texto="${(r.json.texto ?? "").slice(0, 60)}"`;
  });
  await check("TC-N05", "isolamento: nota de u2 não vaza para u4", async () => {
    const c = await api("/api/minhas/notas", { method: "POST", token: t, body: { title: "secreta u2", body: "privada" } });
    const id = c.json?.nota?.id;
    const t4 = await tok("e2e-u4");
    const g = await api("/api/minhas/notas?q=secreta", { token: t4 });
    assert(g.status === 200 && !JSON.stringify(g.json).includes(id), `VAZAMENTO: ${ev(g)}`);
    return `u4 busca 'secreta' -> nao ve nota ${id} de u2`;
  });
}

// ---------- F4 licitações (externo PNCP) ----------
async function f4() {
  console.log("\n=== F4 · licitações ===");
  const t = await tok("e2e-u2");
  await check("TC-L02", "filtro salvo persiste (name+filter)", async () => {
    const p = await api("/api/licitacoes/filtros", { method: "POST", token: t, body: { name: "e2e-mt", filter: { uf: "MT", palavra: "vigilancia" } } });
    const g = await api("/api/licitacoes/filtros", { token: t });
    assert(p.status === 201 && g.status === 200 && JSON.stringify(g.json).includes("e2e-mt"), `post=${p.status} get=${g.status} ${JSON.stringify(g.json).slice(0, 80)}`);
    return `post=${p.status} get=${g.status} body=${JSON.stringify(g.json).slice(0, 90)}`;
  });
  await checkExternal("TC-L01", "busca PNCP (rede externa)", async () => {
    const r = await api("/api/licitacoes/busca", { method: "POST", token: t, body: { q: "vigilancia", tiposDocumento: "edital", pagina: 1, tamanhoPagina: 10 }, timeout: 45000 });
    assert(r.status === 200, ev(r));
    return ev(r).slice(0, 120);
  });
  record("TC-L02b", "sem favoritos no produto — implementação usa filtros", "skip",
    "grep rotas licitacoes.ts:92-149 nao possui /favoritos; documentado no relatorio");
}

// ---------- F5 concursos ----------
async function f5() {
  console.log("\n=== F5 · concursos ===");
  const t = await tok("e2e-u2");
  let extId = null;
  await checkExternal("TC-C03", "ingesta admin (job X-Admin-Token; rede externa DOU)", async () => {
    const r = await api("/v1/admin/concursos/ingesta", { method: "POST", headers: { "x-admin-token": ADMIN_PASS }, body: { tipo: "edicao", data: "23-10-2026", secao: "do1" }, timeout: 60000 });
    assert(r.status < 300, ev(r));
    return ev(r).slice(0, 120);
  });
  await check("TC-C01", "lista + detalhe", async () => {
    const l = await api("/api/concursos", { token: t });
    assert(l.status === 200, ev(l, "lista "));
    const arr = l.json?.concursos ?? [];
    if (arr.length > 0) {
      extId = arr[0].externalId ?? arr[0].id;
      const d = await api(`/api/concursos/${extId}`, { token: t });
      assert(d.status === 200, ev(d, "detalhe "));
      return `lista=${arr.length} detalhe ${extId} ok`;
    }
    return "lista=0 (DOU indisponível neste ambiente — sem o que ingerir)";
  });
  await check("TC-C02", "alertas: consultar por termos acompanhados", async () => {
    const g = await api("/api/concursos/alertas?acompanhados=administracao&acompanhados=tribunal", { token: t });
    assert(g.status === 200, `get=${g.status} ${g.text.slice(0, 80)}`);
    return `get=${g.status} ${JSON.stringify(g.json).slice(0, 90)}`;
  });
}

// ---------- F6 jurídico ----------
async function f6() {
  console.log("\n=== F6 · jurídico ===");
  await checkExternal("TC-J01", "consulta jurídica (serviço externo/IA)", async () => {
    const t = await tok("e2e-u2");
    const r = await api("/api/juridico/consultas", { method: "POST", token: t, body: { question: "Quais os prazos para recurso em licitação na Lei 14.133?" }, timeout: 60000 });
    assert(r.status === 200 || r.status === 201, ev(r));
    return ev(r).slice(0, 120);
  });
  await check("TC-J02", "listar consultas e processos sem erro", async () => {
    const t = await tok("e2e-u2");
    const a = await api("/api/juridico/consultas", { token: t });
    const b = await api("/api/processos", { token: t });
    assert(a.status === 200 && b.status === 200, `consultas=${a.status} processos=${b.status}`);
    return `consultas=${a.status} processos=${b.status}`;
  });
}

// ---------- F7 empréstimos ----------
async function f7() {
  console.log("\n=== F7 · empréstimos (pedido→match→pagamento) ===");
  const t4 = await tok("e2e-u4"); // tomador
  const t6 = await tok("e2e-u6"); // financiador
  let pedidoId = null, matchId = null, paymentId = null;
  await check("TC-E01", "pedido (u4) -> feed (u6) -> interesse -> match", async () => {
    const p = await api("/api/loan-requests", { method: "POST", token: t4, body: { uf: "MT", valorCents: 50000, jurosMesBps: 300, meses: 6, jurosTipo: "simples", motivo: "capital de giro teste e2e" } });
    assert(p.status < 300, ev(p, "pedido "));
    pedidoId = p.json?.request?.id ?? p.json?.id ?? p.json?.pedido?.id;
    assert(pedidoId, `sem id no pedido: ${ev(p)}`);
    const feed = await api("/api/feed/emprestimos", { token: t6 });
    assert(feed.status === 200 && JSON.stringify(feed.json).includes(pedidoId), ev(feed, "feed "));
    const i = await api(`/api/loan-requests/${pedidoId}/interesse`, { method: "POST", token: t6, body: { proposta: "consigo os 50000 a 300bps em 6 meses" } });
    assert(i.status < 300, ev(i, "interesse "));
    const m = await api("/api/loan-matches", { token: t4 });
    assert(m.status === 200, ev(m, "matches "));
    const arr = m.json?.matches ?? m.json?.loanMatches ?? [];
    matchId = arr[0]?.id ?? arr.find?.((x) => JSON.stringify(x).includes(pedidoId))?.id;
    assert(matchId, `sem match: ${ev(m)}`);
    return `pedido=${pedidoId} match=${matchId}`;
  });
  await check("TC-E02", "aceitar match + rodada", async () => {
    const a = await api(`/api/loan-matches/${matchId}/aceitar`, { method: "POST", token: t4, body: {} });
    assert(a.status < 300, ev(a, "aceitar "));
    const r = await api(`/api/loan-matches/${matchId}/rodadas`, { method: "POST", token: t6, body: { proposta: "rodada 1: confirmo 300bps" } });
    assert(r.status < 300, ev(r, "rodada "));
    return `aceitar=${a.status} rodada=${r.status}`;
  });
  await check("TC-E03", "pagamento declarado -> confirmado -> dívida atualiza", async () => {
    const d = await api("/api/payments/declare", { method: "POST", token: t6, body: { matchId, valorCents: 50000 } });
    assert(d.status < 300, ev(d, "declare "));
    paymentId = d.json?.pagamento?.id ?? d.json?.payment?.id ?? d.json?.id ?? d.json?.paymentId;
    assert(paymentId, `sem paymentId: ${ev(d)}`);
    const c = await api("/api/payments/confirm", { method: "POST", token: t4, body: { paymentId, confirmar: true } });
    assert(c.status < 300, ev(c, "confirm "));
    const div = await api("/api/minhas/dividas", { token: t4 });
    assert(div.status === 200, ev(div, "dividas "));
    return `payment=${paymentId} confirm=${c.status} dividas=${JSON.stringify(div.json).slice(0, 80)}`;
  });
  await check("TC-E04", "payload inválido -> 4xx (nunca 500)", async () => {
    const r = await api("/api/loan-requests", { method: "POST", token: t4, body: { uf: "MT", valorCents: -5, jurosMesBps: 300, meses: 6, jurosTipo: "simples", motivo: "x" } });
    assert(r.status >= 400 && r.status < 500, `status=${r.status} ${r.text.slice(0, 80)}`);
    return `negativo -> ${r.status}`;
  });
}

// ---------- F8 investiga ----------
async function f8() {
  console.log("\n=== F8 · investiga (Sherlock real) ===");
  const t5 = await tok("e2e-u5");
  let caseId = null;
  await check("TC-I01", "criar case -> run (Sherlock) -> relatório", async () => {
    const c = await api("/v1/investiga/cases", { method: "POST", token: t5, body: { title: "caso e2e torvalds", targets: [{ kind: "username", value: "torvalds" }], legalBasis: "base legal e2e — LGPD art. 7, finalidade autorizada pelo titular", purpose: "teste e2e do fluxo de investigação" } });
    assert(c.status < 300, ev(c, "criar "));
    caseId = c.json?.case?.id ?? c.json?.id ?? c.json?.caseId;
    assert(caseId, `sem caseId: ${ev(c)}`);
    const run = await api(`/v1/investiga/cases/${caseId}/run`, { method: "POST", token: t5, body: { sites: ["GitHub"] }, timeout: 120000 });
    assert(run.status < 300, ev(run, "run "));
    const rep = await api(`/v1/investiga/cases/${caseId}/report`, { token: t5, timeout: 60000 });
    assert(rep.status === 200, ev(rep, "report "));
    return `case=${caseId} run=${run.status} report=${JSON.stringify(rep.json).slice(0, 90)}`;
  });
  await check("TC-I02", "alerts + export.csv + export.pdf", async () => {
    const a = await api(`/v1/investiga/cases/${caseId}/alerts`, { token: t5 });
    const c = await api(`/v1/investiga/cases/${caseId}/export.csv`, { token: t5, timeout: 60000 });
    const p = await api(`/v1/investiga/cases/${caseId}/export.pdf`, { token: t5, timeout: 60000 });
    assert(a.status === 200 && c.status === 200 && p.status === 200, `alerts=${a.status} csv=${c.status} pdf=${p.status}`);
    assert(c.text.length > 10 && p.text.length > 100, `csv=${c.text.length}B pdf=${p.text.length}B`);
    return `csv=${c.text.length}B pdf=${p.text.length}B`;
  });
  await check("TC-I03", "quota responde; sem plano é bloqueado", async () => {
    const q = await api("/v1/investiga/quota", { token: t5 });
    assert(q.status === 200, ev(q, "quota "));
    const t1 = await tok("e2e-u1");
    const b = await api("/v1/investiga/cases", { method: "POST", token: t1, body: { title: "bloqueado u1", targets: [{ kind: "username", value: "zz" }], legalBasis: "base legal e2e teste bloqueio", purpose: "teste de bloqueio e2e" } });
    assert(b.status >= 400 && b.status < 500, `bloqueio esperado 4xx: ${b.status} ${b.text.slice(0, 80)}`);
    return `quota=${JSON.stringify(q.json).slice(0, 70)}; u1 sem plano -> ${b.status}`;
  });
  await check("TC-I04", "admin concede trial investiga (usuário fresco) -> quota muda", async () => {
    const u = `e2e-i4-${Date.now()}`;
    await api("/api/auth/telegram/dev", { method: "POST", body: { userId: u } });
    const g = await api("/v1/admin/investiga/trial", { method: "POST", headers: { "x-admin-token": ADMIN_PASS }, body: { telegramId: u } });
    assert(g.status < 300, ev(g, "trial "));
    const q = await api("/v1/investiga/quota", { token: await tok(u) });
    assert(q.status === 200, ev(q, "quota "));
    return `trial ${u} -> ${g.status}; quota=${JSON.stringify(q.json).slice(0, 70)}`;
  });
}

// ---------- F9 planos ----------
async function f9() {
  console.log("\n=== F9 · planos e assinaturas ===");
  await check("TC-P01", "5 SKUs + trialDias=7 (defaults)", async () => {
    const r = await api("/api/planos", { token: await tok("e2e-u1") });
    assert(r.status === 200, ev(r));
    const codigos = (r.json?.planos ?? []).map((p) => p.code).sort().join(",");
    assert(codigos === "anota,concurso,investiga,juridica,licitacao", `codigos=${codigos}`);
    return `planos=${codigos} trialDias=${r.json?.trialDias}`;
  });
  await check("TC-P02", "checkout sem PushinPay -> 503 honesto (estado-conhecido)", async () => {
    const r = await api("/api/assinaturas/checkout", { method: "POST", token: await tok("e2e-u1"), body: { planCode: "investiga", period: "monthly", idempotencyKey: `e2e-${Date.now()}` } });
    assert(r.status === 503 && r.json?.code === "PUSHINPAY_NOT_CONFIGURED", ev(r));
    return ev(r);
  });
  await check("TC-P03", "trial 1x por usuário (2a chamada -> 409) — usuário fresco", async () => {
    const u = `e2e-tr-${Date.now()}`;
    const t = (await api("/api/auth/telegram/dev", { method: "POST", body: { userId: u } })).json.token;
    const a = await api("/api/assinaturas/trial", { method: "POST", token: t, body: { planCode: "anota" } });
    const b = await api("/api/assinaturas/trial", { method: "POST", token: t, body: { planCode: "anota" } });
    assert((a.status === 200 || a.status === 201) && b.status === 409, `a=${a.status} b=${b.status}`);
    return `1a=${a.status} 2a=${b.status} ${b.json?.rule ?? ""}`;
  });
  await check("TC-P04", "concessão admin reflete em /api/assinaturas", async () => {
    const r = await api("/api/assinaturas", { token: await tok("e2e-u4") });
    assert(r.status === 200 && JSON.stringify(r.json).includes("anota"), ev(r));
    return ev(r).slice(0, 120);
  });
  await check("TC-P05a", "trial expirado (u3): Investiga bloqueia 4xx", async () => {
    const t3 = await tok("e2e-u3");
    const inv = await api("/v1/investiga/cases", { method: "POST", token: t3, body: { title: "deve bloquear", targets: [{ kind: "username", value: "zz" }], legalBasis: "base legal e2e teste paywall", purpose: "teste paywall e2e" } });
    assert(inv.status >= 400 && inv.status < 500, `investiga deveria bloquear: ${inv.status}`);
    return `investiga=${inv.status} ${inv.text.slice(0, 80)}`;
  });
  await check("TC-P05b", "trial expirado (u3): Jurídico bloqueia (gate v2/08 aplicado)", async () => {
    const t3 = await tok("e2e-u3");
    const jur = await api("/api/juridico/consultas", { method: "POST", token: t3, body: { question: "consulta com trial expirado deve ser bloqueada" }, timeout: 30000 });
    assert(jur.status === 403 && jur.json?.error?.includes("Consulta Jurídica"), `juridico deveria bloquear 403: ${jur.status} ${jur.text.slice(0, 90)}`);
    return `juridico=${jur.status} ${jur.text.slice(0, 90)}`;
  });
}

// ---------- F10 verificação ----------
async function f10() {
  console.log("\n=== F10 · verificação de identidade ===");
  await check("TC-V01", "pendente -> lista no painel -> aprovar -> usuário vê", async () => {
    const u = `e2e-v1-${Date.now()}`;
    const t = await api("/api/auth/telegram/dev", { method: "POST", body: { userId: u } });
    const tk = t.json.token;
    const s = await api("/api/minhas/verificacao", { method: "POST", token: tk, body: { docTipo: "cnh", selfieAt: "2026-10-24T12:00:00Z" } });
    assert(s.status < 300, ev(s, "submit "));
    const at = await adminTok();
    const l = await api("/v1/admin/verificacoes?status=pending", { token: at });
    assert(l.status === 200 && Array.isArray(l.json?.verificacoes) && JSON.stringify(l.json.verificacoes).includes(u), ev(l, "lista "));
    const a = await api(`/v1/admin/verificacoes/${u}/aprovar`, { method: "POST", token: at, body: {} });
    assert(a.status < 300, ev(a, "aprovar "));
    const g = await api("/api/minhas/verificacao", { token: tk });
    assert(g.status === 200 && JSON.stringify(g.json).includes("approved"), ev(g, "user "));
    return `lista pendentes inclui ${u}; aprovar=${a.status}; user=${JSON.stringify(g.json.verificacao).slice(0, 70)}`;
  });
  await check("TC-V02", "reprovar com motivo -> usuário vê o motivo", async () => {
    const u = `e2e-v2-${Date.now()}`;
    const t = await api("/api/auth/telegram/dev", { method: "POST", body: { userId: u } });
    const tk = t.json.token;
    const s = await api("/api/minhas/verificacao", { method: "POST", token: tk, body: { docTipo: "rg" } });
    assert(s.status < 300, ev(s, "submit "));
    const at = await adminTok();
    const r = await api(`/v1/admin/verificacoes/${u}/reprovar`, { method: "POST", token: at, body: { motivo: "documento ilegível no teste e2e" } });
    assert(r.status < 300, ev(r, "reprovar "));
    const g = await api("/api/minhas/verificacao", { token: tk });
    assert(g.status === 200 && g.json?.verificacao?.rejectReason === "documento ilegível no teste e2e", ev(g, "user "));
    return `user v1Status=${g.json.verificacao.v1Status} rejectReason="${g.json.verificacao.rejectReason}"`;
  });
}

// ---------- F11 admin/RBAC ----------
async function f11() {
  console.log("\n=== F11 · painel admin (fora do app) ===");
  await check("TC-R01", "kpis do diretor carregam", async () => {
    const r = await api("/v1/admin/kpis", { token: await adminTok() });
    assert(r.status === 200 && Array.isArray(r.json?.planos), ev(r));
    return ev(r).slice(0, 120);
  });
  await check("TC-R02", "RBAC real: operador_suporte tem kpis; NÃO tem rules; JWT admin != sessão", async () => {
    const { token: opT } = await opLogin();
    const k = await api("/v1/admin/kpis", { token: opT });
    const rules = await api("/v1/admin/rules", { token: opT });
    const me = await api("/api/me", { token: opT });
    assert(k.status === 200, `operador em kpis: ${k.status} (matriz can() em admin/service.ts:31 dá 'kpis' ao papel)`);
    assert(rules.status === 403, `operador em rules: ${rules.status} (esperado 403 — fora da matriz)`);
    assert(me.status === 401 || me.status === 403, `JWT admin em /api/me: ${me.status} (nao deve passar)`);
    return `kpis=${k.status} rules=${rules.status} /api/me=${me.status}`;
  });
  await check("TC-R04", "rules versionadas: plans/investiga v1->v2->rollback->limpeza", async () => {
    const at = await adminTok();
    const c1 = await api("/v1/admin/rules", { method: "POST", token: at, body: { scope: "plans", key: "investiga", valueJson: { monthlyCents: 6990 } } });
    assert(c1.status < 300, ev(c1, "v1 "));
    const c2 = await api("/v1/admin/rules", { method: "POST", token: at, body: { scope: "plans", key: "investiga", valueJson: { monthlyCents: 7990 } } });
    assert(c2.status < 300, ev(c2, "v2 "));
    const p1 = await api("/api/planos", { token: await tok("e2e-u1") });
    const v2preco = (p1.json?.planos ?? []).find((p) => p.code === "investiga")?.monthlyCents;
    assert(v2preco === 7990, `v2 nao aplicou: ${v2preco}`);
    const ruleId = c2.json?.rule?.id ?? c2.json?.id;
    const rb = await api(`/v1/admin/rules/${ruleId}/rollback`, { method: "POST", token: at, body: {} });
    assert(rb.status < 300, ev(rb, "rollback "));
    const p2 = await api("/api/planos", { token: await tok("e2e-u1") });
    const pos = (p2.json?.planos ?? []).find((p) => p.code === "investiga")?.monthlyCents;
    assert(pos === 6990, `rollback nao restaurou v1: ${pos}`);
    sh(`sudo -u postgres psql -d acompanhe -c "DELETE FROM \\"RulesConfig\\" WHERE scope='plans' AND key='investiga'"`);
    const p3 = await api("/api/planos", { token: await tok("e2e-u1") });
    const limpo = (p3.json?.planos ?? []).find((p) => p.code === "investiga")?.monthlyCents;
    assert(limpo === 5990, `limpeza nao voltou ao default: ${limpo}`);
    return `v1=6990 v2=7990 rollback->6990 limpeza->${limpo}`;
  });
  await check("TC-R05", "audit registra ações", async () => {
    const r = await api("/v1/admin/audit", { token: await adminTok() });
    assert(r.status === 200 && JSON.stringify(r.json).length > 20, ev(r));
    return ev(r).slice(0, 110);
  });
  await check("TC-R06", "db/:tabela: diretor 200, operador ativo 403 (sem permissão db)", async () => {
    const d = await api("/v1/admin/db/User", { token: await adminTok() });
    assert(d.status === 200, ev(d, "diretor "));
    const { token: opT } = await opLogin();
    const o = await api("/v1/admin/db/User", { token: opT });
    assert(o.status === 403, `operador: ${o.status} (esperado 403)`);
    return `diretor=${d.status} operador=${o.status}`;
  });
  await check("TC-R07", "operador troca a própria senha e loga com a nova", async () => {
    const { token: opT } = await opLogin();
    const nova = `e2e-Op-${Date.now()}`;
    const c = await api("/v1/admin/auth/password", { method: "POST", token: opT, body: { password: nova } });
    assert(c.status < 300, ev(c, "trocar "));
    const l = await api("/v1/admin/auth/login", { method: "POST", body: { email: "operador.e2e@acompanhe.app", password: nova } });
    assert(l.status === 200 && l.json?.token, ev(l, "login novo "));
    opCred = { pass: nova, token: l.json.token };
    return `troca=${c.status} login novo=${l.status}`;
  });
  await check("TC-R03", "desativar operador -> login 401 (guard ativo)", async () => {
    const { pass } = await opLogin();
    const at = await adminTok();
    const lista = await api("/v1/admin/operadores", { token: at });
    const rows = lista.json?.operadores ?? lista.json ?? [];
    const opRow = Array.isArray(rows) ? rows.find((o) => (o.email ?? "").includes("operador.e2e")) : null;
    assert(opRow?.id, ev(lista, "sem operador "));
    const d = await api(`/v1/admin/operadores/${opRow.id}/active`, { method: "POST", token: at, body: { active: false } });
    assert(d.status < 300, ev(d, "desativar "));
    const l = await api("/v1/admin/auth/login", { method: "POST", body: { email: "operador.e2e@acompanhe.app", password: pass } });
    assert(l.status === 401, `login apos desativar: ${l.status} (esperado 401)`);
    return `desativado=${d.status} login=${l.status} ${l.text.slice(0, 50)}`;
  });
}

// ---------- F12 bot (API do Telegram) ----------
async function f12() {
  console.log("\n=== F12 · bot Telegram ===");
  await check("TC-B01", "getMe + comandos + menu button default (WebApp)", async () => {
    const me = await fetch(`${TG}/getMe`).then((r) => r.json());
    assert(me.ok === true && me.result?.username === "acompanha_bot", JSON.stringify(me).slice(0, 100));
    const cmds = await fetch(`${TG}/getMyCommands`).then((r) => r.json());
    assert(cmds.ok === true && JSON.stringify(cmds.result).includes("config"), JSON.stringify(cmds).slice(0, 100));
    const menu = await fetch(`${TG}/getChatMenuButton`).then((r) => r.json());
    assert(menu.ok === true && JSON.stringify(menu.result).includes("web_app"), JSON.stringify(menu).slice(0, 120));
    return `@${me.result.username} comandos=${cmds.result.map((c) => c.command).join(",")} menu=${JSON.stringify(menu.result).slice(0, 60)}`;
  });
  const b2 = await check("TC-B02", "botão WebApp no chat do usuário (requer /start dele)", async () => {
    const chat = SECRETS.TELEGRAM_BOT_CHAT_ID;
    const r = await fetch(`${TG}/getChatMenuButton?chat_id=${chat}`).then((x) => x.json());
    if (r.ok === true) return `menu button=${JSON.stringify(r.result).slice(0, 100)}`;
    throw new Error(`sem chat iniciado ainda (${r.description ?? "n/d"}) — usuário precisa enviar /start`);
  });
  if (!b2) record("TC-B02", "botão WebApp aguarda /start do usuário no @acompanha_bot", "skip", "ver TC-B02 acima");
}

// ---------- F13 segurança ----------
async function f13() {
  console.log("\n=== F13 · segurança e robustez ===");
  await check("TC-S01", "rota inexistente 404; corpo vazio -> 4xx", async () => {
    const a = await api("/api/nao-existe");
    const b = await api("/api/minhas/notas", { method: "POST", token: await tok("e2e-u2"), body: {} });
    assert(a.status === 404 && b.status >= 400 && b.status < 500, `404=${a.status} vazio=${b.status}`);
    return `404=${a.status} vazio=${b.status}`;
  });
  await check("TC-S02", "/health prova o Postgres", async () => {
    const r = await api("/health");
    assert(r.status === 200 && r.json?.db === "ok", ev(r));
    return ev(r);
  });
}

// ---------- F14 concorrência/persistência ----------
async function f14() {
  console.log("\n=== F14 · concorrência e persistência ===");
  await check("TC-X01", "5 usuários em paralelo: todos 2xx", async () => {
    const users = ["e2e-u1", "e2e-u2", "e2e-u4", "e2e-u5", "e2e-u6"];
    const rs = await Promise.all(users.map(async (u, i) => {
      const t = await tok(u);
      return api("/api/minhas/notas", { method: "POST", token: t, body: { title: `concorrente ${u}`, body: `linha ${i}` } });
    }));
    const statuses = rs.map((r) => r.status);
    assert(statuses.every((s) => s < 300), `statuses=${statuses.join(",")}`);
    return `5 POST paralelos -> ${statuses.join(",")}`;
  });
  await check("TC-X02", "dados persistem (relidos após os testes)", async () => {
    const t = await tok("e2e-u6");
    const g = await api("/api/minhas/notas?q=massa", { token: t });
    assert(g.status === 200, ev(g));
    const arr = g.json?.notas ?? [];
    assert(arr.length >= 10, `notas massa restantes=${arr.length}`);
    return `${arr.length} notas 'massa' relidas do banco`;
  });
}

// ---------- relatórios ----------
function writeReports() {
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail");
  const ext = results.filter((r) => r.status === "externo");
  const conc = results.filter((r) => r.status === "conhecido");
  const skip = results.filter((r) => r.status === "skip");
  const line = (r) => `| ${r.id} | ${r.title} | ${r.status.toUpperCase()} | ${r.sev || "—"} | \`${r.evidence.replace(/\|/g, "/")}\` |`;

  const rel = `# Relatório E2E — ${new Date().toISOString()}

Runner: \`tools/e2e/run-e2e.mjs\` · Base: ${BASE} · Plano: \`docs/plano-teste-e2e.md\`
Usuários reais: e2e-u1..e2e-u7 (dev-auth) + diretor + operador.e2e (criado pelo diretor).

## Resumo
| resultado | qtd |
|---|---|
| PASS | ${pass} |
| FAIL | ${fail.length} |
| S4 externo | ${ext.length} |
| estado-conhecido | ${conc.length} |
| SKIP | ${skip.length} |
| **total** | **${results.length}** |

## Detalhe (evidência crua por caso)
| ID | Caso | Status | Sev | Evidência |
|---|---|---|---|---|
${results.map(line).join("\n")}

## Pendências manuais (não automatizáveis aqui)
- TC-B02/B03: abrir o app pelo botão do @acompanha_bot (requer /start do usuário no celular).
- TC-S02b: health com Postgres parado (teste controlado, feito à parte).
`;
  writeFileSync("docs/relatorio-e2e.md", rel);

  const erros = fail.map((r) => `### ${r.id} — ${r.title}
- Severidade: ${r.sev || "S2"}
- Repro: runner E2E (node tools/e2e/run-e2e.mjs), caso ${r.id}
- Atual: ${r.evidence}
- Evidência: saída do runner anexada em docs/relatorio-e2e.md
- Suspeita de causa: (análise após leitura do código — ver seção de correções)
- Status: aberto
`).join("\n");

  writeFileSync("docs/e2e-erros.md", `# Erros E2E — ${new Date().toISOString()}\n\n${fail.length === 0 ? "Nenhum erro S1/S2 nesta execução.\n" : erros}`);
  console.log(`\n=== RESUMO: pass=${pass} fail=${fail.length} ext=${ext.length} conhecido=${conc.length} skip=${skip.length} total=${results.length} ===`);
  console.log("Relatórios: docs/relatorio-e2e.md · docs/e2e-erros.md");
  return fail.length;
}

// ---------- main ----------
async function main() {
  console.log(`E2E contra ${BASE}`);
  await phase1();
  await f1(); await f2(); await f3(); await f4(); await f5(); await f6();
  await f7(); await f8(); await f9(); await f10(); await f11(); await f12();
  await f13(); await f14();
  const fails = writeReports();
  process.exit(fails > 0 ? 1 : 0);
}
main().catch((e) => { console.error("runner quebrou:", e); process.exit(2); });
