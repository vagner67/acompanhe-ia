/**
 * Export do caso — CSV (máquina) e PDF (humano, court-ready base).
 *
 * Demanda verificada (pesquisa 23/10/2026): "timestamp, source attribution e
 * export limpo para PDF ou CSV para que cliente/advogado/tribunal siga o rastro"
 * (espectrosint 03/07/2026). Cada linha/entrada carrega proveniência.
 */
import PDFDocument from "pdfkit";

import type { OsintCase, OsintFinding, MonitorAlert } from "./types.js";
import type { InvestigaReport } from "./report.js";

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV de achados com alvo resolvido (join por checkId→target). Colunas estáveis. */
export function findingsToCsv(
  caseRec: OsintCase,
  findings: OsintFinding[],
  checkTargets: Map<string, { kind: string; value: string }>,
): string {
  const header = [
    "case_id",
    "target_kind",
    "target_value",
    "source_id",
    "status",
    "inference",
    "confidence_score",
    "confidence_band",
    "evidence_url",
    "retrieved_at",
    "summary",
  ];
  const rows = [header.join(",")];
  for (const f of findings) {
    const t = f.checkId ? checkTargets.get(f.checkId) : undefined;
    rows.push(
      [
        caseRec.id,
        t?.kind ?? "",
        t?.value ?? "",
        f.sourceId,
        f.status,
        f.inference ? "true" : "false",
        f.confidence?.score ?? "",
        f.confidence?.band ?? "",
        f.evidenceUrl ?? "",
        f.retrievedAt,
        f.summary ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return rows.join("\n") + "\n";
}

/** PDF do relatório — texto puro, proveniência por entrada, veredicto fixo. */
export async function reportToPdf(
  caseRec: OsintCase,
  report: InvestigaReport,
  alerts: MonitorAlert[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).text("Acompanhe.IA — Relatório Investiga", { underline: false });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor("#444444").text(`Caso: ${caseRec.title} (${caseRec.id})`);
    doc.text(`Gerado em: ${report.generatedAt}`);
    doc.text(`Base legal: ${caseRec.legalBasis}`);
    doc.text(`Finalidade: ${caseRec.purpose}`);
    doc.moveDown(0.5);

    doc.fontSize(11).fillColor("#000000").text(`VEREDITO: ${report.verdict}`, { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(9).text(
      `Resumo: ${report.summary.total} achados — ${report.summary.found} encontrados · ${report.summary.notFound} ausentes · ${report.summary.unknown} inconclusivos · ${report.summary.inferences ?? 0} inferências`,
    );
    doc.moveDown(0.5);

    doc.fontSize(11).text("Achados (com proveniência)", { underline: true });
    doc.moveDown(0.2);
    for (const f of report.findings) {
      const conf = f.confidence ? `[confiança ${f.confidence.score}/100 ${f.confidence.band}]` : "";
      doc.fontSize(9).fillColor("#000000");
      doc.text(
        `${f.inference ? "▸ INFERÊNCIA" : "•"} ${f.sourceId} — ${f.status.toUpperCase()} ${conf}`,
        { continued: true },
      );
      doc.text(`  (${f.retrievedAt})`);
      if (f.evidenceUrl) doc.fillColor("#2244aa").text(`  ${f.evidenceUrl}`);
      if (f.summary) doc.fillColor("#333333").text(`  ${f.summary}`);
      doc.moveDown(0.25);
    }

    if (report.inferences && report.inferences.length > 0) {
      doc.addPage();
      doc.fontSize(11).fillColor("#000000").text("Inferências do motor de correlação (não são dado bruto)", { underline: true });
      doc.moveDown(0.3);
      for (const inf of report.inferences) {
        doc.fontSize(9).text(`▸ ${inf.summary ?? inf.sourceId}`);
        doc.moveDown(0.2);
      }
    }

    if (alerts.length > 0) {
      doc.moveDown(0.5);
      doc.fontSize(11).text("Alertas de monitoramento", { underline: true });
      for (const a of alerts) {
        doc.fontSize(9).text(`! [${a.kind}] ${a.detail} (${a.createdAt})`);
      }
    }

    doc.moveDown(1);
    doc.fontSize(8).fillColor("#444444").text("Limitações e termos", { underline: true });
    for (const l of report.legalNotice.limitations) {
      doc.text(`— ${l}`);
    }
    doc.moveDown(0.5);
    doc.text(`Integridade: ${report.integrity.algorithm} ${report.integrity.sha256}`);

    doc.end();
  });
}
