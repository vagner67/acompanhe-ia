/**
 * Relatório Investiga — proveniência, veredicto humano e sha256.
 *
 * REGRAS DE OURO (contrato do produto):
 * - Cada achado carrega sourceId + evidenceUrl + retrievedAt (nada de conclusão
 *   sem proveniência).
 * - Veredicto é SEMPRE "LEAD — verificar manualmente". O motor gera leads; o
 *   ser humano conclui.
 * - Status `unknown` é EXIBIDO, nunca disfarçado (fonte indisponível ≠ negativo).
 * - Sem prospectação, sem geolocalização, sem inferência de atributo pessoal.
 */
import { randomUUID } from "node:crypto";

import { INVESTIGA_LIMITS } from "@acompanhe/shared";
import type { InvestigaReport, OsintCheck, OsintFinding, OsintTarget } from "./types.js";
import { annotateConfidence } from "./confidence.js";
import { canonicalize, sha256Hex } from "./hash.js";

export type { InvestigaReport } from "./types.js";
export { canonicalize, sha256Hex } from "./hash.js";

export function buildReport(input: {
  caseId: string;
  targets: OsintTarget[];
  checks: OsintCheck[];
  findings: OsintFinding[];
  inferences?: OsintFinding[];
  now?: () => string;
}): InvestigaReport {
  const now = input.now ?? (() => new Date().toISOString());
  const nowDate = new Date(now());
  // Dado bruto vs inferência — nunca misturar (regra da pesquisa 23/10/2026).
  const rawFindings = input.findings.filter((f) => !f.inference);
  const inferences = input.inferences ?? input.findings.filter((f) => f.inference);
  const bySource: InvestigaReport["summary"]["bySource"] = {};
  let found = 0;
  let notFound = 0;
  let unknown = 0;
  for (const f of rawFindings) {
    const bucket = (bySource[f.sourceId] ??= { found: 0, notFound: 0, unknown: 0 });
    if (f.status === "found") {
      bucket.found += 1;
      found += 1;
    } else if (f.status === "not_found") {
      bucket.notFound += 1;
      notFound += 1;
    } else {
      bucket.unknown += 1;
      unknown += 1;
    }
  }

  // confidence é apresentação (muda com a idade): entra no relatório, não no hash.
  const strip = (f: OsintFinding): OsintFinding => {
    const { confidence: _c, ...rest } = f;
    return rest;
  };
  const body = {
    targets: input.targets,
    checks: input.checks.map((c) => ({
      id: c.id,
      target: c.target,
      quotaConsumed: c.quotaConsumed,
      executedAt: c.executedAt,
    })),
    findings: rawFindings.map(strip),
    inferences: inferences.map(strip),
  };

  return {
    id: randomUUID(),
    caseId: input.caseId,
    generatedAt: now(),
    targets: input.targets,
    checks: body.checks,
    findings: annotateConfidence(rawFindings, nowDate),
    inferences: annotateConfidence(inferences, nowDate),
    summary: {
      total: rawFindings.length,
      found,
      notFound,
      unknown,
      inferences: inferences.length,
      bySource,
    },
    verdict: INVESTIGA_LIMITS.verdict,
    integrity: {
      algorithm: "sha256",
      sha256: sha256Hex(canonicalize(body)),
    },
    legalNotice: {
      legalBasis: "execução de contrato (LGPD art. 7º, V) a pedido do titular do caso",
      purpose:
        "verificação passiva de fontes públicas e vazamentos reportados; sem interação com o alvo (PAI/CAI)",
      limitations: [
        "Resultados são LEADS — verificar manualmente antes de qualquer decisão.",
        "Status 'unknown' indica fonte indisponível ou falha de coleta; não é negativo.",
        "Achados têm data de coleta (retrievedAt); após 30 dias re-verificar.",
        "Sem prospectação comercial, sem geolocalização de pessoa, sem inferência de atributo pessoal.",
      ],
    },
  };
}
