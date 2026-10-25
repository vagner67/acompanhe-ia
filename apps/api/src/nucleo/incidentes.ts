/**
 * Disjuntor por coletor (plano.md §3.6).
 *
 * Sem isto, uma fonte captcha/geo-bloqueada recebe requisição a cada ciclo para
 * sempre: gasta orçamento, queima IP e não corrige nada. O disjuntor decide
 * quando parar de tentar, por quanto tempo e quando desistir de vez.
 */

export interface EstadoBreaker {
  ativo: boolean;
  ciclosZerados: number;
  proximaExecucaoEm: string | null;
}

export interface DecisaoIncidente {
  /** quando o coletor pode ser tentado de novo (null = agora) */
  pausarAte: string | null;
  /** desligar o coletor até intervenção humana (captcha permanente, contrato quebrado) */
  desativar: boolean;
  motivo: string;
}

export type Assinatura = "captcha" | "bloqueio" | "timeout" | "contrato" | "credencial" | "refinar" | "erro" | "ok";

export function assinatura(resultado: {
  ok: boolean;
  http: number | null;
  itens: number;
  captcha?: boolean;
  bloqueio?: boolean;
  semCredencial?: boolean;
  precisaRefinar?: boolean;
  camposFaltando?: string[];
}): Assinatura {
  if (resultado.captcha) return "captcha";
  if (resultado.semCredencial) return "credencial";
  if (resultado.precisaRefinar) return "refinar";
  if (resultado.bloqueio || resultado.http === 429 || resultado.http === 403) return "bloqueio";
  if (resultado.http === null) return "timeout";
  if (!resultado.ok && resultado.itens === 0 && (resultado.http ?? 0) >= 200 && (resultado.http ?? 0) < 400) {
    return "contrato";
  }
  return resultado.ok ? "ok" : "erro";
}

const MIN = 60_000;

/** Backoff por tipo de falha — números explícitos, nada aleatório. */
const BACKOFF_MS: Record<Assinatura, number> = {
  captcha: 6 * 60 * MIN,
  bloqueio: 3 * 60 * MIN,
  timeout: 15 * MIN,
  contrato: 60 * MIN,
  credencial: 12 * 60 * MIN,
  refinar: 10 * MIN,
  erro: 30 * MIN,
  ok: 0,
};

/** Falhas seguidas a partir das quais o coletor é desligado (não adianta insistir). */
const DESISTIR_APOS: Record<Assinatura, number> = {
  captcha: 3,
  bloqueio: 6,
  timeout: 10,
  contrato: 5,
  credencial: 1, // falta de chave não se resolve tentando de novo
  refinar: 4,
  erro: 8,
  ok: Infinity,
};

export function avaliarIncidente(estado: EstadoBreaker, resultado: Parameters<typeof assinatura>[0], agora: Date): DecisaoIncidente {
  const sig = assinatura(resultado);
  if (sig === "ok") return { pausarAte: null, desativar: false, motivo: "saudável" };
  const falhas = estado.ciclosZerados;
  const desativar = falhas >= DESISTIR_APOS[sig];
  const base = BACKOFF_MS[sig];
  const fator = Math.min(2 ** Math.max(0, falhas - 1), 8);
  const pausarAte = new Date(agora.getTime() + base * fator).toISOString();
  const motivo =
    sig === "captcha"
      ? `captcha exige intervenção humana (${falhas} falha${falhas === 1 ? "" : "s"} seguida${falhas === 1 ? "" : "s"})`
      : sig === "bloqueio"
        ? `host bloqueando (HTTP ${resultado.http ?? "?"}) — recuo para não queimar IP`
        : sig === "contrato"
          ? `respondeu HTTP ${resultado.http} sem os campos esperados (${(resultado.camposFaltando ?? []).join(", ") || "payload mudou"})`
          : sig === "refinar"
        ? "portal pediu termo mais específico (respondeu sem lista utilizável)"
        : sig === "credencial"
        ? "coletor exige credencial que não está no ambiente — pendência de configuração, não de rede"
        : sig === "timeout"
            ? `sem resposta do host — recuo exponencial`
            : `erro técnico — recuo exponencial`;
  return { pausarAte: desativar ? null : pausarAte, desativar, motivo };
}

export function podeColetar(estado: EstadoBreaker, agora: Date): { pode: boolean; motivo: string } {
  if (!estado.ativo) return { pode: false, motivo: "coletor desativado (precisa de intervenção ou credencial)" };
  if (estado.proximaExecucaoEm) {
    const quando = new Date(estado.proximaExecucaoEm);
    if (quando.getTime() > agora.getTime()) {
      const min = Math.ceil((quando.getTime() - agora.getTime()) / MIN);
      return { pode: false, motivo: `em recuo por ${min} min (última falha registrada)` };
    }
  }
  return { pode: true, motivo: "liberado" };
}
