/**
 * Pontuação de uma coleta (plano.md §3.5).
 *
 * É a única função que diz "esta configuração é melhor que aquela". Por isso ela
 * só usa o que foi medido: itens entregues, se respondeu, latência e captcha.
 * Sem piso artificial — fonte que entrega 1 item não pode empatar com a que
 * entrega 20.
 */
import type { Canario, ResultadoColeta } from "./tipos.js";

/** Diferença mínima para considerar ganho real (histerese ε do plano). */
export const EPS = 3;

export function pontuarColeta(r: ResultadoColeta, canario?: Canario): number {
  const minimo = Math.max(1, canario?.esperaMinItens ?? 1);
  // teto de referência: 5 itens ou o mínimo do canário, o que for maior.
  const teto = Math.max(minimo, 5);
  const aproveitamento = Math.min(r.itens / teto, 1);
  const confiabilidade = r.ok ? 1 : 0;
  const latencia = 0.05 * (Math.max(0, r.ms) / 100);
  const captcha = r.captcha === true ? 80 : 0;
  const score = 100 * aproveitamento + 40 * confiabilidade - latencia - captcha;
  // captcha = a fonte não entrega NADA utilizável, por melhor que pareça o resto.
  // Trava dura em 20: nenhuma fonte com captcha pode ser eleita "a melhor".
  return Math.round((r.captcha === true ? Math.min(score, 20) : score) * 100) / 100;
}

/** Ganho só conta se passar de ε — evita promoção por ruído de rede. */
export function ganhoReal(atual: number, novo: number): boolean {
  return novo - atual > EPS;
}
