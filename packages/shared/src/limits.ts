/**
 * Limites REAIS do Telegram — implementar como constantes (doc 03 §2).
 * Fonte: core.telegram.org/bots/api · FAQ oficial · Bot API 10.3 (exame 21/10/2026).
 */
export const TELEGRAM_LIMITS = {
  MAX_TEXT: 4096, // code points
  MAX_CAPTION: 1024,
  UPLOAD_PHOTO_BYTES: 10 * 1024 * 1024, // multipart
  UPLOAD_DOC_BYTES: 50 * 1024 * 1024, // multipart
  DOWNLOAD_FILE_BYTES: 20_971_520, // getFile (medida pública 08/2026)
  LOCAL_API_UPLOAD_BYTES: 2_000 * 1024 * 1024, // só com bot-api server local
  RATE_CHAT_MSG_PER_SEC: 1, // 429 + retry_after — fila única por chat
  RATE_GROUP_MSG_PER_MIN: 20,
  RATE_BROADCAST_PER_SEC: 30,
  RATE_BROADCAST_PAID_PER_SEC: 1000, // allow_paid_broadcast (0,1 ★/msg)
  WEBHOOK_PORTS: [443, 80, 88, 8443] as const,
  CALLBACK_DATA_MAX_BYTES: 64, // só ids/opcodes
} as const;

/** Limites de produto (docs 02 §1 · 04 §3 · 06 §3) — editáveis só pelo diretor em rules_config. */
export const PRODUCT_LIMITS = {
  MAX_ACTIVE_LOAN_REQUESTS: 5,
  MAX_LIKES_PER_HOUR: 10,
  MAX_BOOSTS_PER_DAY: 3,
  MAX_PAIR_TOTAL_CENTS: 1_500_000, // R$ 15.000/par (04 §3 · 05 §3)
  MAX_PUBLISH_RATE_BPS: 400, // juros publicação ≤ 4% a.m.
  MATCH_CHAT_HOURS: 72,
  NEGOTIATION_ROUNDS: 3,
  PROPOSAL_TTL_HOURS: 24,
  PAYMENT_DECLARATION_TTL_HOURS: 72, // declared→confirmed→disputed (06 §4)
  MIN_PUSHINPAY_VALUE_CENTS: 50, // doc 08 §2
} as const;

/** Janelas de initData (doc 02 §1/§3) — 300 s financeiro, 24 h login. */
export const AUTH_WINDOWS = {
  FINANCE_MAX_AGE_SEC: 300,
  LOGIN_MAX_AGE_SEC: 86_400,
} as const;
