# Acompanhe.IA — app (bot + Mini App Telegram)

Implementação conforme os artefatos `/home/user/acompanhe-ia-v2/` (docs 00–10) · auditoria forense 21/10/2026.

## Estrutura (monorepo — S0 do doc 10)
```
apps/api     Node 22 + Fastify + Zod — auth initData, JWT, webhook Pushin Pay
apps/bot     Python · aiogram 3 — FSM onboarding, throttle 1 msg/s, webhook secret_token
apps/web     React + Vite — Mini App (= PWA), initData → JWT
packages/shared   constantes congeladas (limites Telegram, SKUs, escala E1–E5, IC)
packages/db       prisma/schema.prisma (DDL doc 09 — S2+)
infra/            docker-compose (Postgres 16 + Redis 7), Dockerfiles, nginx
.github/workflows ci.yml: typecheck + testes + npm audit (falha em high) + testes do bot
```

## Rodar
```bash
npx pnpm@10 install                # monorepo pnpm (npm tem bug de edgesOut em workspaces)
npx pnpm@10 --filter @acompanhe/shared build
npx pnpm@10 test                   # suíte Node (shared + API) — 60 testes
python3 -m pytest apps/bot/tests -q   # suíte do bot (12)
cp .env.example .env               # preencher BOT_TOKEN etc.
npx pnpm@10 dev:api                # API em :3000
npx pnpm@10 dev:web                # Mini App em :5173 (proxy /api,/v1 → :3000)
docker compose up                  # Postgres + Redis + API + Web
```

## Investiga — OSINT avançado (doc 11 · 22/10/2026)
- Motor de username = **sherlock real** (`pip3 install sherlock-project` v0.16.2; 481 sites; fixture de teste = saída real capturada). Binário em `SHERLOCK_BIN`.
- Fontes reais: HIBP v3 (`HIBP_API_KEY` — sem chave = "unavailable", nunca inventa), Gravatar MD5, DNS MX, RDAP, crt.sh (1 req/5 s), Wayback, google-libphonenumber.
- API: `/v1/investiga/*` (casos, run, relatório, quota) + `/v1/admin/investiga/trial` (X-Admin-Token).
- Quotas: **150 checks/dia** (teto sistêmico) · 10 casos ativos · trial 7d 1×. Estourou = `429 queue-paused`.
- Veredicto de todo relatório: **"LEAD — verificar manualmente"** + sha256 de auditoria.

## Segurança implementada (docs 02/08 — testada em CI)
- **initData**: HMAC-SHA256 (`secret = HMAC("WebAppData", bot_token)`), `data_check_string` ordenada sem `hash`, comparação **constant-time** (bytes UTF-8), `auth_date` ≤ 300 s (financeiro) / 24 h (login) — replay rejeitado (testes `initdata.test.ts`).
- **JWT** 1 h com chave separada do bot token (rotacionar por incidente).
- **Webhook Pushin Pay**: **fail-closed** (sem `PUSHINPAY_WEBHOOK_SECRET` → 503); header assinado; `paid` só com **consulta** em `/transactions/{ID}` confirmando `paid` **e** `value == amount`; duplo webhook = 1 efeito (idempotente); valor divergente → investigação, nunca libera (`webhook.test.ts`).
- **Ids Pushin Pay**: normalizados (lower no registro, UPPER na consulta — PR #68).
- Nada de PII em log; Zod em toda fronteira; CORS restrito; headers defensivos.

## Status das sprints (doc 10)
| Sprint | Status |
|---|---|
| S0 monorepo + CI + compose | ✅ |
| S1 bot onboarding + auth + Mini App + webhook | ✅ |
| S2 trust-svc V0–V4 (Serasa, face match) | ⏳ próximo |
| S3 empréstimos (FSM 10 etapas, contrato PDF/A, juros) | ⏳ |
| S4 match + chat + negociação | ⏳ |
| S5 pagamentos completos (cashIn UI, Pix Automático, Stars) | ⏳ |
| S6 pilares (finanças, jurídico, concursos, licitações) | ⏳ |
| S7 escala/tags/IC + enforcement | ⏳ |
| S8 painel admin RBAC + rules engine | ⏳ |

## Regras de ouro (âncoras A1–A6, doc 00)
1. Dinheiro do mútuo **nunca** passa pelo app — liquidação @wallet/Pix entre as partes.
2. Biometria = dado sensível (LGPD art. 11): consentimento versionado + hash.
3. Sem verificação **V1** não se pede empréstimo (403).
4. Escala E1–E5: `nível = min(verificação, histórico)`.
5. Painel: acesso total e regras só do diretor (RBAC + WebAuthn).
6. Tudo regionalizado por UF + cidade (IBGE).
