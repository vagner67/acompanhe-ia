/**
 * AnotA — utilitários de UI compartilhados pelas abas.
 * Regra acordada para esta tela: simples, prática, sem sanfona e sem seta de
 * expandir. Tudo visível com no máximo um toque.
 */
export const fmt = (cents: number) =>
  `R$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const ymAtual = () => new Date().toISOString().slice(0, 7);
export const hoje = () => new Date().toISOString().slice(0, 10);

/** "1.234,56" | "1234.56" | "R$ 12,50" → centavos (inteiro). null se não der. */
export function textoParaCents(texto: string): number | null {
  const limpo = texto.replace(/[R$\s.]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(limpo)) return null;
  return Math.round(Number(limpo) * 100);
}

export const centsParaTexto = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

export const nomeMes = (ym: string) => {
  const [ano, mes] = ym.split("-").map(Number);
  const nomes = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${nomes[(mes ?? 1) - 1]}/${String(ano).slice(2)}`;
};

export const dataBR = (iso: string) => (iso.length >= 10 ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : iso);

export const rotuloTipoConta: Record<string, string> = {
  caixa: "💵 Caixa",
  banco: "🏦 Banco",
  cartao: "💳 Cartão",
  poupanca: "🐷 Poupança",
};

export const corEstado: Record<string, string> = { ok: "ok", atencao: "warn", estourou: "bad" };
