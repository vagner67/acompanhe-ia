/**
 * Número CNJ `NNNNNNN-DD.AAAA.J.TR.OOOO` — Res. 65/2008 (ISO 7064 mod 97).
 * Algoritmo VERIFICADO contra processo real da fixture DataJud capturada em
 * 23/10/2026: 0006903-69.2014.8.11.0037 → DV=69 e (sem_dv+dd) % 97 == 1.
 */
export interface CnjParts {
  sequencial: string; // 7
  dd: string; // 2 (DV)
  ano: string; // 4
  justica: string; // 1 (J)
  tribunal: string; // 2 (TR)
  origem: string; // 4 (OOOO)
}

const CNJ_RE = /^(\d{7})-?(\d{2})\.(\d{4})\.(\d)\.(\d{2})\.(\d{4})$/;

export function parseCnj(numero: string): CnjParts | undefined {
  const m = CNJ_RE.exec(numero.trim());
  if (!m) return undefined;
  return { sequencial: m[1]!, dd: m[2]!, ano: m[3]!, justica: m[4]!, tribunal: m[5]!, origem: m[6]! };
}

export function formatCnj(p: CnjParts): string {
  return `${p.sequencial}-${p.dd}.${p.ano}.${p.justica}.${p.tribunal}.${p.origem}`;
}

/** DV oficial: 98 − ((sem_dv + "00") mod 97). Verificado: dá 69 no caso real. */
export function cnjDv(p: Omit<CnjParts, "dd">): string {
  const base = `${p.sequencial}${p.ano}${p.justica}${p.tribunal}${p.origem}00`;
  return String(98 - (Number(BigInt(base) % 97n))).padStart(2, "0");
}

/** Validação: DV confere E (sem_dv+dd) % 97 == 1 (identidade verificada no caso real). */
export function isValidCnj(numero: string): boolean {
  const p = parseCnj(numero);
  if (!p) return false;
  const { dd, ...semDv } = p;
  if (cnjDv(semDv) !== dd) return false;
  const full = `${p.sequencial}${p.ano}${p.justica}${p.tribunal}${p.origem}${p.dd}`;
  return Number(BigInt(full) % 97n) === 1;
}

/**
 * Alias DataJud a partir do campo TR. Só entradas documentadas; a única
 * verificada AO VIVO em 23/10/2026 é `tjmt` (TR=11 → 200 no DataJud).
 * Demais seguem a tabela de tribunais da Res. 65/2008 — usar
 * `aliasFromTribunal` só quando a entrada existir; senão null (nunca inventar).
 */
/**
 * Alias DataJud a partir do campo TR. Tabela CURTA — só pares com fonte real
 * (números de processo conhecidos; tabela da Res. 65/2008). A única verificada
 * AO VIVO em 23/10/2026 e `tjmt` (TR=11 -> HTTP 200 no DataJud). Qualquer outro
 * TR -> null (chamador informa o alias explicitamente). NAO completar por palpite.
 */
const ALIAS: Record<string, Record<string, string>> = {
  "8": {
    "11": "tjmt", // verificado vivo 23/10/2026 (fixture tjmt)
    "02": "tjal", // verificado vivo 24/10/2026: api_publica_tjal 200 + hits (CNJ real 0764101-97.2025.8.02.0001)
    "26": "tjsp", // padrao CNJ publico: 8.26 = SP; api_publica_tjsp 200 verificado vivo 24/10/2026
    "19": "tjrj", // 8.19 = RJ
    "13": "tjmg", // 8.13 = MG
    "05": "tjba", // 8.05 = BA
    "17": "tjpe", // 8.17 = PE
    "21": "tjrs", // 8.21 = RS
    "16": "tjpr", // 8.16 = PR
    "24": "tjsc", // 8.24 = SC
    "09": "tjgo", // 8.09 = GO
    "06": "tjce", // 8.06 = CE
    "07": "tjdft", // 8.07 = DF
  },
};

export function aliasFromTribunal(justica: string, tribunal: string): string | null {
  return ALIAS[justica]?.[tribunal] ?? null;
}
