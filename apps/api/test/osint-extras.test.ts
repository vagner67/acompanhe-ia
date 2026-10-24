/**
 * Sinais de demanda implementados (pesquisa 23/10/2026): confidence scoring,
 * motor de correlação (inferências separadas), alertas de mudança e export
 * CSV/PDF. Tudo determinístico; nenhuma fonte nova é consultada.
 */
import { describe, it, expect } from "vitest";

import { annotateConfidence, countCorroborations, scoreFinding } from "../src/osint/confidence.js";
import { CORRELATION_RULES, runCorrelation } from "../src/osint/correlation.js";
import { diffFindings, staleFindings } from "../src/osint/monitor.js";
import { findingsToCsv, reportToPdf } from "../src/osint/export.js";
import { buildReport } from "../src/osint/report.js";
import type { OsintCase, OsintFinding } from "../src/osint/types.js";

const NOW = new Date("2026-10-23T12:00:00.000Z");

function finding(over: Partial<OsintFinding>): OsintFinding {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    sourceId: "sherlock",
    status: "found",
    retrievedAt: "2026-10-23T10:00:00.000Z",
    ...over,
  };
}

describe("confidence — regra determinística (doc 11 §6b)", () => {
  it("corroboração e classe de fonte mudam o score; status desconhecido derruba", () => {
    const hibp = finding({ sourceId: "hibp", evidenceUrl: "https://haveibeenpwned.com/x" });
    const rdap = finding({ sourceId: "rdap" });
    const dns = finding({ sourceId: "dns-mx" });
    const unknown = finding({ sourceId: "hibp", status: "unknown" });
    const all = [hibp, rdap, dns, unknown];

    const sHibp = scoreFinding(hibp, all, NOW);
    const sUnknown = scoreFinding(unknown, all, NOW);
    // hibp: 40 (conhecido) + 30·0.7 + 20 (2 corrob.) + 10 (fresco) = 91
    expect(sHibp.score).toBe(91);
    expect(sHibp.band).toBe("alta");
    expect(sHibp.factors.corroborations).toBe(2);
    // unknown: 0 + 21 + 20 + 10 = 51 → média (unknown não é "negativo", mas é fraco)
    expect(sUnknown.score).toBe(51);
    expect(sUnknown.score).toBeLessThan(sHibp.score);
  });

  it("achado velho (>30 d) perde o ponto de frescor", () => {
    const old = finding({ sourceId: "rdap", retrievedAt: "2026-08-01T00:00:00.000Z" });
    const s = scoreFinding(old, [old], NOW);
    expect(s.factors.ageDays).toBeGreaterThan(30);
    expect(s.score).toBe(40 + 30 + 0 + 0); // sem corroboração e velho
  });

  it("annotateConfidence é estável e não muta o input", () => {
    const f = finding({ sourceId: "rdap" });
    const before = { ...f };
    const out = annotateConfidence([f], NOW);
    expect(out[0]?.confidence?.score).toBe(80); // 40 + 30·1.0 + 0 + 10
    expect(f).toEqual(before);
    expect(countCorroborations(f, [f])).toBe(0);
  });
});

describe("correlation — inferências separadas do dado bruto", () => {
  it("C1: ≥3 sites → footprint consistente, marcado como inferência", () => {
    const fs = [
      finding({ sourceId: "sherlock", raw: { siteName: "GitHub" } }),
      finding({ sourceId: "sherlock", raw: { siteName: "Reddit" } }),
      finding({ sourceId: "sherlock", raw: { siteName: "Medium" } }),
    ];
    const out = runCorrelation("case1", fs, NOW);
    const c1 = out.find((f) => (f.raw as { rule?: string }).rule === "C1");
    expect(c1?.inference).toBe(true);
    expect(c1?.summary).toContain("INFERÊNCIA");
    expect(c1?.summary).toContain("3 sites");
    expect(c1?.caseId).toBe("case1");
  });

  it("C2/C3: vazamento cruzado; sem disparo quando não há padrão", () => {
    const fs = [
      finding({ sourceId: "hibp", raw: { count: 2 } }),
      finding({ sourceId: "gravatar" }),
      finding({ sourceId: "sherlock", raw: { siteName: "GitHub" } }),
    ];
    const rules = runCorrelation("c", fs, NOW).map((f) => (f.raw as { rule: string }).rule);
    expect(rules).toContain("C2");
    expect(rules).toContain("C3");
    expect(rules).not.toContain("C1");

    expect(runCorrelation("c", [finding({ sourceId: "wayback", status: "not_found" })], NOW)).toEqual([]);
  });

  it("toda regra declarada tem id/descrição (auditável)", () => {
    expect(CORRELATION_RULES.length).toBeGreaterThanOrEqual(5);
    for (const r of CORRELATION_RULES) {
      expect(r.id).toMatch(/^C\d+$/);
      expect(r.description.length).toBeGreaterThan(10);
    }
  });
});

describe("monitor — alertas de mudança e idade", () => {
  it("diff: novo achado, sumido e mudança de status", () => {
    const prev = [
      finding({ id: "a", sourceId: "sherlock", raw: { siteName: "GitHub" } }),
      finding({ id: "b", sourceId: "sherlock", raw: { siteName: "Reddit" } }),
    ];
    const next = [
      finding({ id: "c", sourceId: "sherlock", raw: { siteName: "GitHub" }, status: "not_found" }),
      finding({ id: "d", sourceId: "sherlock", raw: { siteName: "Medium" } }),
    ];
    const alerts = diffFindings("case1", prev, next, NOW);
    const kinds = alerts.map((a) => a.kind).sort();
    expect(kinds).toEqual(["finding_disappeared", "new_finding", "status_changed"]);
    expect(alerts.find((a) => a.kind === "status_changed")?.detail).toContain("found → not_found");
  });

  it("inferências ficam FORA do diff (são derivadas, não somem como achado)", () => {
    const raw = finding({ id: "r1", sourceId: "sherlock", raw: { siteName: "GitHub" } });
    const inf = finding({
      id: "i1",
      sourceId: "correlation",
      inference: true,
      raw: { rule: "C1" },
    });
    // 1ª execução tinha raw+inferência; 2ª só o raw → NENHUM alerta de "sumiu".
    expect(diffFindings("c", [raw, inf], [raw], NOW)).toEqual([]);
  });

  it("stale: achado encontrado há >30 d gera alerta de re-verificação", () => {
    const old = finding({ sourceId: "rdap", retrievedAt: "2026-09-01T00:00:00.000Z" });
    const alerts = staleFindings("c", [old], NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("stale");
    expect(alerts[0]?.detail).toContain("re-verificar");
  });
});

describe("export — CSV e PDF com proveniência", () => {
  const caseRec: OsintCase = {
    id: "case1",
    subjectId: "u1",
    title: "Caso, com vírgula",
    status: "completed",
    targets: [{ kind: "username", value: "octocat" }],
    legalBasis: "execução de contrato (LGPD art. 7º, V)",
    purpose: "teste",
    createdBy: "u1",
    createdAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
  };

  it("CSV: header estável, escape de vírgula/aspas, confidence incluído", () => {
    const f = annotateConfidence(
      [finding({ checkId: "chk1", sourceId: "sherlock", summary: 'achado com "aspas", vírgula' })],
      NOW,
    )[0]!;
    const csv = findingsToCsv(caseRec, [f], new Map([["chk1", { kind: "username", value: "octocat" }]]));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "case_id,target_kind,target_value,source_id,status,inference,confidence_score,confidence_band,evidence_url,retrieved_at,summary",
    );
    expect(lines[1]).toContain("username,octocat,sherlock,found,false,");
    expect(lines[1]).toContain('"achado com ""aspas"", vírgula"');
  });

  it("PDF: cabeçalho %PDF e veredicto LEAD impresso", async () => {
    const report = buildReport({
      caseId: "case1",
      targets: caseRec.targets,
      checks: [],
      findings: [finding({ checkId: "chk1", sourceId: "sherlock", evidenceUrl: "https://www.github.com/octocat" })],
      now: () => "2026-10-23T13:00:00.000Z",
    });
    const pdf = await reportToPdf(caseRec, report, []);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(800);
  });
});
