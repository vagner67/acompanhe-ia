/**
 * Módulo de telefone — fonte REAL: google-libphonenumber (portagem do
 * libphonenumber do Google). E.164, tipo (MOBILE/FIXED_LINE/...), região.
 * Nada além disso é afirmado sem fonte: enriquecimentos "de operadora/CPF"
 * de APIs desconhecidas NÃO entram.
 */
import { SOURCES } from "./sources.js";
import type { OsintFinding, OsintTarget } from "./types.js";

export interface PhoneOsintResult {
  findings: OsintFinding[];
  raw: Record<string, unknown>;
}

export interface PhoneParseInput {
  /** Parse + classificação (injetável para testes). */
  parse: (raw: string, region: string) => {
    valid: boolean;
    e164?: string | undefined;
    region?: string | null | undefined;
    type?: string | null | undefined;
    national?: string | undefined;
  };
  now?: () => string;
}

export async function checkPhone(
  value: string,
  opts: PhoneParseInput,
  region = "BR",
): Promise<PhoneOsintResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const findings: OsintFinding[] = [];

  let parsed: ReturnType<PhoneParseInput["parse"]>;
  try {
    parsed = opts.parse(value, region);
  } catch (err) {
    findings.push({
      id: crypto.randomUUID(),
      sourceId: SOURCES.libphonenumber.id,
      status: "unknown",
      retrievedAt: now(),
      raw: { value, error: String(err) },
    });
    return { findings, raw: { module: "phone", value } };
  }

  if (parsed.valid) {
    findings.push({
      id: crypto.randomUUID(),
      sourceId: SOURCES.libphonenumber.id,
      status: "found",
      ...(parsed.e164 ? { evidenceUrl: `tel:${parsed.e164}` } : {}),
      retrievedAt: now(),
      raw: {
        value,
        e164: parsed.e164 ?? null,
        region: parsed.region ?? null,
        type: parsed.type ?? null,
        national: parsed.national ?? null,
      },
    });
  } else {
    findings.push({
      id: crypto.randomUUID(),
      sourceId: SOURCES.libphonenumber.id,
      status: "not_found",
      retrievedAt: now(),
      raw: { value, note: "número não válido para a região informada (E.164)" },
    });
  }

  return {
    findings,
    raw: { module: "phone", value, region },
  };
}

export function checkPhoneTarget(target: OsintTarget, opts: PhoneParseInput, region?: string): Promise<PhoneOsintResult> {
  if (target.kind !== "phone") {
    return Promise.reject(new Error("alvo não é phone"));
  }
  return checkPhone(target.value, opts, region);
}
