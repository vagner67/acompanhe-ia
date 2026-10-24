/**
 * Confiança por achado — regra DETERMINÍSTICA e declarada (doc 11 §6b).
 *
 * Demanda verificada (pesquisa 23/10/2026): usuários pedem "source confidence
 * scoring" antes de correlacionar (r/OSINTExperts 08/04/2026) e tratamento de
 * falso-positivo (checkers de username dão falso-positivo "rotineiramente" —
 * revealer.us). A regra abaixo NÃO é juízo de verdade do fato: é um score de
 * **robustez do sinal** baseado só em fatores observáveis:
 *
 *   score = 40·[status conhecido] + 30·peso(fonte) + 20·[corroboração≥2] + 10·[fresco ≤30d]
 *
 * - peso(fonte): primary=1.0 (RDAP/DNS/CT/HTTP status), aggregator=0.7 (HIBP),
 *   ugc=0.5 (perfil social/Gravatar), inference=0.4 (correlação).
 * - corroboração: ≥2 achados "found" de sourceIds DISTINTOS no mesmo caso.
 * - fresco: retrievedAt há ≤30 dias (findingMaxAgeDays).
 * - band: ≥75 alta · 50–74 média · <50 baixa.
 *
 * Score alto NÃO significa "fato verdadeiro": significa sinal com múltipla
 * sustentação. A decisão continua humana ("LEAD — verificar manualmente").
 */
import { INVESTIGA_LIMITS } from "@acompanhe/shared";

import type { ConfidenceBand, FindingConfidence, OsintFinding } from "./types.js";
import { sourceClassOf } from "./sources.js";

export { sourceClassOf } from "./sources.js";

const SOURCE_WEIGHT: Record<FindingConfidence["factors"]["sourceClass"], number> = {
  primary: 1.0,
  aggregator: 0.7,
  ugc: 0.5,
  inference: 0.4,
};

function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 9999;
  return Math.max(0, (now.getTime() - t) / 86_400_000);
}

/** Conta corroborações: achados "found" de outras fontes no mesmo caso. */
export function countCorroborations(finding: OsintFinding, caseFindings: OsintFinding[]): number {
  const others = caseFindings.filter(
    (f) => f.status === "found" && f.sourceId !== finding.sourceId && f.id !== finding.id,
  );
  return new Set(others.map((f) => f.sourceId)).size;
}

export function scoreFinding(
  finding: OsintFinding,
  caseFindings: OsintFinding[],
  now: Date = new Date(),
): FindingConfidence {
  const sourceClass = finding.inference ? "inference" : sourceClassOf(finding.sourceId);
  const corroborations = finding.inference ? 0 : countCorroborations(finding, caseFindings);
  const ageDays = daysSince(finding.retrievedAt, now);
  const statusKnown = finding.status !== "unknown" && finding.status !== "error";

  const score = Math.round(
    (statusKnown ? 40 : 0) +
      30 * SOURCE_WEIGHT[sourceClass] +
      (corroborations >= 2 ? 20 : 0) +
      (ageDays <= INVESTIGA_LIMITS.findingMaxAgeDays ? 10 : 0),
  );

  const band: ConfidenceBand = score >= 75 ? "alta" : score >= 50 ? "média" : "baixa";
  return {
    score,
    band,
    factors: { sourceClass, corroborations, ageDays: Math.round(ageDays), statusKnown },
  };
}

/** Anota todos os achados de um caso com confidence (imutável). */
export function annotateConfidence(
  findings: OsintFinding[],
  now: Date = new Date(),
): OsintFinding[] {
  return findings.map((f) => ({ ...f, confidence: scoreFinding(f, findings, now) }));
}
