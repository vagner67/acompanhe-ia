/**
 * Boilerplate compartilhado dos smokes (doc 13, R10) — antes duplicado em
 * smoke-investiga.ts e smoke-extras.ts (com cópias já divergentes).
 */
import { signInitData } from "../src/security/telegram-initdata.js";

export const API = process.env.API_BASE ?? "http://localhost:3000";
export const BOT_TOKEN = process.env.BOT_TOKEN ?? "000000000:DEV_PLACEHOLDER_TOKEN_NOT_FOR_PRODUCTION";
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "smoke-admin-token";

export interface SmokeCall {
  status: number;
  json: Record<string, unknown>;
  res: Response;
}

export async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<SmokeCall> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json, res };
}

export function initDataFor(userId: number, firstName: string, username: string): string {
  return signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: userId, first_name: firstName, username }),
    },
    BOT_TOKEN,
  );
}

export async function login(
  userId: number,
  firstName: string,
  username: string,
): Promise<{ token: string; status: number; json: Record<string, unknown> }> {
  const auth = await call("POST", "/api/auth/telegram", { initData: initDataFor(userId, firstName, username) });
  return { token: auth.json.token as string, status: auth.status, json: auth.json };
}
