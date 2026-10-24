import { z } from "zod";

/** Configuração validada por Zod em toda fronteira (doc 03 §6). */
const envSchema = z.object({
  BOT_TOKEN: z.string().min(10),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  JWT_SECRET: z.string().min(16),
  JWT_TTL_SECONDS: z.coerce.number().int().default(3600),
  AUTH_DATE_FINANCE_MAX_AGE: z.coerce.number().int().default(300),
  AUTH_DATE_LOGIN_MAX_AGE: z.coerce.number().int().default(86400),
  PUSHINPAY_API_BASE: z.string().url().default("https://api.pushinpay.com.br"),
  PUSHINPAY_TOKEN: z.string().default(""),
  PUSHINPAY_WEBHOOK_SECRET: z.string().default(""),
  PUBLIC_BASE_URL: z.string().default(""),
  // ————— Investiga (doc 11) —————
  /** Chave paga da Have I Been Pwned v3 (32 hex). Sem chave → fonte "unavailable". */
  HIBP_API_KEY: z.string().default(""),
  HIBP_USER_AGENT: z.string().default("AcompanheIA-Investiga/1.0"),
  /** Binário do sherlock (sherlock-project v0.16.2; verificado 22/10/2026). */
  DATABASE_URL: z.string().optional(),
  SHERLOCK_BIN: z.string().default("sherlock"),
  SHERLOCK_TIMEOUT_MS: z.coerce.number().int().default(60000),
  /** Token do diretor (painel soberano) para atos administrativos (trial etc.). */
  ADMIN_TOKEN: z.string().default(""),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const botToken = env.BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN;
  if (!botToken && env.NODE_ENV === "production") {
    // Falha FAST: placeholder silencioso quebrava o auth do Telegram em produção
    // (banner "initData inválido" culpando o usuário — bug apontado no E2E 24/10).
    throw new Error("TELEGRAM_BOT_TOKEN/BOT_TOKEN ausente em produção — recusando subir");
  }
  return envSchema.parse({
    BOT_TOKEN: botToken ?? "000000000:DEV_PLACEHOLDER_TOKEN_NOT_FOR_PRODUCTION",
    PORT: env.PORT,
    HOST: env.HOST,
    NODE_ENV: env.NODE_ENV,
    JWT_SECRET: env.JWT_SECRET ?? "dev-only-jwt-secret-change-in-production-0123456789",
    JWT_TTL_SECONDS: env.JWT_TTL_SECONDS,
    AUTH_DATE_FINANCE_MAX_AGE: env.AUTH_DATE_FINANCE_MAX_AGE,
    AUTH_DATE_LOGIN_MAX_AGE: env.AUTH_DATE_LOGIN_MAX_AGE,
    PUSHINPAY_API_BASE: env.PUSHINPAY_API_BASE,
    PUSHINPAY_TOKEN: env.PUSHINPAY_TOKEN,
    PUSHINPAY_WEBHOOK_SECRET: env.PUSHINPAY_WEBHOOK_SECRET,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL ?? "",
    HIBP_API_KEY: env.HIBP_API_KEY,
    HIBP_USER_AGENT: env.HIBP_USER_AGENT,
    DATABASE_URL: env.DATABASE_URL,
    SHERLOCK_BIN: env.SHERLOCK_BIN,
    SHERLOCK_TIMEOUT_MS: env.SHERLOCK_TIMEOUT_MS,
    ADMIN_TOKEN: env.ADMIN_TOKEN,
  });
}
