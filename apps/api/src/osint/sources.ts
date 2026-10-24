/**
 * Registro ÚNICO de fontes do Investiga (doc 13, R4).
 *
 * Antes: 44 literais de sourceId espalhados em ≥6 arquivos + um mapa paralelo
 * de classes em confidence.ts — digitação errada = fonte sem classe de
 * confiança, silenciosamente. Agora: TODO sourceId do produto nasce aqui.
 *
 * Classes (doc 11 §6b — pesos em confidence.ts):
 *   primary     = registro oficial/protocolo (RDAP, DNS, CT, HTTP, libphonenumber)
 *   aggregator  = agregador de vazamento/índice (HIBP)
 *   ugc         = conteúdo de usuário (Sherlock/Gravatar) — evidência de conta,
 *                 não de identidade
 *   inference   = derivado por regra (correlação) ou sem fonte real
 */
import { SHERLOCK_SOURCE_ID } from "@acompanhe/shared";

import type { FindingConfidence } from "./types.js";

export type SourceClass = FindingConfidence["factors"]["sourceClass"];

export interface SourceDef {
  id: string;
  sourceClass: SourceClass;
  label: string;
}

/** Sem fonte real dedicada (alvo name/url em S1) — nunca inventar resultado. */
export const NO_SOURCE_ID = "s1-no-source";
/** Inferência do motor de correlação — nunca dado bruto. */
export const CORRELATION_SOURCE_ID = "correlation";

export const SOURCES = {
  sherlock: { id: SHERLOCK_SOURCE_ID, sourceClass: "ugc", label: "Sherlock (catálogo de sites)" },
  hibp: { id: "hibp", sourceClass: "aggregator", label: "Have I Been Pwned" },
  gravatar: { id: "gravatar", sourceClass: "ugc", label: "Gravatar" },
  rdap: { id: "rdap", sourceClass: "primary", label: "RDAP (bootstrap IANA)" },
  dnsMx: { id: "dns-mx", sourceClass: "primary", label: "DNS MX" },
  dnsNs: { id: "dns-ns", sourceClass: "primary", label: "DNS NS" },
  crtsh: { id: "crtsh", sourceClass: "primary", label: "Certificate Transparency (crt.sh)" },
  wayback: { id: "wayback", sourceClass: "primary", label: "Wayback Machine" },
  libphonenumber: { id: "libphonenumber", sourceClass: "primary", label: "libphonenumber (E.164)" },
  // Herda o default atual ("aggregator" — comportamento observado preservado;
  // reclassificar é mudança de REGRA de score, fora da refatoração doc 13).
  emailSyntax: { id: "email-syntax", sourceClass: "aggregator", label: "Sintaxe de e-mail (local check)" },
  correlation: { id: CORRELATION_SOURCE_ID, sourceClass: "inference", label: "Motor de correlação (inferência)" },
  none: { id: NO_SOURCE_ID, sourceClass: "inference", label: "Sem fonte real dedicada" },
} as const satisfies Record<string, SourceDef>;

/** Classe da fonte (comportamento idêntico ao mapa legado de confidence.ts). */
export function sourceClassOf(sourceId: string): SourceClass {
  for (const def of Object.values(SOURCES)) {
    if (def.id === sourceId) return def.sourceClass;
  }
  return "aggregator"; // default legado preservado
}
