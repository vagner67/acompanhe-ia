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
 * Alias DataJud por (J,TR). Tabela COMPLETA dos 91 índices públicos do CNJ —
 * cada entrada VERIFICADA empiricamente em 24/10/2026 sondando
 * `https://api-publica.datajud.cnj.jus.br/api_publica_{alias}/_search`
 * (91/91 responderam; um processo real de cada índice confirmou o J.TR do doc).
 * Extras medidos:
 *  - TREs = `tre-{uf}` (não `api_publica_{uf}`); TRE-DF = `tre-df`.
 *  - 5.01 = TST **e** TRT1 (convivem) → candidatos, não chave única.
 *  - 6.16 = TSE · 7.06 = STM · J=9 = Justiça Militar Estadual (9.13/9.21/9.26).
 *  - STJ guarda números de ORIGEM (doc do índice `stj` trazia nº 8.13) → a
 *    busca por nº consulta também a corte superior do ramo.
 *  - STF NÃO tem índice no DataJud (os 91 = 4 superiores + 6 TRFs + 27 TJs +
 *    24 TRTs + 27 TREs + 3 militares, sem STF).
 */
const ALIAS: Record<string, Record<string, string>> = {
  "2": { "00": "stj" },
  "4": { "01": "trf1", "02": "trf2", "03": "trf3", "04": "trf4", "05": "trf5", "06": "trf6" },
  "5": {
    "01": "trt1", "02": "trt2", "03": "trt3", "04": "trt4", "05": "trt5", "06": "trt6",
    "07": "trt7", "08": "trt8", "09": "trt9", "10": "trt10", "11": "trt11", "12": "trt12",
    "13": "trt13", "14": "trt14", "15": "trt15", "16": "trt16", "17": "trt17", "18": "trt18",
    "19": "trt19", "20": "trt20", "21": "trt21", "22": "trt22", "23": "trt23", "24": "trt24",
  },
  "6": {
    "00": "tse", // TSE com numeração própria 6.00 (medido: docs do índice `tse`)
    "01": "tre-ac", "02": "tre-al", "03": "tre-ap", "04": "tre-am", "05": "tre-ba",
    "06": "tre-ce", "07": "tre-df", "08": "tre-es", "09": "tre-go", "10": "tre-ma",
    "11": "tre-mt", "12": "tre-ms", "13": "tre-mg", "14": "tre-pa", "15": "tre-pb",
    "16": "tre-pr", "17": "tre-pe", "18": "tre-pi", "19": "tre-rj", "20": "tre-rn",
    "21": "tre-rs", "22": "tre-ro", "23": "tre-rr", "24": "tre-sc", "25": "tre-se",
    "26": "tre-sp", "27": "tre-to",
  },
  "7": { "06": "stm" },
  "8": {
    "01": "tjac", "02": "tjal", "03": "tjap", "04": "tjam", "05": "tjba", "06": "tjce",
    "07": "tjdft", "08": "tjes", "09": "tjgo", "10": "tjma", "11": "tjmt", "12": "tjms",
    "13": "tjmg", "14": "tjpa", "15": "tjpb", "16": "tjpr", "17": "tjpe", "18": "tjpi",
    "19": "tjrj", "20": "tjrn", "21": "tjrs", "22": "tjro", "23": "tjrr", "24": "tjsc",
    "25": "tjse", "26": "tjsp", "27": "tjto",
  },
  "9": { "13": "tjmmg", "21": "tjmrs", "26": "tjmsp" },
};

export function aliasFromTribunal(justica: string, tribunal: string): string | null {
  return ALIAS[justica]?.[tribunal] ?? null;
}

/**
 * Índices DataJud a consultar para um nº CNJ — a corte do (J,TR) **mais** a
 * corte superior do ramo (superiores guardam números de ORIGEM; 5.01 = TRT1 e
 * TST convivem). STF (J=1) não tem índice → lista vazia (chamador orienta).
 * Verificado empiricamente 24/10/2026; nunca inventa alias fora da tabela.
 */
export function aliasCandidatesFromCnj(justica: string, tribunal: string): string[] {
  const out: string[] = [];
  const add = (a: string | null) => { if (a && !out.includes(a)) out.push(a); };
  add(aliasFromTribunal(justica, tribunal));
  if (justica === "5") add("tst");
  else if (justica === "6") add("tse");
  else if (justica === "7" || justica === "9") add("stm");
  else if (justica === "4" || justica === "8") add("stj");
  else if (justica === "2") add("stj");
  return out.slice(0, 3);
}

/** Os 91 aliases do DataJud (chaves da tabela acima, exceto stf). Medido 24/10/2026. */
export const TRIBUNAIS_DATAJUD: string[] = [
  "tst", "tse", "stj", "stm",
  ...["1", "2", "3", "4", "5", "6"].map((n) => `trf${n}`),
  ...Object.keys(ALIAS["8"]!).map((tr) => ALIAS["8"]![tr]!),
  ...Object.keys(ALIAS["5"]!).map((tr) => ALIAS["5"]![tr]!),
  ...Object.keys(ALIAS["6"]!).map((tr) => ALIAS["6"]![tr]!).filter((a) => a !== "tse"), // 27 TREs
  "tjmmg", "tjmrs", "tjmsp",
];
