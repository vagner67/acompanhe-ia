/**
 * Painel de operações — lógica pura (testável sem rede).
 * Plano: docs/plano-painel-ops.md §3–§7 (G/R/S/E). Nada aqui lê rede nem banco.
 */

export type OpsSource = "keep-alive" | "worker" | "deploy" | "test" | "manual" | "api";
export const OPS_SOURCES: OpsSource[] = ["keep-alive", "worker", "deploy", "test", "manual", "api"];

export const OPS_SERVICES = ["api", "web", "bot", "tunnel", "worker", "app"] as const;
export type OpsService = (typeof OPS_SERVICES)[number];

// ── S3: redação de segredos em qualquer texto devolvido pelo painel ──────
export const REDACT_RE = /(bot[0-9]{6,}:[A-Za-z0-9_-]+|service[_-]?token|password|senha|authorization|Bearer\s+\S+)/gi;
export function redact(s: string): string {
  return String(s ?? "").replace(REDACT_RE, "***");
}

// ── S4: detail higiênico — nada de credencial dentro de OpsEvent.detail ──
const SENSITIVE_KEY = /(token|password|secret|authorization|senha)/i;
export function detailHygienic(detail: unknown): boolean {
  if (detail === null || detail === undefined) return true;
  if (typeof detail !== "object") return true;
  for (const k of Object.keys(detail as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) return false;
  }
  return true;
}

// ── Health score (§3.6): 35·api + 20·web + 15·bot + 15·tunnel + 15·worker ──
export const WEIGHTS: Record<string, number> = { api: 35, web: 20, bot: 15, tunnel: 15, worker: 15 };
/** 0 falhas = 1 · 1 falha em 5 = 0.5 · 2+ = 0 */
export function componentScore(fails: number): number {
  return fails <= 0 ? 1 : fails === 1 ? 0.5 : 0;
}
export function healthScore(failsByService: Record<string, number>): number {
  let total = 0;
  for (const [svc, w] of Object.entries(WEIGHTS)) {
    total += w * componentScore(failsByService[svc] ?? 0);
  }
  return Math.round(total);
}

// ── E1: caps de query ────────────────────────────────────────────────────
export const MAX_HOURS = 168;
export const MAX_LIMIT = 500;
export function capHours(h: number): number | null {
  return Number.isFinite(h) && h > 0 && h <= MAX_HOURS ? Math.floor(h) : null;
}
export function capLimit(l: number): number | null {
  return Number.isFinite(l) && l > 0 && l <= MAX_LIMIT ? Math.floor(l) : null;
}

// ── E1: agregação por bucket de 5 min (range > 24h) ─────────────────────
export interface ProbePoint {
  ts: Date | string;
  ok: boolean;
  latencyMs?: number | null;
}
export interface ProbeBucket {
  ts: string;
  total: number;
  fails: number;
  avgLatencyMs: number | null;
}
export function aggregateProbes(probes: ProbePoint[], bucketMin = 5): ProbeBucket[] {
  const buckets = new Map<string, { total: number; fails: number; lat: number[] }>();
  for (const p of probes) {
    const d = new Date(p.ts);
    const key = new Date(Math.floor(d.getTime() / (bucketMin * 60000)) * (bucketMin * 60000)).toISOString();
    const b = buckets.get(key) ?? { total: 0, fails: 0, lat: [] };
    b.total += 1;
    if (!p.ok) b.fails += 1;
    if (typeof p.latencyMs === "number") b.lat.push(p.latencyMs);
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ts, b]) => ({
      ts,
      total: b.total,
      fails: b.fails,
      avgLatencyMs: b.lat.length ? Math.round(b.lat.reduce((x, y) => x + y, 0) / b.lat.length) : null,
    }));
}

// ── R1: medidor HTTP em memória (tráfego/erros/latência) ────────────────
const LAT_CAP = 1000;
export const meter = {
  startedAt: Date.now(),
  reqs: 0,
  s2xx: 0,
  s4xx: 0,
  s5xx: 0,
  lat: [] as number[],
};
export function recordRequest(status: number, ms: number): void {
  meter.reqs += 1;
  if (status >= 500) meter.s5xx += 1;
  else if (status >= 400) meter.s4xx += 1;
  else meter.s2xx += 1;
  meter.lat.push(Math.round(ms));
  if (meter.lat.length > LAT_CAP) meter.lat.splice(0, meter.lat.length - LAT_CAP);
}
export function meterSnapshot(): {
  reqs: number;
  s2xx: number;
  s4xx: number;
  s5xx: number;
  reqPorMin: number;
  taxaErro5xx: number;
  latenciaP95Ms: number;
} {
  const min = Math.max(1, (Date.now() - meter.startedAt) / 60000);
  const sorted = [...meter.lat].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : 0;
  return {
    reqs: meter.reqs,
    s2xx: meter.s2xx,
    s4xx: meter.s4xx,
    s5xx: meter.s5xx,
    reqPorMin: Math.round((meter.reqs / min) * 10) / 10,
    taxaErro5xx: meter.reqs ? Math.round((meter.s5xx / meter.reqs) * 1000) / 10 : 0,
    latenciaP95Ms: p95,
  };
}

// ── S2: brute-force no login admin (em memória, por IP) ─────────────────
const attempts = new Map<string, { n: number; at: number; until: number }>();
export const LOGIN_MAX = 5;
export const LOGIN_WINDOW_MS = 60_000;
export function loginBlocked(ip: string, now = Date.now()): boolean {
  const a = attempts.get(ip);
  return !!a && a.until > now;
}
export function loginFail(ip: string, now = Date.now()): void {
  const a = attempts.get(ip);
  if (!a || now - a.at > LOGIN_WINDOW_MS) {
    attempts.set(ip, { n: 1, at: now, until: 0 });
    return;
  }
  a.n += 1;
  a.at = now;
  if (a.n >= LOGIN_MAX) a.until = now + LOGIN_WINDOW_MS;
  attempts.set(ip, a);
}
export function loginOk(ip: string): void {
  attempts.delete(ip);
}
