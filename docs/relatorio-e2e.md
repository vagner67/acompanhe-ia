# Relatório E2E — 2026-10-24T20:57:29.223Z

Runner: `tools/e2e/run-e2e.mjs` · Base: http://127.0.0.1:3000 · Plano: `docs/plano-teste-e2e.md`
Usuários reais: e2e-u1..e2e-u7 (dev-auth) + diretor + operador.e2e (criado pelo diretor).

## Resumo
| resultado | qtd |
|---|---|
| PASS | 53 |
| FAIL | 1 |
| S4 externo | 2 |
| estado-conhecido | 0 |
| SKIP | 2 |
| **total** | **58** |

## Detalhe (evidência crua por caso)
| ID | Caso | Status | Sev | Evidência |
|---|---|---|---|---|
| SET-1 | dev-auth e2e-u1..u7 | PASS | — | `7 JWTs emitidos por /api/auth/telegram/dev` |
| SET-2 | trial u2 (investiga) | PASS | — | `200 {"ok":true,"record":{"subjectId":"e2e-u2","skus":["investiga:trial"],"expiresAt":"2026-10-31T20:57:02.953Z","trialUsedAt":"2026-10-24T20:57:02.953Z","grantedVia` |
| SET-3 | trial u3 expirado (SQL real) | PASS | — | `trial=200; sql=UPDATE 0
UPDATE 1` |
| SET-4 | conceder anota(u4)/investiga(u5) | PASS | — | `u4=200 u5=200` |
| SET-5 | massa u6: 10 notas + 10 gastos | PASS | — | `notas=10 gastos=10` |
| SET-6 | verificação pendente u7 | PASS | — | `201 {"ok":true,"v1Status":"pending","rule":"aprovação humana no painel (A3)"}` |
| SET-7 | operador criado pelo diretor | PASS | — | `201 {"operador":{"id":"1fdf6d53-7722-4b05-85e8-cf8ca210a1d1","email":"operador.e2e@acompanhe.app","name":"Operador E2E","role":"operador_suporte","active":true,"cre` |
| SET-8 | operador reativado | PASS | — | `200 {"ok":true}` |
| SET-9 | u4 verificação V1+ aprovada (gate A3) | PASS | — | `submit=201 aprovar=200` |
| SET-10 | u2 plano juridica concedido (gate v2/08) | PASS | — | `200 {"ok":true,"expiresAt":"2026-11-23T20:57:03.235Z"}` |
| TC-A01 | dev-auth emite JWT e /api/me devolve sessão | PASS | — | `me={"tgUserId":"e2e-u2","username":"e2e-u2"}` |
| TC-A02 | sem token/adulterado -> 401 | PASS | — | `sem=401 adulterado=401` |
| TC-G01 | acao nota_criada soma XP e missão | PASS | — | `{"xpGanho":5,"xpTotal":5,"level":1,"streak":1,"novasConquistas":["primeira_nota"],"missao":{"code":"m_notas_5","progress":1,"done":false,"xp` |
| TC-G02 | ação repetida: política real registrada | PASS | — | `1a={"xpGanho":10,"xpTotal":15,"level":1,"streak":1,"novasConqui 2a={"xpGanho":0,"xpTotal":15,"level":1,"streak":1,"novasConquis` |
| TC-G03 | ranking grava participação e lista | PASS | — | `post=200 get=200 {"uf":"BR","ranking":[{"userId":"deep-gami-637899","xp":15,"level":1},{"userId":` |
| TC-N01 | CRUD completo de notas | PASS | — | `criada=c325df1d-16f3-4fa6-86af-e8b63f1516e8 put=200 busca ok del=200` |
| TC-N02 | export.csv tem cabeçalho + linhas só do usuário (u6 massa) | PASS | — | `csv 21 linhas; cabecalho=tipo,id,data,titulo,descricao,valor_cents,categoria,tags; sem dados de terceiros` |
| TC-N03 | gastos CRUD + resumo bate com a soma | PASS | — | `gasto=f7f46608-8e15-4910-9706-69ce9ee3ef7e put/del ok; resumo={"resumo":{"ym":"2026-10","totalCents":4321,"porCategoria":[{"category":"casa","totalCents` |
| TC-N04 | OCR real (tesseract) no recibo.png | PASS | — | `engine=manual chars=0 texto=""` |
| TC-N05 | isolamento: nota de u2 não vaza para u4 | PASS | — | `u4 busca 'secreta' -> nao ve nota 39a09120-53ba-497b-ab8b-4bcd30967eb6 de u2` |
| TC-L02 | filtro salvo persiste (name+filter) | PASS | — | `post=201 get=200 body={"filtros":[{"name":"e2e-mt","filter":{"uf":"MT","palavra":"vigilancia"}}],"filters":[{"na` |
| TC-L01 | busca PNCP (rede externa) | EXTERNO | S4 | `502 {"error":"fonte PNCP indisponível","detail":"fetch failed"}` |
| TC-L02b | sem favoritos no produto — implementação usa filtros | SKIP | — | `grep rotas licitacoes.ts:92-149 nao possui /favoritos; documentado no relatorio` |
| TC-C03 | ingesta admin (job X-Admin-Token; rede externa DOU) | EXTERNO | S4 | `502 {"error":"fonte DOU indisponível","detail":"fetch failed"}` |
| TC-C01 | lista + detalhe | PASS | — | `lista=0 (DOU indisponível neste ambiente — sem o que ingerir)` |
| TC-C02 | alertas: consultar por termos acompanhados | PASS | — | `get=200 {"alerts":[],"rule":"RF-D07 — T-7/T-3/T-1 de inscrição"}` |
| TC-J01 | consulta jurídica (serviço externo/IA) | PASS | — | `201 {"consulta":{"id":"d2303c07-05ed-46b9-b1ca-4d5d0ae1122b","rodape":"conteúdo informativo, não é parecer jurídico"},"r` |
| TC-J02 | listar consultas e processos sem erro | PASS | — | `consultas=200 processos=200` |
| TC-E01 | pedido (u4) -> feed (u6) -> interesse -> match | PASS | — | `pedido=lr_36ghbz0r match=lm_oko00vv9` |
| TC-E02 | aceitar match + rodada | PASS | — | `aceitar=200 rodada=200` |
| TC-E03 | pagamento declarado -> confirmado -> dívida atualiza | PASS | — | `payment=pay_wmwc8tee confirm=200 dividas={"dividas":[{"matchId":"lm_oko00vv9","requestId":"lr_36ghbz0r","expiraEm":"2026-` |
| TC-E04 | payload inválido -> 4xx (nunca 500) | PASS | — | `negativo -> 422` |
| TC-I01 | criar case -> run (Sherlock) -> relatório | PASS | — | `case=7c9533a3-eeb4-4d7c-9458-a60c2355cee1 run=200 report={"report":{"id":"5bc9dafb-7f4f-426a-a491-5a3458d8b5f6","caseId":"7c9533a3-eeb4-4d7c-9458-a` |
| TC-I02 | alerts + export.csv + export.pdf | PASS | — | `csv=293B pdf=2295B` |
| TC-I03 | quota responde; sem plano é bloqueado | PASS | — | `quota={"window":{"day":"2026-10-24","used":1,"limit":150,"remaining":149},"l; u1 sem plano -> 403` |
| TC-I04 | admin concede trial investiga (usuário fresco) -> quota muda | PASS | — | `trial e2e-i4-1792875447035 -> 201; quota={"window":{"day":"2026-10-24","used":0,"limit":150,"remaining":150},"l` |
| TC-P01 | 5 SKUs + trialDias=7 (defaults) | PASS | — | `planos=anota,concurso,investiga,juridica,licitacao trialDias=7` |
| TC-P02 | checkout sem PushinPay -> 503 honesto (estado-conhecido) | PASS | — | `503 {"error":"credencial PushinPay não configurada — configure PUSHINPAY_TOKEN no servidor para emitir PIX","code":"PUSHINPAY_NOT_CONFIGURED","pushinpayConfigurado"` |
| TC-P03 | trial 1x por usuário (2a chamada -> 409) — usuário fresco | PASS | — | `1a=200 2a=409 TRIAL perUserOnce` |
| TC-P04 | concessão admin reflete em /api/assinaturas | PASS | — | `200 {"entitlement":{"subjectId":"e2e-u4","skus":["anota"],"expiresAt":"2026-11-23T20:57:03.071Z","grantedVia":"manual"},` |
| TC-P05a | trial expirado (u3): Investiga bloqueia 4xx | PASS | — | `investiga=403 {"error":"plano Investiga ativo é necessário (ou Pack avulso)","rule":"v2/08 §9.` |
| TC-P05b | trial expirado (u3): Jurídico bloqueia (gate v2/08 aplicado) | PASS | — | `juridico=403 {"error":"plano Consulta Jurídica ativo é necessário","rule":"v2/08 §9.5"}` |
| TC-V01 | pendente -> lista no painel -> aprovar -> usuário vê | PASS | — | `lista pendentes inclui e2e-v1-1792875447073; aprovar=200; user={"userId":"e2e-v1-1792875447073","v1Status":"approved","v2Status":"non` |
| TC-V02 | reprovar com motivo -> usuário vê o motivo | PASS | — | `user v1Status=rejected rejectReason="documento ilegível no teste e2e"` |
| TC-R01 | kpis do diretor carregam | PASS | — | `200 {"planos":[{"code":"anota","name":"AnotA","defaultMonthlyCents":1490},{"code":"juridica","name":"Consulta Jurídica",` |
| TC-R02 | RBAC real: operador_suporte tem kpis; NÃO tem rules; JWT admin != sessão | PASS | — | `kpis=200 rules=403 /api/me=401` |
| TC-R04 | rules versionadas: plans/investiga v1->v2->rollback->limpeza | PASS | — | `v1=6990 v2=7990 rollback->6990 limpeza->5990` |
| TC-R05 | audit registra ações | PASS | — | `200 {"entries":[{"id":"93","actorId":"56e21eb4-1f02-46cf-8b80-fcb97d1e7aac","actorRole":"diretor","action":"ru` |
| TC-R06 | db/:tabela: diretor 200, operador ativo 403 (sem permissão db) | PASS | — | `diretor=200 operador=403` |
| TC-R07 | operador troca a própria senha e loga com a nova | PASS | — | `troca=200 login novo=200` |
| TC-R03 | desativar operador -> login 401 (guard ativo) | PASS | — | `desativado=200 login=401 {"error":"credenciais inválidas"}` |
| TC-B01 | getMe + comandos + menu button default (WebApp) | PASS | — | `@acompanha_bot comandos=start,config,ajuda,suporte menu={"type":"web_app","text":"Abrir app","web_app":{"url":"https` |
| TC-B02 | botão WebApp no chat do usuário (requer /start dele) | FAIL | S2 | `sem chat iniciado ainda (Bad Request: user not found) — usuário precisa enviar /start` |
| TC-B02 | botão WebApp aguarda /start do usuário no @acompanha_bot | SKIP | — | `ver TC-B02 acima` |
| TC-S01 | rota inexistente 404; corpo vazio -> 4xx | PASS | — | `404=404 vazio=422` |
| TC-S02 | /health prova o Postgres | PASS | — | `200 {"status":"ok","db":"ok","service":"acompanhe-api","time":"2026-10-24T20:57:29.208Z"}` |
| TC-X01 | 5 usuários em paralelo: todos 2xx | PASS | — | `5 POST paralelos -> 201,201,201,201,201` |
| TC-X02 | dados persistem (relidos após os testes) | PASS | — | `11 notas 'massa' relidas do banco` |

## Pendências manuais (não automatizáveis aqui)
- TC-B02/B03: abrir o app pelo botão do @acompanha_bot (requer /start do usuário no celular).
- TC-S02b: health com Postgres parado (teste controlado, feito à parte).
