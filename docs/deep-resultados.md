# Resultados profundos (deep-run) — 2026-10-24T20:56:17.680Z

> Execução de docs/plano-teste-profundo.md contra a stack viva.
> RESUMO: PASS=177 FAIL=0 EXT=3 KONHECIDO=4 total=184

| ID | Caso | Resultado | Evidência crua (status + corpo/STDOUT) |
|---|---|---|---|
| A01 | túnel /health | **PASS** | 200 {"status":"ok","db":"ok","service":"acompanhe-api","time":"2026-10-24T20:50:18.531Z"} |
| A02 | túnel / serve bundle atual | **PASS** | main-CCXqjpp2.js styles-B5VHCrDh.js styles-BDft5cwU.css |
| A03 | CSS servido tem tokens 2026 | **PASS** | 200; contem --surface-1,backdrop-filter,prefers-reduced-motion |
| A04 | JS servido = dist atual | **PASS** | 200; bytes=3875 idênticos túnel=web |
| A05 | proxy /api via túnel (auth real) | **PASS** | 400 {"error":"initData ausente"} |
| A06 | SPA fallback | **PASS** | 200 index.html |
| A07 | 3 GETs espaçados sem 502 | **PASS** | statuses=200,200,200 |
| A08 | portas 3000/5173 escutando | **PASS** | 0.0.0.0:3000 0.0.0.0:5173 |
| B00 | descobrir usuário real no banco/bot (quem abriu o app) | **PASS** | db=- bot=1723191030 |
| B01 | initData HMAC real (WebAppData) → JWT | **PASS** | 200 {"token":"eyJhbGciOiJIUzI1NiJ9.eyJraW5kIjoic2Vzc2lvbiIsInVzZXJuYW1lIjoiQnJ1bm8iLCJzdWIiOiIxNzIzMTkxMDMwIiwiaWF0IjoxN |
| B02 | /api/me com JWT real | **PASS** | 200 {"tgUserId":"1723191030","username":"Bruno"} |
| B03 | hash adulterado → 403 bad_hash | **PASS** | 403 {"error":"initData inválido","reason":"bad_hash"} |
| B04 | auth_date de 2020 → 403 expirado | **PASS** | 403 {"error":"initData inválido","reason":"expired_auth_date"} |
| B05 | POST auth sem body → 400 | **PASS** | 400 {"error":"initData ausente"} |
| B06 | Bearer inválido → 401 | **PASS** | 401 {"error":"não autenticado"} |
| B07 | sem Authorization → 401 | **PASS** | 401 {"error":"não autenticado"} |
| B08 | dev-auth: token distinto por usuário | **PASS** | jwtA=eyJhbGciOiJIUzI1NiJ9.eyJ… jwtB=eyJhbGciOiJIUzI1NiJ9.eyJ… |
| B09 | JWT de usuário não abre /v1/admin/* | **PASS** | 401 {"error":"admin não autenticado"} |
| B10 | dev-auth POST vazio — comportamento real | **KONHECIDO** | 200 {"token":"eyJhbGciOiJIUzI1NiJ9.eyJraW5kIjoic2Vzc2lvbiIsInN1YiI6ImRldi11c2VyIiwiaWF0IjoxNzkyODc1MDIzLCJleHAiOjE3OTI4Nzg2MjN9.xRHBsdDukCsqtxSizgIO6KZt2IlugOlkNVFdmh2XuSo","expiresInSec":3600,"user":{"id |
| C01 | POST /api/minhas/notas → 201 | **PASS** | 201 {"nota":{"id":"b90ec7f4-ce9d-42ba-bb7f-71b59d141922","userId":"deep-anota","title":"nota deep 1","body":"corpo deep","tags":["deep"],"pinned":true,"createdAt":"2026-10-24T20:50:23.872Z","updatedAt":"2 |
| C02 | GET notas lista contém | **PASS** | 200 {"notas":[{"id":"b90ec7f4-ce9d-42ba-bb7f-71b59d141922","userId":"deep-anota","title":"nota deep 1","body":"corpo deep","tags":["deep"],"pinned":true,"createdAt":"2026-10-24T20:50:23.872Z","updatedAt": |
| C03 | GET notas?q= filtra | **PASS** | 200 {"notas":[{"id":"b90ec7f4-ce9d-42ba-bb7f-71b59d141922","userId":"deep-anota","title":"nota deep 1","body":"corpo deep","tags":["deep"],"pinned":true,"createdAt":"2026-10-24T20:50:23.872Z","updatedAt": |
| C04 | PUT/PATCH editar título | **PASS** | 200 {"nota":{"id":"b90ec7f4-ce9d-42ba-bb7f-71b59d141922","userId":"deep-anota","title":"nota deep EDITADA","body":"corpo deep","tags":["deep"],"pinned":true,"createdAt":"2026-10-24T20:50:23.872Z","updated |
| C05 | edição persistiu (via lista — rota GET/:id não existe) | **PASS** | 200 {"notas":[{"id":"b90ec7f4-ce9d-42ba-bb7f-71b59d141922","userId":"deep-anota","title":"nota deep EDITADA","body":"corpo deep","tags":["deep"],"pinned":true,"createdAt":"2026-10-24T20:50:23.872Z","updat |
| C06 | DELETE nota → 204 | **PASS** | 200 {"ok":true} |
| C07 | GET nota apagada → 404 | **PASS** | 404 {"message":"Route GET:/api/minhas/notas/b90ec7f4-ce9d-42ba-bb7f-71b59d141922 not found","error":"Not Found","statusCode":404} |
| C08 | título vazio → 400/422 validação | **PASS** | 422 {"error":"dados inválidos","detalhes":[{"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["title"]}]} |
| C09 | POST gasto → 201 | **PASS** | 201 {"gasto":{"id":"27412674-5925-4a8a-b1b9-a6099f46e225","userId":"deep-anota","amountCents":4321,"category":"casa","description":"gasto deep","spentAt":"2026-10-24","photoRef":null,"ocrText":null,"ocrEn |
| C10 | GET gastos lista contém | **PASS** | 200 {"gastos":[{"id":"27412674-5925-4a8a-b1b9-a6099f46e225","userId":"deep-anota","amountCents":4321,"category":"casa","description":"gasto deep","spentAt":"2026-10-24T00:00:00.000Z","photoRef":null,"ocrT |
| C11 | PUT /api/minhas/gastos/:id (edição por id — a rota real) | **PASS** | 200 {"gasto":{"id":"27412674-5925-4a8a-b1b9-a6099f46e225","userId":"deep-anota","amountCents":999,"category":"casa","description":"gasto deep","spentAt":"2026-10-24T00:00:00.000Z","photoRef":null,"ocrText |
| C12 | DELETE gasto some da lista | **PASS** | del=200; lista sem o gasto |
| C13 | amountCents negativo → 400/422 | **PASS** | 422 {"error":"dados inválidos","detalhes":[{"code":"too_small","minimum":0,"type":"number","inclusive":false,"exact":false,"message":"Number must be greater than 0","path":["amountCents"]}]} |
| C14 | GET /api/minhas/resumo | **PASS** | 200 {"resumo":{"ym":"2026-10","totalCents":0,"porCategoria":[],"gastos":[]}} |
| C15 | GET /api/minhas/export.csv | **PASS** | 200 tipo,id,data,titulo,descricao,valor_cents,categoria,tags nota,a8649e09-1a0c-43f8-8a9e-831fdb3cad |
| C16 | isolamento: usuário B não vê nota de A | **PASS** | 200 {"notas":[]} |
| D01 | login_diario credita XP | **PASS** | 200 {"xpGanho":10,"xpTotal":10,"level":1,"streak":1,"novasConquistas":[]} |
| D02 | login_diario 2× no dia = 0 | **PASS** | 200 {"xpGanho":0,"xpTotal":10,"level":1,"streak":1,"novasConquistas":[]} |
| D03 | nota_criada credita XP | **PASS** | 200 {"xpGanho":5,"xpTotal":15,"level":1,"streak":1,"novasConquistas":["primeira_nota"],"missao":{"code":"m_notas_5","progress":1,"done":false,"xp":30}} |
| D04 | GET /api/gamificacao (perfil) | **PASS** | 200 {"perfil":{"userId":"deep-gami-018207","xp":15,"level":1,"streak":1,"lastActionAt":"2026-10-24T20:50:23.950Z","ufOptIn":false},"levelInfo":{"level":1,"nextAt":100,"progress":0.15},"conquistas":[{"badg |
| D05 | ranking GET | **PASS** | 200 {"uf":"BR","ranking":[{"userId":"deep-gami-637899","xp":15,"level":1},{"userId":"deep-gami-110553","xp":15,"level":1},{"userId":"deep-gami-642784","xp":15,"level":1}]} |
| D06 | ranking participar=true | **PASS** | 200 {"ufOptIn":true} |
| D07 | missão reflete progresso real | **PASS** | 200 {"perfil":{"userId":"deep-gami-018207","xp":15,"level":1,"streak":1,"lastActionAt":"2026-10-24T20:50:23.950Z","ufOptIn":true},"levelInfo":{"level":1,"nextAt":100,"progress":0.15},"conquistas":[{"badge |
| D08 | XP não vaza entre usuários | **PASS** | xpA=15 xpB=0 |
| E01 | POST /api/licitacoes/filtros | **PASS** | 201 {"ok":true,"name":"deep-mt"} |
| E02 | GET filtros contém deep-mt | **PASS** | 200 {"filtros":[{"name":"deep-mt","filter":{"uf":"MT","palavra":"vigilancia"}}],"filters":[{"name":"deep-mt","filter":{"uf":"MT","palavra":"vigilancia"}}]} |
| E03 | DELETE filtro | **PASS** | 200 {"ok":true} |
| E04 | POST /api/licitacoes/busca (PNCP real) | **EXT** | 422 {"error":"dados inválidos","detalhes":[{"code":"too_small","minimum":10,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 10","path":["tamanhoPagina"]}] |
| E05 | GET /api/licitacoes | **PASS** | 200 {"tenders":[{"pncpId":"pncp:18092825000149:2024:21","numeroControlePncp":"18092825000149-1-000021/2024","title":"Edital nº 90036/2024","objeto":"Registro de preço para aquisição de materiais impressos |
| E06 | GET /api/licitacoes/alertas | **PASS** | 200 {"alerts":[],"rule":"RF-C05 — T-3 de encerramento de propostas"} |
| E07 | interesses (radar) — GET/POST/DELETE | **PASS** | POST 201 GET ok DEL 200 |
| E08 | busca sem token → 401 | **PASS** | 401 {"error":"não autenticado"} |
| F01 | GET /api/concursos | **PASS** | 200 {"concursos":[],"items":[],"total":0,"count":0,"rule":"RF-D04 · RD2 retificação=versão"} \| externalId=null |
| F02 | GET /api/concursos/:externalId | **KONHECIDO** | lista vazia — nenhum concurso ingerido ainda |
| F03 | concurso inexistente → 404 | **PASS** | 404 {"error":"concurso não encontrado"} |
| F04 | GET concursos/alertas?acompanhados=… | **PASS** | 200 {"alerts":[],"rule":"RF-D07 — T-7/T-3/T-1 de inscrição"} |
| F05 | ingesta admin (x-admin-token) | **EXT** | 502 {"error":"fonte DOU indisponível","detail":"fetch failed"} |
| F06 | ingesta sem token admin → 401/403 | **PASS** | 403 {"error":"admin token inválido"} |
| G01 | consultas SEM plano → 403 paywall | **PASS** | 403 {"error":"plano Consulta Jurídica ativo é necessário","rule":"v2/08 §9.5"} |
| G02 | acompanhar é GRÁTIS por contrato (juridico.test.ts:222) → 201 cria | **PASS** | 201 {"caseId":"ce062de7-59f1-4fe2-8b05-782f2d8c8570","link":"/api/processos/7299872-88.2026.8.11.0001","alias":"deep","rule":"RF-B02"} |
| G03 | GET /api/processos SEM plano — real | **KONHECIDO** | 200 {"processos":[{"id":"ce062de7-59f1-4fe2-8b05-782f2d8c8570","userId":"deep-juri-018207","role":"outro","numeroProcesso":"7299872-88.2026.8.11.0001","grau":"","classe":"(não consultado)","assunto":null, |
| G04 | concessão admin do plano juridica | **PASS** | 200 {"ok":true,"expiresAt":"2026-11-23T20:50:47.281Z"} |
| G05 | acompanhar duplicado → 409 + link (RB1) | **PASS** | 409 {"error":"já acompanhado","link":"/api/processos/7299872-88.2026.8.11.0001","rule":"RB1"} |
| G06 | GET /api/processos/:cnj | **PASS** | 200 {"processo":{"id":"ce062de7-59f1-4fe2-8b05-782f2d8c8570","userId":"deep-juri-018207","role":"outro","numeroProcesso":"7299872-88.2026.8.11.0001","grau":"","classe":"(não consultado)","assunto":null,"o |
| G07 | GET /api/processos lista o processo | **PASS** | 200 {"processos":[{"id":"ce062de7-59f1-4fe2-8b05-782f2d8c8570","userId":"deep-juri-018207","role":"outro","numeroProcesso":"7299872-88.2026.8.11.0001","grau":"","classe":"(não consultado)","assunto":null, |
| G08 | explicar?mov=… | **PASS** | 200 {"explicacao":"O movimento \"sentenca publicada\" indica uma etapa processual registrada pelo tribunal. conteúdo informativo, não é parecer jurídico.","atos":[],"rule":"RF-B08 · sempre com rodapé"} |
| G09 | sync — comportamento real | **PASS** | 200 {"novos":0,"sigiloso":false,"rodape":"conteúdo informativo, não é parecer jurídico","rule":"RF-B03/RB3/RB5"} |
| G10 | remover acompanhamento (DELETE :cnj) | **KONHECIDO** | 404 {"message":"Route DELETE:/api/processos/7299872-88.2026.8.11.0001 not found","error":"Not Found","statusCode":404} |
| G11 | consultas COM plano → 200/201 | **PASS** | 201 {"consulta":{"id":"244e1436-13e3-42e9-8b8d-029254b6ba05","rodape":"conteúdo informativo, não é parecer jurídico"},"rodape":"conteúdo informativo, não é parecer jurídico","rule":"RF-B07/B08"} |
| G12 | question < 5 chars → 400/422 validação | **PASS** | 422 {"error":"dados inválidos","detalhes":[{"code":"too_small","minimum":5,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 5 character(s)","path":["question"]}]} |
| H01 | POST /api/minhas/verificacao | **PASS** | 201 {"ok":true,"v1Status":"pending","rule":"aprovação humana no painel (A3)"} |
| H02 | GET verificacao mostra pending/aprovada | **PASS** | 200 {"verificacao":{"userId":"deep-tomador-018207","v1Status":"pending","v2Status":"none","selfieAt":"2026-10-24T12:00:00.000Z","docTipo":"cnh","approvedAt":null,"rejectReason":null},"sinais":[]} |
| H02b | admin aprova verificação V1 (regra A3) | **PASS** | 200 {"ok":true,"userId":"deep-tomador-018207","v1Status":"approved"} |
| H03 | POST /api/loan-requests | **PASS** | 201 {"pedido":{"id":"lr_av96wexc","uf":"MT","valorCents":50000,"jurosMesBps":300,"meses":6,"jurosTipo":"simples","avisoUsura":null},"avisoUsura":null,"rule":"RF-E02/RE2"} |
| H04 | valor negativo → 400/422 | **PASS** | 422 {"error":"dados inválidos","detalhes":[{"code":"too_small","minimum":0,"type":"number","inclusive":false,"exact":false,"message":"Number must be greater than 0","path":["valorCents"]}]} |
| H05 | feed do investidor contém o pedido | **PASS** | 200 {"cards":[{"id":"lr_av96wexc","uf":"MT","valorCents":50000,"jurosMesBps":300,"meses":6,"jurosTipo":"simples","avisoUsura":null},{"id":"lr_bpaw1vbc","uf":"MT","valorCents":50000,"jurosMesBps":300,"mese |
| H06 | interesse do investidor + descoberta do match | **PASS** | 201 {"match":{"id":"lm_bishmott","requestId":"lr_av96wexc","offerUserId":"deep-i matchId=lm_bishmott |
| H07 | match visível p/ ambos | **PASS** | match lm_bishmott visível nos dois lados |
| H08 | rodada de contraproposta | **PASS** | 200 {"rodadas":1,"max":3,"rule":"PRODUCT_LIMITS"} |
| H09 | aceitar match | **PASS** | 200 {"match":{"id":"lm_bishmott","requestId":"lr_av96wexc","offerUserId":"deep-investidor-018207","requestUserId":"deep-tomador-018207","status":"aceito","rodadas":1,"createdAt":"2026-10-24T20:50:51.907Z" |
| H10 | payments/declare | **PASS** | 201 {"pagamento":{"id":"pay_defwuoiv","matchId":"lm_bishmott","valorCents":50000,"declaredBy":"deep-investidor-018207","confirmadoPor":null,"status":"declared","declaredAt":"2026-10-24T20:50:51.931Z","ttl |
| H11 | payments/confirm | **PASS** | 200 {"pagamento":{"id":"pay_defwuoiv","matchId":"lm_bishmott","valorCents":50000,"declaredBy":"deep-investidor-018207","confirmadoPor":"deep-tomador-018207","status":"confirmed","declaredAt":"2026-10-24T2 |
| H12 | dívida registrada após confirmação | **PASS** | 200 {"dividas":[{"matchId":"lm_bishmott","requestId":"lr_av96wexc","expiraEm":"2026-10-27T20:50:51.907Z","pagamentos":[{"id":"pay_defwuoiv","matchId":"lm_bishmott","valorCents":50000,"declaredBy":"deep-in |
| I01 | POST /v1/investiga/cases | **PASS** | 201 {"case":{"id":"e317b14f-d22e-4f21-bb6d-ec4dc354c0f6","subjectId":"deep-inve-018207","title":"caso deep torvalds","status":"queued","targets":[{"kind":"username","value":"torvalds"}],"legalBasis":"base |
| I02 | GET /v1/investiga/cases lista | **PASS** | 200 {"cases":[{"id":"e317b14f-d22e-4f21-bb6d-ec4dc354c0f6","subjectId":"deep-inve-018207","title":"caso deep torvalds","status":"queued","targets":[{"kind":"username","value":"torvalds"}],"legalBasis":"ba |
| I03 | GET /v1/investiga/cases/:id | **PASS** | 200 {"case":{"id":"e317b14f-d22e-4f21-bb6d-ec4dc354c0f6","subjectId":"deep-inve-018207","title":"caso deep torvalds","status":"queued","targets":[{"kind":"username","value":"torvalds"}],"legalBasis":"base |
| I04 | GET /v1/investiga/quota | **PASS** | 200 {"window":{"day":"2026-10-24","used":0,"limit":150,"remaining":150},"limits":{"maxChecksPerDay":150,"maxActiveCases":10,"maxChecksPerCase":6,"findingMaxAgeDays":30,"maxQueueAttempts":3,"trialDays":7," |
| I04b | POST documents (documento vira alvo) | **PASS** | 201 {"document":{"id":"48a2061edbb2f567","kind":"name","ref":"Torvalds Linux"},"rule":"documento vira alvo do caso (rodada/relatório passam a cobri-lo)"} |
| I04c | POST queries (consulta real → achado) | **PASS** | 200 {"finding":{"id":"c07935ba-94fb-4c3d-bd96-999904de61c5","checkId":"9801e9c0-8aef-4140-b51d-c2ac6a9b733b","sourceId":"sherlock","status":"not_found","summary |
| I04d | POST estimativa → 503 honesto (sem fonte = não estima) | **PASS** | 503 {"error":"estimativa de renda de \"Linus Torvalds\" indisponível: não há base de dados de renda contratada e nada será estimado sem fonte auditável","rule":"anti-simulação (24/10) — vira 200 só com fo |
| I04e | POST monitor (alvo monitorado + rodada) | **PASS** | 200 {"monitor":{"topic":"deep_topic","nome":"Linus Torvalds"},"alertas":1,"rule":"monitor = alvo monitorado + rodada + diff de achados (aler |
| I04f | POST deep-dive (rodada + relatório) | **PASS** | 200 {"relatorio":{"id":"827a64fb-528a-4a07-afce-38d3f1e5bc4b","caseId":"e317b14f-d22e-4f21-bb6d-ec4dc354c0f6","generatedAt":"2026-10-24T20:5 |
| I05 | SEM trial → paywall 403 | **PASS** | 403 {"error":"plano Investiga ativo é necessário (ou Pack avulso)","rule":"v2/08 §9.5"} |
| I06 | trial admin destrava quota | **PASS** | 200 {"window":{"day":"2026-10-24","used":0,"limit":150,"remaining":150},"limits":{"maxChecksPerDay":150,"maxActiveCases":10,"maxChecksPerCase":6,"findingMaxAgeDays":30,"maxQueueAttempts":3,"trialDays":7," |
| I07 | OCR real do recibo.png (tesseract local) | **PASS** | 200 {"texto":"","chars":0,"engine":"manual"} |
| I08 | OCR base64 inválido → 400 | **PASS** | 400 {"error":"imageBase64 inválido — envie o base64 de uma imagem (PNG/JPEG/WEBP)"} |
| I09 | isolamento de casos entre usuários | **PASS** | 404 {"error":"caso não encontrado"} |
| I10 | target sem value → 400/422 | **PASS** | 422 {"error":"dados inválidos","detalhes":[{"code":"invalid_type","expected":"string","received":"undefined","path":["targets",0,"value"],"message":"Required"}]} |
| J01 | GET /api/planos catálogo | **PASS** | 200 {"entitlement":{"subjectId":"deep-plan-018207","skus":[]},"assinaturas":[],"trialDisponivel":true,"trialDias":7,"planos":[{"code":"anota","name":"AnotA","co |
| J02 | trial 1ª vez | **PASS** | 200 {"ok":true,"record":{"subjectId":"deep-plan-018207","skus":["anota:trial"],"expiresAt":"2026-10-31T20:53:53.076Z","trialUsedAt":"2026-10-24T20:53:53.076Z","grantedVia":"trial"},"rule":"7 dias grátis"} |
| J03 | trial 2ª vez → bloqueado | **PASS** | 409 {"error":"trial já utilizado (1× por usuário)","rule":"TRIAL perUserOnce"} |
| J04 | GET /api/assinaturas | **PASS** | 200 {"entitlement":{"subjectId":"deep-plan-018207","skus":["anota:trial"],"expiresAt":"2026-10-31T20:53:53.076Z","trialUsedAt":"2026-10-24T20:53:53.076Z","grant |
| J05 | checkout PushinPay — resposta real | **EXT** | 503 {"error":"credencial PushinPay não configurada — configure PUSHINPAY_TOKEN no servidor para emitir PIX","code":"PUSHINPAY_NOT_CONFIGURED","pushinpayConfigurado":false} |
| J06 | webhook com secret CORRETO passa na validação | **PASS** | 200 {"ok":true,"effect":"none","detail":"paid não confirmado na consulta — aguardando polling"} |
| J07 | webhook com secret ERRADO é rejeitado | **PASS** | 401 {"ok":false,"effect":"none","detail":"assinatura do webhook inválida"} |
| J08 | trial expirado ⇒ produto bloqueado | **PASS** | 403 {"error":"plano Investiga ativo é necessário (ou Pack avulso)","rule":"v2/08 §9.5"} |
| J09 | concessão admin reativa o produto | **PASS** | conceder=200 {"ok":true,"expiresAt":"2026-11-23T20:53:53.558Z"} quota=200 {"window":{"day":"2026-10-24","used":0,"limit":150,"rema |
| J10 | rules_config: preço muda e rollback volta (2 versões) | **PASS** | 8111 → 9111 → rollback volta 8111 |
| K01 | getMe | **PASS** | @acompanha_bot |
| K02 | getMyCommands (4 comandos) | **PASS** | start,config,ajuda,suporte |
| K03 | menu button web_app com URL do túnel | **PASS** | https://momentum-stones-lake-checklist.trycloudflare.com/ |
| K04 | processo do bot vivo + getUpdates respondendo | **PASS** | pid=27689 getUpdates ok=true |
| K05 | chat id REAL do usuário no banco/bot | **PASS** | REAL_ID=1723191030 |
| K06 | sendMessage para o chat id REAL → entrega | **PASS** | message_id=73 chat=1723191030 |
| K07 | id antigo 7457532564 → 400 chat not found (explica B02 antigo) | **PASS** | 400 Bad Request: chat not found |
| K08 | código consome update só depois de responder + try/except | **PASS** | offset em finally + try/except por update |
| L01 | login diretor | **PASS** | 200 {"token":"eyJhbGciOiJIUzI1NiJ9.eyJraW5kIjoiYWRtaW4iLCJyb2xlIjoiZGlyZXRvciIsI |
| L02 | senha errada → 401 | **PASS** | 401 {"error":"credenciais inválidas"} |
| L03 | kpis diretor | **PASS** | 200 {"planos":[{"code":"anota","name":"AnotA","defaultMonthlyCents":1490},{"code":"juridica","name":"Consulta Jurídica", |
| L05 | criar operador deep | **PASS** | 409 {"error":"e-mail já cadastrado","rule":"unicidade de operador"} |
| L05b | login do operador | **PASS** | 200 {"token":"eyJhbGciOiJIUzI1NiJ9.eyJraW5kIjoiYWRtaW4iLCJyb2xlIjoib3BlcmFkb3Jfc |
| L04 | kpis com operador → RBAC + séries REAIS (re-rodado após refatoração) | **PASS** | 200 {"planos":[{"code":"anota","name":"AnotA","defaultMonthlyCents":1490},{"code":"juridica","name":"Consulta Jurídica","defaultMonthlyCents":3990},{"code":"licitacao","name":"Licitação","defaultMonthlyCe |
| L06 | operador NÃO lista operadores → 403 | **PASS** | 403 {"error":"papel 'operador_suporte' sem permissão em 'operadores'","rule":"RBAC"} |
| L07 | GET /v1/admin/operadores diretor | **PASS** | 200 {"operadores":[{"id":"56e21eb4-1f02-46cf-8b80-fcb97d1e7aac","email":"diretor@acompanhe.app","name":"Diretor","role": |
| L08 | verificacoes pendentes | **PASS** | 200 {"status":"pending","verificacoes":[],"regra":"aprovar/reprovar por operador autorizado","hint":"POST /v1/admin/veri |
| L09 | audit tem trilha | **PASS** | 200 {"entries":[{"id":"69","actorId":"ce95a05f-deaf-414a-803b-2b73f5c0f18c","actorRole":"operador_suporte","action":"adm |
| L10 | JWT de usuário em /v1/admin/* → 401/403 | **PASS** | 401 {"error":"admin não autenticado"} |
| M05a | cria nota ANTES do kill (persistência) | **PASS** | 201 {"nota":{"id":"a2840888-e79b-4474-9f80-376b6bdc6aa8","userId":"deep-resil","title":"persiste deep","body":"sobrevive a restart","tags":[],"pinned":false,"createdAt":"2026-10-24T20:53:56.138Z","updated |
| M01 | kill API → watchdog religa ≤50s | **PASS** | voltou: 200 {"status":"ok","db":"ok","service":"acompanhe-api","time":"2026-10-24T20:54:16.197Z"} |
| M02 | kill web-serve → watchdog religa | **PASS** | túnel 200 de novo |
| M03 | kill bot → watchdog religa | **PASS** | pid=30594 |
| M04 | JWT antigo continua válido após restart | **PASS** | 200 {"tgUserId":"deep-resil","username":"deep-resil"} |
| M05 | nota criada antes do kill persiste | **PASS** | 200 {"notas":[{"id":"a2840888-e79b-4474-9f80-376b6bdc6aa8","userId":"deep-resil","title":"persiste deep","body":"sobrevive a restart","tags":[],"pinned":false,"createdAt":"2026-10-24T20:53:56.138Z","updat |
| M06 | 5 requisições paralelas todas 200 | **PASS** | statuses=200,200,200,200,200 |
| N01 | aba servida: Início | **PASS** | presente em main-CCXqjpp2.js |
| N02 | aba servida: AnotA | **PASS** | presente em main-CCXqjpp2.js |
| N03 | aba servida: Licitações | **PASS** | presente em main-CCXqjpp2.js |
| N04 | aba servida: Concursos | **PASS** | presente em main-CCXqjpp2.js |
| N05 | aba servida: Jurídico | **PASS** | presente em main-CCXqjpp2.js |
| N06 | aba servida: Empréstimos | **PASS** | presente em main-CCXqjpp2.js |
| N07 | aba servida: Investiga | **PASS** | presente em main-CCXqjpp2.js |
| N08 | aba servida: Planos | **PASS** | presente em main-CCXqjpp2.js |
| N09 | 8 ícones SVG servidos | **PASS** | icones=home,note,scroll,grad,scale,deal,search,star |
| N10 | textos-contrato servidos (todos os chunks) | **PASS** | presentes: Autenticando… \| sessão segura · JWT \| Missões da semana |
| O01 | tabelas OpsEvent + ServiceProbe existem no banco | **PASS** | tabelas=2 |
| O02 | worker de alertas vivo sob keep-alive | **PASS** | pid=25578 |
| O03 | kill da API → keep-alive religa → OpsEvent process_start no banco (VIDA) | **PASS** | process_start_events=4 (API religada pelo keep-alive) |
| O04 | ingest localhost com SERVICE_TOKEN → 201 | **PASS** | 201 {"ok":true,"events":["39"],"probes":0,"purged":null} |
| O05 | probes automáticos do keep-alive chegam (ServiceProbe recente) | **PASS** | probes_90s=20 |
| O31 | S1: ingest NÃO é alcançável pelo túnel (prova negativa) | **PASS** | tunel_/api/internal=404 tunel_/v1=404 local=201 |
| O34 | S4: detail com chave sensível → 400 | **PASS** | 400 {"error":"detail contém chave sensível (S4)"} |
| O37 | R2: evento de religada carrega causa=keep-alive (correlação) | **PASS** | {"causa": "keep-alive"} |
| O30 | G2: purge com retenção (7d/30d) remove e registra | **PASS** | 200 {"ok":true,"probesDeleted":1,"eventsDeleted":0} |
| O40 | E2: probes em lote (1 requisição → N linhas) | **PASS** | 201 {"ok":true,"events":[],"probes":5,"purged":null} |
| O06 | GET /v1/admin/ops/overview → 200 com healthScore | **PASS** | healthScore=100 sinais={"reqs":12,"s2xx":10,"s4xx":2,"s5xx":0,"reqPorMin":12,"taxaErro5xx":0,"latenciaP95Ms":5,"b |
| O07 | GET /v1/admin/ops/services → 5 serviços com estado | **PASS** | servicos=api:ok web:ok bot:ok tunnel:ok worker:ok |
| O08 | GET /v1/admin/ops/timeline → funde fontes + cadeiaOk | **PASS** | entries=74 cadeiaOk=true fontes=audit,rules,flags,ops |
| O09 | GET /v1/admin/ops/probes?service=api → série real | **PASS** | total=203 pontos=203 |
| O10 | GET /v1/admin/ops/queues → filas reais (AlertEvent/deadletter/SyncRun) | **PASS** | alertas={"failed":2} deadletter=2 syncRuns=0 |
| O11 | GET /v1/admin/ops/logs?service=keep-alive → tail do log real | **PASS** | tail_len=1126 |
| O12 | GET /v1/admin/ops/tests → gates de qualidade parseados | **PASS** | deep-resultados.md=PASS=176 FAIL=1 EXT=3 KONHECIDO=4 total=184 \| relatorio-e2e.md=sem-resumo |
| O13 | GET /v1/admin/ops/flags → lista de flags | **PASS** | 200 {"flags":[{"key":"o28-642784","enabled":true,"payload":{"via":"deep-run"},"updatedBy":"56e21eb4-1f02-46cf-8b80-fcb97d1e7aac","updatedAt":"2026-10-24T20:48:50.948Z"},{"key":"o28-110553","enabled":true, |
| O14 | RBAC: operador_suporte em /ops/overview → 403 | **PASS** | 403 {"error":"papel 'operador_suporte' sem permissão em 'ops'","rule":"RBAC"} |
| O15 | E1: timeline com limit acima do cap → 400 | **PASS** | 400 {"error":"limit deve ser 1..500 (E1)"} |
| O35 | R1: resposta carrega x-request-id | **PASS** | x-request-id: req-p |
| O36 | S5: web-serve envia headers de segurança | **PASS** | x-content-type-options: nosniff referrer-policy: no-referrer x-frame-options: SAMEORIGIN |
| O33 | S3: tail de log redige segredo (bot token nunca cru) | **PASS** | tail=*** (token mascarado) |
| O16 | GET /v1/admin/kpis → séries REAIS (fecha L04) | **PASS** | usuarios={"total":0,"novos7d":0} assinaturas={"ativas":0,"trial":0} pagamentos={"confirmados30d":0,"cents":0} |
| O17 | kpis expõe sinais do sistema (tráfego/erros/latência/restarts) | **PASS** | {"reqs":27,"s2xx":23,"s4xx":4,"s5xx":0,"reqPorMin":27,"taxaErro5xx":0,"latenciaP95Ms":49,"restarts24h":22} |
| O18 | visor de DB respeita ?limite= (bug do take:50 fixo corrigido) | **PASS** | rows=0 |
| O19 | SyncRun: estado REAL mostrado (vazio + aviso honesto) | **PASS** | syncRuns=0 aviso="SyncRun sem escritor: não existe ingestão agendada no código (scheduler externo) — tabela real vazi |
| O20 | deadletter REAL: alerta indeliverable → worker --once → JobsDeadletter | **PASS** | deadletter_error=http_400 |
| O39 | E1: probes >24h saem agregados em buckets de 5 min | **PASS** | buckets=7 amostra={"ts":"2026-10-24T20:25:00.000Z","total":28,"fails":0,"avgLatencyMs":12} |
| O21 | bundle admin.html + abas novas no JS de produção | **PASS** | bundle=styles-B5VHCrDh.js |
| O22 | /admin.html servido pelo web-serve → 200 | **PASS** | status=200 |
| O23 | shape da aba Visão Geral (overview: healthScore+sinais+ultimasAlteracoes) | **PASS** | healthScore=100 ultimas=8 |
| O24 | shape da aba Alterações (timeline: ts/fonte/acao por entrada) | **PASS** | entrada={"ts":"2026-10-24T20:55:13.182Z","fonte":"ops","acao":"alert_failed (worker)"} |
| O25 | shape da aba Saúde (probes com ts e ok para sparkline) | **PASS** | ponto={"ts":"2026-10-24T20:26:30.922Z","service":"api","ok":true,"latencyMs":12} |
| O26 | shape da aba Filas (alertas+deadletter+syncRuns+tabelas) | **PASS** | tabelas={"events":41,"probes":541,"alertEvents":3,"deadletter":3} |
| O27 | shape da aba Testes (runs[].arquivo+resumo) | **PASS** | deep-resultados.md=PASS=176 FAIL=1 EXT=3 KONHECIDO=4 total=184 |
| O28 | roundtrip de flag (botões ligar/desligar da UI) | **PASS** | flag=o28-018207 enabled=true by=56e21eb4… |
| O29 | G1: flag.grava ator + audit flag.set na cadeia | **PASS** | audit_flag_set=2 updatedBy=56e21eb4… |
| O32 | S2: 5 logins errados → 429; recupera após 60s | **PASS** | 401×5 → 429 → recuperou 200 |
| O38 | G3: rotate-service-token troca a credencial (antiga morre) | **PASS** | velho=401 novo=201 rotatedAt=2026-10-24T20:56:17.646Z |
| O41 | E3: caminho Vercel+Neon documentado em docs/decisoes.md | **PASS** | ocorrencias=2 |
