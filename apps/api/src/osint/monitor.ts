/**
 * Monitoramento — alertas de MUDANÇA entre execuções e achados velhos.
 *
 * Demanda verificada (pesquisa 23/10/2026): "alerta em tempo real quando dado
 * crítico muda seria enorme e obrigatório para a maioria de nós"
 * (r/osinttools 08/04/2026). Aqui: diff determinístico entre o estado anterior
 * e a nova execução + marcação de achados acima de findingMaxAgeDays (30 d).
 */
import { randomUUID } from "node:crypto";

import { INVESTIGA_LIMITS } from "@acompanhe/shared";

import type { MonitorAlert, OsintFinding } from "./types.js";
import { siteNameOf } from "./raw.js";

function key(f: OsintFinding): string {
  const site = siteNameOf(f);
  return `${f.sourceId}:${site ?? ""}`;
}

function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 9999;
  return Math.max(0, (now.getTime() - t) / 86_400_000);
}

/** Diff determinístico: novos achados, sumidos e mudanças de status. */
export function diffFindings(
  caseId: string,
  previous: OsintFinding[],
  next: OsintFinding[],
  now: Date = new Date(),
): MonitorAlert[] {
  const alerts: MonitorAlert[] = [];
  const createdAt = now.toISOString();
  // Compara APENAS dado bruto: inferências são derivadas e ficam de fora do diff.
  const prevRaw = previous.filter((f) => !f.inference);
  const nextRaw = next.filter((f) => !f.inference);
  const prevByKey = new Map(prevRaw.map((f) => [key(f), f]));
  const nextByKey = new Map(nextRaw.map((f) => [key(f), f]));

  for (const [k, f] of nextByKey) {
    const prev = prevByKey.get(k);
    if (!prev) {
      if (f.status === "found") {
        alerts.push({
          id: randomUUID(),
          caseId,
          kind: "new_finding",
          sourceId: f.sourceId,
          targetKey: k,
          detail: `NOVO: ${f.sourceId}${siteNameOf(f) ? `/${siteNameOf(f)}` : ""} agora encontrado`,
          createdAt,
          raw: { evidenceUrl: f.evidenceUrl ?? null },
        });
      }
      continue;
    }
    if (prev.status !== f.status) {
      alerts.push({
        id: randomUUID(),
        caseId,
        kind: "status_changed",
        sourceId: f.sourceId,
        targetKey: k,
        detail: `MUDOU: ${k} ${prev.status} → ${f.status}`,
        createdAt,
        raw: { from: prev.status, to: f.status },
      });
    }
  }

  for (const [k, f] of prevByKey) {
    if (!nextByKey.has(k) && f.status === "found") {
      alerts.push({
        id: randomUUID(),
        caseId,
        kind: "finding_disappeared",
        sourceId: f.sourceId,
        targetKey: k,
        detail: `SUMIU: ${k} era encontrado e não apareceu na re-verificação`,
        createdAt,
        raw: { evidenceUrl: f.evidenceUrl ?? null },
      });
    }
  }

  return alerts;
}

/** Achados acima da idade máxima (30 d) → recomendação de re-verificação. */
export function staleFindings(
  caseId: string,
  findings: OsintFinding[],
  now: Date = new Date(),
  maxAgeDays = INVESTIGA_LIMITS.findingMaxAgeDays,
): MonitorAlert[] {
  const createdAt = now.toISOString();
  return findings
    .filter((f) => f.status === "found" && daysSince(f.retrievedAt, now) > maxAgeDays)
    .map((f) => ({
      id: randomUUID(),
      caseId,
      kind: "stale" as const,
      sourceId: f.sourceId,
      targetKey: key(f),
      detail: `VELHO: ${key(f)} coletado há ${Math.round(daysSince(f.retrievedAt, now))} d (> ${maxAgeDays} d) — re-verificar antes de decidir`,
      createdAt,
      raw: { retrievedAt: f.retrievedAt },
    }));
}
