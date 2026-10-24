import { z } from "zod";
import { PRODUCT_LIMITS } from "./limits.js";

/** UFs do Brasil (IBGE) — regionalização (A6). */
export const UFS = [
  "AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI",
  "RJ","RN","RS","RO","RR","SC","SP","SE","TO",
] as const;

export const ufSchema = z.enum(UFS);
export const cityIbgeSchema = z.number().int().min(1_000_000).max(99_99999);

/** Entrada do fluxo de onboarding (doc 03 §3 passos 2–4). */
export const onboardingSchema = z.object({
  uf: ufSchema,
  cityIbge: cityIbgeSchema,
  termsVersion: z.string().min(1),
  termsAccepted: z.literal(true),
});

/** Pedido de empréstimo (doc 06 §3 — gates de publicação). */
export const loanRequestSchema = z
  .object({
    amountCents: z.number().int().min(1).max(PRODUCT_LIMITS.MAX_PAIR_TOTAL_CENTS),
    purpose: z.string().min(3).max(200),
    termMonths: z.number().int().min(1).max(24),
    maxInterestBps: z.number().int().min(0).max(PRODUCT_LIMITS.MAX_PUBLISH_RATE_BPS),
    correction: z.enum(["none", "ipca", "igpm"]),
  })
  .strict();

/** Payload do webhook Pushin Pay (doc 08 §3) — id é normalizado (lower). */
export const pushinpayWebhookSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["created", "processing", "paid", "expired"]),
    value: z.number().int().min(0).optional(),
  })
  .passthrough();

export const regionSchema = z.object({ uf: ufSchema, cityIbge: cityIbgeSchema }).strict();

export type OnboardingInput = z.infer<typeof onboardingSchema>;
export type LoanRequestInput = z.infer<typeof loanRequestSchema>;
export type PushinpayWebhook = z.infer<typeof pushinpayWebhookSchema>;
