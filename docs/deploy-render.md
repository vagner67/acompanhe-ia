# Deploy Acompanhe.IA → Render (24/10/2026)

Status: **PRODUÇÃO NO AR** — https://acompanhe.onrender.com (web service `srv-dbei8pgae00c73d868r0`, plano **free**, região oregon).
Despertador de 13 min: **pendente de credencial externa** (ver §5).

## 1. Topologia (1 serviço, 3 processos, 1 container)

```
Dockerfile (node:22-bookworm-slim + python3)
└── deploy/start.sh
    ├── prisma db push          → schema no Render Postgres
    ├── node dist/server.js     → API Fastify (PORT injetada pelo Render, 0.0.0.0)
    ├── node dist/worker.js     → entregas de alertas + purge + sync
    └── python -m bot.main      → bot @acompanha_bot (aiogram, polling)
```

Se qualquer processo cair, o `wait -n` derruba o container e o Render reinicia (supervisão do plano).
O web app (mini app + `/admin.html`) é servido pelo MESMO Fastify via `@fastify/static` (patch em `server.ts`, guardado por `existsSync(webDist)`).

**Por que um serviço só**: 750 Free instance hours/mês por workspace. Um web service 24/7 = 744h (cabe por 6h de margem). Dois serviços free 24/7 = 1488h → suspensão ~dia 15. Bot+worker juntos na API é a única configuração free que fecha.

## 2. Recursos criados (API do Render — IDs reais)

| Recurso | ID | Plano | Notas |
|---|---|---|---|
| Postgres `acompanhe-db` | `dpg-dbei5dfb9u1s739q1nf0-a` | **free** | **`expiresAt: 2026-11-23T21:27Z`** — expira em 30 dias; +14 de graça e é APAGADO. Migração obrigatória até lá (export: `POST /v1/postgres/{id}/export`) |
| Web service `acompanhe` | `srv-dbei8pgae00c73d868r0` | **free** | Docker, health check `/health`, autoDeploy=commit, URL https://acompanhe.onrender.com |
| Repo Git | `vagner67/acompanhe-ia` | público | decisão do usuário (24/10); varredura byte a byte provou zero credenciais no repo (175 arquivos) |

Env vars do serviço (via API, valores nunca em repo/cmdline): `NODE_ENV`, `DATABASE_URL` (interna dpg-...), `BOT_TOKEN`, `MINI_APP_URL`, `PUBLIC_BASE_URL`, `JWT_SECRET`, `ADMIN_TOKEN`, `PUSHINPAY_WEBHOOK_SECRET`, `PUSHINPAY_TOKEN`, `SERVICE_TOKEN_FILE=/etc/secrets/servicetokens.json`.
`secretFiles`: `servicetokens.json` = `{"SERVICE_TOKEN": "..."}` (montado em `/etc/secrets/` pelo Render; rotacionável pelo painel — o arquivo é efêmero por deploy).

## 3. Bugs REAIS encontrados no deploy (todos corrigidos, cada um com prova)

1. **`pnpm-workspace.yaml` fora da camada de deps do Dockerfile** → `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "prisma" not found` (build log real via `GET /v1/logs?type=build`). Correção: `COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./`.
2. **`apps/api/tsconfig.tsbuildinfo` COMMITADO** (fora do .gitignore) → `tsc -b` no build limpo confiava no incremental e **pulava a emissão** de `worker.js` (só reemitiu `server.js` porque ele tinha mudado) → `Cannot find module '/app/apps/api/dist/worker.js'` → `wait -n` derrubava o container em loop (runtime log real). Correção em 3 camadas: `git rm --cached`, `*.tsbuildinfo` no .gitignore, `**/*.tsbuildinfo` no .dockerignore + `find /app -name "tsconfig.tsbuildinfo" -delete` antes do build.
3. **Bot subia errado**: `python bot/main.py` → `ModuleNotFoundError: No module named 'bot_core'` (o entry é `python -m bot.main` com cwd `apps/bot`). Correção no `deploy/start.sh`.
4. **Bot local × bot cloud** = `TelegramConflictError` (dois pollers brigando pelo `getUpdates`, exatamente o K04). Correção: `tools/keep-alive.sh` ganhou marker `tools/bot.off` (bot de produção = o do Render); bot local morto + keep-alive recarregado.

## 4. Smoke tests (após o deploy final — stdout real)

| Teste | Resultado |
|---|---|
| `GET /health` | `{"status":"ok","db":"ok","service":"acompanhe-api"}` |
| `GET /` (mini app) | 200 |
| `GET /admin.html` (painel FORA do app) | 200 |
| `POST /v1/admin/auth/login` (diretor) | 200 + JWT |
| `GET /v1/admin/kpis` (L04, KPIs reais) | 200 — planos com preços |
| worker | `[worker] ciclo: sent=0 blocked=0 failed=0 retried=0` nos logs |
| bot | `Run polling for bot @acompanha_bot id=8934593622` sem conflito após matar o local |

## 5. Técnica do despertador (13 min) — POR QUE AINDA NÃO ESTÁ ATIVA

**Objetivo**: plano free dorme após 15 min sem tráfego (~1 min para acordar). Um ping a cada 13 min mantém o serviço acordado para sempre (744h/mês cabem nas 750h).

Tentativas REAIS e seus desfechos:
- **Cron nativo do Render** (`*/13 * * * *`, plano `0.5c-512mb`, ~US$ 1/mês): o usuário aprovou, mas a criação respondeu **HTTP 402 "Payment information is required"** — workspace sem cartão (https://dashboard.render.com/billing).
- **`pg_cron` + `pg_net` no Postgres free** (o banco acordaria o app via SQL): o Render não consta em NENHUMA lista de suporte a essas extensões (RDS/Supabase/Neon/DigitalOcean têm; Render não) e o psql do sandbox nem conecta (5432 bloqueado). Técnica morta — documentada para não ser retestada.
- **GitHub Actions agendado**: o PAT (`repo, write:packages`) não pode criar arquivos `.github/workflows/*` (exige escopo `workflow`) — empurrar workflow foi REJEITADO pelo GitHub.
- **Escolha do usuário (24/10)**: **despertador externo grátis** (UptimeRobot ou cron-job.org). Pendente: a API key/credencial da conta do usuário.

Configuração pronta (assim que a key chegar):
- **UptimeRobot** (grátis, ping a cada 5 min — margem maior que 13): `POST https://api.uptimerobot.com/v2/newMonitor` com `api_key`, `type=1`, `url=https://acompanhe.onrender.com/health`, `interval=300`.
- **cron-job.org** (grátis, agenda `*/13 * * * *`): job GET `https://acompanhe.onrender.com/health` via API deles.
- Alternativa futura (quando houver cartão): cron do Render acima — tudo integrado no mesmo painel.

## 6. Operação contínua

- **Deploy**: `git push` na `main` (autoDeploy=commit) ou `POST /v1/services/{id}/deploys` (API).
- **Logs**: `GET /v1/logs?ownerId=tea-dbehsr8m7kps73dure7g&resource=srv-...&type=app|build|request`.
- **Painel admin**: https://acompanhe.onrender.com/admin.html (diretor: e-mail do `.secrets.json` + senha = `ADMIN_TOKEN`; trocar via `/v1/admin/auth/password`).
- **Rotação do SERVICE_TOKEN**: funciona no container (reescreve `/etc/secrets/servicetokens.json` efêmero) — após rotacionar, persistir no `.secrets.json` local.
- **Postgres free expira 2026-11-23**: ANTES disso, export (`POST /v1/postgres/{id}/export`) + upgrade para pago (US$ 6/mês) ou migração para Neon.
- **keep-alive local**: dev/testes; bot local permanece OFF (`tools/bot.off`) enquanto o bot de produção estiver no Render.
