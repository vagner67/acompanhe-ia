import type { FindingConfidence, MonitorAlert } from "@acompanhe/shared";

export const STATUS_COLORS: Record<string, string> = {
  found: "#4ade80",
  not_found: "#94a3b8",
  unknown: "#fbbf24",
  unavailable: "#fbbf24",
  error: "#f87171",
};

export const STATUS_LABELS: Record<string, string> = {
  found: "encontrado",
  not_found: "ausente",
  unknown: "inconclusivo",
  unavailable: "fonte indisponível",
  error: "erro",
};

export const BAND_COLORS: Record<FindingConfidence["band"], string> = {
  "alta": "#4ade80",
  "média": "#fbbf24",
  "baixa": "#f87171",
};

export const ALERT_LABELS: Record<MonitorAlert["kind"], string> = {
  new_finding: "NOVO achado",
  finding_disappeared: "SUMIU",
  status_changed: "MUDOU",
  stale: "VELHO (re-verificar)",
};
