/**
 * Detecção do tipo de consulta do campo único (nome · CPF · CNPJ · nº processo) —
 * plano-busca-unificada.md §3.1. Algoritmos de DV REAIS (CPF/CNPJ módulo 11;
 * CNJ ISO 7064 mod 97 via cnj.ts). Sem atalhos: documento com DV errado é
 * recusado (422 na rota) — nunca é enviado às fontes.
 */
import { cnjDv, formatCnj, parseCnj } from "./cnj.js";

export type TipoConsulta = "cnj" | "cpf" | "cnpj" | "nome";

export interface Deteccao {
  tipo: TipoConsulta;
  /** valor normalizado (só dígitos para documentos; nome com espaços colapsados) */
  valor: string;
  /** formato canônico quando houver (CNJ formatado) */
  formato?: string;
  advertencia?: string;
  /** quando o padrão parece um documento mas o DV não confere */
  erro?: string;
}

const soDigitos = (s: string) => s.replace(/\D+/g, "");

/** DVs oficiais CPF (módulo 11, pesos 10..2 e 11..2). */
export function cpfDvs(cpf11: string): [string, string] {
  const d = soDigitos(cpf11);
  const dig = (base: string, pesoInicial: number): string => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return String(resto === 10 ? 0 : resto);
  };
  return [dig(d.slice(0, 9), 10), dig(d.slice(0, 10), 11)];
}

/** DVs oficiais CNPJ (módulo 11, pesos 5..2/9..2 e 6..2/9..2). */
export function cnpjDvs(cnpj14: string): [string, string] {
  const d = soDigitos(cnpj14);
  const dig = (base: string): string => {
    let peso = base.length - 7;
    let soma = 0;
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    const resto = soma % 11;
    return String(resto < 2 ? 0 : 11 - resto);
  };
  return [dig(d.slice(0, 12)), dig(d.slice(0, 13))];
}

export function validarCpf(cpf: string): boolean {
  const d = soDigitos(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const [d1, d2] = cpfDvs(d);
  return d[9] === d1 && d[10] === d2;
}

export function validarCnpj(cnpj: string): boolean {
  const d = soDigitos(cnpj);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const [d1, d2] = cnpjDvs(d);
  return d[12] === d1 && d[13] === d2;
}

export function formatarCpf(cpf11: string): string {
  const d = soDigitos(cpf11);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export function formatarCnpj(cnpj14: string): string {
  const d = soDigitos(cnpj14);
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/**
 * Detecta o que o usuário digitou. Ordem importa: 20 dígitos → CNJ;
 * 11 dígitos → CPF; 14 dígitos → CNPJ; o resto é nome.
 * `erro` (documento com DV errado) tem precedência: a rota responde 422
 * em vez de procurar por um documento inválido.
 */
export function detectarConsulta(entrada: string): Deteccao {
  const bruto = (entrada ?? "").trim().replace(/\s+/g, " ");
  const digitos = soDigitos(bruto);

  // ── número de processo (20 dígitos, com ou sem formatação) ──
  if (digitos.length === 20 || parseCnj(bruto)) {
    const partes = parseCnj(bruto) ?? parseCnjEmDigitos(digitos);
    if (partes) {
      const dvEsperado = cnjDv({ sequencial: partes.sequencial, ano: partes.ano, justica: partes.justica, tribunal: partes.tribunal, origem: partes.origem });
      if (dvEsperado !== partes.dd) {
        return { tipo: "cnj", valor: digitos, erro: `número de processo com dígitos verificadores inválidos (esperado ${dvEsperado})` };
      }
      return { tipo: "cnj", valor: digitos, formato: formatCnj(partes) };
    }
  }

  // ── CPF (11 dígitos) ──
  if (digitos.length === 11) {
    if (!validarCpf(digitos)) {
      return { tipo: "cpf", valor: digitos, erro: "CPF com dígitos verificadores inválidos — confira o número digitado" };
    }
    return { tipo: "cpf", valor: digitos, formato: formatarCpf(digitos) };
  }

  // ── CNPJ (14 dígitos) ──
  if (digitos.length === 14) {
    if (!validarCnpj(digitos)) {
      return { tipo: "cnpj", valor: digitos, erro: "CNPJ com dígitos verificadores inválidos — confira o número digitado" };
    }
    return { tipo: "cnpj", valor: digitos, formato: formatarCnpj(digitos) };
  }

  // ── nome ──
  const nome = bruto;
  const letras = nome.replace(/[^\p{L}]/gu, "");
  if (letras.length < 3) {
    return { tipo: "nome", valor: nome, erro: "informe nome, CPF/CNPJ ou número do processo (nome com pelo menos 3 letras)" };
  }
  const palavras = nome.split(" ").filter((p) => p.length > 1).length;
  return {
    tipo: "nome",
    valor: nome,
    ...(palavras < 2 ? { advertencia: "informe nome e sobrenome para reduzir homônimos" } : {}),
  };
}

function parseCnjEmDigitos(d: string) {
  return parseCnj(`${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16, 20)}`);
}
