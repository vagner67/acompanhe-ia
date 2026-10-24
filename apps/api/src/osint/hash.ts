/**
 * Hash de auditoria (doc 13, R11.3) — serialização canônica + sha256.
 * Separado do relatório para que montar conteúdo e digerir conteúdo não
 * sejam o mesmo módulo. As funções NÃO mudaram de comportamento: o sha256
 * dos relatórios continua idêntico (contrato congelado doc 13 §4).
 */
import { createHash } from "node:crypto";

/** Serialização canônica (chaves ordenadas) para o hash de auditoria. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
