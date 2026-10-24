# Arquitetura — Acompanhe.IA

O Acompanhe é um **monolito modular com worker orientado a eventos**, num monorepo pnpm.
Adotada da arquitetura do **tgstack** (github.com/scoobingoo/tgstack, MIT, lido em 24/10/2026 —
`docs/architecture.md` de lá) e adaptada ao nosso stack (Fastify + Prisma + fila em Postgres).
As regras abaixo são **checadas por teste**: `apps/api/test/architecture.test.ts`
(mesmo mecanismo do `apps/server/test/architecture.spec.ts` do tgstack).

```text
Telegram ──webhook/polling──► apps/bot (Python/aiogram)     [canal do usuário]
Navegador/Mini App ──/api,/v1──► apps/api (Fastify)         [produto]
Painel admin (fora do app) ──/v1/admin──► apps/api          [RBAC]
                 apps/api ──enfileira──► AlertEvent (Postgres, status=queued)
                 apps/api/src/worker.ts ──entrega rate-limitada──► Telegram
                 apps/api · worker ──► Postgres (Prisma)
```

## Pacotes e grafo de dependências

| Pacote | Pode importar | Nunca importa |
|---|---|---|
| `packages/shared` | `zod` + relativos | APIs de Node, Fastify, Prisma (roda no navegador) |
| `packages/db` | Prisma, `pg` | Fastify, apps |
| `apps/api` | todos os pacotes | — |
| `apps/web` | `@acompanhe/shared` | `apps/api`, `@acompanhe/db` (front não toca servidor/banco) |
| `apps/bot` | — (Python) | — |

**Valores que os apps concordam** (XP, prefixos de rota, esquema de auth, status de alerta)
vivem em `packages/shared/src/constants.ts` — nunca como string literal em um app.
Literais de ação de XP existem **só** nesse arquivo (teste falha se aparecer em outro).

## Dois processos, um codebase

| | `src/server.ts` | `src/worker.ts` |
|---|---|---|
| Faz | REST + auth + webhooks + **enfileira** alertas | **entrega** AlertEvent `queued` via Telegram |
| Porta HTTP | sim (`PORT`) | nunca (`listen` proibido por teste) |
| Escala | atrás do proxy | mais workers; o ritmo é global (fila) |

Os dois importam a mesma infra (config, stores Prisma). A API **nunca** registra processors.

## Camadas (dependências apontam num sentido só)

```
routes/ (HTTP) → service/ (domínio) → store* (persistência) → Prisma/Postgres
jobs/ (worker) → store* (persistência)
```

- `**/service.ts` e `jobs/` são **framework-free** (não importam Fastify — teste falha).
- `routes/` é o único lugar que fala HTTP.

## Namespaces HTTP e autenticação

| Prefixo | Guard | Credencial |
|---|---|---|
| `/api/auth/telegram` | — | initData HMAC do Telegram |
| `/api/auth/telegram/dev` | **só fora de produção** (404 em produção) | dev browser (mock) |
| `/api/*`, `/v1/*` | JWT Bearer por rota | sessão da mini-app |
| `/v1/admin/*` | RBAC (7 papéis, diretor cria operadores) | login e-mail+senha |
| `/health` | — | prova Postgres (`db: ok/down/n/a`; 503 se down) |

Toda rota vive sob `/api`, `/v1` ou `/health`; rotas do painel **só** sob `/v1/admin`
(painel fora do mini-app) — ambos checados por teste.

## Worker de entrega (política tgstack, adaptada)

`jobs/runner.ts` — semântica do `broadcasts.processor.ts` do tgstack:
- ritmo global `ratePerSecond` (padrão 25/s), **sem rajada**;
- **429** → pausa a entrega inteira por `retry_after` (o ciclo termina);
- **403** → usuário bloqueou: marca `blocked`, **sem retry**;
- outros **4xx** → falha definitiva (`failed`);
- rede/**5xx** → até 3 tentativas (`attempts` no payload do AlertEvent).
- fila = tabela `AlertEvent` (status `queued|delivered|read|silenced|blocked|failed`);
  sem Redis por decisão (ver docs/decisoes.md).

## Removibilidade e testes

- Domínio puro (services/jobs) é coberto por testes sem rede nem HTTP.
- `pnpm worker -- --once` roda um ciclo (cron/systemd timer/E2E).
- Regras de arquitetura quebram `vitest run` quando violadas.
