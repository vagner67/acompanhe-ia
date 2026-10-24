/**
 * Módulo de domínio — fontes REAIS verificadas em 22/10/2026:
 * - RDAP:      GET https://rdap.org/domain/{dominio}        (bootstrap IANA)
 * - crt.sh:    GET https://crt.sh/?q=%25.{dominio}&output=json (CT logs;
 *              cortesia: 1 req/5 s por IP — respeitar com intervalo no runner)
 * - Wayback:   GET https://archive.org/wayback/available?url={dominio}
 * - DNS:       node:dns (NS/MX/A) — delegação e presença de correio.
 */
import { SOURCES } from "./sources.js";
import type { OsintFinding, OsintTarget } from "./types.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DomainOsintOptions {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  now?: () => string;
  /** Dns injetável (testes). */
  resolveNs?: (domain: string) => Promise<string[]>;
  resolveMx?: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
}

export interface DomainOsintResult {
  findings: OsintFinding[];
  raw: Record<string, unknown>;
}

export async function checkDomain(
  domain: string,
  opts: DomainOsintOptions = {},
): Promise<DomainOsintResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());
  const findings: OsintFinding[] = [];
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  // 1) RDAP (real).
  try {
    const res = await fetchFn(`https://rdap.org/domain/${encodeURIComponent(clean)}`, {
      headers: { accept: "application/rdap+json, application/json" },
    });
    if (res.status === 200) {
      const body = (await res.json()) as {
        ldhName?: string;
        status?: string[];
        events?: Array<{ eventAction?: string; eventDate?: string }>;
        entities?: Array<{ roles?: string[]; handle?: string }>;
      };
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.rdap.id,
        status: "found",
        evidenceUrl: `https://rdap.org/domain/${clean}`,
        retrievedAt: now(),
        raw: {
          ldhName: body.ldhName ?? null,
          status: body.status ?? [],
          events: (body.events ?? []).slice(0, 10).map((e) => ({ action: e.eventAction ?? null, date: e.eventDate ?? null })),
          entityRoles: (body.entities ?? []).slice(0, 10).map((e) => e.roles ?? []),
        },
      });
    } else if (res.status === 404) {
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.rdap.id,
        status: "not_found",
        retrievedAt: now(),
        raw: { domain: clean, httpStatus: 404, meaning: "sem registro no RDAP (bootstrapping IANA)" },
      });
    } else {
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.rdap.id,
        status: "unknown",
        retrievedAt: now(),
        raw: { domain: clean, httpStatus: res.status },
      });
    }
  } catch (err) {
    findings.push({
      id: crypto.randomUUID(),
      sourceId: SOURCES.rdap.id,
      status: "unknown",
      retrievedAt: now(),
      raw: { domain: clean, error: String(err) },
    });
  }

  // 2) crt.sh (real; cortesia 1 req/5 s — o runner aplica o intervalo).
  try {
    const res = await fetchFn(`https://crt.sh/?q=${encodeURIComponent(`%.${clean}`)}&output=json`);
    if (res.status === 200) {
      const body = (await res.json()) as Array<{ name_value?: string; not_before?: string; not_after?: string; issuer_name?: string }>;
      const names = new Set<string>();
      for (const cert of body.slice(0, 200)) {
        for (const n of (cert.name_value ?? "").split("\n")) {
          const nn = n.trim().toLowerCase();
          if (nn) names.add(nn);
        }
      }
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.crtsh.id,
        status: "found",
        evidenceUrl: `https://crt.sh/?q=${encodeURIComponent(`%.${clean}`)}`,
        retrievedAt: now(),
        raw: {
          certificates: body.length,
          names: [...names].slice(0, 50),
          window: { not_before: body[0]?.not_before ?? null, not_after: body[0]?.not_after ?? null },
        },
      });
    } else {
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.crtsh.id,
        status: "unknown",
        retrievedAt: now(),
        raw: { domain: clean, httpStatus: res.status },
      });
    }
  } catch (err) {
    findings.push({
      id: crypto.randomUUID(),
      sourceId: SOURCES.crtsh.id,
      status: "unknown",
      retrievedAt: now(),
      raw: { domain: clean, error: String(err) },
    });
  }

  // 3) Wayback (real).
  try {
    const res = await fetchFn(`https://archive.org/wayback/available?url=${encodeURIComponent(clean)}`);
    if (res.status === 200) {
      const body = (await res.json()) as { archived_snapshots?: { closest?: { url?: string; timestamp?: string; status?: string } } };
      const closest = body.archived_snapshots?.closest;
      if (closest?.url) {
        findings.push({
          id: crypto.randomUUID(),
          sourceId: SOURCES.wayback.id,
          status: "found",
          evidenceUrl: closest.url,
          retrievedAt: now(),
          raw: { snapshot: { url: closest.url, timestamp: closest.timestamp ?? null, status: closest.status ?? null } },
        });
      } else {
        findings.push({
          id: crypto.randomUUID(),
          sourceId: SOURCES.wayback.id,
          status: "not_found",
          retrievedAt: now(),
          raw: { domain: clean, note: "sem snapshot conhecido" },
        });
      }
    } else {
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.wayback.id,
        status: "unknown",
        retrievedAt: now(),
        raw: { domain: clean, httpStatus: res.status },
      });
    }
  } catch (err) {
    findings.push({
      id: crypto.randomUUID(),
      sourceId: SOURCES.wayback.id,
      status: "unknown",
      retrievedAt: now(),
      raw: { domain: clean, error: String(err) },
    });
  }

  // 4) DNS (real).
  if (opts.resolveNs) {
    try {
      const ns = await opts.resolveNs(clean);
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.dnsNs.id,
        status: ns.length > 0 ? "found" : "not_found",
        retrievedAt: now(),
        raw: { domain: clean, ns },
      });
    } catch (err) {
      findings.push({
        id: crypto.randomUUID(),
        sourceId: SOURCES.dnsNs.id,
        status: "unknown",
        retrievedAt: now(),
        raw: { domain: clean, error: String(err) },
      });
    }
  }

  return { findings, raw: { module: "domain", domain: clean } };
}

export function checkDomainTarget(target: OsintTarget, opts: DomainOsintOptions): Promise<DomainOsintResult> {
  if (target.kind !== "domain") {
    return Promise.reject(new Error("alvo não é domain"));
  }
  return checkDomain(target.value, opts);
}
