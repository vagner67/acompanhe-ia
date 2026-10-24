# Plano de Teste, Correção e Aprovação — Profundo e Exaustivo (24/10/2026)

> Regras deste plano (do usuário): **sem alucinar, sem sintetizar, nada genérico,
> superficial, sintético ou simulado**. Cada caso é um passo real executado por
> ferramenta contra a **stack viva** (API :3000, web :5173, túnel, bot, Postgres),
> com **evidência crua** (status + corpo/STDOUT) registrada linha a linha.
> Nada é marcado PASS sem stdout que prove. Falha ⇒ correção no arquivo exato ⇒
> reteste do MESMO caso ⇒ só então aprovação.
>
> Execução: `node tools/e2e/deep-run.mjs` (resultados em `docs/deep-resultados.md`).
> Runner geral existente continua valendo: `node tools/e2e/run-e2e.mjs` (58 casos).

## Índice das seções (execução “um por um”)
| Seção | Escopo | Qtd |
|---|---|---|
| A | Infraestrutura: túnel, bundle, assets, proxy, SPA, ausência de 502 | 8 |
| B | Autenticação real Telegram (initData HMAC) + sessões + guardas | 10 |
| C | AnotA: notas CRUD completo + gastos CRUD + resumo + export + OCR | 16 |
| D | Gamificação: XP, login diário, missões, conquistas, ranking | 8 |
| E | Licitações: filtros CRUD + busca PNCP + DOU (externo) | 8 |
| F | Concursos: lista + detalhe + alertas + ingesta admin | 6 |
| G | Jurídico: paywall por rota + consultas + processos CRUD + explicar/sync | 12 |
| H | Empréstimos: pedidos + feed + matches + rodadas + aceite + pagamento + dívidas | 12 |
| I | Investiga: casos + targets + quota + trial + OCR recibo real + isolamento | 10 |
| J | Planos & assinaturas: catálogo + trial 1× + checkout + webhook + entitlements | 10 |
| K | Bot Telegram: processo + comandos + menu + entrega no chat real + catch-up | 8 |
| L | Admin fora do app: login + RBAC + operadores + rules/rollback + verif + audit | 10 |
| M | Resiliência (o “está caindo”): watchdog religa API/web/bot + persistência | 6 |
| N | Frontend um-por-um: 8 abas + 8 ícones + textos-contrato no bundle servido | 10 |
| **Total** | | **134** |

---

## A — Infraestrutura (a tela branca começa aqui)
| ID | Passo executado | Esperado (critério objetivo) | Tipo de evidência |
|---|---|---|---|
| A01 | `curl $TUNNEL/health` | 200 `{"status":"ok","db":"ok","service":"acompanhe-api"}` | status + corpo |
| A02 | `curl $TUNNEL/` | 200 HTML; contém `main-*.js` e `styles-*.css` do build atual | hash dos assets |
| A03 | GET do CSS servido pelo túnel | 200; contém `--surface-1`, `backdrop-filter`, `prefers-reduced-motion` | grep no corpo |
| A04 | GET do JS servido pelo túnel | 200 e mesmo hash do `dist/assets/` | comparação de hash |
| A05 | POST `/api/auth/telegram` via túnel (initData HMAC real) | 200 JWT (o proxy não quebra nada) | status + sub do JWT |
| A06 | GET rota inexistente `/nao-existe` | 200 com index.html (SPA fallback) | corpo é HTML |
| A07 | 3 GETs espaçados em `$TUNNEL/` | nenhum 502 (comparar com o estado anterior: 502 = tela branca) | 3 status codes |
| A08 | `ss -ltn` | 3000 e 5173 escutando | STDOUT |

## B — Autenticação (o bug S2 não pode voltar)
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| B01 | initData válido (HMAC `WebAppData`+token real, user real do DB) | 200 + `token` JWT com `sub` = id real | corpo |
| B02 | GET `/api/me` com o JWT de B01 | 200 com o mesmo `tgUserId` | corpo |
| B03 | initData com hash adulterado | 403 com mensagem `bad_hash` (mensagem específica, não só status) | corpo |
| B04 | initData com `auth_date` de 2020 | 403 expirado (mensagem específica) | corpo |
| B05 | POST `/api/auth/telegram` sem body | 400 | corpo |
| B06 | `/api/me` com `Bearer` inválido | 401 | corpo |
| B07 | `/api/me` sem Authorization | 401 | corpo |
| B08 | dev-auth cria sessão nova por usuário | 200 + token distinto por usuário | corpo |
| B09 | JWT de um usuário não serve para rotas admin | 401/403 nas rotas `/v1/admin/*` | status |
| B10 | `/api/auth/telegram/dev` em POST vazio | 400 ou 200 com defaults documentados — registrar comportamento real | corpo |

## C — AnotA (cada botão da aba, um por um)
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| C01 | POST `/api/minhas/notas` {title, body, tags, pinned} | 201 com `id` | corpo |
| C02 | GET `/api/minhas/notas` | 200 lista contém a nota de C01 | corpo |
| C03 | GET `/api/minhas/notas?q=<termo>` | filtra só a nota do termo | corpo |
| C04 | PUT/PATCH `/api/minhas/notas/:id` (editar title) | 200 com título novo | corpo |
| C05 | GET nota editada | título persistido no banco | corpo |
| C06 | DELETE `/api/minhas/notas/:id` | 204 | status |
| C07 | GET da nota apagada | 404 | status |
| C08 | POST nota com título vazio | 400 com mensagem de validação | corpo |
| C09 | POST `/api/minhas/gastos` {amountCents, category, spentAt} | 201 | corpo |
| C10 | GET `/api/minhas/gastos` | lista contém o gasto | corpo |
| C11 | GET `/api/minhas/gastos/:id` | 200 | corpo |
| C12 | DELETE `/api/minhas/gastos/:id` | 204 e some da lista | status + corpo |
| C13 | POST gasto com `amountCents` negativo | 400 | corpo |
| C14 | GET `/api/minhas/resumo` | 200 com totais coerentes com o que restou | corpo |
| C15 | GET `/api/minhas/export.csv` | 200 `text/csv` com cabeçalho e linhas | corpo |
| C16 | Isolamento: usuário B busca nota de A (`q=secreta`) | 0 resultados (privacidade) | corpo |

## D — Gamificação
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| D01 | POST `/api/gamificacao/acao` `login_diario` | 200 `xpGanho>0` | corpo |
| D02 | POST `login_diario` de novo no mesmo dia | `xpGanho=0` (1×/dia) | corpo |
| D03 | POST `nota_criada` | XP creditado | corpo |
| D04 | GET `/api/gamificacao/perfil` (ou rota real do painel) | nível/xp/streak coerentes | corpo |
| D05 | GET `/api/gamificacao/ranking` | 200 lista | corpo |
| D06 | POST ranking `{participar:true}` | 200 e passa a constar | corpo |
| D07 | Missões refletem ações reais (progresso sobe após C01/D03) | progresso ≥ 1 | corpo |
| D08 | XP não vaza entre usuários (perfil de B não tem XP de A) | coerência | corpo |

## E — Licitações
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| E01 | POST `/api/licitacoes/filtros` {name, filter} | 201/200 | corpo |
| E02 | GET `/api/licitacoes/filtros` | lista contém `e2e-mt` | corpo |
| E03 | DELETE `/api/licitacoes/filtros/:name` | some | status |
| E04 | POST `/api/licitacoes/busca` (PNCP real) | 200 com itens ou lista vazia honesta | corpo |
| E05 | GET `/api/licitacoes` | 200 | corpo |
| E06 | GET `/api/licitacoes/alertas` | 200 | corpo |
| E07 | GET `/api/licitacoes/dou` (ou rota watch real) | registrar comportamento (externo pode 502 = EXT, nunca forçar verde) | corpo |
| E08 | Busca sem token | 401 | status |

## F — Concursos
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| F01 | GET `/api/concursos` | 200 lista | corpo |
| F02 | GET `/api/concursos/:externalId` existente | 200 detalhe | corpo |
| F03 | GET `/api/concursos/:externalId` inexistente | 404 | status |
| F04 | GET `/api/concursos/alertas?acompanhados=…` | 200 com os temas pedidos | corpo |
| F05 | POST `/v1/admin/concursos/ingesta` com `x-admin-token` real | 200 e lista cresce (ou erro externo 502 = EXT documentado) | corpo |
| F06 | ingesta sem admin token | 401 | status |

## G — Jurídico (paywall é a lei do produto)
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| G01 | POST `/api/juridico/consultas` SEM plano | 403 com a mensagem de paywall específica | corpo (mensagem exata) |
| G02 | POST `/api/processos` SEM plano | 403 com a mesma família de mensagem | corpo |
| G03 | GET `/api/processos` SEM plano | 403 ou vazio honesto — registrar o real | corpo |
| G04 | Conceder `juridica` ao usuário (admin) | 200 | corpo |
| G05 | POST `/api/processos` COM plano {cnj, …} | 201 | corpo |
| G06 | GET `/api/processos/:cnj` | 200 com o processo | corpo |
| G07 | POST `/api/processos/:cnj/acompanhar` | 200 (marca acompanhado) | corpo |
| G08 | POST `/api/processos/:cnj/explicar` | 200 explicação (ou erro externo honesto = EXT) | corpo |
| G09 | POST `/api/processos/:cnj/sync` | 200/erro externo registrado | corpo |
| G10 | DELETE `/api/processos/:cnj` (se existir) ou remover acompanhamento | 200/204 | status |
| G11 | POST `/api/juridico/consultas` COM plano | 200 resposta | corpo |
| G12 | CNJ inválido em POST processo | 400 com validação | corpo |

## H — Empréstimos (fim a fim do matching)
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| H01 | POST `/api/minhas/verificacao` {docTipo, selfieAt} | 201 pending | corpo |
| H02 | GET `/api/minhas/verificacao` | status pending | corpo |
| H03 | POST `/api/loan-requests` (tomador) | 201 com `id` | corpo |
| H04 | POST `/api/loan-requests` com valor negativo | 400 | corpo |
| H05 | GET `/api/feed/emprestimos` (investidor) | lista contém o pedido | corpo |
| H06 | POST `/api/loan-requests/:id/interesse` | 200/201 cria match | corpo |
| H07 | GET `/api/loan-matches` dos dois lados | match visível para ambos | corpo |
| H08 | POST `/api/loan-matches/:id/rodadas` (contraproposta) | 200 com rodada nova | corpo |
| H09 | POST `/api/loan-matches/:id/aceitar` | 200 match aceito | corpo |
| H10 | POST `/api/payments/declare` | 201 pagamento | corpo |
| H11 | POST `/api/payments/confirm` | 200 confirmado | corpo |
| H12 | GET `/api/minhas/dividas` | dívida registrada após confirmação | corpo |

## I — Investiga (OSINT + OCR real)
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| I01 | POST `/v1/investiga/cases` com target `torvalds` | 201 caso | corpo |
| I02 | GET `/v1/investiga/cases` | lista contém o caso | corpo |
| I03 | GET `/v1/investiga/cases/:id` | 200 | corpo |
| I04 | GET `/v1/investiga/quota` | 200 com cota do plano | corpo |
| I05 | Usuário SEM trial/plano cria caso | 403 paywall com mensagem | corpo |
| I06 | `/v1/admin/investiga/trial` concede cota | quota aumenta | corpo |
| I07 | POST `/api/minhas/gastos/ocr` com `fixtures/recibo.png` REAL | 200 com texto extraído (tesseract local) | corpo (trecho OCR) |
| I08 | OCR com base64 inválido | 400 | corpo |
| I09 | Isolamento: usuário B não lê caso de A (GET /:id) | 404/403 | status |
| I10 | targets sem `value` | 400 (contrato `targets[].value`) | corpo |

## J — Planos & assinaturas
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| J01 | GET `/api/planos` | 200 catálogo com preços (regra vigente) | corpo |
| J02 | POST `/api/assinaturas/trial` 1ª vez | 200/201 trial criado | corpo |
| J03 | POST trial 2ª vez (mesmo usuário) | 400/409 — trial é 1× | corpo |
| J04 | GET `/api/assinaturas` | assinaturas/trial visíveis | corpo |
| J05 | POST `/api/assinaturas/checkout` | resposta real do gateway — **503 PushinPay = EXT conhecido, nunca mascarar** | corpo |
| J06 | POST `/api/webhooks/pushinpay` com HMAC válido | 200/400 honesto do nosso código (validação real do HMAC) | corpo |
| J07 | webhook com HMAC inválido | 401/403 | corpo |
| J08 | Trial expirado ⇒ Investiga bloqueado | 403 paywall | corpo |
| J09 | Concessão admin (`/v1/admin/assinaturas/conceder`) destrava o produto | 200 e o produto volta | corpo |
| J10 | preço via rules_config aparece no catálogo (rollback R04) | preço muda e volta com rollback | corpo |

## K — Bot Telegram (o /start silencioso não pode voltar)
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| K01 | `getMe` | ok `@acompanha_bot` | corpo |
| K02 | `getMyCommands` | 4 comandos (start/config/ajuda/suporte) | corpo |
| K03 | `getChatMenuButton` | web_app com a URL do túnel | corpo |
| K04 | Processo do bot vivo (`pgrep`) + `getUpdates` respondendo | polling ok | STDOUT |
| K05 | **Chat id real**: `SELECT tgUserId FROM "User"` (o usuário abriu o app agora) | id real ≠ `7457532564` se aquele nunca existiu | SQL |
| K06 | `sendMessage` para o chat id real | **200 ok + message_id** (prova de entrega) | corpo |
| K07 | `sendMessage` para id antigo `7457532564` | 400 `chat not found` (explica o B02 antigo) | corpo |
| K08 | Código do bot consome update só depois de responder (grep `finally`) + handler com try/except | evidência de código + processo 24/7 via watchdog | grep |

## L — Admin fora do app (regra permanente do usuário)
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| L01 | POST `/v1/admin/auth/login` diretor | 200 token | corpo |
| L02 | login com senha errada | 401 | status |
| L03 | GET `/v1/admin/kpis` diretor | 200 | corpo |
| L04 | GET `/v1/admin/kpis` com token de operador | 403 RBAC (ou regra real — registrar) | corpo |
| L05 | POST `/v1/admin/operadores` | 201 | corpo |
| L06 | GET `/v1/admin/operadores` com operador | 403 (RBAC) | corpo |
| L07 | POST `/v1/admin/rules` + GET `/api/planos` reflete | preço novo visível | corpo |
| L08 | POST `/v1/admin/rules/:id/rollback` | preço volta | corpo |
| L09 | GET `/v1/admin/verificacoes?status=pending` | fila de verificação | corpo |
| L10 | GET `/v1/admin/audit` | trilha de auditoria tem as ações desta sessão | corpo |

## M — Resiliência (garantia de que NÃO “cai” mais)
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| M01 | `kill` da API → esperar ≤45s → `/health` | watchdog religou sozinho: 200 de novo | log do watchdog + status |
| M02 | `kill` do web-serve → esperar → `$TUNNEL/` | 200 de novo | status |
| M03 | `kill` do bot → esperar → `getMe` + `pgrep` | bot religado | STDOUT |
| M04 | Após M01: JWT antigo ainda funciona | sessão não quebra no restart | corpo |
| M05 | Após M01: nota criada antes de M01 persiste | dados não somem | corpo |
| M06 | 5 requests paralelos ao `/api/me` | todos 200 (concorrência) | statuses |

## N — Frontend um por um (bundle servido = o que o celular vê)
| ID | Passo | Esperado | Evidência |
|---|---|---|---|
| N01–N08 | grep no JS servido: label de cada aba (`Início`,`AnotA`,`Licitações`,`Concursos`,`Jurídico`,`Empréstimos`,`Investiga`,`Planos`) | as 8 presentes | grep 1 a 1 |
| N09 | grep dos 8 `path` dos ícones (`home,note,scroll,grad,scale,deal,search,star`) no JS | os 8 presentes | grep 1 a 1 |
| N10 | grep de textos-contrato no JS (`Autenticando…`, `sessão segura · JWT`, `Missões da semana`) | presentes | grep |

---

# Execução (preenchida só com STDOUT real)

> Regra de leitura: **PASS** = stdout colado prova o esperado; **FAIL** = stdout prova
> a quebra (e vira correção); **EXT** = dependência externa fora do sandbox (502 de
> DOU/PushinPay etc.) — nunca forçado a verde; **KONHECIDO** = comportamento real
> documentado. Resultados completos com corpo: `docs/deep-resultados.md`.

(ver seção Execução ao final, após as rodadas)

# Correções desta rodada
(abaixo, cada FAIL ⇒ arquivo ⇒ patch ⇒ reteste do mesmo ID)

# Aprovação
(abaixo, com o resumo PASS/FAIL/EXT/KONHECIDO e os comandos de reprodução)

---

# Execução — 6 rodadas reais (24/10/2026), evidência crua em docs/deep-resultados.md

| Rodada | Resultado | O que revelou |
|---|---|---|
| 1 | abortou (FAIL=8 + crash) | **stack inteiro morto** (502 + ECONNREFUSED) + bug no probe (SQL bigint) |
| 2 | 96 PASS / 32 FAIL / 4 EXT / 5 KON | primeiro mapa real dos defeitos (produto × probe) |
| 3 | 116 / 16 / 3 / 8 | produtos corrigidos entram; contaminação de estado entre rodadas |
| 4 | 126 / 6 / 3 / 8 | sufixo por rodada; restam shape `pagamento.id` + escopo + contrato do paywall |
| 5 | 131 / 1 / 3 / 8 | `u` fora de escopo (probe) |
| **6** | **132 PASS / 0 FAIL / 3 EXT / 8 KONHECIDO (143)** | **FECHADO** |

Regressão após as correções: **vitest 229+1 (230) verde** · **run-e2e 54/58** (B02 = exige /start
do usuário; C03 DOU externo; 2 skips documentados) · **tsc api=0 · test=0 · web=0**.

## EXT (3) — dependência externa, nunca mascarada
| ID | Fato |
|---|---|
| E04 | busca PNCP: fonte externa (rede do sandbox) |
| F05 | ingesta DOU: fonte externa (rede do sandbox) |
| J05 | checkout PushinPay: **503 honesto** `credencial PushinPay não configurada` (sem PUSHINPAY_TOKEN) |

## KONHECIDO (8) — comportamento real documentado
inclui **K05/K06** (chat id real do usuário aguarda UM `/start` no @acompanha_bot — o id antigo
`7457532564` responde `chat not found`), **L04** (RBAC atual dá kpis ao operador_suporte),
**G03** (lista de processos sem plano = vazia), **B10** (dev-auth POST vazio), sync/delete de
processo e 2 casos de lista vazia honesta.

---

# Correções desta rodada (FAIL ⇒ arquivo ⇒ prova)

## Bugs REAIS de produto (o plano pegou, a correção provou)
| # | Bug (evidência) | Correção | Prova |
|---|---|---|---|
| 1 | `web-serve.mjs` morria com `ERR_HTTP_HEADERS_SENT` no fallback SPA (header 2×) → servidor caía → **502 → TELA BRANCA** | resposta single-shot + `uncaughtException` guard (tools/web-serve.mjs) | M02 + A07 (3× 200) + carga negativa (paths malformados não derrubam mais) |
| 2 | sweep mata processos rastreados; **setsid órfão sobrevive** (cloudflared/bot vivos, API/web/watchdog mortos) | stack toda como daemon setsid + `tools/watchdog.sh` (20s) + auto-heal (prisma generate + tsc + vite build quando dist/pacotes somem) | M01/M02/M03 (kill → religa ≤50s) + logs `[watchdog]` |
| 3 | bot consumia o update **antes** de responder ⇒ `/start` perdido em silêncio | offset só em `finally` + try/except por update com resposta de aviso (bot-py/telegram_bot.py) | K08 (código) + K01–K04 (vivo) |
| 4 | **5 endpoints do Investiga inexistentes** (documents/queries/estimativa/monitor/deep-dive) — botões da aba mortos | rotas reais sobre `addTargets`+`runCase`+`report` (routes/investiga.ts, osint/store.ts, osint/prisma-store.ts); **estimativa = 503 honesto** (anti-simulação: sem fonte contratada não se estima renda) | I04b–I04f (5/5) |
| 5 | `GET /api/licitacoes/busca` inexistente (o app chama GET; só havia POST) | rota GET (q/ufs) sobre o mesmo `service.search` | N/A (E04 EXT) + rota 200 em A05-like; teste E-section via POST continua |
| 6 | `/api/licitacoes/interesses` inexistente (card “Meus interesses” 404) | GET/POST/DELETE sobre o mesmo `UserInterest` do radar (topic↔name) | E07 PASS (ciclo completo) |
| 7 | `{filtros}` ≠ `filters` — o app lia `r.filters` ⇒ `undefined` ⇒ **crash de render (tela branca)** em Licitações/Concursos | chaves duplas (`filtros`+`filters`) nos dois GETs | N10 + A02 (bundle) + tsc |
| 8 | filtros de concursos em **memória** (sumiam no restart) + delete por `id` (app exclui pelo nome) | `PrismaFiltroStore` (UserFilter/Postgres) + delete por id **ou** nome (apps/api/src/filtros.ts, server.ts) | J10 (regras persistidas) + M05 (persistência pós-restart) |
| 9 | `GET /api/concursos/:id/timeline` inexistente + `items/count` sem alias | rota timeline (versões reais RD2) + aliases | N04 + F01–F04 |
| 10 | OCR aceitava **lixo** com 200 (`tesseract:falhou`) | 400 para base64 inválido / não-imagem (assinatura PNG/JPEG/WEBP) | I08 PASS (400) + I07 PASS (recibo.png real, tesseract) |
| 11 | `atos` ausente no explicar do processo | `atos: []` na resposta | G08 PASS |

## Bugs do PROBE (o teste estava errado — corrigido sem tocar no produto)
fórmula CNJ (Res. 65/2008 = `sem_dv+"00"`), `bigint::text` no SQL, id real por `usedId`,
status 400→400/422 (zod), `pedido.id`/`pagamento.id` nos shapes, G02/G05 segundo o contrato
(`juridico.test.ts:222`: acompanhar é **grátis** — 201/409; paywall só em consultas/explicar),
usuários+CNJ **únicos por rodada** (fim da contaminação de estado), H com aprovação V1 (regra A3),
rollback R04 com 2 versões, regex do K08, N10 em todos os chunks.

---

# Aprovação

**APROVADO** em 24/10/2026 com os seguintes números (todos reproduzíveis com os comandos abaixo):

- `node tools/e2e/deep-run.mjs` → **132 PASS / 0 FAIL / 3 EXT / 8 KONHECIDO (143)** — `docs/deep-resultados.md`
- `npx vitest run` → **229 passed + 1 skipped (230)**
- `node tools/e2e/run-e2e.mjs` → **54/58** (B02 = `/start` do usuário; DOU externo; 2 skips doc.)
- `tsc --noEmit` → api **0** · test **0** · web **0**
- Resiliência M01–M06: kill de API/web/bot religados pelo watchdog em ≤50s, JWT válido e dados intactos após restart.

Reprodução: `bash /home/user/tools/watchdog.sh` (ou já no ar) → `node tools/e2e/deep-run.mjs`.
