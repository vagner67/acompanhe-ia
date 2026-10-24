/**
 * Contrato de mútuo (plano.md §5.4) — RF-E04 + RE4.
 * RE4: numeração + versão + SHA-256; cópia às duas partes; hash MUDA com 1 byte.
 * RE5: a fórmula de juros é IMPRESSA no contrato.
 * JUR-7: kit executivo + notificação extraudicial (doc 06 §6).
 * Parecer é ato privativo (Lei 8.906/1994, art. 1º) — o contrato NÃO é parecer.
 */
import { createHash } from "node:crypto";

import type { EmprestimoInput, EmprestimoResultado } from "./calculadora.js";

export interface ContratoParte {
  nome: string;
  documento: string; // CPF/mascarado
  papel: "mutuante" | "mutuario";
}

export interface ContratoInput {
  numero: string; // ex.: "2026/000123"
  versao: number;
  partes: [ContratoParte, ContratoParte];
  emprestimo: EmprestimoInput;
  resultado: EmprestimoResultado;
  dataAssinatura: string; // ISO
  vencimentos: string[]; // ISO das parcelas
  observacoes?: string;
}

export interface ContratoEmitido {
  numero: string;
  versao: number;
  texto: string;
  sha256: string;
  emitidoEm: string;
}

/** RE5 — fórmula declarada. RE4 — hash do conteúdo íntegro. */
export function emitirContrato(input: ContratoInput, emitidoEm = new Date().toISOString()): ContratoEmitido {
  const linhas = [
    `CONTRATO DE MÚTUO Nº ${input.numero} — VERSÃO ${input.versao}`,
    `Emitido em: ${emitidoEm}`,
    "",
    "PARTES",
    ...input.partes.map((p) => `- ${p.papel === "mutuante" ? "MUTUANTE" : "MUTUÁRIO"}: ${p.nome} (doc. ${p.documento})`),
    "",
    "DO OBJETO",
    `O mutuante empresta ao mutuário a quantia de R$ ${(input.resultado.principalCents / 100).toFixed(2)}.`,
    "",
    "DOS JUROS E CORREÇÃO (fórmula declarada — RE5)",
    `Tipo: ${input.emprestimo.jurosTipo} | Taxa: ${(input.emprestimo.jurosMesBps / 100).toFixed(2)}% a.m.`,
    `Fórmula aplicada: ${input.resultado.formula}`,
    `Juros: R$ ${(input.resultado.jurosCents / 100).toFixed(2)} | Correção: R$ ${(input.resultado.correcaoCents / 100).toFixed(2)}`,
    "",
    "DO PAGAMENTO",
    `Prazo: ${input.emprestimo.meses} mes(es) | Vencimentos: ${input.vencimentos.join(", ")}`,
    `Total devido: R$ ${(input.resultado.totalCents / 100).toFixed(2)}`,
    "",
    "DA LIQUIDAÇÃO (RE1 — Linha Vermelha)",
    "O pagamento NÃO transita pelo aplicativo: liquidação via @wallet (USDT/GRAM) ou Pix P2P entre as partes.",
    "",
    "DA SEGURANÇA",
    "Este documento tem SHA-256 registrado; qualquer alteração de 1 byte muda o hash.",
    input.observacoes ? `\nOBSERVAÇÕES\n${input.observacoes}` : "",
    "",
    "Assinaturas eletrônicas das partes — cópia entregue a ambas (RE4).",
  ].filter((l) => l !== undefined);

  const texto = linhas.join("\n");
  const sha256 = createHash("sha256").update(texto, "utf8").digest("hex");
  return { numero: input.numero, versao: input.versao, texto, sha256, emitidoEm };
}

/** JUR-7 — kit executivo + notificação extraudicial (estrutura; disparo = job). */
export function kitExecutivo(contrato: ContratoEmitido): { titulo: string; itens: string[]; sha256Contrato: string } {
  return {
    titulo: `Kit executivo — Contrato ${contrato.numero} v${contrato.versao}`,
    itens: [
      "Cópia do contrato assinado (com SHA-256)",
      "Extrato de pagamentos e saldo devedor",
      "Notificação extrajudicial de cobrança (quando aplicável)",
      "Termo de quitação (ao fim)",
    ],
    sha256Contrato: contrato.sha256,
  };
}
