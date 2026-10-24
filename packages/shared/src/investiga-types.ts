/**
 * DTOs do Investiga — CONTRATO ÚNICO compartilhado entre API e web (doc 13, R1).
 *
 * Motivo (defeito D5 do doc 13): os tipos eram copiados à mão entre
 * `apps/api/src/osint/types.ts` e `apps/web/src/api.ts`; as cópias divergiram
 * em silêncio (incidente real de 23/10/2026: API emitia `band:"media"` e a web
 * declarava `"média"`). Aqui vive UMA definição; api e web importam daqui.
 * A forma abaixo é a do JSON real emitido pela API (contrato congelado doc 13 §4).
 */

export type OsintTargetKind = "username" | "email" | "phone" | "domain" | "name" | "url";

export type FindingStatus = "found" | "not_found" | "unknown" | "unavailable" | "error";

export interface OsintTarget {
  kind: OsintTargetKind;
  value: string;
  label?: string;
}

export type ConfidenceBand = "alta" | "média" | "baixa";

export interface FindingConfidence {
  /** 0–100, fórmula determinística (doc 11 §6b). */
  score: number;
  band: ConfidenceBand;
  /** Fatores observáveis que compuseram o score (auditável). */
  factors: {
    sourceClass: "primary" | "aggregator" | "ugc" | "inference";
    corroborations: number;
    ageDays: number;
    statusKnown: boolean;
  };
}

export interface OsintFinding {
  id: string;
  /** Check que produziu o achado (preenchido na orquestração). */
  checkId?: string;
  /** Caso dono — usado por inferências (correlação), que abrangem o caso todo. */
  caseId?: string;
  /** Fonte real (ex.: "sherlock", "hibp", "gravatar", "rdap", "crtsh"). */
  sourceId: string;
  status: FindingStatus;
  /** Frase curta factual (o que a fonte disse), sem conclusão. */
  summary?: string;
  evidenceUrl?: string;
  retrievedAt: string;
  /** Resposta bruta enxuta (sem PII de terceiros além do necessário). */
  raw?: unknown;
  /** Confiança declarada (doc 11 §6b) — NUNCA é veredito. */
  confidence?: FindingConfidence;
  /** true = inferência do motor de correlação, NÃO dado bruto de fonte. */
  inference?: boolean;
}

export type MonitorAlertKind = "new_finding" | "finding_disappeared" | "status_changed" | "stale";

/** Alerta de monitoramento (mudança ou achado velho). */
export interface MonitorAlert {
  id: string;
  caseId: string;
  kind: MonitorAlertKind;
  sourceId: string;
  targetKey: string;
  detail: string;
  createdAt: string;
  /** Dados de apoio (status anterior/novo, idades). */
  raw?: unknown;
}

export type OsintCheckStatus = "queued" | "running" | "completed" | "error";

export interface OsintCheck {
  id: string;
  caseId: string;
  target: OsintTarget;
  legalBasis: string;
  purpose: string;
  quotaConsumed: number;
  status: OsintCheckStatus;
  executedAt: string;
  error?: string;
}

export type OsintCaseStatus = "draft" | "queued" | "running" | "completed" | "archived" | "error";

export interface OsintCase {
  id: string;
  subjectId: string;
  title: string;
  status: OsintCaseStatus;
  targets: OsintTarget[];
  /** LGPD art. 7º/11 — base declarada por caso (nunca presumida). */
  legalBasis: string;
  /** "specific intelligence requirement" (doutrina) — por que se investiga. */
  purpose: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Janela diária de quota (teto 150 checks/dia — v2/08 §9.3). */
export interface QuotaWindow {
  day: string;
  used: number;
  limit: number;
  remaining: number;
}

/** Relatório Investiga — forma do JSON de GET /v1/investiga/cases/:id/report. */
export interface InvestigaReport {
  id: string;
  caseId: string;
  generatedAt: string;
  targets: OsintTarget[];
  checks: Array<{
    id: string;
    target: OsintTarget;
    quotaConsumed: number;
    executedAt: string;
  }>;
  findings: OsintFinding[];
  /** Inferências do motor de correlação — SEPARADAS do dado bruto. */
  inferences: OsintFinding[];
  summary: {
    total: number;
    found: number;
    notFound: number;
    unknown: number;
    inferences: number;
    bySource: Record<string, { found: number; notFound: number; unknown: number }>;
  };
  verdict: string;
  integrity: {
    algorithm: "sha256";
    /** sha256 do corpo canônico (targets+checks+findings+inferences).
     *  `confidence` fica FORA do hash: muda com a idade do achado. */
    sha256: string;
  };
  legalNotice: {
    legalBasis: string;
    purpose: string;
    limitations: string[];
  };
}
