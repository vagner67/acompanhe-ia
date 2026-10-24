/**
 * R7 (doc 13) — ÚNICA fonte de fixture do sherlock nos testes.
 *
 * Proveniência (obrigatória pela regra "fixture = evidência"):
 * - Captura REAL de 22/10/2026, sherlock v0.16.2 (481 sites), Python 3.13.
 *   Comando positivo: `sherlock octocat --site GitHub --site Medium --print-all
 *   --csv --folderoutput DIR`; comando negativo: `sherlock zzznobodyzzz99x
 *   --site GitHub --print-all --csv --folderoutput DIR`.
 * - Nenhum valor foi inventado. Recortes estão declarados como recorte.
 * - Histórico: existiam DUAS cópias divergentes desta captura
 *   (sherlock.test.ts com `response_time_s` completo 0.5454852370000935;
 *   investiga.test.ts com a linha editada para 0.545). Pela regra do doc 13
 *   §3 R7, vale o valor integral capturado; a cópia editada foi eliminada.
 */

/** STDOUT integral da captura (2 sites × Claimed). */
export const REAL_STDOUT_FOUND_2 = [
  "",
  "[+] GitHub: https://www.github.com/octocat",
  "[+] Medium: https://medium.com/@octocat",
  "",
  "[*] Search completed with 2 results",
  "",
].join("\n");

/** CSV integral da captura (2 linhas Claimed; colunas exatas do upstream). */
export const REAL_CSV_FOUND_2 = [
  "username,name,url_main,url_user,exists,http_status,response_time_s",
  "octocat,GitHub,https://www.github.com/,https://www.github.com/octocat,Claimed,200,0.5454852370000935",
  "octocat,Medium,https://medium.com/,https://medium.com/@octocat,Claimed,200,0.2625870560000294",
  "",
].join("\n");

/**
 * RECORTE declarado da captura acima, para simular `--site GitHub` (1 site):
 * a linha/Medium foi omitida do stdout e do CSV e o contador foi ajustado
 * 2→1. Valores das linhas mantidos INTACTOS (0.5454852370000935).
 */
export const REAL_STDOUT_FOUND_1 = [
  "",
  "[+] GitHub: https://www.github.com/octocat",
  "",
  "[*] Search completed with 1 results",
  "",
].join("\n");

export const REAL_CSV_FOUND_1 = [
  "username,name,url_main,url_user,exists,http_status,response_time_s",
  "octocat,GitHub,https://www.github.com/,https://www.github.com/octocat,Claimed,200,0.5454852370000935",
  "",
].join("\n");

/** Caso negativo integral (username inexistente, site ausente). */
export const REAL_STDOUT_NONE = [
  "[*] Checking username zzznobodyzzz99x on:",
  "",
  "[-] GitHub: Not Found!",
  "",
  "[*] Search completed with 0 results",
  "",
].join("\n");

export const REAL_CSV_NONE = "username,name,url_main,url_user,exists,http_status,response_time_s\n";
