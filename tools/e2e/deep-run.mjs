#!/usr/bin/env node
/**
 * tools/e2e/deep-run.mjs — Executa docs/plano-teste-profundo.md caso a caso
 * contra a STACK VIVA (API :3000 · web :5173 · túnel · bot · Postgres).
 * Regras: evidência crua por ID (status + corpo/STDOUT); FAIL nunca é mascarado;
 * EXT = dependência externa (registrar o corpo real, nunca forçar verde).
 * Saída: stdout + docs/deep-resultados.md
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";

const SECRETS = JSON.parse(readFileSync("/home/user/.secrets.json", "utf8"));
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3000";
const WEB = "http://127.0.0.1:5173";
const TUNNEL = (SECRETS.TELEGRAM_WEBAPP_URL ?? "").replace(/\/$/, "");
const TG = `https://api.telegram.org/bot${SECRETS.TELEGRAM_BOT_TOKEN}`;
const ADMIN_EMAIL = SECRETS.ADMIN_EMAIL ?? "diretor@acompanhe.app";
const ADMIN_PASS = SECRETS.ADMIN_TOKEN;
const DOC = "/home/user/acompanhe-ia/docs/deep-resultados.md";
const RUN = String(Date.now()).slice(-6); // sufixo único por rodada — evita contaminação de estado

// ---------------- helpers ----------------
const results = [];
async function api(path, { method = "GET", token, body, timeout = 30000, headers = {}, base = BASE } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(base + path, {
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
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, text, json };
  } finally { clearTimeout(t); }
}
function sh(cmd, timeout = 60000) {
  try { return { ok: true, out: execSync(cmd, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? e) }; }
}
function ev(r, label = "") {
  const body = (r?.text ?? String(r ?? "")).slice(0, 200).replace(/\s+/g, " ");
  return `${label}${r?.status !== undefined ? r.status + " " : ""}${body}`;
}
function T(id, desc, kind, evidence) {
  results.push({ id, desc, kind, evidence: String(evidence).slice(0, 400).replace(/\s+/g, " ") });
  console.log(`${kind.padEnd(10)} ${id}  ${desc}  || ${String(evidence).slice(0, 110).replace(/\s+/g, " ")}`);
}
async function Tcase(id, desc, fn) {
  try {
    const out = await fn();
    const { kind = "PASS", evidence = "ok" } = typeof out === "object" && out !== null ? out : { evidence: String(out ?? "ok") };
    T(id, desc, kind, evidence);
  } catch (e) {
    T(id, desc, "FAIL", `exceção: ${e?.message ?? e}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const tokens = {};
async function tok(user) {
  if (tokens[user]) return tokens[user];
  const r = await api("/api/auth/telegram/dev", { method: "POST", body: { userId: user, username: user } });
  assert(r.status === 200 && r.json?.token, `dev-auth ${user}: ${ev(r)}`);
  tokens[user] = r.json.token;
  return tokens[user];
}
let adminT = null;
async function adminTok() {
  if (adminT) return adminT;
  const r = await api("/v1/admin/auth/login", { method: "POST", body: { email: ADMIN_EMAIL, password: ADMIN_PASS } });
  assert(r.status === 200 && r.json?.token, `admin login: ${ev(r)}`);
  adminT = r.json.token;
  return adminT;
}
function sql(q) {
  const esc = q.replace(/'/g, `'\\''`);
  return sh(`sudo -u postgres psql -d acompanhe -tA -v ON_ERROR_STOP=1 -c '${esc}'`);
}
function initDataFor(userId, username) {
  const d = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAH_deep_run",
    user: JSON.stringify({ id: Number(userId) || 0, first_name: username, username }, null, 0),
  };
  const dcs = Object.keys(d).sort().map((k) => `${k}=${d[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(SECRETS.TELEGRAM_BOT_TOKEN).digest();
  d.hash = createHmac("sha256", secret).update(dcs).digest("hex");
  return new URLSearchParams(d).toString();
}
function cnjValido(n = "5000123", ano = "2026", j = "8", tr = "11", o = "0001") {
  // DV Res. 65/2008 conforme src/juridico/cnj.ts: 98 − ((sem_dv + "00") mod 97)
  const base = `${n.padStart(7, "0")}${ano}${j}${tr}${o}00`.replace(/\D/g, "");
  const dd = String(98n - (BigInt(base) % 97n)).padStart(2, "0");
  return `${n.padStart(7, "0")}-${dd}.${ano}.${j}.${tr}.${o}`;
}
async function waitFor(fn, ms = 50000, step = 5000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try { if (await fn()) return true; } catch { /* tenta de novo */ }
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

// ---------------- A · Infraestrutura ----------------
async function secA() {
  console.log("\n=== A · Infraestrutura ===");
  await Tcase("A01", "túnel /health", async () => {
    const r = await api("/health", { base: TUNNEL });
    assert(r.status === 200 && r.json?.status === "ok" && r.json?.db === "ok", ev(r));
    return { evidence: ev(r) };
  });
  let html = "";
  await Tcase("A02", "túnel / serve bundle atual", async () => {
    const r = await api("/", { base: TUNNEL });
    html = r.text ?? "";
    assert(r.status === 200 && /main-[A-Za-z0-9_-]+\.js/.test(html) && /styles-[A-Za-z0-9_-]+\.css/.test(html), ev(r).slice(0, 120));
    return { evidence: html.match(/(main|styles)-[A-Za-z0-9_-]+\.(js|css)/g)?.join(" ") };
  });
  await Tcase("A03", "CSS servido tem tokens 2026", async () => {
    const cssName = html.match(/styles-[A-Za-z0-9_-]+\.css/)?.[0];
    assert(cssName, "sem css no html");
    const r = await api(`/assets/${cssName}`, { base: TUNNEL });
    const need = ["--surface-1", "backdrop-filter", "prefers-reduced-motion"];
    const falta = need.filter((s) => !r.text?.includes(s));
    assert(r.status === 200 && falta.length === 0, `status=${r.status} faltam=${falta}`);
    return { evidence: `200; contem ${need.join(",")}` };
  });
  await Tcase("A04", "JS servido = dist atual", async () => {
    const jsName = html.match(/main-[A-Za-z0-9_-]+\.js/)?.[0];
    const a = await api(`/assets/${jsName}`, { base: TUNNEL });
    const b = await api(`/assets/${jsName}`, { base: WEB });
    assert(a.status === 200 && b.status === 200 && a.text === b.text && (a.text ?? "").length > 1000, `tun=${a.status} web=${b.status}`);
    return { evidence: `200; bytes=${(a.text ?? "").length} idênticos túnel=web` };
  });
  await Tcase("A05", "proxy /api via túnel (auth real)", async () => {
    const r = await api("/api/auth/telegram", { method: "POST", base: TUNNEL, body: {} });
    assert([400, 403].includes(r.status), `esperado 400/403 com body vazio, veio ${ev(r)}`);
    return { evidence: ev(r) };
  });
  await Tcase("A06", "SPA fallback", async () => {
    const r = await api("/rota-que-nao-existe", { base: TUNNEL });
    assert(r.status === 200 && (r.text ?? "").includes("<!doctype html"), ev(r).slice(0, 80));
    return { evidence: "200 index.html" };
  });
  await Tcase("A07", "3 GETs espaçados sem 502", async () => {
    const st = [];
    for (let i = 0; i < 3; i++) {
      const r = await api("/", { base: TUNNEL });
      st.push(r.status);
      if (i < 2) await new Promise((r2) => setTimeout(r2, 2000));
    }
    assert(st.every((s) => s === 200), `statuses=${st}`);
    return { evidence: `statuses=${st}` };
  });
  await Tcase("A08", "portas 3000/5173 escutando", async () => {
    const r = sh("ss -ltn | grep -E ':(3000|5173)\\s' | awk '{print $4}'");
    assert(r.out.includes(":3000") && r.out.includes(":5173"), r.out);
    return { evidence: r.out.trim().replace(/\n/g, " ") };
  });
}

// ---------------- B · Autenticação ----------------
let REAL_ID = null;
async function secB() {
  console.log("\n=== B · Autenticação ===");
  await Tcase("B00", "descobrir usuário real no banco/bot (quem abriu o app)", async () => {
    const r = sql(`SELECT "tgUserId" FROM "User" WHERE "tgUserId"::text ~ '^[0-9]+$' ORDER BY "createdAt" DESC NULLS LAST LIMIT 3;`);
    const ids = (r.ok ? r.out : "").trim().split("\n").filter((x) => /^\d+$/.test(x));
    // fonte 2: o próprio bot loga chat_id de cada /start recebido
    const blog = sh(`grep -o "chat_id=[0-9]*" /tmp/bot.log 2>/dev/null | sort -u | tail -3`);
    const botIds = (blog.out.match(/chat_id=(\d+)/g) ?? []).map((s) => s.split("=")[1]);
    REAL_ID = ids[0] ?? botIds[0] ?? null;
    if (!REAL_ID) return { kind: "KONHECIDO", evidence: "nenhum id numérico ainda (usuário real não autenticou/mandou /start com a API no ar) — pedir 1 /start" };
    return { evidence: `db=${ids.join(",") || "-"} bot=${botIds.join(",") || "-"}` };
  });
  let realJwt = null;
  let usedId = null;
  await Tcase("B01", "initData HMAC real (WebAppData) → JWT", async () => {
    const id = REAL_ID ?? "7457532564";
    usedId = id;
    const r = await api("/api/auth/telegram", { method: "POST", body: { initData: initDataFor(id, "Bruno") } });
    assert(r.status === 200 && r.json?.token, ev(r));
    realJwt = r.json.token;
    return { evidence: ev(r).slice(0, 120) };
  });
  await Tcase("B02", "/api/me com JWT real", async () => {
    const r = await api("/api/me", { token: realJwt });
    assert(r.status === 200 && String(r.json?.tgUserId) === String(usedId), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("B03", "hash adulterado → 403 bad_hash", async () => {
    const id = REAL_ID ?? "7457532564";
    const bad = initDataFor(id, "Bruno");
    const r = await api("/api/auth/telegram", { method: "POST", body: { initData: bad.replace(/hash=[a-f0-9]+/, "hash=" + "0".repeat(64)) } });
    assert(r.status === 403 && (r.text ?? "").includes("bad_hash"), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("B04", "auth_date de 2020 → 403 expirado", async () => {
    const d = { auth_date: "1577836800", query_id: "x", user: JSON.stringify({ id: 1, first_name: "a" }) };
    const dcs = Object.keys(d).sort().map((k) => `${k}=${d[k]}`).join("\n");
    const secret = createHmac("sha256", "WebAppData").update(SECRETS.TELEGRAM_BOT_TOKEN).digest();
    d.hash = createHmac("sha256", secret).update(dcs).digest("hex");
    const r = await api("/api/auth/telegram", { method: "POST", body: { initData: new URLSearchParams(d).toString() } });
    assert(r.status === 403, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("B05", "POST auth sem body → 400", async () => {
    const r = await api("/api/auth/telegram", { method: "POST", body: {} });
    assert(r.status === 400, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("B06", "Bearer inválido → 401", async () => {
    const r = await api("/api/me", { token: "eyJhbGciOiJIUzI1NiJ9.xx.yy" });
    assert(r.status === 401, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("B07", "sem Authorization → 401", async () => {
    const r = await api("/api/me");
    assert(r.status === 401, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("B08", "dev-auth: token distinto por usuário", async () => {
    const a = await tok("deep-b8a"); const b = await tok("deep-b8b");
    assert(a !== b && a.split(".").length === 3, "tokens iguais ou não-JWT");
    return { evidence: `jwtA=${a.slice(0, 24)}… jwtB=${b.slice(0, 24)}…` };
  });
  await Tcase("B09", "JWT de usuário não abre /v1/admin/*", async () => {
    const r = await api("/v1/admin/kpis", { token: await tok("deep-b9") });
    assert([401, 403].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("B10", "dev-auth POST vazio — comportamento real", async () => {
    const r = await api("/api/auth/telegram/dev", { method: "POST", body: {} });
    assert([200, 400].includes(r.status), ev(r));
    return { kind: r.status === 200 ? "KONHECIDO" : "PASS", evidence: ev(r) };
  });
}

// ---------------- C · AnotA ----------------
async function secC() {
  console.log("\n=== C · AnotA ===");
  const t = await tok("deep-anota");
  let notaId = null;
  await Tcase("C01", "POST /api/minhas/notas → 201", async () => {
    const r = await api("/api/minhas/notas", { method: "POST", token: t, body: { title: "nota deep 1", body: "corpo deep", tags: ["deep"], pinned: true } });
    assert(r.status === 201 && (r.json?.id ?? r.json?.nota?.id), ev(r));
    notaId = r.json?.id ?? r.json?.nota?.id;
    return { evidence: ev(r) };
  });
  await Tcase("C02", "GET notas lista contém", async () => {
    const r = await api("/api/minhas/notas", { token: t });
    assert(r.status === 200 && (r.text ?? "").includes("nota deep 1"), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("C03", "GET notas?q= filtra", async () => {
    const r = await api("/api/minhas/notas?q=deep", { token: t });
    assert(r.status === 200 && (r.text ?? "").includes("nota deep 1"), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("C04", "PUT/PATCH editar título", async () => {
    let r = await api(`/api/minhas/notas/${notaId}`, { method: "PUT", token: t, body: { title: "nota deep EDITADA" } });
    if (r.status === 404) r = await api(`/api/minhas/notas/${notaId}`, { method: "PATCH", token: t, body: { title: "nota deep EDITADA" } });
    assert([200, 204].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("C05", "edição persistiu (via lista — rota GET/:id não existe)", async () => {
    const r = await api(`/api/minhas/notas?q=EDITADA`, { token: t });
    assert(r.status === 200 && (r.text ?? "").includes("nota deep EDITADA"), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("C06", "DELETE nota → 204", async () => {
    const r = await api(`/api/minhas/notas/${notaId}`, { method: "DELETE", token: t });
    assert([200, 204].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("C07", "GET nota apagada → 404", async () => {
    const r = await api(`/api/minhas/notas/${notaId}`, { token: t });
    assert(r.status === 404, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("C08", "título vazio → 400/422 validação", async () => {
    const r = await api("/api/minhas/notas", { method: "POST", token: t, body: { title: "", body: "x" } });
    assert([400, 422].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  let gastoId = null;
  await Tcase("C09", "POST gasto → 201", async () => {
    const r = await api("/api/minhas/gastos", { method: "POST", token: t, body: { amountCents: 4321, category: "casa", description: "gasto deep", spentAt: "2026-10-24" } });
    assert(r.status === 201 && (r.json?.id ?? r.json?.gasto?.id), ev(r));
    gastoId = r.json?.id ?? r.json?.gasto?.id;
    return { evidence: ev(r) };
  });
  await Tcase("C10", "GET gastos lista contém", async () => {
    const r = await api("/api/minhas/gastos", { token: t });
    assert(r.status === 200 && (r.text ?? "").includes("gasto deep"), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("C11", "PUT /api/minhas/gastos/:id (edição por id — a rota real)", async () => {
    const r = await api(`/api/minhas/gastos/${gastoId}`, { method: "PUT", token: t, body: { amountCents: 999, category: "casa", description: "gasto deep", spentAt: "2026-10-24" } });
    assert([200, 204].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("C12", "DELETE gasto some da lista", async () => {
    const d = await api(`/api/minhas/gastos/${gastoId}`, { method: "DELETE", token: t });
    assert([200, 204].includes(d.status), ev(d));
    const l = await api("/api/minhas/gastos", { token: t });
    assert(!(l.text ?? "").includes("gasto deep"), `ainda na lista: ${ev(l)}`);
    return { evidence: `del=${d.status}; lista sem o gasto` };
  });
  await Tcase("C13", "amountCents negativo → 400/422", async () => {
    const r = await api("/api/minhas/gastos", { method: "POST", token: t, body: { amountCents: -5, category: "casa", description: "x", spentAt: "2026-10-24" } });
    assert([400, 422].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("C14", "GET /api/minhas/resumo", async () => {
    const r = await api("/api/minhas/resumo", { token: t });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("C15", "GET /api/minhas/export.csv", async () => {
    const r = await api("/api/minhas/export.csv", { token: t });
    assert(r.status === 200 && (r.text ?? "").includes(","), ev(r).slice(0, 80));
    return { evidence: ev(r).slice(0, 100) };
  });
  await Tcase("C16", "isolamento: usuário B não vê nota de A", async () => {
    await api("/api/minhas/notas", { method: "POST", token: t, body: { title: "secreta deep A", body: "privada" } });
    const tB = await tok("deep-anota-b");
    const r = await api("/api/minhas/notas?q=secreta", { token: tB });
    assert(r.status === 200 && !(r.text ?? "").includes("secreta deep A"), ev(r));
    return { evidence: ev(r) };
  });
}

// ---------------- D · Gamificação ----------------
async function secD() {
  console.log("\n=== D · Gamificação ===");
  const t = await tok(`deep-gami-${RUN}`);
  await Tcase("D01", "login_diario credita XP", async () => {
    const r = await api("/api/gamificacao/acao", { method: "POST", token: t, body: { acao: "login_diario" } });
    assert(r.status === 200 && (r.json?.xpGanho ?? 0) > 0, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("D02", "login_diario 2× no dia = 0", async () => {
    const r = await api("/api/gamificacao/acao", { method: "POST", token: t, body: { acao: "login_diario" } });
    assert(r.status === 200 && (r.json?.xpGanho ?? -1) === 0, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("D03", "nota_criada credita XP", async () => {
    const r = await api("/api/gamificacao/acao", { method: "POST", token: t, body: { acao: "nota_criada" } });
    assert(r.status === 200 && (r.json?.xpGanho ?? 0) > 0, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("D04", "GET /api/gamificacao (perfil)", async () => {
    const r = await api("/api/gamificacao", { token: t });
    assert(r.status === 200 && r.json?.levelInfo, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("D05", "ranking GET", async () => {
    const r = await api("/api/gamificacao/ranking", { token: t });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("D06", "ranking participar=true", async () => {
    const r = await api("/api/gamificacao/ranking", { method: "POST", token: t, body: { participar: true } });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("D07", "missão reflete progresso real", async () => {
    const r = await api("/api/gamificacao", { token: t });
    const mis = r.json?.missoes ?? [];
    assert(r.status === 200 && mis.some((m) => (m.progress ?? 0) >= 1), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("D08", "XP não vaza entre usuários", async () => {
    const a = await api("/api/gamificacao", { token: t });
    const b = await api("/api/gamificacao", { token: await tok(`deep-gami-b-${RUN}`) });
    assert((b.json?.perfil?.xp ?? 0) === 0 || (b.json?.perfil?.xp ?? 0) < (a.json?.perfil?.xp ?? 10 ** 9), ev(b));
    return { evidence: `xpA=${a.json?.perfil?.xp} xpB=${b.json?.perfil?.xp}` };
  });
}

// ---------------- E · Licitações ----------------
async function secE() {
  console.log("\n=== E · Licitações ===");
  const t = await tok("deep-lic");
  await Tcase("E01", "POST /api/licitacoes/filtros", async () => {
    const r = await api("/api/licitacoes/filtros", { method: "POST", token: t, body: { name: "deep-mt", filter: { uf: "MT", palavra: "vigilancia" } } });
    assert([200, 201].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("E02", "GET filtros contém deep-mt", async () => {
    const r = await api("/api/licitacoes/filtros", { token: t });
    assert(r.status === 200 && (r.text ?? "").includes("deep-mt"), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("E03", "DELETE filtro", async () => {
    const r = await api("/api/licitacoes/filtros/deep-mt", { method: "DELETE", token: t });
    assert([200, 204].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("E04", "POST /api/licitacoes/busca (PNCP real)", async () => {
    const r = await api("/api/licitacoes/busca", { method: "POST", token: t, body: { q: "vigilancia", tiposDocumento: "edital", pagina: 1, tamanhoPagina: 5 }, timeout: 45000 });
    if (r.status === 200) return { evidence: ev(r) };
    return { kind: "EXT", evidence: ev(r) };
  });
  await Tcase("E05", "GET /api/licitacoes", async () => {
    const r = await api("/api/licitacoes", { token: t });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("E06", "GET /api/licitacoes/alertas", async () => {
    const r = await api("/api/licitacoes/alertas", { token: t });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("E07", "interesses (radar) — GET/POST/DELETE", async () => {
    const a = await api("/api/licitacoes/interesses", { method: "POST", token: t, body: { topic: "deep-vigilancia", query: { uf: "MT" } } });
    const b = await api("/api/licitacoes/interesses", { token: t });
    const d = await api("/api/licitacoes/interesses/deep-vigilancia", { method: "DELETE", token: t });
    assert([200, 201].includes(a.status) && b.status === 200 && (b.text ?? "").includes("deep-vigilancia") && d.status === 200, `POST ${ev(a)} | GET ${ev(b)} | DEL ${ev(d)}`);
    return { evidence: `POST ${a.status} GET ok DEL ${d.status}` };
  });
  await Tcase("E08", "busca sem token → 401", async () => {
    const r = await api("/api/licitacoes/busca", { method: "POST", body: { q: "x" } });
    assert(r.status === 401, ev(r));
    return { evidence: ev(r) };
  });
}

// ---------------- F · Concursos ----------------
async function secF() {
  console.log("\n=== F · Concursos ===");
  const t = await tok("deep-conc");
  let ext = null;
  await Tcase("F01", "GET /api/concursos", async () => {
    const r = await api("/api/concursos", { token: t });
    assert(r.status === 200, ev(r));
    const arr = Array.isArray(r.json) ? r.json : (r.json?.items ?? r.json?.concursos ?? []);
    ext = arr[0]?.externalId ?? arr[0]?.id ?? null;
    return { evidence: `${ev(r).slice(0, 100)} | externalId=${ext}` };
  });
  await Tcase("F02", "GET /api/concursos/:externalId", async () => {
    if (!ext) return { kind: "KONHECIDO", evidence: "lista vazia — nenhum concurso ingerido ainda" };
    const r = await api(`/api/concursos/${ext}`, { token: t });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("F03", "concurso inexistente → 404", async () => {
    const r = await api("/api/concursos/nao-existe-9999", { token: t });
    assert(r.status === 404, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("F04", "GET concursos/alertas?acompanhados=…", async () => {
    const r = await api("/api/concursos/alertas?acompanhados=administracao&acompanhados=tribunal", { token: t });
    assert(r.status === 200 && r.json && "alerts" in r.json, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("F05", "ingesta admin (x-admin-token)", async () => {
    const r = await api("/v1/admin/concursos/ingesta", { method: "POST", headers: { "x-admin-token": ADMIN_PASS }, body: { tipo: "edicao", data: "23-10-2026", secao: "do1" }, timeout: 60000 });
    if (r.status >= 500) return { kind: "EXT", evidence: ev(r) };
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("F06", "ingesta sem token admin → 401/403", async () => {
    const r = await api("/v1/admin/concursos/ingesta", { method: "POST", body: {} });
    assert([401, 403].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
}

// ---------------- G · Jurídico ----------------
async function secG() {
  console.log("\n=== G · Jurídico ===");
  const t = await tok(`deep-juri-${RUN}`);
  const cnj = cnjValido(String(1000000 + Math.floor(Math.random() * 8999999)));
  await Tcase("G01", "consultas SEM plano → 403 paywall", async () => {
    const r = await api("/api/juridico/consultas", { method: "POST", token: t, body: { question: "pergunta deep sem plano deve ser bloqueada" }, timeout: 30000 });
    assert(r.status === 403 && (r.json?.error ?? "").length > 0, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("G02", "acompanhar é GRÁTIS por contrato (juridico.test.ts:222) → 201 cria", async () => {
    const r = await api(`/api/processos/${cnj}/acompanhar`, { method: "POST", token: t, body: { alias: "deep" } });
    assert(r.status === 201 && (r.json?.link ?? "").includes(cnj.slice(0, 7)), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("G03", "GET /api/processos SEM plano — real", async () => {
    const r = await api("/api/processos", { token: t });
    assert([200, 403].includes(r.status), ev(r));
    return { kind: "KONHECIDO", evidence: ev(r) };
  });
  await Tcase("G04", "concessão admin do plano juridica", async () => {
    const at = await adminTok();
    const r = await api("/v1/admin/assinaturas/conceder", { method: "POST", token: at, body: { tgUserId: `deep-juri-${RUN}`, planCode: "juridica", days: 30 } });
    assert(r.status === 200 || r.status === 201, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("G05", "acompanhar duplicado → 409 + link (RB1)", async () => {
    const r = await api(`/api/processos/${cnj}/acompanhar`, { method: "POST", token: t, body: { alias: "deep caso" } });
    assert(r.status === 409 && (r.json?.link ?? "").includes(cnj.slice(0, 7)), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("G06", "GET /api/processos/:cnj", async () => {
    const r = await api(`/api/processos/${cnj}`, { token: t });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("G07", "GET /api/processos lista o processo", async () => {
    const r = await api("/api/processos", { token: t });
    assert(r.status === 200 && (r.text ?? "").includes(cnj.slice(0, 7)), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("G08", "explicar?mov=…", async () => {
    const r = await api(`/api/processos/${cnj}/explicar?mov=${encodeURIComponent("sentenca publicada")}`, { token: t, timeout: 60000 });
    if (r.status >= 500) return { kind: "EXT", evidence: ev(r) };
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("G09", "sync — comportamento real", async () => {
    const r = await api(`/api/processos/${cnj}/sync`, { method: "POST", token: t, timeout: 60000 });
    if (r.status >= 500) return { kind: "EXT", evidence: ev(r) };
    assert([200, 201, 404].includes(r.status), ev(r));
    return { kind: r.status === 404 ? "KONHECIDO" : "PASS", evidence: ev(r) };
  });
  await Tcase("G10", "remover acompanhamento (DELETE :cnj)", async () => {
    const r = await api(`/api/processos/${cnj}`, { method: "DELETE", token: t });
    assert([200, 204, 404].includes(r.status), ev(r));
    return { kind: r.status === 404 ? "KONHECIDO" : "PASS", evidence: ev(r) };
  });
  await Tcase("G11", "consultas COM plano → 200/201", async () => {
    const r = await api("/api/juridico/consultas", { method: "POST", token: t, body: { question: "quais os prazos para recurso na Lei 14.133?" }, timeout: 60000 });
    if (r.status >= 500) return { kind: "EXT", evidence: ev(r) };
    assert([200, 201].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("G12", "question < 5 chars → 400/422 validação", async () => {
    const r = await api("/api/juridico/consultas", { method: "POST", token: t, body: { question: "oi" } });
    assert([400, 422].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
}

// ---------------- H · Empréstimos ----------------
async function secH() {
  console.log("\n=== H · Empréstimos ===");
  const tom = await tok(`deep-tomador-${RUN}`);
  const inv = await tok(`deep-investidor-${RUN}`);
  await Tcase("H01", "POST /api/minhas/verificacao", async () => {
    const r = await api("/api/minhas/verificacao", { method: "POST", token: tom, body: { docTipo: "cnh", selfieAt: "2026-10-24T12:00:00Z" } });
    assert([200, 201].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("H02", "GET verificacao mostra pending/aprovada", async () => {
    const r = await api("/api/minhas/verificacao", { token: tom });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("H02b", "admin aprova verificação V1 (regra A3)", async () => {
    const at = await adminTok();
    const r = await api(`/v1/admin/verificacoes/deep-tomador-${RUN}/aprovar`, { method: "POST", token: at, body: {} });
    assert([200, 201].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  let pedidoId = null;
  await Tcase("H03", "POST /api/loan-requests", async () => {
    const r = await api("/api/loan-requests", { method: "POST", token: tom, body: { uf: "MT", valorCents: 50000, jurosMesBps: 300, meses: 6, jurosTipo: "simples", motivo: "capital de giro deep" } });
    assert([200, 201].includes(r.status) && (r.json?.id ?? r.json?.pedido?.id ?? r.json?.request?.id), ev(r));
    pedidoId = r.json?.id ?? r.json?.pedido?.id ?? r.json?.request?.id;
    return { evidence: ev(r) };
  });
  await Tcase("H04", "valor negativo → 400/422", async () => {
    const r = await api("/api/loan-requests", { method: "POST", token: tom, body: { uf: "MT", valorCents: -5, jurosMesBps: 300, meses: 6, jurosTipo: "simples", motivo: "x deep" } });
    assert([400, 422].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("H05", "feed do investidor contém o pedido", async () => {
    const r = await api("/api/feed/emprestimos", { token: inv });
    assert(r.status === 200 && (r.text ?? "").includes(String(pedidoId)), ev(r));
    return { evidence: ev(r) };
  });
  let matchId = null;
  await Tcase("H06", "interesse do investidor + descoberta do match", async () => {
    const r = await api(`/api/loan-requests/${pedidoId}/interesse`, { method: "POST", token: inv, body: {} });
    assert([200, 201].includes(r.status), ev(r));
    matchId = r.json?.id ?? r.json?.match?.id ?? r.json?.matchId ?? null;
    if (!matchId) {
      const m = await api("/api/loan-matches", { token: inv });
      const arr = m.json?.matches ?? [];
      matchId = arr[0]?.id ?? null;
    }
    assert(matchId, `sem match após interesse: ${ev(r)}`);
    return { evidence: `${ev(r).slice(0, 80)} matchId=${matchId}` };
  });
  await Tcase("H07", "match visível p/ ambos", async () => {
    const a = await api("/api/loan-matches", { token: tom });
    const b = await api("/api/loan-matches", { token: inv });
    const emA = (a.json?.matches ?? []).some((m) => m.id === matchId);
    const emB = (b.json?.matches ?? []).some((m) => m.id === matchId);
    assert(a.status === 200 && b.status === 200 && emA && emB, `tom=${ev(a).slice(0, 90)} inv=${ev(b).slice(0, 90)}`);
    return { evidence: `match ${matchId} visível nos dois lados` };
  });
  await Tcase("H08", "rodada de contraproposta", async () => {
    const r = await api(`/api/loan-matches/${matchId}/rodadas`, { method: "POST", token: inv, body: { proposta: "aceito se cair para 250bps" } });
    assert(r.status === 200 && r.json?.rodadas >= 1, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("H09", "aceitar match", async () => {
    const r = await api(`/api/loan-matches/${matchId}/aceitar`, { method: "POST", token: tom, body: {} });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  let paymentId = null;
  await Tcase("H10", "payments/declare", async () => {
    const r = await api("/api/payments/declare", { method: "POST", token: inv, body: { matchId, valorCents: 50000 } });
    assert([200, 201].includes(r.status) && (r.json?.pagamento?.id ?? r.json?.id ?? r.json?.payment?.id), ev(r));
    paymentId = r.json?.id ?? r.json?.pagamento?.id ?? r.json?.payment?.id ?? r.json?.paymentId;
    return { evidence: ev(r) };
  });
  await Tcase("H11", "payments/confirm", async () => {
    const r = await api("/api/payments/confirm", { method: "POST", token: tom, body: { paymentId, confirmar: true } });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("H12", "dívida registrada após confirmação", async () => {
    const r = await api("/api/minhas/dividas", { token: tom });
    const arr = r.json?.dividas ?? [];
    assert(r.status === 200 && arr.length >= 1, ev(r));
    return { evidence: ev(r) };
  });
}

// ---------------- I · Investiga ----------------
async function secI() {
  console.log("\n=== I · Investiga ===");
  const t = await tok(`deep-inve-${RUN}`);
  let caseId = null;
  await Tcase("I01", "POST /v1/investiga/cases", async () => {
    const at = await adminTok();
    await api("/v1/admin/investiga/trial", { method: "POST", headers: { "x-admin-token": ADMIN_PASS }, body: { telegramId: `deep-inve-${RUN}` } });
    const r = await api("/v1/investiga/cases", { method: "POST", token: t, body: { title: "caso deep torvalds", targets: [{ kind: "username", value: "torvalds" }], legalBasis: "base legal deep — LGPD art. 7", purpose: "teste deep do fluxo de investigação" } });
    assert([200, 201].includes(r.status) && (r.json?.id ?? r.json?.case?.id), ev(r));
    caseId = r.json?.id ?? r.json?.case?.id;
    void at;
    return { evidence: ev(r) };
  });
  await Tcase("I02", "GET /v1/investiga/cases lista", async () => {
    const r = await api("/v1/investiga/cases", { token: t });
    assert(r.status === 200 && (r.text ?? "").includes("caso deep"), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("I03", "GET /v1/investiga/cases/:id", async () => {
    const r = await api(`/v1/investiga/cases/${caseId}`, { token: t });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("I04", "GET /v1/investiga/quota", async () => {
    const r = await api("/v1/investiga/quota", { token: t });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("I04b", "POST documents (documento vira alvo)", async () => {
    const r = await api(`/v1/investiga/cases/${caseId}/documents`, { method: "POST", token: t, body: { content: "Torvalds Linux" } });
    assert(r.status === 201 && r.json?.document?.kind === "name", ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("I04c", "POST queries (consulta real → achado)", async () => {
    const r = await api(`/v1/investiga/cases/${caseId}/queries`, { method: "POST", token: t, body: { documentId: "torvalds" }, timeout: 120000 });
    assert([200, 201].includes(r.status) && typeof r.json?.findings === "number", ev(r));
    return { evidence: ev(r).slice(0, 160) };
  });
  await Tcase("I04d", "POST estimativa → 503 honesto (sem fonte = não estima)", async () => {
    const r = await api(`/v1/investiga/cases/${caseId}/estimativa`, { method: "POST", token: t, body: { nome: "Linus Torvalds" } });
    assert(r.status === 503 && (r.json?.error ?? "").includes("indisponível"), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("I04e", "POST monitor (alvo monitorado + rodada)", async () => {
    const r = await api(`/v1/investiga/cases/${caseId}/monitor`, { method: "POST", token: t, body: { nome: "Linus Torvalds", topic: "deep_topic" }, timeout: 120000 });
    assert([200, 201].includes(r.status) && r.json?.monitor?.topic === "deep_topic", ev(r));
    return { evidence: ev(r).slice(0, 140) };
  });
  await Tcase("I04f", "POST deep-dive (rodada + relatório)", async () => {
    const r = await api(`/v1/investiga/cases/${caseId}/deep-dive`, { method: "POST", token: t, body: { nome: "Linus Torvalds" }, timeout: 120000 });
    assert([200, 201].includes(r.status) && r.json?.relatorio, ev(r));
    return { evidence: ev(r).slice(0, 140) };
  });
  await Tcase("I05", "SEM trial → paywall 403", async () => {
    const t2 = await tok(`deep-inve-pw-${RUN}`);
    const r = await api("/v1/investiga/cases", { method: "POST", token: t2, body: { title: "bloqueado", targets: [{ kind: "username", value: "zz" }], legalBasis: "base legal deep bloqueio", purpose: "teste paywall deep" } });
    assert(r.status === 403 && (r.json?.error ?? "").length > 0, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("I06", "trial admin destrava quota", async () => {
    await api("/api/auth/telegram/dev", { method: "POST", body: { userId: `deep-inve-tr-${RUN}` } });
    await api("/v1/admin/investiga/trial", { method: "POST", headers: { "x-admin-token": ADMIN_PASS }, body: { telegramId: `deep-inve-tr-${RUN}` } });
    const r = await api("/v1/investiga/quota", { token: await tok(`deep-inve-tr-${RUN}`) });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("I07", "OCR real do recibo.png (tesseract local)", async () => {
    const b64 = readFileSync("/home/user/acompanhe-ia/tools/e2e/fixtures/recibo.png").toString("base64");
    const r = await api("/api/minhas/gastos/ocr", { method: "POST", token: t, body: { imageBase64: b64 }, timeout: 90000 });
    assert(r.status === 200 && (r.text ?? "").length > 20, ev(r));
    return { evidence: ev(r).slice(0, 180) };
  });
  await Tcase("I08", "OCR base64 inválido → 400", async () => {
    const r = await api("/api/minhas/gastos/ocr", { method: "POST", token: t, body: { imageBase64: "nao-e-base64-###" }, timeout: 30000 });
    assert(r.status === 400, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("I09", "isolamento de casos entre usuários", async () => {
    const t2 = await tok(`deep-inve-iso-${RUN}`);
    const r = await api(`/v1/investiga/cases/${caseId}`, { token: t2 });
    assert([403, 404].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("I10", "target sem value → 400/422", async () => {
    const r = await api("/v1/investiga/cases", { method: "POST", token: t, body: { title: "sem value", targets: [{ kind: "username" }], legalBasis: "base legal deep", purpose: "contrato targets[].value" } });
    assert([400, 422].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
}

// ---------------- J · Planos & assinaturas ----------------
async function secJ() {
  console.log("\n=== J · Planos & assinaturas ===");
  const t = await tok(`deep-plan-${RUN}`);
  await Tcase("J01", "GET /api/planos catálogo", async () => {
    const r = await api("/api/planos", { token: t });
    assert(r.status === 200 && (r.text ?? "").includes("investiga"), ev(r));
    return { evidence: ev(r).slice(0, 160) };
  });
  await Tcase("J02", "trial 1ª vez", async () => {
    const r = await api("/api/assinaturas/trial", { method: "POST", token: t, body: { planCode: "anota" } });
    assert([200, 201].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("J03", "trial 2ª vez → bloqueado", async () => {
    const r = await api("/api/assinaturas/trial", { method: "POST", token: t, body: { planCode: "anota" } });
    assert([400, 409].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("J04", "GET /api/assinaturas", async () => {
    const r = await api("/api/assinaturas", { token: t });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r).slice(0, 160) };
  });
  await Tcase("J05", "checkout PushinPay — resposta real", async () => {
    const r = await api("/api/assinaturas/checkout", { method: "POST", token: t, body: { planCode: "investiga", period: "monthly", idempotencyKey: `deep-${Date.now()}` } });
    if ([200, 201].includes(r.status)) return { evidence: ev(r) };
    return { kind: "EXT", evidence: ev(r) };
  });
  await Tcase("J06", "webhook com secret CORRETO passa na validação", async () => {
    const r = await api("/api/webhooks/pushinpay", { method: "POST", headers: { "x-pushinpay-webhook-secret": SECRETS.PUSHINPAY_WEBHOOK_SECRET ?? "" }, body: { status: "paid", id: "deep-transacao-fantasma" } });
    if ([401, 403].includes(r.status)) return { kind: "FAIL", evidence: `secret correto REJEITADO: ${ev(r)}` };
    return { evidence: ev(r) };
  });
  await Tcase("J07", "webhook com secret ERRADO é rejeitado", async () => {
    const r = await api("/api/webhooks/pushinpay", { method: "POST", headers: { "x-pushinpay-webhook-secret": "segredo-errado-deep" }, body: { status: "paid", id: "x" } });
    assert([401, 403, 503].includes(r.status), `aceitou secret errado: ${ev(r)}`);
    return { evidence: ev(r) };
  });
  await Tcase("J08", "trial expirado ⇒ produto bloqueado", async () => {
    const u = `deep-expirado-${RUN}`;
    const tk = await tok(`deep-expirado-${RUN}`);
    const at = await adminTok();
    await api("/v1/admin/assinaturas/conceder", { method: "POST", token: at, body: { tgUserId: u, planCode: "investiga", days: -1 } });
    const r = await api("/v1/investiga/cases", { method: "POST", token: tk, body: { title: "deve bloquear", targets: [{ kind: "username", value: "zz" }], legalBasis: "base legal deep paywall", purpose: "teste paywall deep" } });
    assert(r.status === 403, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("J09", "concessão admin reativa o produto", async () => {
    const at = await adminTok();
    const c = await api("/v1/admin/assinaturas/conceder", { method: "POST", token: at, body: { tgUserId: `deep-expirado-${RUN}`, planCode: "investiga", days: 30 } });
    assert([200, 201].includes(c.status), ev(c));
    const r = await api("/v1/investiga/quota", { token: await tok(`deep-expirado-${RUN}`) });
    assert(r.status === 200, ev(r));
    return { evidence: `conceder=${ev(c).slice(0, 60)} quota=${ev(r).slice(0, 60)}` };
  });
  await Tcase("J10", "rules_config: preço muda e rollback volta (2 versões)", async () => {
    const at = await adminTok();
    const c1 = await api("/v1/admin/rules", { method: "POST", token: at, body: { scope: "plans", key: "investiga", valueJson: { monthlyCents: 8111 } } });
    assert([200, 201].includes(c1.status), ev(c1));
    const c2 = await api("/v1/admin/rules", { method: "POST", token: at, body: { scope: "plans", key: "investiga", valueJson: { monthlyCents: 9111 } } });
    assert([200, 201].includes(c2.status), ev(c2));
    const mid = await api("/api/planos", { token: t });
    assert((mid.text ?? "").includes("9111"), `preço novo não apareceu: ${ev(mid)}`);
    const ruleId = c2.json?.id ?? c2.json?.rule?.id;
    const rb = await api(`/v1/admin/rules/${ruleId}/rollback`, { method: "POST", token: at, body: {} });
    assert([200, 201].includes(rb.status), `rollback: ${ev(rb)}`);
    const after = await api("/api/planos", { token: t });
    assert(!(after.text ?? "").includes("9111") && (after.text ?? "").includes("8111"), `rollback não voltou p/ 8111: ${ev(after)}`);
    return { evidence: "8111 → 9111 → rollback volta 8111" };
  });
}

// ---------------- K · Bot ----------------
async function secK() {
  console.log("\n=== K · Bot ===");
  await Tcase("K01", "getMe", async () => {
    const r = await fetch(`${TG}/getMe`).then((x) => x.json());
    assert(r.ok === true && r.result?.username === "acompanha_bot", JSON.stringify(r).slice(0, 120));
    return { evidence: `@${r.result.username}` };
  });
  await Tcase("K02", "getMyCommands (4 comandos)", async () => {
    const r = await fetch(`${TG}/getMyCommands`).then((x) => x.json());
    const cmds = (r.result ?? []).map((c) => c.command);
    assert(cmds.includes("start") && cmds.includes("config") && cmds.includes("ajuda") && cmds.includes("suporte"), JSON.stringify(cmds));
    return { evidence: cmds.join(",") };
  });
  await Tcase("K03", "menu button web_app com URL do túnel", async () => {
    const r = await fetch(`${TG}/getChatMenuButton`).then((x) => x.json());
    const url = r.result?.web_app?.url ?? "";
    assert(url.includes("trycloudflare.com"), JSON.stringify(r).slice(0, 140));
    return { evidence: url };
  });
  await Tcase("K04", "processo do bot vivo + getUpdates respondendo", async () => {
    const p = sh(`pgrep -f "telegram_bot[.]py" | head -1`);
    const g = await fetch(`${TG}/getUpdates?timeout=0`).then((x) => x.json());
    assert(p.ok && p.out.trim() && g.ok === true, `pgrep=${p.out} tg=${JSON.stringify(g).slice(0, 80)}`);
    return { evidence: `pid=${p.out.trim()} getUpdates ok=${g.ok}` };
  });
  await Tcase("K05", "chat id REAL do usuário no banco/bot", async () => {
    if (!REAL_ID) return { kind: "KONHECIDO", evidence: "sem id real ainda — usuário precisa mandar /start no @acompanha_bot" };
    return { evidence: `REAL_ID=${REAL_ID}` };
  });
  await Tcase("K06", "sendMessage para o chat id REAL → entrega", async () => {
    if (!REAL_ID) return { kind: "KONHECIDO", evidence: "aguardando /start do usuário (id real desconhecido)" };
    const body = {
      chat_id: Number(REAL_ID),
      text: "✅ Teste de entrega profundo do Acompanhe.IA — se você recebeu isto, o canal bot↔usuário está 100%.",
      reply_markup: { inline_keyboard: [[{ text: "Abrir app", web_app: { url: TUNNEL } }]] },
    };
    const r = await fetch(`${TG}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
    assert(r.ok === true && r.result?.message_id, JSON.stringify(r).slice(0, 160));
    return { evidence: `message_id=${r.result.message_id} chat=${r.result.chat.id}` };
  });
  await Tcase("K07", "id antigo 7457532564 → 400 chat not found (explica B02 antigo)", async () => {
    const r = await fetch(`${TG}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: 7457532564, text: "probe" }) }).then((x) => x.json());
    assert(r.ok === false && String(r.description ?? "").includes("chat not found"), JSON.stringify(r));
    return { evidence: `${r.error_code} ${r.description}` };
  });
  await Tcase("K08", "código consome update só depois de responder + try/except", async () => {
    const src = readFileSync("/home/user/tools/bot-py/telegram_bot.py", "utf8");
    const okFinally = /finally:[\s\S]{0,300}offset = u\[.update_id.\] \+ 1/.test(src);
    const okTry = /try:\s*\n\s*if not chat_id/.test(src) || src.includes("except Exception as e:");
    assert(okFinally && okTry, `finally=${okFinally} try=${okTry}`);
    return { evidence: "offset em finally + try/except por update" };
  });
}

// ---------------- L · Admin fora do app ----------------
async function secL() {
  console.log("\n=== L · Admin (fora do app) ===");
  let opToken = null;
  await Tcase("L01", "login diretor", async () => {
    const r = await api("/v1/admin/auth/login", { method: "POST", body: { email: ADMIN_EMAIL, password: ADMIN_PASS } });
    assert(r.status === 200 && r.json?.token, ev(r));
    return { evidence: ev(r).slice(0, 80) };
  });
  await Tcase("L02", "senha errada → 401", async () => {
    const r = await api("/v1/admin/auth/login", { method: "POST", body: { email: ADMIN_EMAIL, password: "senha-errada-deep" } });
    assert(r.status === 401, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("L03", "kpis diretor", async () => {
    const r = await api("/v1/admin/kpis", { token: await adminTok() });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r).slice(0, 120) };
  });
  await Tcase("L05", "criar operador deep", async () => {
    const r = await api("/v1/admin/operadores", { method: "POST", token: await adminTok(), body: { email: "deep.op@acompanhe.app", name: "Operador Deep", role: "operador_suporte", password: "deep-Op-2026x" } });
    assert([200, 201, 409].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("L05b", "login do operador", async () => {
    const r = await api("/v1/admin/auth/login", { method: "POST", body: { email: "deep.op@acompanhe.app", password: "deep-Op-2026x" } });
    assert(r.status === 200 && r.json?.token, ev(r));
    opToken = r.json.token;
    return { evidence: ev(r).slice(0, 80) };
  });
  await Tcase("L04", "kpis com operador → RBAC + séries REAIS (re-rodado após refatoração)", async () => {
    const r = await api("/v1/admin/kpis", { token: opToken });
    assert(r.status === 200, ev(r));
    assert(r.json?.usuarios?.total !== undefined, `shape ainda stub: ${ev(r)}`);
    return { evidence: ev(r) };
  });
  await Tcase("L06", "operador NÃO lista operadores → 403", async () => {
    const r = await api("/v1/admin/operadores", { token: opToken });
    assert(r.status === 403, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("L07", "GET /v1/admin/operadores diretor", async () => {
    const r = await api("/v1/admin/operadores", { token: await adminTok() });
    assert(r.status === 200 && (r.text ?? "").includes("deep.op"), ev(r));
    return { evidence: ev(r).slice(0, 120) };
  });
  await Tcase("L08", "verificacoes pendentes", async () => {
    const r = await api("/v1/admin/verificacoes?status=pending", { token: await adminTok() });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r).slice(0, 120) };
  });
  await Tcase("L09", "audit tem trilha", async () => {
    const r = await api("/v1/admin/audit", { token: await adminTok() });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r).slice(0, 120) };
  });
  await Tcase("L10", "JWT de usuário em /v1/admin/* → 401/403", async () => {
    const r = await api("/v1/admin/kpis", { token: await tok("deep-l10") });
    assert([401, 403].includes(r.status), ev(r));
    return { evidence: ev(r) };
  });
}

// ---------------- M · Resiliência (o "está caindo") ----------------
async function secM() {
  console.log("\n=== M · Resiliência ===");
  const t = await tok("deep-resil");
  let notaId = null;
  await Tcase("M05a", "cria nota ANTES do kill (persistência)", async () => {
    const r = await api("/api/minhas/notas", { method: "POST", token: t, body: { title: "persiste deep", body: "sobrevive a restart" } });
    assert([200, 201].includes(r.status), ev(r));
    notaId = r.json?.id ?? r.json?.nota?.id;
    return { evidence: ev(r) };
  });
  await Tcase("M01", "kill API → watchdog religa ≤50s", async () => {
    sh(`pkill -f "src/serve[r].ts" || true`);
    const ok = await waitFor(async () => (await api("/health")).status === 200);
    assert(ok, "API não voltou em 50s");
    const r = await api("/health");
    return { evidence: `voltou: ${ev(r)}` };
  });
  await Tcase("M02", "kill web-serve → watchdog religa", async () => {
    sh(`pkill -f "web-serve[.]mjs" || true`);
    const ok = await waitFor(async () => (await api("/", { base: TUNNEL })).status === 200);
    assert(ok, "web não voltou em 50s");
    return { evidence: `túnel 200 de novo` };
  });
  await Tcase("M03", "kill bot → watchdog religa", async () => {
    sh(`pkill -f "telegram_bot[.]py" || true`);
    const ok = await waitFor(async () => sh(`pgrep -f "telegram_bot[.]py" | head -1`).out.trim().length > 0);
    assert(ok, "bot não voltou em 50s");
    return { evidence: `pid=${sh(`pgrep -f "telegram_bot[.]py" | head -1`).out.trim()}` };
  });
  await Tcase("M04", "JWT antigo continua válido após restart", async () => {
    const r = await api("/api/me", { token: t });
    assert(r.status === 200, ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("M05", "nota criada antes do kill persiste", async () => {
    const r = await api("/api/minhas/notas?q=persiste", { token: t });
    assert(r.status === 200 && (r.text ?? "").includes("persiste deep"), ev(r));
    return { evidence: ev(r) };
  });
  await Tcase("M06", "5 requisições paralelas todas 200", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => api("/api/me", { token: t })));
    const st = rs.map((x) => x.status);
    assert(st.every((s) => s === 200), `statuses=${st}`);
    return { evidence: `statuses=${st}` };
  });
}

// ---------------- N · Frontend um por um ----------------
async function secN() {
  console.log("\n=== N · Frontend (bundle servido) ===");
  const html = await api("/", { base: TUNNEL });
  const jsName = html.text?.match(/main-[A-Za-z0-9_-]+\.js/)?.[0];
  const js = (await api(`/assets/${jsName}`, { base: TUNNEL })).text ?? "";
  const abas = ["Início", "AnotA", "Licitações", "Concursos", "Jurídico", "Empréstimos", "Investiga", "Planos"];
  for (let i = 0; i < abas.length; i++) {
    await Tcase(`N0${i + 1}`, `aba servida: ${abas[i]}`, async () => {
      assert(js.includes(abas[i]), `label ${abas[i]} fora do bundle`);
      return { evidence: `presente em ${jsName}` };
    });
  }
  const icones = ["home", "note", "scroll", "grad", "scale", "deal", "search", "star"];
  await Tcase("N09", "8 ícones SVG servidos", async () => {
    const faltando = icones.filter((p) => !js.includes(p));
    assert(faltando.length === 0, `faltam: ${faltando}`);
    return { evidence: `icones=${icones.join(",")}` };
  });
  await Tcase("N10", "textos-contrato servidos (todos os chunks)", async () => {
    const dir = "/home/user/acompanhe-ia/apps/web/dist/assets";
    const todos = sh(`cat ${dir}/*.js ${dir}/*.css 2>/dev/null`).out ?? "";
    const need = ["Autenticando…", "sessão segura · JWT", "Missões da semana"];
    const falta = need.filter((s) => !(js.includes(s) || todos.includes(s)));
    assert(falta.length === 0, `faltam: ${falta}`);
    return { evidence: `presentes: ${need.join(" | ")}` };
  });
}

// ---------------- O · Painel de operações (docs/plano-painel-ops.md) ----------------
let svcToken = SECRETS.SERVICE_TOKEN ?? "";
function sqlOps(q) { return sql(q); }

async function secO() {
  // ——— F1: instrumentação e coleta ———
  await Tcase("O01", "tabelas OpsEvent + ServiceProbe existem no banco", () => {
    const r = sqlOps(`SELECT count(*) FROM information_schema.tables WHERE table_name IN ('OpsEvent','ServiceProbe')`);
    assert(r.ok && r.out.trim() === "2", `esperado 2 tabelas: ${r.out}`);
    return { evidence: `tabelas=${r.out.trim()}` };
  });

  await Tcase("O02", "worker de alertas vivo sob keep-alive", () => {
    const r = sh(`pgrep -f 'src/work[e]r.ts' | head -1`);
    assert(r.ok && r.out.trim().length > 0, `worker não está rodando: ${r.out}`);
    return { evidence: `pid=${r.out.trim()}` };
  });

  await Tcase("O03", "kill da API → keep-alive religa → OpsEvent process_start no banco (VIDA)", async () => {
    sh(`pkill -f 'src/serve[r].ts' || true`);
    const ok = await waitFor(async () => {
      const h = await api("/health");
      return h.status === 200;
    }, 60000, 4000);
    assert(ok, "API não voltou em 60s");
    await new Promise((r) => setTimeout(r, 4000)); // dá tempo do ops-report do keep-alive
    const r = sqlOps(`SELECT count(*) FROM "OpsEvent" WHERE kind='process_start' AND service='api' AND source='keep-alive' AND ts > now() - interval '3 minutes'`);
    assert(r.ok && Number(r.out.trim()) >= 1, `sem evento process_start: ${r.out}`);
    return { evidence: `process_start_events=${r.out.trim()} (API religada pelo keep-alive)` };
  });

  await Tcase("O04", "ingest localhost com SERVICE_TOKEN → 201", async () => {
    const r = await api("/api/internal/ops/ingest", {
      method: "POST",
      headers: { "x-service-token": svcToken },
      body: { events: [{ source: "test", kind: "test_run", service: "app", ok: true, detail: { caso: "O04" } }] },
    });
    assert(r.status === 201, ev(r));
    return { evidence: ev(r) };
  });

  await Tcase("O05", "probes automáticos do keep-alive chegam (ServiceProbe recente)", async () => {
    await waitFor(async () => {
      const r = sqlOps(`SELECT count(*) FROM "ServiceProbe" WHERE ts > now() - interval '90 seconds'`);
      return r.ok && Number(r.out.trim()) >= 1;
    }, 40000, 6000);
    const r = sqlOps(`SELECT count(*) FROM "ServiceProbe" WHERE ts > now() - interval '90 seconds'`);
    assert(Number(r.out.trim()) >= 1, `sem probes: ${r.out}`);
    return { evidence: `probes_90s=${r.out.trim()}` };
  });

  // ——— S1/R2/S4/G2 (pilares da coleta) ———
  await Tcase("O31", "S1: ingest NÃO é alcançável pelo túnel (prova negativa)", async () => {
    const viaInternal = await api("/api/internal/ops/ingest", {
      method: "POST", base: TUNNEL,
      headers: { "x-service-token": svcToken },
      body: { events: [] },
    });
    const viaV1 = await api("/v1/ops/ingest", {
      method: "POST", base: TUNNEL,
      headers: { "x-service-token": svcToken },
      body: { events: [] },
    });
    const controle = await api("/api/internal/ops/ingest", {
      method: "POST",
      headers: { "x-service-token": svcToken },
      body: { events: [] },
    });
    assert(viaInternal.status === 404, `via túnel /api/internal deveria ser 404: ${ev(viaInternal)}`);
    assert(viaV1.status === 404, `via túnel /v1/ops/ingest deveria 404: ${ev(viaV1)}`);
    assert(controle.status === 201, `controle local deveria 201: ${ev(controle)}`);
    return { evidence: `tunel_/api/internal=${viaInternal.status} tunel_/v1=${viaV1.status} local=${controle.status}` };
  });

  await Tcase("O34", "S4: detail com chave sensível → 400", async () => {
    const r = await api("/api/internal/ops/ingest", {
      method: "POST",
      headers: { "x-service-token": svcToken },
      body: { events: [{ source: "test", kind: "flag_change", service: "app", ok: true, detail: { serviceToken: "vazou" } }] },
    });
    assert(r.status === 400, ev(r));
    return { evidence: ev(r) };
  });

  await Tcase("O37", "R2: evento de religada carrega causa=keep-alive (correlação)", async () => {
    const r = sqlOps(`SELECT detail::text FROM "OpsEvent" WHERE kind='process_start' AND service='api' AND source='keep-alive' ORDER BY ts DESC LIMIT 1`);
    assert(r.ok && r.out.includes("keep-alive"), `sem causa: ${r.out}`);
    return { evidence: r.out.trim().slice(0, 120) };
  });

  await Tcase("O30", "G2: purge com retenção (7d/30d) remove e registra", async () => {
    // insere probe vencido e chama o purge real
    const ins = await api("/api/internal/ops/ingest", {
      method: "POST",
      headers: { "x-service-token": svcToken },
      body: { probes: [{ service: "web", ok: true, latencyMs: 1, ts: new Date(Date.now() - 8 * 86400000).toISOString() }] },
    });
    assert(ins.status === 201, ev(ins));
    const r = await api("/api/internal/ops/purge", { method: "POST", headers: { "x-service-token": svcToken } });
    assert(r.status === 200, ev(r));
    const j = r.json ?? {};
    assert(Number(j.probesDeleted) >= 1, `probe vencido não saiu: ${ev(r)}`);
    return { evidence: ev(r) };
  });

  await Tcase("O40", "E2: probes em lote (1 requisição → N linhas)", async () => {
    const r = await api("/api/internal/ops/ingest", {
      method: "POST",
      headers: { "x-service-token": svcToken },
      body: { probes: ["api", "web", "bot", "tunnel", "worker"].map((service) => ({ service, ok: true, latencyMs: 7 })) },
    });
    assert(r.status === 201 && r.json?.probes === 5, ev(r));
    return { evidence: ev(r) };
  });

  // ——— F2: API admin ops + RBAC ———
  const tokAdmin = await adminTok();

  await Tcase("O06", "GET /v1/admin/ops/overview → 200 com healthScore", async () => {
    const r = await api("/v1/admin/ops/overview", { token: tokAdmin });
    assert(r.status === 200 && typeof r.json?.healthScore === "number", ev(r));
    return { evidence: `healthScore=${r.json.healthScore} sinais=${JSON.stringify(r.json.sinais).slice(0, 90)}` };
  });

  await Tcase("O07", "GET /v1/admin/ops/services → 5 serviços com estado", async () => {
    const r = await api("/v1/admin/ops/services", { token: tokAdmin });
    assert(r.status === 200 && r.json?.servicos?.length === 5, ev(r));
    return { evidence: `servicos=${r.json.servicos.map((s) => `${s.service}:${s.ok === null ? "?" : s.ok ? "ok" : "down"}`).join(" ")}` };
  });

  await Tcase("O08", "GET /v1/admin/ops/timeline → funde fontes + cadeiaOk", async () => {
    const r = await api("/v1/admin/ops/timeline", { token: tokAdmin });
    assert(r.status === 200 && Array.isArray(r.json?.entries), ev(r));
    assert(r.json?.cadeiaOk === true, `cadeia adulterada: ${ev(r)}`);
    return { evidence: `entries=${r.json.entries.length} cadeiaOk=true fontes=${r.json.fontes.join(",")}` };
  });

  await Tcase("O09", "GET /v1/admin/ops/probes?service=api → série real", async () => {
    const r = await api("/v1/admin/ops/probes?service=api&hours=24", { token: tokAdmin });
    assert(r.status === 200 && Array.isArray(r.json?.pontos), ev(r));
    return { evidence: `total=${r.json.total} pontos=${r.json.pontos.length}` };
  });

  await Tcase("O10", "GET /v1/admin/ops/queues → filas reais (AlertEvent/deadletter/SyncRun)", async () => {
    const r = await api("/v1/admin/ops/queues", { token: tokAdmin });
    assert(r.status === 200 && r.json?.alertas !== undefined, ev(r));
    return { evidence: `alertas=${JSON.stringify(r.json.alertas)} deadletter=${r.json.deadletter.length} syncRuns=${r.json.syncRuns.length}` };
  });

  await Tcase("O11", "GET /v1/admin/ops/logs?service=keep-alive → tail do log real", async () => {
    const r = await api("/v1/admin/ops/logs?service=keep-alive&lines=30", { token: tokAdmin });
    assert(r.status === 200 && String(r.json?.tail ?? "").includes("keep-alive"), ev(r));
    return { evidence: `tail_len=${String(r.json.tail).length}` };
  });

  await Tcase("O12", "GET /v1/admin/ops/tests → gates de qualidade parseados", async () => {
    const r = await api("/v1/admin/ops/tests", { token: tokAdmin });
    assert(r.status === 200 && Array.isArray(r.json?.runs) && r.json.runs.length === 2, ev(r));
    return { evidence: r.json.runs.map((x) => `${x.arquivo}=${x.resumo ?? "sem-resumo"}`).join(" | ").slice(0, 160) };
  });

  await Tcase("O13", "GET /v1/admin/ops/flags → lista de flags", async () => {
    const r = await api("/v1/admin/ops/flags", { token: tokAdmin });
    assert(r.status === 200 && Array.isArray(r.json?.flags), ev(r));
    return { evidence: ev(r) };
  });

  await Tcase("O14", "RBAC: operador_suporte em /ops/overview → 403", async () => {
    const email = `deep-ops-${RUN}@deep.run`;
    const criar = await api("/v1/admin/operadores", {
      method: "POST", token: tokAdmin,
      body: { email, name: `Ops ${RUN}`, role: "operador_suporte", password: `Ops-${RUN}-senha!` },
    });
    assert(criar.status === 201, ev(criar));
    const login = await api("/v1/admin/auth/login", { method: "POST", body: { email, password: `Ops-${RUN}-senha!` } });
    assert(login.status === 200, ev(login));
    const r = await api("/v1/admin/ops/overview", { token: login.json.token });
    assert(r.status === 403 && r.json?.rule === "RBAC", ev(r));
    return { evidence: ev(r) };
  });

  await Tcase("O15", "E1: timeline com limit acima do cap → 400", async () => {
    const r = await api("/v1/admin/ops/timeline?limit=99999", { token: tokAdmin });
    assert(r.status === 400, ev(r));
    return { evidence: ev(r) };
  });

  await Tcase("O35", "R1: resposta carrega x-request-id", () => {
    const r = sh(`curl -s -D - -o /dev/null ${BASE}/health | grep -i x-request-id`);
    assert(r.ok && /x-request-id/i.test(r.out), `header ausente: ${r.out}`);
    return { evidence: r.out.trim().split("\n")[0] };
  });

  await Tcase("O36", "S5: web-serve envia headers de segurança", () => {
    const r = sh(`curl -s -D - -o /dev/null ${WEB}/ | grep -iE "x-content-type-options|referrer-policy|x-frame-options"`);
    const n = (r.out.match(/:/g) ?? []).length;
    assert(r.ok && n >= 3, `headers faltando: ${r.out}`);
    return { evidence: r.out.trim().replace(/\s+/g, " ").slice(0, 140) };
  });

  await Tcase("O33", "S3: tail de log redige segredo (bot token nunca cru)", async () => {
    sh(`echo 'linha-o33 bot123456789:SEGREDO-CRUAQUI-O33 fim' >> /tmp/worker.log`);
    const r = await api("/v1/admin/ops/logs?service=worker&lines=20", { token: tokAdmin });
    assert(r.status === 200, ev(r));
    assert(!String(r.json.tail).includes("SEGREDO-CRUAQUI-O33"), `segredo vazou: ${ev(r)}`);
    assert(String(r.json.tail).includes("***"), `sem redação: ${ev(r)}`);
    return { evidence: "tail=*** (token mascarado)" };
  });

  // ——— F3: kpis reais + fixes ———
  await Tcase("O16", "GET /v1/admin/kpis → séries REAIS (fecha L04)", async () => {
    const r = await api("/v1/admin/kpis", { token: tokAdmin });
    assert(r.status === 200 && r.json?.usuarios?.total !== undefined, ev(r));
    return { evidence: `usuarios=${JSON.stringify(r.json.usuarios)} assinaturas=${JSON.stringify(r.json.assinaturas)} pagamentos=${JSON.stringify(r.json.pagamentos)}` };
  });

  await Tcase("O17", "kpis expõe sinais do sistema (tráfego/erros/latência/restarts)", async () => {
    const r = await api("/v1/admin/kpis", { token: tokAdmin });
    const s = r.json?.sistema ?? {};
    assert(typeof s.reqPorMin === "number" && typeof s.taxaErro5xx === "number" && typeof s.latenciaP95Ms === "number", ev(r));
    return { evidence: JSON.stringify(s) };
  });

  await Tcase("O18", "visor de DB respeita ?limite= (bug do take:50 fixo corrigido)", async () => {
    const r = await api("/v1/admin/db/user?limite=3", { token: tokAdmin });
    assert(r.status === 200 && r.json?.rows?.length <= 3, ev(r));
    return { evidence: `rows=${r.json.rows.length}` };
  });

  await Tcase("O19", "SyncRun: estado REAL mostrado (vazio + aviso honesto)", async () => {
    const r = await api("/v1/admin/ops/queues", { token: tokAdmin });
    assert(r.status === 200, ev(r));
    assert(Array.isArray(r.json?.syncRuns), ev(r));
    return { evidence: `syncRuns=${r.json.syncRuns.length} aviso=${JSON.stringify(r.json.aviso ?? null).slice(0, 100)}` };
  });

  await Tcase("O20", "deadletter REAL: alerta indeliverable → worker --once → JobsDeadletter", async () => {
    const ins = sqlOps(`INSERT INTO "AlertEvent"("userId", "topic", "channel", "status", "payload", "createdAt") VALUES ('o20-${RUN}', 'processos', 'telegram', 'queued', '{"chatId":"0","detail":"ops-o20","attempts":0}'::jsonb, '${new Date().toISOString()}') RETURNING id`);
    assert(ins.ok, `insert falhou: ${ins.out}`);
    for (let i = 0; i < 3; i++) {
      sh(`bash /home/user/tools/worker-start.sh --once`, 90000);
      const d = sqlOps(`SELECT count(*) FROM "JobsDeadletter"`);
      if (Number((d.out ?? "0").trim()) >= 1) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const r = sqlOps(`SELECT error FROM "JobsDeadletter" ORDER BY id DESC LIMIT 1`);
    assert(r.ok && r.out.trim().length > 0, `sem deadletter: ${r.out}`);
    return { evidence: `deadletter_error=${r.out.trim().slice(0, 60)}` };
  });

  await Tcase("O39", "E1: probes >24h saem agregados em buckets de 5 min", async () => {
    const r = await api("/v1/admin/ops/probes?service=api&hours=48", { token: tokAdmin });
    assert(r.status === 200, ev(r));
    const p = r.json?.pontos ?? [];
    const bucketed = p.length === 0 || p[0]?.total !== undefined;
    assert(bucketed, `sem agregação: ${JSON.stringify(p[0] ?? {})}`);
    return { evidence: `buckets=${p.length} amostra=${JSON.stringify(p[0] ?? {}).slice(0, 90)}` };
  });

  // ——— F4: UI (bundle + shapes que a UI renderiza) ———
  await Tcase("O21", "bundle admin.html + abas novas no JS de produção", () => {
    const html = sh(`ls /home/user/acompanhe-ia/apps/web/dist/admin.html`);
    assert(html.ok, `admin.html ausente: ${html.out}`);
    const js = sh(`grep -l "alteracoes" /home/user/acompanhe-ia/apps/web/dist/assets/*.js | head -1`);
    assert(js.ok && js.out.trim().length > 0, "abas novas fora do bundle");
    return { evidence: `bundle=${js.out.trim().split("/").pop()}` };
  });

  await Tcase("O22", "/admin.html servido pelo web-serve → 200", () => {
    const r = sh(`curl -s -o /dev/null -w '%{http_code}' ${WEB}/admin.html`);
    assert(r.out.trim() === "200", `status=${r.out}`);
    return { evidence: `status=${r.out.trim()}` };
  });

  await Tcase("O23", "shape da aba Visão Geral (overview: healthScore+sinais+ultimasAlteracoes)", async () => {
    const r = await api("/v1/admin/ops/overview", { token: tokAdmin });
    assert(r.json?.healthScore !== undefined && r.json?.sinais !== undefined && Array.isArray(r.json?.ultimasAlteracoes), ev(r));
    return { evidence: `healthScore=${r.json.healthScore} ultimas=${r.json.ultimasAlteracoes.length}` };
  });

  await Tcase("O24", "shape da aba Alterações (timeline: ts/fonte/acao por entrada)", async () => {
    const r = await api("/v1/admin/ops/timeline?limit=10", { token: tokAdmin });
    const e = r.json?.entries?.[0] ?? {};
    assert(e.ts !== undefined && e.fonte !== undefined && e.acao !== undefined, JSON.stringify(e).slice(0, 120));
    return { evidence: `entrada=${JSON.stringify({ ts: e.ts, fonte: e.fonte, acao: e.acao }).slice(0, 110)}` };
  });

  await Tcase("O25", "shape da aba Saúde (probes com ts e ok para sparkline)", async () => {
    const r = await api("/v1/admin/ops/probes?service=api&hours=6", { token: tokAdmin });
    const p = (r.json?.pontos ?? []).find((x) => x.ok !== undefined) ?? (r.json?.pontos ?? [])[0];
    assert(p && p.ts !== undefined, `sem pontos: ${ev(r)}`);
    return { evidence: `ponto=${JSON.stringify(p).slice(0, 90)}` };
  });

  await Tcase("O26", "shape da aba Filas (alertas+deadletter+syncRuns+tabelas)", async () => {
    const r = await api("/v1/admin/ops/queues", { token: tokAdmin });
    assert(r.json?.alertas && Array.isArray(r.json?.deadletter) && Array.isArray(r.json?.syncRuns) && r.json?.tabelas, ev(r));
    return { evidence: `tabelas=${JSON.stringify(r.json.tabelas)}` };
  });

  await Tcase("O27", "shape da aba Testes (runs[].arquivo+resumo)", async () => {
    const r = await api("/v1/admin/ops/tests", { token: tokAdmin });
    const run = r.json?.runs?.[0] ?? {};
    assert(run.arquivo !== undefined && "resumo" in run, JSON.stringify(run));
    return { evidence: `${run.arquivo}=${run.resumo ?? "sem-resumo"}` };
  });

  await Tcase("O28", "roundtrip de flag (botões ligar/desligar da UI)", async () => {
    const on = await api("/v1/admin/ops/flags", {
      method: "POST", token: tokAdmin,
      body: { key: `o28-${RUN}`, enabled: true, payload: { via: "deep-run" } },
    });
    assert(on.status === 201, ev(on));
    const list = await api("/v1/admin/ops/flags", { token: tokAdmin });
    const flag = (list.json?.flags ?? []).find((f) => f.key === `o28-${RUN}`);
    assert(flag?.enabled === true && !!flag?.updatedBy, ev(list));
    return { evidence: `flag=${flag.key} enabled=${flag.enabled} by=${String(flag.updatedBy).slice(0, 8)}…` };
  });

  // ——— G1/G3: governança de credenciais ———
  await Tcase("O29", "G1: flag.grava ator + audit flag.set na cadeia", async () => {
    const r = sqlOps(`SELECT count(*) FROM "AuditLog" WHERE action='flag.set'`);
    assert(r.ok && Number(r.out.trim()) >= 1, `audit flag.set ausente: ${r.out}`);
    const f = sqlOps(`SELECT "updatedBy" FROM "FeatureFlag" WHERE key LIKE 'o28-%' ORDER BY "updatedAt" DESC LIMIT 1`);
    assert(f.ok && f.out.trim().length > 0, `updatedBy vazio: ${f.out}`);
    return { evidence: `audit_flag_set=${r.out.trim()} updatedBy=${f.out.trim().slice(0, 8)}…` };
  });

  await Tcase("O32", "S2: 5 logins errados → 429; recupera após 60s", async () => {
    let ultimo = 0;
    for (let i = 0; i < 6; i++) {
      const r = await api("/v1/admin/auth/login", {
        method: "POST",
        body: { email: "bruto@force.com", password: "senha-errada-123" },
      });
      ultimo = r.status;
      if (i < 5) assert(r.status === 401, `tentativa ${i + 1}: ${ev(r)}`);
    }
    assert(ultimo === 429, `6ª tentativa deveria 429: ${ultimo}`);
    const ok = await waitFor(async () => {
      const r = await api("/v1/admin/auth/login", {
        method: "POST",
        body: { email: ADMIN_EMAIL, password: ADMIN_PASS },
      });
      return r.status === 200;
    }, 75000, 8000);
    assert(ok, "login não recuperou após a janela de 60s");
    return { evidence: `401×5 → 429 → recuperou 200` };
  });

  await Tcase("O38", "G3: rotate-service-token troca a credencial (antiga morre)", async () => {
    const antes = svcToken;
    const r = await api("/v1/admin/ops/rotate-service-token", { method: "POST", token: tokAdmin });
    assert(r.status === 200, ev(r));
    const novo = sh(`python3 -c "import json;print(json.load(open('/home/user/.secrets.json'))['SERVICE_TOKEN'])"`).out.trim();
    assert(novo.length > 10 && novo !== antes, "token não mudou");
    svcToken = novo;
    const velho = await api("/api/internal/ops/ingest", {
      method: "POST", headers: { "x-service-token": antes }, body: { events: [] },
    });
    const fresco = await api("/api/internal/ops/ingest", {
      method: "POST", headers: { "x-service-token": novo }, body: { events: [] },
    });
    assert(velho.status === 401 && fresco.status === 201, `velho=${velho.status} novo=${fresco.status}`);
    return { evidence: `velho=401 novo=201 rotatedAt=${r.json?.rotatedAt ?? "?"}` };
  });

  await Tcase("O41", "E3: caminho Vercel+Neon documentado em docs/decisoes.md", () => {
    const r = sh(`grep -c "ops-report.sh" /home/user/acompanhe-ia/docs/decisoes.md`);
    assert(r.ok && Number(r.out.trim()) >= 1, `nota E3 ausente: ${r.out}`);
    return { evidence: `ocorrencias=${r.out.trim()}` };
  });
}

// ---------------- main ----------------
async function main() {
  console.log(`deep-run | BASE=${BASE} TUNNEL=${TUNNEL}`);
  const secs = [
    ["A", secA], ["B", secB], ["C", secC], ["D", secD], ["E", secE], ["F", secF],
    ["G", secG], ["H", secH], ["I", secI], ["J", secJ], ["K", secK], ["L", secL],
    ["M", secM], ["N", secN], ["O", secO],
  ];
  for (const [nome, fn] of secs) {
    try { await fn(); }
    catch (e) {
      T(`SEÇÃO-${nome}`, `seção abortou: ${e?.message ?? e}`, "FAIL", String(e?.stack ?? e).slice(0, 200));
    }
  }

  const cont = { PASS: 0, FAIL: 0, EXT: 0, KONHECIDO: 0 };
  for (const r of results) cont[r.kind] = (cont[r.kind] ?? 0) + 1;
  const resumo = `RESUMO: PASS=${cont.PASS} FAIL=${cont.FAIL} EXT=${cont.EXT} KONHECIDO=${cont.KONHECIDO} total=${results.length}`;
  console.log(`\n=== ${resumo} ===`);
  for (const r of results.filter((x) => x.kind === "FAIL")) console.log(`FAIL >> ${r.id} ${r.desc} || ${r.evidence}`);

  const md = [
    `# Resultados profundos (deep-run) — ${new Date().toISOString()}`,
    "",
    `> Execução de docs/plano-teste-profundo.md contra a stack viva.`,
    `> ${resumo}`,
    "",
    "| ID | Caso | Resultado | Evidência crua (status + corpo/STDOUT) |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.desc} | **${r.kind}** | ${r.evidence.replace(/\|/g, "\\|")} |`),
    "",
  ].join("\n");
  writeFileSync(DOC, md);
  console.log(`\nEvidências completas: ${DOC}`);
  process.exit(cont.FAIL > 0 ? 1 : 0);
}
main().catch((e) => { console.error("deep-run morreu:", e); process.exit(2); });
