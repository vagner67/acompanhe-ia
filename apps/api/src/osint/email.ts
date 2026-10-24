/**
 * Módulo de e-mail — fontes REAIS apenas (verificadas em 22/10/2026):
 * 1. Gravatar: GET https://www.gravatar.com/avatar/{md5(email)}?d=404
 *    (md5 do e-mail trim+lower; 200 = avatar público existe; 404 = não).
 * 2. Have I Been Pwned v3: GET
 *    https://haveibeenpwned.com/api/v3/breachedaccount/{email}?truncateResponse=true
 *    header `hibp-api-key` + User-Agent; 200 = lista de vazamentos;
 *    404 = sem vazamento; 401/403/sem chave = "unavailable" (NUNCA inventar).
 * 3. MX do domínio (node:dns resolveMx): presença/ausência de registros MX.
 * 4. Pivô determinístico do local-part (regra explícita, não heurística solta):
 *    firstname.lastname / f.lastname / first_last → candidatos de username
 *    devolvidos como `candidates` para consulta posterior via Sherlock.
 */
import { createHash } from "node:crypto";
import { resolveMx } from "node:dns/promises";

import { SOURCES } from "./sources.js";
import type { OsintFinding, OsintTarget } from "./types.js";

export interface EmailOsintResult {
  findings: OsintFinding[];
  /** Candidatos de username derivados do local-part (p/ consulta Sherlock). */
  candidates: string[];
  raw: Record<string, unknown>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface EmailOsintOptions {
  hibpApiKey?: string | undefined;
  userAgent?: string;
  timeoutMs?: number;
  fetchFn?: FetchLike;
  now?: () => string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function gravatarHash(email: string): string {
  return createHash("md5").update(email.trim().toLowerCase()).digest("hex");
}

/** Deriva candidatos de username a partir do local-part (regra declarada). */
export function localPartCandidates(local: string): string[] {
  const clean = local.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  const parts = clean.split(/[._-]/).filter((p) => p.length > 1);
  const out = new Set<string>();
  if (parts.length >= 2) {
    out.add(parts.join(""));
    out.add(`${parts[0]}.${parts[parts.length - 1]}`);
    out.add(`${parts[0]}${parts[parts.length - 1]}`);
    const first = parts[0] ?? "";
    const last = parts[parts.length - 1] ?? "";
    if (first.length > 0 && last.length > 0) {
      out.add(`${first[0]}${last}`);
      out.add(`${first}_${last}`);
    }
  } else if (clean.length >= 3) {
    out.add(clean.replace(/[._-]/g, ""));
  }
  return [...out].filter((c) => c.length >= 3).slice(0, 5);
}

export async function checkEmail(
  email: string,
  opts: EmailOsintOptions = {},
): Promise<EmailOsintResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());
  const findings: OsintFinding[] = [];
  const raw: Record<string, unknown> = { module: "email", email };

  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    findings.push({
      id: crypto.randomUUID(),
      sourceId: SOURCES.emailSyntax.id,
      status: "not_found",
      retrievedAt: now(),
      raw: { email, note: "endereço não passa na validação sintática" },
    });
    return { findings, candidates: [], raw };
  }

  // 1) Gravatar (real, sem chave).
  const hash = gravatarHash(normalized);
  try {
    const res = await fetchFn(`https://www.gravatar.com/avatar/${hash}?d=404`, {
      method: "GET",
      redirect: "manual",
    });
    if (res.status === 200) {
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.gravatar.id,
        status: "found",
        evidenceUrl: `https://gravatar.com/${hash}`,
        retrievedAt: now(),
        raw: { hash, httpStatus: 200 },
      });
    } else if (res.status === 404) {
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.gravatar.id,
        status: "not_found",
        retrievedAt: now(),
        raw: { hash, httpStatus: 404 },
      });
    } else {
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.gravatar.id,
        status: "unknown",
        retrievedAt: now(),
        raw: { hash, httpStatus: res.status },
      });
    }
  } catch (err) {
    findings.push({
      id: crypto.randomUUID(),
      sourceId: SOURCES.gravatar.id,
      status: "unknown",
      retrievedAt: now(),
      raw: { hash, error: String(err) },
    });
  }

  // 2) HIBP (real; sem chave → unavailable, nunca inventar).
  if (!opts.hibpApiKey) {
    findings.push({
      id: crypto.randomUUID(),
      sourceId: SOURCES.hibp.id,
      status: "unknown",
      retrievedAt: now(),
      raw: {
        email: normalized,
        unavailable: true,
        reason: "HIBP_API_KEY ausente — fonte não consultada (não inventar resultado)",
      },
    });
  } else {
    try {
      const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(normalized)}?truncateResponse=true`;
      const res = await fetchFn(url, {
        headers: {
          "hibp-api-key": opts.hibpApiKey,
          "user-agent": opts.userAgent ?? "AcompanheIA-Investiga/1.0 (contato via Telegram @acompanheia)",
        },
      });
      if (res.status === 200) {
        const body = (await res.json()) as Array<{ Name?: string; Title?: string; BreachDate?: string; Domain?: string }>;
        findings.push({
          id: crypto.randomUUID(),
          sourceId: SOURCES.hibp.id,
          status: "found",
          evidenceUrl: `https://haveibeenpwned.com/${normalized}`,
          retrievedAt: now(),
          raw: {
            email: normalized,
            breaches: body.map((b) => ({
              name: b.Name ?? null,
              title: b.Title ?? null,
              breachDate: b.BreachDate ?? null,
              domain: b.Domain ?? null,
            })),
            count: body.length,
          },
        });
      } else if (res.status === 404) {
        findings.push({
          id: crypto.randomUUID(),
          sourceId: SOURCES.hibp.id,
          status: "not_found",
          retrievedAt: now(),
          raw: { email: normalized, httpStatus: 404, meaning: "sem vazamento conhecido na base do HIBP" },
        });
      } else {
        findings.push({
          id: crypto.randomUUID(),
          sourceId: SOURCES.hibp.id,
          status: "unknown",
          retrievedAt: now(),
          raw: { email: normalized, httpStatus: res.status, unavailable: true },
        });
      }
    } catch (err) {
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.hibp.id,
        status: "unknown",
        retrievedAt: now(),
        raw: { email: normalized, error: String(err), unavailable: true },
      });
    }
  }

  // 3) MX do domínio (real, node:dns).
  const domain = normalized.split("@")[1] ?? "";
  try {
    const mx = await resolveMx(domain);
    if (mx.length > 0) {
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.dnsMx.id,
        status: "found",
        evidenceUrl: `https://rdap.org/domain/${domain}`,
        retrievedAt: now(),
        raw: {
          domain,
          mx: mx.map((r) => ({ exchange: r.exchange, priority: r.priority })),
        },
      });
    } else {
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.dnsMx.id,
        status: "not_found",
        retrievedAt: now(),
        raw: { domain, note: "sem registros MX" },
      });
    }
  } catch (err) {
    findings.push({
      id: crypto.randomUUID(),
      sourceId: SOURCES.dnsMx.id,
      status: "unknown",
      retrievedAt: now(),
      raw: { domain, error: String(err) },
    });
  }

  // 4) Pivô do local-part → candidatos (não é achado; é material de trabalho).
  const local = normalized.split("@")[0] ?? "";
  const candidates = localPartCandidates(local);
  raw.localPartCandidates = candidates;

  return { findings, candidates, raw };
}

/** Converte um alvo de e-mail em chamada de módulo. */
export function checkEmailTarget(target: OsintTarget, opts: EmailOsintOptions): Promise<EmailOsintResult> {
  if (target.kind !== "email") {
    return Promise.reject(new Error("alvo não é email"));
  }
  return checkEmail(target.value, opts);
}
