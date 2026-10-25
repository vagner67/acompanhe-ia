/**
 * Token de serviço (chamadas máquina→máquina: ingestão do índice, ops).
 * Em produção vem de um Render Secret File (`SERVICE_TOKEN_FILE`), nunca de env
 * em texto no painel; localmente cai no `.secrets.json`. Cache de 5s evita
 * leitura de disco por request — a rotação de token vale em ≤5s.
 */
import { readFileSync } from "node:fs";

export const caminhoServiceToken = () => process.env.SERVICE_TOKEN_FILE ?? "/home/user/.secrets.json";
const ARQUIVO = caminhoServiceToken;
let cache: { token: string | null; at: number } = { token: null, at: 0 };

export function readServiceToken(): string | null {
  if (Date.now() - cache.at < 5000) return cache.token;
  let token: string | null = null;
  try {
    token = (JSON.parse(readFileSync(ARQUIVO(), "utf8")) as { SERVICE_TOKEN?: string }).SERVICE_TOKEN ?? null;
  } catch {
    /* sem arquivo = sem token */
  }
  if (!token) token = process.env.SERVICE_TOKEN ?? null;
  cache = { token, at: Date.now() };
  return token;
}

/** Só para testes: descarta o cache. */
export function esquecerServiceToken(): void {
  cache = { token: null, at: 0 };
}
