# Plano — Painel Avançado de Operações (alterações · processos · vida · saúde)

> Status: **PLANO** (nada executado ainda). Nada será marcado feito sem teste verde + evidência crua.
> Restrições permanentes: painel FORA do mini app (`docs/arquitetura.md:62-63`); RBAC por operador (operador só pelo diretor); preços+trial no painel; credenciais só em `/home/user/.secrets.json` (chmod 600); nada genérico/simulado.

---

## 0. Escopo (as 4 palavras do pedido, cada uma com superfície)

| Domínio | Significado concreto neste app | Superfície no painel |
|---|---|---|
| **ALTERAÇÕES** | Toda mutação controlada: ações de operadores (AuditLog com cadeia hash), regras/preços (RulesConfig versionado + rollback), feature flags (FeatureFlag), deploys/rebuilds (keep-alive auto-heal), URL do mini app (túnel novo) | Aba **Alterações** — timeline unificada com selo `cadeiaOk` |
| **PROCESSOS** | Os 5 processos reais da operação: API (:3000), web-serve (:5173), bot Telegram, túnel cloudflared, **worker de alertas** (`apps/api/src/worker.ts`) | Aba **Serviços** — pid, uptime, restarts, quem religou |
| **VIDA** | Nascimento/morte/ressurreição: religadas pelo keep-alive, auto-heal (deps/postgres/bundle), gêmeo recriado, túnel novo, boots | Aba **Vida** (timeline de eventos de processo, durável em banco — hoje só `/tmp/keep-alive.log`, volátil) |
| **SAÚDE** | Instantâneo + série: `/health` (db), HTTP 200 web/túnel, getMe do bot, latência dos probes, backlogs (fila de alertas, deadletter), gates de teste (vitest/deep-run/run-e2e) | Aba **Saúde** + **Visão Geral** (health score e 4 sinais) |

Metodologia (fonte pesquisada, não achismo): **Four Golden Signals** (latência, tráfego, erros, saturação — Google SRE Book [4]), **RED** para serviços de request e **USE** para recursos [2][6][7]; percentis p95 (média esconde cauda [1]); dashboard em camadas (visão geral → serviço → debug) com anotações de deploy nas séries [10]; health score 0–100 combinando taxa de erro + latência [15]; alertar por sintomas (RED), não por causas [2][11].

---

## 1. Diagnóstico REAL do que existe (base para refatorar, não reescrever)

| Ativo | Onde | Estado | Teste que prova |
|---|---|---|---|
| AuditLog com **cadeia de hash** (prevHash→hash) + verificação `cadeiaOk` na leitura | `schema.prisma:101-115`; `admin/service.ts:43-61` (`auditHash`); `store-prisma.ts:836-873`; rota `/v1/admin/audit` (`routes/admin.ts:256-271`) | **Funcional e persistente** | `admin.test.ts:89` "ações geram cadeia verificável e adulteração quebra" |
| RulesConfig versionado + rollback (preços/trial) | `schema.prisma:117-128`; `store-prisma.ts:876-911`; rotas `/v1/admin/rules*` | **Funcional** | `admin.test.ts:107` "preço do plano definido no painel + rollback restaura" |
| RBAC 7 papéis + matriz `PERMISSIONS` + `can()` | `admin/service.ts:28-40`; gate em `routes/admin.ts:83` | **Funcional** | `admin.test.ts:52`; E2E `L06` → `403 {"error":"papel 'operador_suporte' sem permissão em 'operadores'","rule":"RBAC"}` |
| Visor de BD (whitelist de 14 tabelas, somente-leitura) | `routes/admin.ts` `/v1/admin/db/:tabela` | Funcional (com bugs — §2.2/2.3) | deep-run série D |
| `/health` profundo (prova Postgres; 503 quando cai) | `server.ts:192-203` | **Funcional** | E2E + keep-alive usa como sinal |
| keep-alive: auto-heal (deps/postgres/bundle), health HTTP com grace de 2 ciclos, gêmeo via pidfiles `/tmp/keep-alive.d/`, log `[keep-alive HH:MM:SS] msg` | `tools/keep-alive.sh` | **Provado ao vivo** (kill API → religa ≤15s; kill daemon → gêmeo recria) | `docs/relatorio-e2e.md` (seção keep-alive) |
| Pipeline de alertas: `jobs/dispatcher.ts` (jobPollProcessos, jobVencimentoParcelas, jobMatchExpirando) → `AlertEvent(status=queued)` → `worker.ts` → Telegram (política 429/403 em `jobs/runner.ts`) | `apps/api/src/jobs/`, `apps/api/src/worker.ts` | **Código com testes verdes, mas worker MORTO em produção** (§2.6) | `jobs.test.ts`, `jobs-runner.test.ts` |
| UI do painel (entry separado `admin.html`, login e-mail+senha, 6 abas) | `admin-main.tsx`; `AdminScreen` em `screens.tsx:902`; cliente `adminApi` em `api2.ts:126-146` | **Funcional, crua** (aba kpis = `<pre>` JSON) | build `dist/admin.html`; constraint checada por teste (`arquitetura.md:62-63`) |
| FeatureFlag / SyncRun / JobsDeadletter | `schema.prisma:130-140, 602-624` | **SÓ schema — órfãos** (§2.5) | grep case-insensitive repo inteiro = 3 hits, todos no próprio schema.prisma |

## 2. Lacunas REAIS encontradas (com evidência crua — nada inventado)

1. **`/v1/admin/kpis` é stub.** `routes/admin.ts:134-143` devolve `{planos, trialDefaultDias, operadores, rule:"KPIs agregados; séries por consulta em /v1/admin/db"}`. Prova: caso `L04` ficou **KONHECIDO** com `200 {"planos":[…]}` (`docs/deep-resultados.md:128`).
2. **Aba `db` consulta tabela fora da whitelist.** `screens.tsx` (AdminScreen) chama `aa.db("game_profiles", 10)` fixo; whitelist do servidor (`admin.ts`, handler `/v1/admin/db/:tabela`) = `user, payment, subscription, nota, gasto, loanrequest, loanmatch, matchpayment, legalcase, legaladvice, contest, tender, alertevent, userverification` → `game_profiles` **não está** → 404 "tabela fora da whitelist". A aba abre em erro por padrão.
3. **Cliente e servidor discordam no limite.** `api2.ts:145` envia `?limite=${limite}`; o handler **ignora** o query e usa `take: 50` fixo.
4. **Tipo do cliente kpis é mentira.** `api2.ts:133` declara `get<Record<string, number>>` mas a resposta real tem `planos: array` — raiz da confusão do L04.
5. **`SyncRun`, `FeatureFlag`, `JobsDeadletter` são órfãos.** `grep -rin "syncrun|featureflag|deadletter|sync_run|feature_flag|dead_letter"` no repo inteiro (exceto node_modules) → **apenas `packages/db/prisma/schema.prisma`** (3 linhas de model). Nenhum escritor, nenhum leitor. Processos de ingestão (datajud/djen/pncp/dou/querido/bancas — `SyncRun.source`) não deixam rastro; flags de alteração controlada não existem na prática.
6. **Worker de entrega de alertas está MORTO e sem supervisor.** `pgrep -af worker` → vazio (só kworkers do kernel). `tools/keep-alive.sh` só supervisiona api/web/bot/túnel (`start_api/start_web/start_bot/start_tunnel`). Pipeline inteiro (dispatcher→AlertEvent→worker→Telegram) tem testes verdes mas **nenhuma entrega acontece em produção**.
7. **"Vida" do app só em `/tmp/keep-alive.log` (volátil).** Evidência de volatilidade: na virada de um turno o ambiente recriou `/tmp` e **todos os logs zeraram** (inspeção deste plano: `ls /tmp/*.log` vazio, processos mortos). Histórico de religadas/auto-heal/gêmeo/túnel perdido — nada durável.
8. **Saúde sem série temporal.** `/health` (`server.ts:192-203`) responde só o instantâneo (`db: ok|down` → `status: ok|degraded`). web/túnel/bot não têm endpoint de saúde próprio; o keep-alive checa mas **não registra histórico**.
9. **Zero métricas HTTP.** `server.ts` não tem middleware de contagem: sem tráfego, sem taxa de erro, sem latência — os 4 sinais de ouro não têm fonte.
10. **Timeline de alterações fragmentada.** AuditLog, RulesConfig e FeatureFlag não se cruzam; deploys/rebuilds (auto-heal do keep-alive) e mudança de URL do túnel não passam por nenhuma dessas tabelas.
11. **Gates de qualidade invisíveis.** vitest (230 casos), deep-run (143 casos → `docs/deep-resultados.md`), run-e2e (58 → `docs/relatorio-e2e.md`) produzem evidência em markdown e ninguém vê isso no painel.
12. **FeatureFlag sem UI nem API** (decorre de 5) — a "alteração controlada" por flag não existe operacionalmente.
13. **Bot sem observabilidade.** Estado (getMe, último update, último `/start` recebido, falhas 429/403 do runner) não aparece em lugar nenhum.

## 3. Arquitetura da refatoração (contratos exatos)

```
fontes (vita/processo/saúde)          coleta                API admin (RBAC)              UI (FORA do app)
─────────────────────────────   ─────────────────────   ──────────────────────────   ─────────────────────────
keep-alive.sh (log/religadas) ──► tools/ops-report.sh ─┐
worker.ts (entregas 429/403) ──► OpsEvent direto no DB ┤
middleware meter (server.ts) ──► memória → /ops/kpis    ├─► /v1/admin/ops/*  ────────► AdminScreen (abas novas,
probes (cron do keep-alive) ───► ServiceProbe ──────────┤     (recurso "ops")           auto-refresh 15s)
AuditLog/RulesConfig/FeatureFlag (já existem) ─────────┘
```

### 3.1 Tabelas novas (migration F1)

```prisma
model OpsEvent {
  id      BigInt   @id @default(autoincrement())
  ts      DateTime @default(now())
  source  String   @db.VarChar(16)  // keep-alive | worker | deploy | test | manual | api
  kind    String   @db.VarChar(32)  // process_start | process_down | heal_deps | heal_postgres | heal_bundle |
                                    // twin_recreated | tunnel_new | health_fail | health_ok | alert_delivered |
                                    // alert_failed | test_run | flag_change | url_change
  service String   @db.VarChar(16)  // api | web | bot | tunnel | worker | app
  ok      Boolean  @default(true)
  detail  Json?
  @@index([ts]) @@index([service, ts])
}

model ServiceProbe {
  id         BigInt   @id @default(autoincrement())
  ts         DateTime @default(now())
  service    String   @db.VarChar(16)
  ok         Boolean
  latencyMs  Int?
  detail     Json?
  @@index([service, ts])
}
```

Retenção: probes 7 dias, eventos 30 dias (limpeza no ingest — mesma linha do `take` limitado do visor de DB).

### 3.2 Coleta (F1)

- `tools/ops-report.sh <source> <kind> <service> <ok|fail> [json]` → `curl -sS -X POST http://127.0.0.1:3000/v1/ops/ingest -H "x-service-token: $TOKEN"`; token lido de `/home/user/.secrets.json` (nova chave `SERVICE_TOKEN`, gerada aleatória, chmod 600 — **nunca em cmdline nem repo**).
- `keep-alive.sh`: função `log()` passa a gravar no arquivo **e** chamar `ops-report.sh` (falha do report nunca derruba o keep-alive: `|| true`).
- `worker.ts`: ao concluir `deliverPending`, grava `OpsEvent(kind=alert_delivered|alert_failed, service=worker, detail={429|403|retryable})` direto no `Db` (já importado).
- Probes: novo `tools/probe.sh` chamado pelo keep-alive a cada ciclo (15s): `curl` API `/health`, web `/`, túnel (a cada 4 ciclos, para não depender de rede externa todo ciclo), bot `getMe` (a cada 4 ciclos) → grava `ServiceProbe` via ingest.
- **Worker vira 5º serviço do keep-alive** (`start_worker` + health: processo vivo; `--once` em ciclo a cada 30s ou loop com `WORKER_INTERVAL_MS`).

### 3.3 Endpoints novos (F2/F3) — todos sob `/v1/admin/ops/*`, gate `can(role, "ops")`

| Rota | Retorna (DTO congelado em `packages/shared`) | Resolve |
|---|---|---|
| `GET /ops/overview` | `{healthScore, sinais:{latenciaP95Ms, reqPorMin, taxaErro5xx, backlog}, servicos:[{service, ok, desde, restarts24h}], ultimasAlteracoes:[…]}` | Visão Geral |
| `GET /ops/services` | processos: `{service, pid, ok, uptimeSec, restarts24h, ultimoEvento}` (derivado de OpsEvent + pidfiles) | PROCESSOS + VIDA |
| `GET /ops/timeline?kind=&limit=` | fonte unificada `{entries:[{ts, fonte: audit|rules|flags|ops, acao, ator, antes, depois, hash?}], cadeiaOk}` | ALTERAÇÕES (fim a fim) |
| `GET /ops/probes?service=&hours=` | série `{service, pontos:[{ts, ok, latencyMs}]}` | SAÚDE (série) |
| `GET /ops/kpis` | KPIs **reais** (§3.4) | fecha L04 |
| `GET /ops/queues` | `{alertas:{queued, sent, failed, blocked}, deadletter:[…], syncRuns:[…]}` (lê AlertEvent/JobsDeadletter/SyncRun — os dois últimos com lista vazia até F1 religar escritores) | PROCESSOS de dados |
| `GET /ops/logs?service=&lines=` | tail dos logs `/tmp/{api,web,bot,cf,keep-alive,worker}.log` (**whitelist fixa de arquivos** — nada de path traversal) | debug |
| `GET /ops/tests` | últimos runs parseados de `docs/deep-resultados.md` + `docs/relatorio-e2e.md` (regex `PASS=|FAIL=|RUN-`) | SAÚDE (gates) |
| `GET/POST /ops/flags` | FeatureFlag CRUD (toda mutação vira `auditAppend` + `OpsEvent(kind=flag_change)`) | ALTERAÇÕES controladas |

### 3.4 KPIs reais (fecha L04 — queries exatas, tabelas do schema)

`GET /v1/admin/kpis` passa a retornar (e o stub sai):
`{usuarios:{total, novos7d}, assinaturas:{ativas, trial}, pagamentos:{confirmados30d, cents}, alertas:{queued, sent24h, failed24h, blocked}, fila:{deadletter}, sistema:{reqPorMin, taxaErro5xx, latenciaP95Ms, restarts24h}, planos:[…], trialDefaultDias}` — agregações por `count`/`sum` em `User`, `Subscription`, `Payment`, `AlertEvent`, `JobsDeadletter` (fontes reais do `schema.prisma`). Corrigir `api2.ts:133` para o tipo novo. **Caso L04 do deep-run é re-rodado e deve virar PASS com o novo shape documentado na evidência.**

### 3.5 RBAC (F2)

`PERMISSIONS` (`admin/service.ts:28`) ganha recurso `"ops"`: `diretor:["*"]` (já cobre), `admin_ops` += `ops`, `auditor` += `ops`. `operador_suporte`/`operador_mod`/`analista_financeiro`/`suporte_oab` **sem** `ops`. Toda rota nova passa pelo mesmo gate de `routes/admin.ts:83` (audit automático de leitura sensível continua valendo).

### 3.6 UI (F4) — refatorar `AdminScreen`, manter FORA do mini-app

Abas (ordem do fluxo de investigação — camadas [10]): **Visão Geral** (health score 0–100 + 4 sinais em cards bento) → **Serviços** (5 processos, pid/uptime/restarts) → **Alterações** (timeline unificada + selo `cadeiaOk` verde/vermelho) → **Saúde** (séries de probe por serviço, sparkline SVG inline sem biblioteca) → **Filas** (alertas/deadletter/sync) → **Testes** (últimos runs + contagens) → **Regras** → **Operadores** → **Verificações** → **DB** (default corrigido para `user`). Auto-refresh 15s na Visão Geral (respeita `prefers-reduced-motion`), chips/bento/hairline do tema 2026 já aplicado em `styles.css`. Deep link `?aba=` na URL. Login/RBAC existentes intactos.

Fórmula do health score (exata, sem magia): `score = 35·api + 20·web + 15·bot + 15·tunnel + 15·worker`, cada componente 1 (ok no probe recente) / 0.5 (degraded: 1 falha em 5) / 0 (down ou 2+ falhas seguidas), arredondado 0–100.

## 4. Fases de execução (cada fase termina COM PROVA; nada avança com teste vermelho)

### F1 — Instrumentação e coleta
Tarefas: migration `OpsEvent`+`ServiceProbe`; `POST /v1/ops/ingest` (auth `x-service-token`, 401 sem token); `tools/ops-report.sh`; hook em `keep-alive.sh` (`log()` duplo); `start_worker` no keep-alive; `tools/probe.sh`; `SERVICE_TOKEN` em `.secrets.json`.
Prova: SQL das tabelas; `curl` ingest 401/201; `kill` da API → religada → `SELECT` mostra `process_start`; `pgrep` mostra worker vivo.
Casos deep-run **O01–O05** + pilares **O30** (expurgo), **O31** (ingest só localhost — prova negativa via túnel), **O34** (detail higiênico), **O37** (correlação heal→start) — cada um com stdout em `docs/deep-resultados.md`.

### F2 — API ops + RBAC
Tarefas: rotas `/v1/admin/ops/{overview,services,timeline,probes,queues,logs}`; recurso `ops` na matriz; DTOs em `packages/shared`; `apps/api/test/ops.test.ts`.
Casos vitest: matriz `ops` (3 papéis positivos, 4 negativos — um por um); timeline funde audit+rules+ops; logs rejeitam path fora da whitelist; overview calcula score por fórmula documentada.
Casos deep-run **O06–O15** (inclui 403 de `operador_suporte` em `/ops/overview` — prova de RBAC de ponta a ponta) + pilares **O29** (approvedBy obrigatório), **O32** (brute-force 429), **O33** (redação de segredos no tail), **O35** (`x-request-id`), **O36** (headers do web-serve).

### F3 — KPIs reais + fixes do painel atual
Tarefas: `/v1/admin/kpis` real (§3.4); tipo `api2.ts:133`; aba db default `user`; aceitar `limite` no handler (sair do `take:50` fixo); religar escritores de `SyncRun` (dispatcher grava source/status/itens por job) e `JobsDeadletter` (runner grava falha definitiva).
Prova: **re-rodar L04 do deep-run → PASS** com o shape novo exibido; casos **O16–O20** + pilares **O38** (rotação de SERVICE_TOKEN), **O39** (caps/agregação), **O40** (insert em lote), **O41** (caminho Vercel+Neon documentado); `jobs.test.ts` estendido.

### F4 — UI do painel
Tarefas: refatorar `AdminScreen` (abas §3.6), `adminApi` novos métodos, sparklines SVG inline, auto-refresh, `?aba=`.
Prova: `tsc` web=0; `vite build`; smoke real: `curl` do `dist/admin.html` contém ids das abas; login + cada aba carrega via endpoints (evidência crua dos fetchs); casos deep-run **O21–O28** (E2E dos endpoints que alimentam cada aba, na ordem das abas).

### F5 — Gates completos (regressão fim a fim)
`pnpm -r test` (230+N) · `node tools/e2e/deep-run.mjs` (143+N) · `node tools/e2e/run-e2e.mjs` (58) · `tsc` api/test/web = 0. Qualquer FAIL vira correção + re-rodada (mesma disciplina das 6 rodadas do plano profundo).

### F6 — Documentação e aprovação
Preencher neste doc: **Execução** (rodadas com números), **Correções** (bugs reais encontrados durante a refatoração), **Aprovação** (comandos de reprodução: `bash tools/keep-alive.sh status` → `node tools/e2e/deep-run.mjs`). Apresentar ao usuário.

## 5. Riscos e rollback

| Risco | Mitigação |
|---|---|
| Volume de probes/eventos | retenção 7d/30d no ingest; índices por `ts`; probe do túnel/bot a cada 4 ciclos |
| `SERVICE_TOKEN` vazado | só em `.secrets.json` chmod 600; nunca em cmdline/repo (regra vigente) |
| keep-alive quebrar com hook novo | `ops-report.sh … \|\| true`; keep-alive continua sozinho se a API cair; teste O03 prova religada **com** hook |
| Worker religado mas com erro de env | política 429/403 já testada (`jobs-runner.test.ts`); eventos `alert_failed` tornam a falha visível no painel |
| Rollback | flag `ops_panel=false` esconde as abas novas; tabelas novas não tocam fluxo do mini-app; endpoints novos não substituem nenhum existente; nada do mini-app é modificado nesta refatoração |

## 6. Critérios de aprovação (checklist final — nenhum pode ser pulado)

- [x] 143+N casos do deep-run: 0 FAIL; casos O01–O41 com stdout real → **rodada 4: 177 PASS / 0 FAIL / 3 EXT / 4 KONHECIDO (184)** em `docs/deep-resultados.md`
- [x] vitest 230+N verde; `tsc` ×3 = 0 → **vitest 246+1 (247)**; tsc api=0·test=0·web=0
- [x] L04 **re-rodado → PASS** (KPIs reais) → evidência: `200 {"planos":[…], "usuarios":…}` + O16
- [x] Worker vivo sob keep-alive (prova: O02 pid real; O20 deadletter REAL `http_400` via worker --once)
- [x] Prova de "fim a fim": matar API e religar aparece na timeline → **O03 PASS** (`process_start_events=4` no banco) + O37 (`causa=keep-alive`)
- [x] Painel continua FORA do mini app (teste de arquitetura verde — `architecture.test.ts` passa com rotas sob `/api`)
- [x] **Cinco pilares**: S1 provado negativo via túnel (O31: `tunel_/api/internal=404 tunel_/v1=404 local=201`); G1 sem ator → 400 (vitest) + O29 (`updatedBy` no banco); R1 `x-request-id` presente (O35); E1 caps 400 (O15); S3 redação visível (O33: tail=***)

---

## 9. Execução (24/10 — 4 rodadas do deep-run, evidência crua)

| Rodada | Resultado | O que correu |
|---|---|---|
| 1 | 169 PASS / 5 FAIL | bugs reais encontrados (§10): cadeia audit sem `actorRole`; jsonb quebra `auditHash`; O14/O20 eram bugs do próprio caso; colector perdia eventos em boot |
| 2 | 169 PASS / 5 FAIL | actorRole corrigido; permaneceu `JSON.stringify(after)` × jsonb + janela de retry curta + A01/A05 por API em boot |
| 3 | 176 PASS / 1 FAIL | único fail K04 = 409 do Telegram (colisão de getUpdates com o bot vivo — transitório) |
| **4** | **177 PASS / 0 FAIL / 3 EXT / 4 KONHECIDO (184)** | **APROVADO** — O01–O41 todos PASS; L04 re-rodado PASS |

Gates complementares: **vitest 246+1 (247) verde** (29 casos novos em `apps/api/test/ops.test.ts`); `tsc` api/test/web = 0; `run-e2e` 53 pass / 2 EXT (PNCP+DOU: `fetch failed` — rede externa) / 1 FAIL conhecido (**TC-B02: falta o `/start` do usuário no bot**) / 2 skip.

## 10. Correções (bugs REAIS encontrados durante a refatoração)

1. **AuditLog não persistia `actorRole`** (coluna inexistente + `actorRole: null` hardcoded no `auditList` de `store-prisma.ts:858`) — a cadeia nunca fechava contra Postgres. Corrigido: coluna + persistência + leitura.
2. **`auditHash` usava `JSON.stringify(after)`** — o `jsonb` reordena chaves no round-trip e o digest divergia a partir da primeira entrada com objeto. Corrigido com `canonJson` (chaves ordenadas) cobrindo `actorId|actorRole|action|target|ip|ts|before|after`. Cadeia reiniciada 2× (19 + 20 linhas de teste não-verificáveis descartadas — ambas documentadas).
3. **`ops-report.sh`**: `${5:-{}}` no bash aninhava chaves errado (JSON inválido → coleta muda em silêncio) + janela de retry curta demais para o boot da API. Corrigido: default explícito + retry 10×3s em background pelo `log()` do keep-alive.
4. **Grace do health-check não era imune a gêmeos** (2 supervisores fora de fase derrubavam a API no meio do boot). Corrigido: grace por **idade do marker (≥25s de parede)**.
5. **`/v1/admin/kpis` era stub** → KPIs reais por agregação (fecha **L04 → PASS**).
6. **Aba `db` consultava `game_profiles`** (fora da whitelist → 404) → default `user`; e o `take:50` fixo passou a respeitar `?limite=`.
7. **`adminApi.kpis` tipado errado** (`Record<string, number>` para resposta com array) — corrigido.
8. **S1 real**: `/v1/ops/ingest` sob `/v1/` ficaria exposto pelo proxy do web-serve (o check de IP sozinho seria derrotado — o socket chega como 127.0.0.1). Solução: rota em `/api/internal/*` + **bloqueio explícito de `/api/internal` no `web-serve.mjs`** (O31 prova negativa via túnel).
9. **Worker de entregas estava morto e sem supervisor** — agora 5º serviço do keep-alive (O02) + grava `alert_delivered`/`alert_failed`/`purge` em `OpsEvent` + `JobsDeadletter` real em `markFailed` (O20: `deadletter_error=http_400`).
10. Dois bugs dos próprios casos de teste (O14 exigia `name` no operador; O20 usava colunas sem aspas no SQL do Prisma) — corrigidos nos casos, não mascarados.

**Desvio honesto registrado (F3/O19)**: `SyncRun` **continua sem escritor** — não existe rotina de ingestão agendada no código (`jobs/dispatcher.ts` é função pura alimentada por um scheduler externo que ainda não existe). Inventar escritor seria simulação; o painel mostra a tabela real (vazia) com aviso explícito, e o contrato de leitura está pronto.

## 11. Aprovação

**COMANDOS DE REPRODUÇÃO:**
```bash
bash /home/user/tools/keep-alive.sh status        # 5 serviços + 2 supervisores + saúde
cd /home/user/acompanhe-ia
node tools/e2e/deep-run.mjs                        # 184 casos → docs/deep-resultados.md
# vitest + tsc
cd apps/api && pnpm exec vitest run && pnpm exec tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.test.json
cd ../web && pnpm exec tsc -p tsconfig.json --noEmit
```

**NÚMEROS FINAIS:** deep-run **177/0/3/4 (184)** · vitest **246+1 (247)** · tsc **0/0/0** · run-e2e 53/2 EXT/1 (B02 pendente do `/start` do usuário)/2 skip.

Painel operando em `/admin.html` (fora do mini app) com as 10 abas: visao · servicos · alteracoes · saude · filas · testes · regras · operadores · verificacoes · db.

## 7. Os cinco pilares — auditoria honesta deste plano + reforços obrigatórios

Auditoria do que o plano JÁ cobre × o que faltava (resposta direta, sem marketing):

| Pilar | Já coberto (onde) | Lacuna real encontrada | Reforço (obrigatório, com caso de teste) |
|---|---|---|---|
| **Observabilidade** | §3.2 probes, §3.3 ops/*, 4 sinais, health score, logs, filas, gates — **núcleo do plano** | — | mantido como está |
| **Rastreabilidade** | cadeia de hash do AuditLog (`admin.test.ts:89`), timeline unificada (§3.3), evidência crua por caso | sem correlação entre eventos (um heal → religada não se ligam; requisições sem id) | **R1/R2** abaixo (casos O35, O37) |
| **Governança** | RBAC 7 papéis + recurso `ops`; `approvedBy` já existe no RulesConfig (`schema.prisma:123`); retenção 7d/30d; visor de BD whitelist; operador só pelo diretor | sem política explícita de aprovação/expurgo/rotação de credencial; flag_change sem ator obrigatório | **G1–G3** abaixo (casos O29, O30, O38) |
| **Segurança** | SERVICE_TOKEN chmod 600; whitelist de tabelas e de arquivos de log; gate `can()` em toda rota | **`/v1/ops/ingest` exposto via túnel** (`web-serve.mjs:93` faz proxy de `/v1/`); login admin sem brute-force; tail de logs pode vazar segredo; `OpsEvent.detail` aceita qualquer JSON | **S1–S5** abaixo (casos O31–O34, O36) |
| **Escalabilidade** | índices `@@index([ts])`, retenção, probes de rede a cada 4 ciclos | sem cap de query, sem agregação por bucket, sem expurgo agendado, sem caminho Vercel+Neon | **E1–E3** abaixo (casos O39–O41) |

### 7.1 Governança (G)
- **G1 — Ato obrigatório**: toda mutação de `RulesConfig` e `FeatureFlag` exige `approvedBy` preenchido + `auditAppend` (ator, antes, depois). Sem ator → 400. *(O29)*
- **G2 — Expurgo agendado**: worker roda `DELETE` de `ServiceProbe` > 7d e `OpsEvent` > 30d a cada 100 ciclos; tamanho das tabelas exposto em `/ops/queues` (`bytes`). *(O30)*
- **G3 — Rotação de credencial**: `POST /v1/admin/ops/rotate-service-token` (só diretor) gera novo `SERVICE_TOKEN`, grava audit com ator, invalida o anterior na hora. *(O38)*

### 7.2 Segurança (S)
- **S1 — Ingest só de localhost**: `/v1/ops/ingest` aceita apenas origem `127.0.0.1`/`::1` **e** `x-service-token` válido → qualquer chamada via túnel cai em **403** mesmo com token certo. *(O31: prova negativa pelo túnel, evidência crua)*
- **S2 — Brute-force no login admin**: 5 tentativas falhas/min por IP → `429` por 60s (contador em memória do `/v1/admin/auth/login`). *(O32)*
- **S3 — Redação de segredos**: `/ops/logs` mascara padrões `(bot[0-9]+:[A-Za-z0-9_-]+|service.?token|password|senha|Bearer\s+\S+)` → `***` antes de devolver. *(O33)*
- **S4 — `OpsEvent.detail` higiênico**: ingest rejeita payload com chaves sensíveis (`token|password|secret|authorization`) → 400. *(O34)*
- **S5 — Headers no `web-serve.mjs`**: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN` em toda resposta estática. *(O36)*

### 7.3 Rastreabilidade (R)
- **R1 — `x-request-id`**: middleware na API gera id curto (hex 12), devolve no header de **toda** resposta e loga em erro 5xx; `OpsEvent.detail.requestId` quando o evento nasce de requisição. *(O35)*
- **R2 — Correlação de eventos**: `OpsEvent.detail.causa` liga pares heal→`process_start` (ex.: `health_fail` 19:12 → `process_start` 19:12 com o mesmo `causa`); timeline ordena por `ts` e mostra o par. *(O37)*

### 7.4 Escalabilidade (E)
- **E1 — Caps e agregação**: `hours` ≤ 168, `limit` ≤ 500 (fora → 400); range > 24h agrega `ServiceProbe` em buckets de 5 min na própria query (GROUP BY date_trunc). *(O39)*
- **E2 — Escrita em lote**: probes de um ciclo = 1 `INSERT` multi-linha; volume estimado ≈ 16k linhas/dia (api+web a 15s; bot/túnel/worker a 60s) → 7d ≈ 112k linhas com `@@index([service, ts])`. *(O40)*
- **E3 — Caminho Vercel+Neon** (deploy já planejado): `ops-report.sh` só troca a URL alvo; worker vira scheduled function; probes vira cron do deploy — **contratos de §3.3 não mudam**. Documentado em `docs/decisoes.md` na F6. *(O41)*

## 8. Fontes consultadas (metodologia)

- Google SRE Book — Four Golden Signals (latência, tráfego, erros, saturação) [sre.google/sre-book/monitoring-distributed-systems]
- RED (Rate/Errors/Duration, Tom Wilkie) e USE (Utilization/Saturation/Errors, Brendan Gregg) — quando usar cada um [grafana.com/docs/.../best-practices; mguarinos.com observability-series]
- Percentis (p95), não médias; health score 0–100 combinando erro+latência [oneuptime.com — Service Health Dashboard 2026]
- Dashboard em camadas (visão geral → serviço → debug) + anotações de deploy [wasilzafar.com — Monitoring & Observability Part 13]
- Alertar por sintomas (RED), não por causas; saturação é indicador líder [apistatuscheck.com; devopsbeast.com]
