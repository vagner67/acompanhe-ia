/**
 * Acesso tipado a `raw` de achados (doc 13, R8). Antes, a extração de
 * `siteName` estava replicada com cast em 3 lugares (monitor.ts ×2,
 * correlation.ts) — cada novo consumidor inventava sua própria forma.
 */
import type { OsintFinding } from "./types.js";

export interface SherlockRawLike {
  siteName?: string;
}

/** siteName do raw do Sherlock (ou undefined — nunca inventar). */
export function siteNameOf(f: OsintFinding): string | undefined {
  const raw = f.raw as SherlockRawLike | undefined;
  return raw && typeof raw === "object" ? raw.siteName : undefined;
}
