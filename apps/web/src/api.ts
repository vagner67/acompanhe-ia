import { getInitData } from "./telegram";
import type { Session } from "./types";

import type {
  InvestigaReport,
  MonitorAlert,
  OsintCase,
  OsintFinding,
  OsintTarget,
  QuotaWindow,
} from "@acompanhe/shared";

/** Cliente da API — URLs relativas (proxy do dev server; doc 10/preview).
 *  Tipos DTO vivem em @acompanhe/shared (doc 13, R1) — nunca declarar aqui. */
const BASE = import.meta.env.VITE_API_BASE ?? "";

export async function authenticate(): Promise<Session> {
  const initData = getInitData();
  const res = await fetch(`${BASE}/api/auth/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData }),
  });
  if (!res.ok) throw new Error(`auth falhou: ${res.status}`);
  return res.json();
}

export async function me(token: string): Promise<{ tgUserId: string; username: string | null }> {
  const res = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`me falhou: ${res.status}`);
  return res.json();
}

// ————— Investiga (doc 11) —————

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function investigaQuota(
  token: string,
): Promise<{ window: QuotaWindow; limits?: unknown; planQuota?: unknown }> {
  const res = await fetch(`${BASE}/v1/investiga/quota`, { headers: authHeaders(token) });
  return jsonOrThrow(res);
}

export async function investigaListCases(token: string): Promise<{ cases: OsintCase[] }> {
  const res = await fetch(`${BASE}/v1/investiga/cases`, { headers: authHeaders(token) });
  return jsonOrThrow(res);
}

export async function investigaCreateCase(
  token: string,
  body: { title: string; targets: OsintTarget[]; legalBasis: string; purpose: string },
): Promise<{ case: OsintCase }> {
  const res = await fetch(`${BASE}/v1/investiga/cases`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  return jsonOrThrow(res);
}

export async function investigaRunCase(
  token: string,
  caseId: string,
  body: { sites?: string[] } = {},
): Promise<{
  findings: OsintFinding[];
  inferences: OsintFinding[];
  alerts: MonitorAlert[];
  window: QuotaWindow;
}> {
  const res = await fetch(`${BASE}/v1/investiga/cases/${caseId}/run`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  return jsonOrThrow(res);
}

export async function investigaAlerts(
  token: string,
  caseId: string,
): Promise<{ alerts: MonitorAlert[]; rule: string }> {
  const res = await fetch(`${BASE}/v1/investiga/cases/${caseId}/alerts`, { headers: authHeaders(token) });
  return jsonOrThrow(res);
}

export async function investigaReport(token: string, caseId: string): Promise<{ report: InvestigaReport }> {
  const res = await fetch(`${BASE}/v1/investiga/cases/${caseId}/report`, { headers: authHeaders(token) });
  return jsonOrThrow(res);
}

/** URL de download direto (a autenticação vai no header via investigaExportBlob). */
export function investigaExportUrl(caseId: string, format: "csv" | "pdf"): string {
  return `${BASE}/v1/investiga/cases/${caseId}/export.${format}`;
}

export async function investigaExportBlob(
  token: string,
  caseId: string,
  format: "csv" | "pdf",
): Promise<Blob> {
  const res = await fetch(investigaExportUrl(caseId, format), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`export falhou: ${res.status}`);
  return res.blob();
}
