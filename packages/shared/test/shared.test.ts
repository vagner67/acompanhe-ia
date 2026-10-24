import { describe, it, expect } from "vitest";
import { PLAN_SKUS, TRIAL, AVULSOS, planByCode } from "../src/skus.js";
import { LEVELS, effectiveLevel, heatIndex, heatClass, finalScore, TAG_VALIDITY_MONTHS } from "../src/levels.js";
import { TELEGRAM_LIMITS, PRODUCT_LIMITS, AUTH_WINDOWS } from "../src/limits.js";

describe("SKUs canônicos (doc 08 §9)", () => {
  it("preços batem com a tabela canônica", () => {
    expect(PLAN_SKUS.map((p) => [p.code, p.monthlyCents, p.yearlyCents])).toEqual([
      ["anota", 1490, 14900],
      ["juridica", 3990, 39900],
      ["licitacao", 4990, 49900],
      ["concurso", 2490, 24900],
      ["investiga", 5990, 59900],
    ]);
  });
  it("quotas de IA por dia", () => {
    expect(PLAN_SKUS.map((p) => p.aiMessagesPerDay)).toEqual([20, 60, 60, 40, 80]);
  });
  it("trial 7 dias 1× · avulsos 9,90 · investigaPack", () => {
    expect(TRIAL.days).toBe(7);
    expect(AVULSOS.boostPack).toEqual({ cents: 990, quantity: 5 });
    expect(AVULSOS.investigaPack).toEqual({ cents: 990, quantity: 5 });
    expect(planByCode("licitacao")?.name).toBe("Licitação");
    expect(planByCode("investiga")?.name).toBe("Investiga");
    expect(planByCode("investiga")?.monthlyCents).toBe(5990);
    expect(planByCode("investiga")?.yearlyCents).toBe(59900);
  });
});

describe("escala/tags/IC (doc 04)", () => {
  it("tetos E1–E5", () => {
    expect(LEVELS.map((l) => l.maxCents)).toEqual([30_000, 80_000, 200_000, 500_000, 1_500_000]);
  });
  it("nivel = min(verificação, histórico) — A4", () => {
    expect(effectiveLevel("E4", "E2")).toBe("E2");
    expect(effectiveLevel("E1", "E5")).toBe("E1");
    expect(effectiveLevel("E3", "E3")).toBe("E3");
  });
  it("IC = 40R+25F+20P+15V com clamp 0–100", () => {
    expect(heatIndex(1, 1, 1, 1)).toBe(100);
    expect(heatIndex(0, 0, 0, 0)).toBe(0);
    expect(heatIndex(0.5, 1, 1, 1)).toBe(80);
    expect(heatIndex(2, 0, 0, 0)).toBe(80); // clamp em componentes altos ainda ≤ 100
  });
  it("classes quente/morna/fria/congelada", () => {
    expect(heatClass(80, true, 0)).toBe("quente_verificada");
    expect(heatClass(80, false, 0)).toBe("morna");
    expect(heatClass(50, true, 30)).toBe("fria");
    expect(heatClass(90, true, 90)).toBe("congelada");
  });
  it("score_final = score × (0.85 + 0.15 × IC/100)", () => {
    expect(finalScore(100, 100)).toBe(100);
    expect(finalScore(100, 0)).toBe(85);
  });
  it("validade das tags 6/12/24 m", () => {
    expect(TAG_VALIDITY_MONTHS).toEqual({
      bom_pagador: 6, exemplar: 24, observacao: 6, mal_pagador: 12, fraude_ban: 24,
    });
  });
});

describe("limites (docs 02/03/06)", () => {
  it("Telegram — doc 03 §2", () => {
    expect(TELEGRAM_LIMITS.MAX_TEXT).toBe(4096);
    expect(TELEGRAM_LIMITS.DOWNLOAD_FILE_BYTES).toBe(20_971_520);
    expect(TELEGRAM_LIMITS.CALLBACK_DATA_MAX_BYTES).toBe(64);
    expect(TELEGRAM_LIMITS.WEBHOOK_PORTS).toEqual([443, 80, 88, 8443]);
  });
  it("produto — doc 02 §1 / 06 §3", () => {
    expect(PRODUCT_LIMITS.MAX_ACTIVE_LOAN_REQUESTS).toBe(5);
    expect(PRODUCT_LIMITS.MAX_LIKES_PER_HOUR).toBe(10);
    expect(PRODUCT_LIMITS.MAX_BOOSTS_PER_DAY).toBe(3);
    expect(PRODUCT_LIMITS.MAX_PAIR_TOTAL_CENTS).toBe(1_500_000);
    expect(PRODUCT_LIMITS.MIN_PUSHINPAY_VALUE_CENTS).toBe(50);
  });
  it("janelas de initData — doc 02", () => {
    expect(AUTH_WINDOWS.FINANCE_MAX_AGE_SEC).toBe(300);
    expect(AUTH_WINDOWS.LOGIN_MAX_AGE_SEC).toBe(86_400);
  });
});
