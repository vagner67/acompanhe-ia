/**
 * Contrato ÚNICO de coletor do app (plano.md §3.1).
 *
 * Existe porque o motor de auto-aperfeiçoamento nasceu preso ao Jurídico: os tipos
 * tinham campos de e-SAJ/DJEN e qualquer fonte nova exigia copiar o motor. Aqui o
 * coletor declara o que sabe fazer; o núcleo mede, decide, aplica e reverte.
 *
 * Regra de honestidade: só entra em `espaco` o parâmetro que REALMENTE muda a
 * execução. Parâmetro decorativo é pior que ausente — a IA "otimizaria" o nada.
 */

export type Modulo =
  | "juridico"
  | "licitacoes"
  | "concursos"
  | "investiga"
  | "anota"
  | "pagamentos"
  | "operacao";

export type Familia = "api-json" | "html" | "registro" | "busca";

export type ParamValor = number | string | boolean;
export type Params = Record<string, ParamValor>;

export interface ParamSpec {
  tipo: "numero" | "booleano" | "enum";
  min?: number;
  max?: number;
  passo?: number;
  opcoes?: ParamValor[];
  /** pedido da IA só é aceito se justificar; fora da faixa é descartado */
  descricao?: string;
}

/** Como a coleta terminou — nada opaco: http, tempo, itens e o motivo da falha. */
export interface ResultadoColeta {
  ok: boolean;
  http: number | null;
  ms: number;
  itens: number;
  /** mensagem curta do que deu errado (vai para diagnóstico e log) */
  erro?: string;
  /** portal pediu captcha: não burlamos, só declaramos */
  captcha?: boolean;
  /** 403/429/geo: bloqueio explícito da fonte */
  bloqueio?: boolean;
  /** campos que o parser esperava e não achou (sinal de quebra de contrato) */
  camposFaltando?: string[];
  /** falta credencial (chave paga/registrada): não é falha transitória, é pendência */
  semCredencial?: boolean;
  /** o portal respondeu OK pedindo termo mais específico (não é quebra de contrato) */
  precisaRefinar?: boolean;
  /** trecho curto já sanitizado do payload — evidência para o diagnóstico */
  amostra?: string;
}

export interface CtxColeta {
  /** injetável em teste: nenhum teste toca a rede */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** consulta do canário em execução */
  consulta?: string;
  agora?: Date;
  /** credenciais do ambiente (chave de API, etc.) */
  env?: Record<string, string | undefined>;
}

export interface Canario {
  id: string;
  /** consulta que sabidamente devolve resultado quando a fonte está saudável */
  consulta: string;
  /** abaixo disso consideramos que a fonte parou de entregar (deriva) */
  esperaMinItens: number;
}

export interface Coletor {
  id: string;
  modulo: Modulo;
  host: string;
  familia: Familia;
  descricao: string;
  /** parâmetros vigentes de fábrica (versão 1) */
  padrao: Params;
  /** espaço de busca: o que o motor PODE mudar, com limites duros */
  espaco: Record<string, ParamSpec>;
  canarios: Canario[];
  /** teto de requisições: limite duro, não sugestão (evita otimizar até bloquear) */
  orcamento: { rpm: number; rpd: number };
  /** exige credencial paga/registrada; sem ela o coletor fica "sem_credencial" */
  exigirCredencial?: string;
  executar(params: Params, ctx?: CtxColeta): Promise<ResultadoColeta>;
}

// ── helpers de leitura de parâmetro (sempre dentro do tipo declarado) ──────
export const num = (p: Params, k: string, d: number): number => {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d;
};
export const bool = (p: Params, k: string, d: boolean): boolean => {
  const v = p[k];
  return typeof v === "boolean" ? v : d;
};
export const texto = (p: Params, k: string, d: string): string => {
  const v = p[k];
  return typeof v === "string" ? v : d;
};

/** Resumo de uma bateria de canários numa única métrica do coletor. */
export function agregar(execucoes: Array<{ r: ResultadoColeta; esperaMinItens: number }>): ResultadoColeta {
  if (execucoes.length === 0) {
    return { ok: false, http: null, ms: 0, itens: 0, erro: "nenhum canário executado" };
  }
  const itens = execucoes.reduce((a, e) => a + e.r.itens, 0);
  const leramAlgo = execucoes.some((e) => e.r.itens >= e.esperaMinItens);
  const primeiraFalha = execucoes.find((e) => !e.r.ok);
  const bloqueio = execucoes.some((e) => e.r.bloqueio);
  const captcha = execucoes.some((e) => e.r.captcha);
  const campos = execucoes.flatMap((e) => e.r.camposFaltando ?? []);
  return {
    ok: Boolean(leramAlgo) || execucoes.every((e) => e.r.ok),
    http: execucoes.find((e) => e.r.http !== null)?.r.http ?? null,
    ms: Math.max(...execucoes.map((e) => e.r.ms)),
    itens,
    ...(bloqueio ? { bloqueio: true } : {}),
    ...(captcha ? { captcha: true } : {}),
    ...(primeiraFalha?.r.erro ? { erro: primeiraFalha.r.erro } : {}),
    ...(campos.length ? { camposFaltando: [...new Set(campos)] } : {}),
    ...(execucoes.find((e) => e.r.amostra)?.r.amostra ? { amostra: execucoes.find((e) => e.r.amostra)!.r.amostra } : {}),
  };
}
