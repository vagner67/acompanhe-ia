/**
 * Escala E1–E5 e tags — doc 04 §1/§3 (âncora A4: nivel = min(verificação, histórico)).
 */
export type LevelCode = "E1" | "E2" | "E3" | "E4" | "E5";

export interface LevelSpec {
  code: LevelCode;
  name: string;
  maxCents: number;
  minVerification: "V1" | "V2" | "V3" | "V4";
  requirements: string;
}

export const LEVELS: readonly LevelSpec[] = [
  { code: "E1", name: "Semeador", maxCents: 30_000, minVerification: "V1", requirements: "entrada" },
  { code: "E2", name: "Construtor", maxCents: 80_000, minVerification: "V1", requirements: "1 quitado em dia" },
  { code: "E3", name: "Firme", maxCents: 200_000, minVerification: "V2", requirements: "3 quitados + 30 d + 0 atrasos > 30 d" },
  { code: "E4", name: "Confiança", maxCents: 500_000, minVerification: "V3", requirements: "5 quitados + 90 d + renda comprovada" },
  { code: "E5", name: "Ouro", maxCents: 1_500_000, minVerification: "V4", requirements: "10 quitados + 12 meses + score ≥ 850" },
] as const;

/** nível = min(nível_verificação, nível_histórico) — A4. */
export function effectiveLevel(verificationLevel: LevelCode, historyLevel: LevelCode): LevelCode {
  const order: LevelCode[] = ["E1", "E2", "E3", "E4", "E5"];
  return order[Math.min(order.indexOf(verificationLevel), order.indexOf(historyLevel))]!;
}

export type TagCode = "bom_pagador" | "exemplar" | "observacao" | "mal_pagador" | "fraude_ban";

export const TAGS: readonly TagCode[] = ["bom_pagador", "exemplar", "observacao", "mal_pagador", "fraude_ban"];

/** Validade das tags (04 §1): 6/12/24 meses conforme a tag. */
export const TAG_VALIDITY_MONTHS: Record<TagCode, number> = {
  bom_pagador: 6,
  exemplar: 24,
  observacao: 6,
  mal_pagador: 12,
  fraude_ban: 24,
};

/** Índice de Calor 0–100: IC = 40R + 25F + 20P + 15V (04 §3). */
export function heatIndex(r: number, f: number, p: number, v: number): number {
  const ic = 40 * r + 25 * f + 20 * p + 15 * v;
  return Math.max(0, Math.min(100, Math.round(ic)));
}

export type HeatClass = "quente_verificada" | "morna" | "fria" | "congelada";

export function heatClass(ic: number, v1: boolean, diasSemAcao: number): HeatClass {
  if (diasSemAcao >= 90) return "congelada";
  if (ic < 40 || diasSemAcao >= 30) return "fria";
  if (ic >= 70 && v1) return "quente_verificada";
  return "morna";
}

/** score_final = score × (0.85 + 0.15 × IC/100) (04 §5). */
export function finalScore(score: number, ic: number): number {
  return Math.round(score * (0.85 + 0.15 * (Math.max(0, Math.min(100, ic)) / 100)) * 100) / 100;
}
