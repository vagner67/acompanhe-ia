/**
 * Investiga — cota operacional e limites (extraído de v2/08).
 *
 * TETO SISTÊMICO (contrato absoluto): 150 checks por dia, de qualquer natureza
 * (e-mail, telefone, nome, username, domínio). Após o teto, a fila DORME e o
 * botão "Rodar agora" retorna `429 queue-paused` com a próxima janela.
 *
 * Fontes reais (verificado por ferramenta em 22/10/2026):
 * - sherlock (sherlock-project/sherlock) v0.16.2 — CLI instalado (`pip3 install
 *   sherlock-project`), catálogo `data.json` com 481 sites + chave `$schema`
 *   (482 chaves), flag `--site` casa NOMES EXATOS do catálogo (case-sensitive;
 *   "Reddit" ok, "reddit" falha com `Error: Desired sites not found`), saída
 *   `--print-all`: `[+] Nome: url` (encontrado) / `[-] Nome: Not Found!`
 *   (ausente); `--csv --folderoutput DIR` gera `DIR/<username>.csv` com
 *   colunas `username,name,url_main,url_user,exists,http_status,response_time_s`
 *   e só grava linhas `exists=Claimed` (CSV vazio = 0 achados). `--json` NÃO
 *   é saída: é carregamento de catálogo alternativo.
 * - haveibeenpwned.com v3 `GET /breachedaccount/{email}?truncateResponse=true`
 *   + header `hibp-api-key` + User-Agent; 404 = sem vazamento; 401/403 ou chave
 *   ausente = fonte "unavailable" (NUNCA inventar resultado).
 * - gravatar.com `GET /avatar/{md5(email)}?d=404` — 200 = avatar existe.
 * - DNS MX do domínio do e-mail (node:dns resolveMx).
 * - rdap.org `GET /domain/{dominio}` (bootstrap IANA oficial).
 * - crt.sh `GET /?q=%25.{dominio}&output=json` (CT logs; cortesia 1 req/5 s).
 * - archive.org `GET /wayback/available?url=`.
 * - google-libphonenumber (E.164/tipo/carrier) — pacote npm real.
 *
 * Veredicto é SEMPRE "LEAD — verificar manualmente" (a ferramenta gera leads;
 * o ser humano verifica). Nada de conclusão definitiva, nada de dado sintetizado.
 */

/** Estado de uma janela diária de um assinante. */
export interface InvestigaQuota {
  /** Subject (telegramId) do assinante. */
  subjectId: string;
  /** Janela YYYY-MM-DD. */
  day: string;
  /** Checks já executados na janela. */
  used: number;
}

/** Limite duro por plano (extras via Pack ou avulso comprado). */
export const INVESTIGA_LIMITS = {
  /** Teto do dia (checks). Contrato absoluto de 150/dia. */
  maxChecksPerDay: 150,
  /** Casos abertos simultâneos. */
  maxActiveCases: 10,
  /** Checks por alvo dentro de um caso. */
  maxChecksPerCase: 6,
  /** Idade máxima de um achado antes de recomendar re-verificação. */
  findingMaxAgeDays: 30,
  /** Tentativas do item de fila antes de `queue-paused`. */
  maxQueueAttempts: 3,
  /** Trial 7 dias, 1x por usuário. */
  trialDays: 7,
  /** Regra de ouro: resultado nunca é definitivo. */
  verdict: "LEAD — verificar manualmente",
} as const;

/** Quotas de consumo do plano Investiga (consumo verificado nos docs). */
export const INVESTIGA_QUOTA = {
  /** 150 checks/dia de qualquer natureza (teto sistêmico). */
  dailyChecks: 150,
  /** ~150 checks/dia → mantém teto cheio do plano pago. */
  monthlyChecks: 4500,
} as const;

/** Nome canônico da fonte do motor de username (repositório real). */
export const SHERLOCK_SOURCE_ID = "sherlock";
