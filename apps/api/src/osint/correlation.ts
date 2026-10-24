/**
 * Motor de correlação — regras DECLARATIVAS (mesma doutrina do correlation
 * engine YAML do SpiderFoot: 37 regras pré-definidas; as nossas são as
 * declaradas abaixo, cada uma com id/descrição auditáveis).
 *
 * Regra da pesquisa (23/10/2026): "separar dado bruto de inferência"
 * (coalitioncyber 08/02/2026; r/OSINTExperts: 2–3 fontes antes de correlacionar).
 * Toda saída deste motor tem `inference: true`, sourceId "correlation" e o
 * veredicto do relatório continua "LEAD — verificar manualmente".
 */
import { randomUUID } from "node:crypto";

import { SOURCES } from "./sources.js";
import { siteNameOf } from "./raw.js";
import type { OsintFinding } from "./types.js";

export interface CorrelationRule {
  id: string;
  description: string;
  /** Avalia o conjunto de achados brutos do caso. */
  when: (findings: OsintFinding[]) => boolean;
  /** Emite o resumo factual da inferência + material de apoio. */
  emit: (findings: OsintFinding[]) => { summary: string; raw: Record<string, unknown> };
}

function bySource(findings: OsintFinding[], sourceId: string): OsintFinding[] {
  return findings.filter((f) => f.sourceId === sourceId && f.status === "found" && !f.inference);
}

/** Chave do alvo: siteName (sherlock) ou o próprio sourceId quando global. */
function siteName(f: OsintFinding): string {
  return siteNameOf(f) ?? f.sourceId;
}

export const CORRELATION_RULES: CorrelationRule[] = [
  {
    id: "C1",
    description: "Mesmo username presente em ≥3 sites distintos → footprint consistente",
    when: (fs) => bySource(fs, SOURCES.sherlock.id).length >= 3,
    emit: (fs) => {
      const sites = bySource(fs, SOURCES.sherlock.id).map(siteName);
      return {
        summary: `INFERÊNCIA: username presente em ${sites.length} sites distintos — footprint consistente (não prova mesma pessoa)`,
        raw: { rule: "C1", sites },
      };
    },
  },
  {
    id: "C2",
    description: "HIBP (vazamento) + Gravatar (avatar público) → identidade com histórico de exposição",
    when: (fs) => bySource(fs, SOURCES.hibp.id).length > 0 && bySource(fs, SOURCES.gravatar.id).length > 0,
    emit: (fs) => {
      const breaches = (bySource(fs, SOURCES.hibp.id)[0]?.raw as { count?: number } | undefined)?.count ?? null;
      return {
        summary: "INFERÊNCIA: e-mail com avatar público e histórico de vazamento — alvo de golpe/impersonação é mais provável",
        raw: { rule: "C2", breaches },
      };
    },
  },
  {
    id: "C3",
    description: "HIBP (vazamento) + username em ≥1 site → exposição cruzada",
    when: (fs) => bySource(fs, SOURCES.hibp.id).length > 0 && bySource(fs, SOURCES.sherlock.id).length > 0,
    emit: (fs) => ({
      summary: "INFERÊNCIA: e-mail vazado e username em uso público — cruzar credenciais expostas com contas ativas é risco real",
      raw: {
        rule: "C3",
        sites: bySource(fs, SOURCES.sherlock.id).map(siteName),
      },
    }),
  },
  {
    id: "C4",
    description: "E-mail válido com domínio sem MX → provável descartável/inativo",
    when: (fs) =>
      fs.some((f) => f.sourceId === SOURCES.dnsMx.id && f.status === "not_found" && !f.inference),
    emit: () => ({
      summary: "INFERÊNCIA: domínio do e-mail sem registros MX — endereço provavelmente descartável ou inativo (interpretar com cautela)",
      raw: { rule: "C4" },
    }),
  },
  {
    id: "C5",
    description: "RDAP ativo + certificados CT → infraestrutura de domínio viva",
    when: (fs) => bySource(fs, SOURCES.rdap.id).length > 0 && bySource(fs, SOURCES.crtsh.id).length > 0,
    emit: (fs) => {
      const certs = (bySource(fs, SOURCES.crtsh.id)[0]?.raw as { certificates?: number } | undefined)?.certificates ?? null;
      return {
        summary: `INFERÊNCIA: domínio registrado e com ${certs ?? "?"} certificados CT — infraestrutura ativa`,
        raw: { rule: "C5", certificates: certs },
      };
    },
  },
];

/** Executa as regras e devolve inferências como achados marcados. */
export function runCorrelation(
  caseId: string,
  findings: OsintFinding[],
  now: Date = new Date(),
): OsintFinding[] {
  const out: OsintFinding[] = [];
  for (const rule of CORRELATION_RULES) {
    if (!rule.when(findings)) continue;
    const { summary, raw } = rule.emit(findings);
    out.push({
      id: randomUUID(),
      caseId,
      sourceId: SOURCES.correlation.id,
      status: "found",
      summary,
      retrievedAt: now.toISOString(),
      raw: { ...raw, ruleDescription: rule.description },
      inference: true,
    });
  }
  return out;
}
