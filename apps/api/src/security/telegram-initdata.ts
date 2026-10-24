import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Validação de initData do Telegram (doc 02 §3 — checklist "imprimir na parede").
 * - secret = HMAC_SHA256(key literal "WebAppData", msg = bot_token)
 * - data_check_string = pares "chave=valor" ordenados por chave, sem `hash`, unidos por \n
 * - comparação constant-time em bytes UTF-8
 * - auth_date ≤ maxAgeSec (300 s financeiro / 24 h login — doc 02 §1)
 * NUNCA logar o initData (PII + token de sessão).
 */

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export type VerifyResult =
  | { ok: true; data: Map<string, string>; user: TelegramUser | null }
  | { ok: false; reason: "missing_hash" | "bad_hash" | "missing_auth_date" | "expired_auth_date" | "bad_user" };

function hmacSha256(key: Buffer | string, msg: string): Buffer {
  return createHmac("sha256", key).update(msg, "utf8").digest();
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // compara com ele mesmo para manter tempo ~constante no tamanho
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSec: number; nowSec?: number },
): VerifyResult {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing_hash" };

  params.delete("hash");
  const keys = [...new Set([...params.keys()])].sort();
  const dataCheckString = keys.map((k) => `${k}=${params.get(k) ?? ""}`).join("\n");

  const secret = hmacSha256("WebAppData", botToken);
  const computed = hmacSha256(secret, dataCheckString).toString("hex");

  if (!constantTimeEqualHex(computed, hash)) return { ok: false, reason: "bad_hash" };

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw || !/^\d+$/.test(authDateRaw)) return { ok: false, reason: "missing_auth_date" };
  const authDate = Number(authDateRaw);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (now - authDate > opts.maxAgeSec) return { ok: false, reason: "expired_auth_date" };

  let user: TelegramUser | null = null;
  const userRaw = params.get("user");
  if (userRaw) {
    try {
      const parsed = JSON.parse(userRaw) as TelegramUser;
      if (typeof parsed?.id !== "number") return { ok: false, reason: "bad_user" };
      user = parsed;
    } catch {
      return { ok: false, reason: "bad_user" };
    }
  }

  return { ok: true, data: new Map(params), user };
}

/** Para testes e dev: gera um initData válido (não existe em produção). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  const keys = [...new Set([...params.keys()])].sort();
  const dcs = keys.map((k) => `${k}=${params.get(k) ?? ""}`).join("\n");
  const secret = hmacSha256("WebAppData", botToken);
  const hash = hmacSha256(secret, dcs).toString("hex");
  params.set("hash", hash);
  return params.toString();
}
