/**
 * Calculadora de empréstimo (plano.md §5.3) — RF-E03 + RE5.
 * RE5: a FÓRMULA é declarada no contrato — nada de "juros do sistema".
 * Juros simples:  J = C * i * t          (t em meses)
 * Juros compostos: M = C * (1 + i)^t     (t em meses)
 * Correção:        M_corr = M * (1 + idx)^t  (IPCA/IGPM/fixa) — idx a.m.
 * Mora:            M_mora = M_corr * (m/30) * d  (d = dias de atraso)
 * Valores em centavos (inteiros) para não errar ponto flutuante.
 */
export type JurosTipo = "simples" | "compostos";
export type CorrecaoTipo = "nenhuma" | "ipca" | "igpm" | "fixa";

export interface EmprestimoInput {
  principalCents: number;
  jurosMesBps: number; // 400 = 4,00% a.m. (teto de publicação: ≤ 4% a.m.)
  meses: number;
  jurosTipo: JurosTipo;
  correcaoTipo?: CorrecaoTipo;
  correcaoMesBps?: number; // quando fixa (ou índice conhecido)
  moraDiaBps?: number; // mora diária (b.p. por dia)
  diasAtraso?: number;
}

export interface EmprestimoResultado {
  principalCents: number;
  jurosCents: number;
  correcaoCents: number;
  moraCents: number;
  totalCents: number;
  formula: string; // RE5 — impressa no contrato
}

function round(x: number): number {
  return Math.floor(x + 0.5);
}

export function calcularEmprestimo(input: EmprestimoInput): EmprestimoResultado {
  const C = input.principalCents;
  const i = input.jurosMesBps / 10_000;
  const t = input.meses;
  if (C <= 0 || t <= 0) throw new Error("principal e prazo devem ser positivos");

  let jurosCents: number;
  let formulaJuros: string;
  if (input.jurosTipo === "simples") {
    jurosCents = round(C * i * t);
    formulaJuros = `J = C × i × t = ${C} × ${i} × ${t}`;
  } else {
    jurosCents = round(C * (Math.pow(1 + i, t) - 1));
    formulaJuros = `M = C × (1 + i)^t = ${C} × (1 + ${i})^${t}`;
  }

  const idx = (input.correcaoMesBps ?? 0) / 10_000;
  const correcaoCents =
    input.correcaoTipo && input.correcaoTipo !== "nenhuma" ? round((C + jurosCents) * (Math.pow(1 + idx, t) - 1)) : 0;

  const moraCents = input.diasAtraso ? round((C + jurosCents + correcaoCents) * ((input.moraDiaBps ?? 0) / 10_000) * input.diasAtraso) : 0;

  const totalCents = C + jurosCents + correcaoCents + moraCents;
  const formula = [
    formulaJuros,
    input.correcaoTipo && input.correcaoTipo !== "nenhuma" ? `Corr = (C+J) × ((1 + ${idx})^${t} − 1)` : "Corr = 0",
    input.diasAtraso ? `Mora = (C+J+Corr) × ${(input.moraDiaBps ?? 0) / 10_000}/dia × ${input.diasAtraso} d` : "Mora = 0",
    "Total = C + J + Corr + Mora",
  ].join(" | ");

  return { principalCents: C, jurosCents, correcaoCents, moraCents, totalCents, formula };
}

/** Agenda de parcelas (price): parcela = PMT, saldo devedor decresce. */
export function agendaParcelas(input: EmprestimoInput, parcelas: number): Array<{ n: number; valorCents: number; saldoCents: number }> {
  const i = input.jurosMesBps / 10_000;
  const C = input.principalCents;
  const pmt = i === 0 ? round(C / parcelas) : round((C * i) / (1 - Math.pow(1 + i, -parcelas)));
  const out: Array<{ n: number; valorCents: number; saldoCents: number }> = [];
  let saldo = C;
  for (let n = 1; n <= parcelas; n++) {
    const jurosMes = round(saldo * i);
    const amort = pmt - jurosMes;
    saldo = n === parcelas ? 0 : Math.max(0, saldo - amort);
    out.push({ n, valorCents: pmt, saldoCents: saldo });
  }
  return out;
}

/** RE2 — aviso de usura acima do parâmetro do diretor (Lei 4.595/64 art. 4º §3º). */
export const MAX_PUBLISH_RATE_BPS = 400; // ≤ 4% a.m. para PUBLICAR (doc 03 §3.3)

export function avisoUsura(jurosMesBps: number, tetoBps: number): string | null {
  if (jurosMesBps > tetoBps) {
    return `ATENÇÃO: taxa de ${(jurosMesBps / 100).toFixed(2)}% a.m. acima do teto de ${(tetoBps / 100).toFixed(2)}% a.m. — possível caracterização de usura (Lei 4.595/1964, art. 4º, §3º; Súmula 596 STF).`;
  }
  return null;
}
