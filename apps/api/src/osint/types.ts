/**
 * Tipos do Investiga (doc 11) — reexport do contrato ÚNICO em
 * `@acompanhe/shared/investiga-types` (doc 13, R1). Este módulo mantém o
 * caminho histórico `osint/types.js` estável; a definição vive no shared
 * para API e web nunca divergirem (incidente "media"/"média" de 23/10/2026).
 *
 * Todo achado carrega proveniência (sourceId + evidenceUrl + retrievedAt);
 * LEAD, nunca conclusão. Status "unknown"/"unavailable" é EXIBIDO, nunca
 * disfarçado de negativo.
 */
export type {
  ConfidenceBand,
  FindingConfidence,
  FindingStatus,
  InvestigaReport,
  MonitorAlert,
  MonitorAlertKind,
  OsintCase,
  OsintCaseStatus,
  OsintCheck,
  OsintCheckStatus,
  OsintFinding,
  OsintTarget,
  OsintTargetKind,
  QuotaWindow,
} from "@acompanhe/shared";
