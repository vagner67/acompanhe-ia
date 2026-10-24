# Decisões — Acompanhe.IA

Registro de decisões difíceis de reverter (padrão do `docs/decisions.md` do tgstack).
Formato: **Dn — título (data)** · contexto · decisão · consequências.

## D1 — Arquitetura base extraída do tgstack (2026-10-24)

- **Contexto**: pedido "pesquisar app semelhante, baixar o repo, retirar as arquiteturas
  e colocar no Acompanha, sem alucinar/sintetizar". Pesquisa no GitHub (24/10/2026):
  candidatos `tgstack`, `fastapi-telegram-subscription-starter`, `TMA`, `web-telegram-shop`.
  Escolhido **tgstack** (github.com/scoobingoo/tgstack, MIT) por ser o mais semelhante:
  monorepo TS com bot + Mini App + painel admin + pagamentos + testes + deploy.
  Repo baixado em `/home/user/ref/tgstack` e lido (`docs/architecture.md` etc.).
- **Decisão**: adotar (1) regras de arquitetura **executáveis em teste**; (2) constants
  compartilhados (literais de XP só em `packages/shared/src/constants.ts`); (3) worker
  separado com política de envio 429/403/retry; (4) dev-auth p/ navegador sem Telegram;
  (5) `/health` profundo (prova o Postgres); (6) docs de arquitetura + decisão.
- **Consequências**: `vitest run` agora falha se um refactor violar as regras; o web e a
  API não podem mais divergir nos nomes de ação de XP; o deploy ganha um processo `worker`.

## D2 — Fila em Postgres (AlertEvent), NÃO Redis/BullMQ (2026-10-24)

- **Contexto**: o tgstack usa Redis + BullMQ para broadcasts. Nossa fila já existe como
  tabela `AlertEvent` (status `queued|delivered|...`, dedupe por `dedupeKey`).
- **Decisão**: manter Postgres como fila; o worker consome `status=queued`.
- **Consequências**: infra mais simples (sem Redis) para o deploy; se o volume de envios
  passar de ~milhares/minuto, revisar (aí BullMQ passa a valer).

## D3 — Literais de ação de XP só em `packages/shared/src/constants.ts` (2026-10-24)

- **Contexto**: web mandava `acao: "nota_criada"` como literal e a API validava contra
  `XP_ACTIONS` — risco silencioso de divergência.
- **Decisão**: `XP` (nomes) + `XP_ACTIONS` (valores) em shared; web e API usam `XP.*`;
  teste de arquitetura proíbe o literal em qualquer outro arquivo.
- **Consequências**: renomear uma ação agora quebra o build em vez de falhar em runtime.

## D4 — Dev-auth só fora de produção (2026-10-24)

- **Contexto**: o web só abria dentro do Telegram (sem initData → erro). tgstack resolve
  com mock assinado para dev (`apps/miniapp/src/mocks/`, `dev/mock-bot.ts`).
- **Decisão**: `POST /api/auth/telegram/dev` emite JWT **somente** quando
  `NODE_ENV !== "production"` (404 em produção, coberto por teste); o web só a chama
  quando `import.meta.env.DEV` (false em build de produção).
- **Consequências**: dev em navegador com 1 clique; produção não tem superfície extra.

## D5 — Não adotados do tgstack (2026-10-24)

- **NestJS/módulos/DI**: nosso Fastify + funções puras já cumpre o mesmo papel; migrar
  framework quebraria tudo sem ganho real agora.
- **i18n Fluent (en/vi)**: produto é pt-BR primeiro; fica no backlog.
- **Admin por magic link**: nosso painel usa login RBAC por operador (requisito do usuário).
- **Turborepo/changesets**: pnpm workspaces puro já basta no nosso tamanho.

## D6 — Paywall da Consulta Jurídica (24/10, fecho do E2E)
O plano de teste (F9/P05, aprovado) determina que todo produto pago bloqueia usuário sem plano.
Aplicado gate v2/08 §9.5 em `POST /api/juridico/consultas` e `GET /api/processos/:cnj/explicar`
(SKUs aceitos: `juridica`, `juridica:trial` — não existe pack avulso jurídico em `AVULSOS`).
Janela RF-B07/B08 (1 consulta/6h) continua valendo PARA QUEM tem plano. Testes: `juridico.test.ts`
(paywall + OAB com grant) e E2E TC-P05b.

## Painel de operações — caminho de crescimento (E3, 24/10)
- Coleta: `tools/ops-report.sh` grava em `/api/internal/ops/ingest` (só localhost; o
  web-serve bloqueia `/api/internal` do proxy — o túnel nunca alcança).
- Em Vercel+Neon: `ops-report.sh` só troca a URL alvo (OPS_INGEST_URL); o worker
  (`tools/worker-start.sh`) vira scheduled function; os probes (`tools/probe.sh`)
  viram cron do deploy. Os contratos `/v1/admin/ops/*` não mudam.
- Retenção: probes 7d, eventos 30d (expurgo no ingest a cada 100 e no worker a cada 100 ciclos).
