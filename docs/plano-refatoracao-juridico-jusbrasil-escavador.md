# Plano de refatoração do Jurídico do Acompanhe.IA
## Arquitetura e buscador de Jusbrasil e Escavador → o que transplantar (e o que NÃO transplantar)

**Data**: 25/10/2026 · **Status**: PESQUISA CONCLUÍDA → AGUARDANDO SUA DECISÃO (nada foi alterado ainda)
**Regra desta rodada**: só fatos medidos/verificados. Nenhuma estimativa apresentada como certeza. Nada de "genericamente escalável" — cada bloco abaixo tem origem, custo e limite declarados.

---

## 1. Como funciona o Jusbrasil (fontes primárias)

### 1.1 Coleta → armazenamento → busca → web (engenharia oficial)
Fonte: blog de engenharia do Jusbrasil, "Como o Jusbrasil funciona" (`medium.com/jusbrasil-tech/como-o-jusbrasil-funciona-4303f2b1d356`).

- Origem: derivou do **Goshme** (buscador de deep web). Missão: trazer à superfície o conteúdo de tribunais invisível ao Google.
- **Coleta**: *crawlers* em **Java e Python**, com expressões regulares, extração de informação e aprendizado de máquina; processamento de **Diários Oficiais em PDF** (cadernos de até 3 mil páginas) com **NER** (reconhecimento de entidades: pessoas, empresas, processos, OAB, CPF, datas).
- **Armazenamento**: **HBase** sobre HDFS/Hadoop — 20+ TB na época do artigo; 300 milhões de documentos.
- **Busca**: cluster de **Elasticsearch** (derivado do Lucene) indexando os documentos armazenados.
- **Borda/Web**: HAProxy balanceando ~13M requests; aplicação Python monolítica progressivamente quebrada em **microserviços (Node.js, Ruby, Scala)**; containers via **Mesos + Tsuru**; >100 servidores em clusters separados por função (coleta, armazenamento, busca, web, teste, processamento).
- Conclusão arquitetural: **pipeline desacoplado** (coleta ≠ indexação ≠ consulta) — a coleta nunca bloqueia a consulta do usuário.

### 1.2 O buscador (produto público)
- Busca pública por **nome, CPF, CNPJ e número do processo** (páginas de ajuda do Jusbrasil).
- Escala do problema de homônimos documentada em checagem independente (Aos Fatos): a busca por "José da Silva" retornava **32.207 processos de 3.459 pessoas diferentes** — o Jusbrasil exibe aviso de homônimos no topo.
- Sem filtro por polo (autor/réu): o polo é inferido pela posição do nome no par (esquerda = ativo, direita = passivo).

### 1.3 A API comercial (documentação oficial `api.jusbrasil.com.br/docs`)
Módulos publicados, verificados por HTTP 200: `consulta_processual_por_cpf_cnpj` (+ `consulta_lote`, `monitoramento_cpf_cnpj`, `motor_de_decisao`), `autos_processuais` (inteiro teor), `api_intimacoes`, `diarios_oficiais` (busca + monitoramento), `distribuicao` (novos processos), `autenticacao`.

Contratos lidos na fonte:
- **Consulta por CPF/CNPJ**: `POST /background-check/lawsuits/{criminal|civil|trabalhista}` com `documentNumber` + `pagination.cursor` (size ≤ 100). **Retorna por padrão os 100 processos mais recentes**; `pagination.total` traz o total real.
- Cada processo vem com `confianca_associacao` (**ALTA/MEDIA…**) — isto é, eles **expõem o grau de certeza do vínculo processo↔documento**, `polo_passivo`, `papel`, `status {inferido, normalizado, tribunal}`, `eventos_relevantes` (ex.: `transito_em_julgado`), `tipificacao` com legislação, `UF`, `comarca`, `forum`, `link`.
- **Motor de Decisão**: `POST /background-check/assessments {document_number, criteria_slug}` → `criticidade` (string) ou `criticidades[]`; `GET …/{id}/audit` devolve **justificativas e razões** (qual regra disparou, por quê, com qual processo). SLA declarado < 1s.
- **Diários Oficiais**: `POST https://op.digesto.com.br/api/diarios-oficiais/doc/buscar` com **sintaxe Elasticsearch 7.14.1** (`query_string`, `match`, filtros), **fuzzy/Levenshtein**, índice **sem acentos** (pontuação preservada), *highlights*/snippets configuráveis, facetas por data e diário, paginação `from/size`.
- **Distribuição/novos processos**: webhook diário (`evt_type: 4`), com **janela de 90 dias** de retroativos de distribuição, filtros por tribunal e por parte monitorada; payload traz partes com CPF, advogados, movimentos, audiências e links de anexos em PDF.
- Autenticação: `X-API-KEY`/`apikey` + `X-Request-ID` (rastreio); alguns endpoints Digesto usam Bearer token.
- Escala declarada na página comercial: **500M+ processos**, atualização diária, **95% dos andamentos em até 48h**.

---

## 2. Como funciona o Escavador (documentação oficial `api.escavador.com/v2/docs`)

### 2.1 Consulta
- `GET /api/v2/envolvido/processos?nome=|cpf_cnpj=` + filtro por tribunais + paginação por **cursor**.
- `GET /api/v2/processos/{numero}`, **movimentações**, **documentos públicos**, **autos**, **envolvidos**, **estatísticas** e **assuntos** normalizados.
- **Resumo inteligente**: `POST` solicita geração assíncrona + `GET` status/resultado.
- Normalização forte: `orgao_julgador_normalizado`, `assuntos_normalizados` com `codigo_cnj` e `path_completo`, `status_predito` (INATIVO/ATIVO), `fontes_tribunais_estao_arquivadas`.

### 2.2 Monitoramento e callbacks
- `POST /api/v2/monitoramentos/processos {numero, tribunal?, frequencia: DIARIA|SEMANAL, documentos_publicos?}` → status **PENDENTE → ENCONTRADO / NAO_ENCONTRADO** (não cobra quando não encontra).
- Eventos de webhook documentados: `update_status`, `movimentacao_nova`, `processo_dado_novo`, `envolvido_novo`, `novo_processo_envolvido` (para monitoramento por **NUMDOC** ou **NOME**).
- Motivo declarado do assíncrono: instabilidade dos sistemas dos tribunais e **captcha** — buscas são enfileiradas e o resultado chega por callback.

### 2.3 O algoritmo de match (documentação de suporte) — a parte mais importante
- Quando o tribunal informa o documento da parte, o vínculo processo↔CPF é direto.
- Quando **não** informa: eles associam nome→CPF **somente se o nome for único no Brasil**; se houver homônimos, **não associam** e o resultado pode não retornar — recomendam buscar por nome e **filtrar por estado**.
- Cada vínculo traz um **motivo**: `NOME_ALGORITMO`, `MESMO_ADVOGADO_OUTRO_PROCESSO`, `NOME_EXATO_ESTADO`, `NOME_EXATO_MUNICIPIO`.

### 2.4 Registro de capacidade por tribunal
- `GET /api/v2/tribunais/sistemas` → para cada tribunal: `sistema_nome` (PJE, ESAJ, PROJUDI, EPROC, tucujuris, SITE…), `utiliza_certificado_digital`, `utiliza_2fa`.
- Na v1: `GET /api/tribunal/origens` traz a flag **`busca_nome`** por tribunal — ou seja, **eles publicam que nem todo tribunal aceita busca por nome**, exatamente como medimos aqui (nossas 4 bases e-SAJ).

### 2.5 Cobrança (medida)
- v2, listagem por pessoa/OAB: **~R$ 4,50 na chamada inicial (até 200 itens)** + **R$ 0,05 por bloco adicional de 200 itens**; consultas idênticas em 24h são cobradas novamente; paginação é barata.
- Pré-pago com créditos válidos por 90 dias; consumidor a partir de R$ 9,90/mês. API não tem preço público — é negociado.

---

## 3. Os 7 padrões que ambos usam (e que explicam por que parecem "completos")

| # | Padrão | Jusbrasil | Escavador | Acompanhe.IA hoje |
|---|---|---|---|---|
| P1 | **Pipeline desacoplado**: coletor → armazenamento → índice → consulta | crawlers + HBase + ES | robôs + base + API | **não temos** (consulta ao vivo, sem índice) |
| P2 | **Índice próprio pesquisável** (full-text/facetas) | Elasticsearch | busca por cursor na própria base | **não temos** |
| P3 | **Vínculo processo↔pessoa com grau de certeza** | `confianca_associacao` | `motivo` do match | **parcial** (só nome + UF, sem score) |
| P4 | **Monitoramento push (webhook) com fila e retentativa** | evt_type 4, webhook diário | monitoramentos + callbacks | **polling manual** (`sync` sob demanda) |
| P5 | **Publicações/diários oficiais** | busca+monitoramento em diários | monitoramento de diário | **não temos** |
| P6 | **Normalização semântica** (CNJ: assunto/classe/status) | status inferido/normalizado | `codigo_cnj`, `status_predito` | **temos a tabela CNJ (975 movs)**, sem normalizar assunto/classe |
| P7 | **Registro de capacidade por fonte** (quem aceita o quê) | filtros por diário/tribunal | `busca_nome`, cert/2FA por tribunal | **não temos** (hardcoded em 4 bases) |

---

## 4. Diagnóstico do Acompanhe.IA hoje (tudo já provado nesta sessão)

- **Temos**: 91 tribunais por **número** via DataJud (mapa (J,TR)→alias verificado 91/91); busca por **nome/CPF/CNPJ** em **4 bases e-SAJ** (AC, AL, CE, SP) com 4 estados honestos; cruzamento DataJud por lote; tabela oficial de **975 movimentos CNJ**; assistente *grounded* (17 testes); paywall por plano; alertas no Telegram; busca pública web (DDG/Wikipédia/Tavily) no chat; 304 testes verdes; deploy Render 24/7.
- **Não temos**: índice próprio; busca full-text com facetas; monitoramento push; publicações (DJEN/diários); inteiro teor; score de vínculo (homônimos tratados só por aviso textual); registro de capacidade por fonte; motor de risco.

---

## 5. Lacunas priorizadas (o que a refatoração resolve)

| Lacuna | Impacto real hoje | Origem da solução |
|---|---|---|
| L1. Nome/CPF só em 4 tribunais | usuário busca e "não acha" o processo que sabe existir | índice próprio (DataJud) + e-SAJ + (opcional) API comercial |
| L2. Sem índice → cada consulta depende do tribunal responder | latência e instabilidade de fonte viram problema do usuário | P1/P2 |
| L3. Homônimos sem score | usuário não sabe se o resultado é "a pessoa dele" | P3 (score + motivo, como os dois fazem) |
| L4. Sem publicações (intimações) | perde o ato que **inicia prazo** (CPC 224 §2º: publicação = 1º dia útil após disponibilização) | **DJEN/Comunica (CNJ)** — ver §6.4 |
| L5. Monitoramento só manual | não avisa de processo novo distribuído | P4 (polling próprio → push quando houver provedor) |
| L6. Sem registro de capacidade | usuário não entende por que MT não funciona | P7 (tabela por fonte, derivada de medição) |

---

## 6. Arquitetura proposta (o que será alterado — para sua aprovação)

### 6.1 Camada de catálogo de fontes (P7) — primeiro, porque barateia tudo
- `apps/api/src/juridico/fontes.ts`: registro declarativo por fonte: `{ id, tipo: "datajud"|"esaj"|"djen"|"api_comercial", ufs[], aceita: ["numero"|"nome"|"cpf"|"cnpj"|"oab"], estado, verificadoEm, limitacao? }`.
- Toda tela/rota consulta o **catálogo**, nunca listas hardcoded → cobertura exibida = cobertura real.
- Teste: `fontes.test.ts` valida que o catálogo reflete exatamente as bases verificadas e que nenhuma fonte é anunciada sem `verificadoEm`.

### 6.2 Índice próprio (P1/P2) — "mini-DataJud" no Postgres
- **Schema**: `ProcessoIndice { numeroCnj PK, tribunal, uf, classe, assunto, orgaoJulgador, grau, valorCausa, dataAjuizamento, status, ultimoMovimentoNome, atualizadoEm }`, `ParteIndice { id, numeroCnj, nome, nomeNormalizado, documentoHash?, polo, tipoPessoa, scoreVinculo, motivoVinculo }`, `MovimentoIndice { numeroCnj, codigo, nome, dataHora }`.
- **Índice de busca**: `tsvector` (português) + `pg_trgm` para fuzzy (Levenshtein/trigram, como o Jusbrasil faz com Elastisearch) — **sem dependência externa**, roda no Postgres do Render.
- **Carga (job)**: por tribunal e por janela, `_search` no DataJud com `search_after` (o CNJ documenta paginação até 10.000/página e `search_after` para varredura profunda) → normaliza (P6) → upsert. Sem crawl de PJe, sem captcha.
- **Consulta** (`GET /api/processos/buscar-indice`): nome/CPF/número → busca no índice, com **facetas** (tribunal, ano, classe, UF) e **score de vínculo** (P3).
- **Honestidade obrigatória**: resultado do índice sempre marcado com `fonte: "indice"` e `atualizadoEm`; se o processo está no índice mas desatualizado > N horas, a UI diz "pode haver movimentação nova".

### 6.3 Score de vínculo e homônimos (P3) — copiando o melhor dos dois
- `scoreVinculo ∈ [0,1]` + `motivo`: `documento_informado` (1.0) · `documento_algoritmo` (0.9) · `mesmo_advogado_outro_processo` (0.8) · `nome_exato_estado` (0.6) · `nome_exato_municipio` (0.5) · **sem documento = não afirmar vínculo** (a lição do Escavador).
- UI: cada card mostra o score e o motivo em português claro ("documento informado pelo tribunal", "nome é único no estado"). Nunca presentar homônimo como "seu processo".

### 6.4 Publicações — DJEN/Comunica (CNJ), a fonte que fecha a lacuna L4
- Contrato **verificado no Swagger oficial** (`api.swaggerhub.com/apis/cnj/pcp/1.0.0`): `GET /api/v1/comunicacao` com `numeroOab`, `ufOab`, `nomeAdvogado`, **`nomeParte`**, **`numeroProcesso`**, `dataDisponibilizacaoInicio`, `dataDisponibilizacaoFim`. Sem chave. Base: `https://comunicaapi.pje.jus.br/api/v1` (homolog: `hcomunicaapi.cnj.jus.br`).
- **BLOQUEIO MEDIDO HOJE**: do nosso sandbox (EUA) e, por consequência, do Render (Oregon): **HTTP 403 CloudFront** (`x-amz-cf-pop: SEA900`) — geo-bloqueio para IP fora do Brasil, exatamente o que a documentação de terceiros alerta. Ou seja: **não funciona do servidor atual sem egress brasileiro.**
- Portanto, três caminhos (decisão §8): (a) egress BR (proxy/VPS pequeno) e aí é grátis e nacional; (b) contratar provedor comercial que já entrega publicações; (c) implementar com **degradação honesta** ("publicações indisponíveis deste servidor") — nunca simular.

### 6.5 Monitoramento (P4)
- **Fase própria, sem provedor pago**: job no worker já existente (`sincronizar`), varredura por processo acompanhado em intervalo configurável, respeitando o free tier; alerta no Telegram **já existe** → passa a ser alimentado por este job.
- **Com provedor** (Jusbrasil/Escavador): webhook assinado + fila + retentativa + dedupe (o `alertDedupeKey` já existe no código).
- Nunca prometer "tempo real": DataJud atualiza com defasagem; publicações DJEN têm regra própria de disponibilização (00h) e publicação (dia útil seguinte).

### 6.6 Motor de risco (P-extra, opcional — inspirado no `motor_de_decisao`)
- `avaliarRisco({processos, movimentos})` → `criticidade` + **justificativas auditáveis** (processo, regra, motivo), 100% determinístico e testável — **sem LLM no cálculo**, para não alucinar. Regras v1: volume de processos por área, valor da causa agregado, presença de execuções/falências, tempo de tramitação, polo (passivo).
- Só entra se você quiser: é "inteligência" vendável, mas não é requisito do buscador.

---

## 7. Fases, esforço e custo

| Fase | Entrega | Esforço | Custo |
|---|---|---|---|
| **F1** | Catálogo de fontes (P7) + UI de cobertura real + testes | 1 ciclo | R$ 0 |
| **F2** | Índice próprio mínimo (schema + ingestão DataJud + busca nome/CPF/nº com facetas) | 2 ciclos | R$ 0 (Postgres atual) |
| **F3** | Score de vínculo + homônimos com motivo + UI | 1 ciclo | R$ 0 |
| **F4** | Monitoramento por polling no worker + alertas Telegram | 1 ciclo | R$ 0 (worker atual) |
| **F5** | Publicações DJEN | 1 ciclo **+ egress BR** | grátis, **mas** exige proxy BR (~US$ 3–5/mês) |
| **F6** (opcional) | Motor de risco determinístico | 1–2 ciclos | R$ 0 |
| **F7** (opcional) | Adaptador de API comercial (Jusbrasil Consulta PRO / Escavador v2) plugável por chave | 1 ciclo | **usuário paga**: Escavador ~R$ 4,50/consulta até 200 itens; Jusbrasil sob consulta |

**Fora de escopo, explicitamente** (e por quê): burlar captcha (TJGO e outros) — viola termos; automação com login/certificado em PJe/eproc — exige credencial do usuário e tem implicação legal; copiar inteiro teor de peças de terceiros — direitos e LGPD; "crawler de tudo" — escala incompatível com o free tier.

**LGPD**: índice só de **dados públicos** de processo (sem CPF em claro — armazenar **hash** para casar documento), base legal = dados públicos (art. 7º, §3º), com registro de finalidade e exclusão a pedido.

---

## 8. Decisões que preciso de você ANTES de alterar

1. **Fonte de nome/CPF nacional**: construir índice próprio (grátis, cobre o que o DataJud publica) **ou** contratar API comercial (Escavador/Jusbrasil) **ou** híbrido (índice + adaptador opcional por chave)?
2. **Publicações (DJEN)**: contratar egress brasileiro (~US$ 3–5/mês) para ter intimações nacionais grátis **ou** deixar para depois **ou** já implementar com degradação honesta?
3. **Monitoramento**: polling próprio no worker (grátis, ciclo de horas) **ou** esperar provedor com webhook **ou** os dois?
4. **Motor de risco** (criticidade + justificativas): entra agora, depois, ou não entra?

---

## 9. Status da implementação (25/10/2026)

### 9.1 O que foi entregue

| Fase | Arquivo | Estado |
|---|---|---|
| F1/F2 catálogo de fontes + cobertura | `apps/api/src/juridico/fontes.ts` | ✅ `GET /api/processos/fontes` |
| F3 índice próprio (contrato + memória) | `juridico/indice.ts`, `juridico/limites.ts` | ✅ |
| F3 índice próprio (Postgres) | `juridico/indice-prisma.ts` | ✅ `ProcessoIndice`/partes/movimentos, LGPD via `documentoHash` |
| F4 ingestão por número | `juridico/ingestao.ts` | ✅ `POST /api/processos/indice/ingest` (1..200, `x-service-token`) |
| F5 busca no índice + facetas | rota `GET /api/processos/indice` | ✅ 422 p/ CNJ com DV errado, `advertencia` quando só nome |
| F6 motor de risco | `juridico/risco.ts` | ✅ `POST /api/processos/risco`, `risco-v1`, justificativas auditáveis |
| F7 monitoramento por polling | `jobs/monitor.ts` + bloco no `worker.ts` | ✅ ciclo `MONITOR_INTERVAL_MIN` (60), janela `MONITOR_INTERVAL_HORAS` (6) |
| UI | `apps/web/src/{api2.ts,screens.tsx}` | ✅ cobertura real, busca no índice (score/motivo), card de criticidade — **sem sanfona** |

### 9.2 Cobertura honesta (não prometer além disso)

- **Número de processo**: DataJud/CNJ, **91 tribunais**.
- **Nome / CPF / CNPJ**: só e-SAJ (`ac`, `al`, `ce`, `sp`) + o que já foi indexado. O DataJud **não publica partes** — o índice nunca inventa nome de parte.
- **DJEN/Comunica (intimações)**: geo-bloqueado fora do Brasil (403 CloudFront) → declarado `planejado` no catálogo, não usado.
- `GET /api/processos/fontes` é a **fonte única** dessa informação para a UI (evita texto solto e desatualizado).

### 9.3 Bug real encontrado pelo smoke fim a fim (e corrigido)

O DataJud devolve `numeroProcesso` **sem máscara** (`00069036920148110037`) e o índice gravava exatamente isso, enquanto a busca comparava com a forma canônica (`0006903-69.2014.8.11.0037`). Os testes de unidade passavam porque o store em memória normalizava por dígitos; o Postgres faz igualdade exata → **busca retornava 0 itens em produção**.

Correções:
1. `formatarNumero()` em `juridico/cnj.ts` — ponto único de normalização (aceita com ou sem máscara).
2. `processoDoDatajud` / conversão e-SAJ passam a gravar **sempre o CNJ canônico**.
3. `PrismaIndiceStore.buscar` aceita as duas formas (`in: [canônica, dígitos]`) para não quebrar registros antigos.
4. As rotas deixaram de fazer `parseCnj(det.valor)!` (que estourava 500 com 20 dígitos crus) e usam `formatarNumero`.

### 9.4 Verificação

- Suíte completa: **351 passed / 0 failed / 1 skipped** (baseline anterior era 304; +46 testes novos, nenhuma regressão).
- Arquivos novos de teste: `fontes`, `indice`, `risco`, `monitor`, `indice-rotas`, `indice-prisma` (+ casos em `alias91`).
- Smoke fim a fim (`/home/user/tools/smoke-juridico-indice.py`): **22/22 ok** contra API real + Postgres real + DataJud real — inclui login por `initData` assinado, concessão de plano pelo painel, ingestão real de processo, busca com/sem máscara, facetas, aviso de cobertura por nome, 422 de DV e criticidade.
- Ingestão é **idempotente** (repetir o mesmo lote não duplica: `totalNoIndice` estável).

### 9.5 Riscos conhecidos / próximos passos

- **Volume**: o índice só terá nomes depois de ingestão (números coletados, e-SAJ já suportado). Não é base nacional por nome — e a UI diz isso explicitamente.
- **Latência do DataJud**: ~30–50 s por processo em horário de pico; ingestão é assíncrona por lote (≤200) de propósito.
- **Monitoramento**: 1º ciclo após o deploy; log `monitor_ciclo` em `opsEvent` para auditar.
- **Próximo passo natural**: agendador de ingestão (coletar números dos casos ativos dos usuários), depois DJEN quando houver egress brasileiro.

### 9.6 Segundo bug real, achado só no smoke de produção

`POST /api/processos/indice/ingest` respondia **401 mesmo com o `x-service-token` correto** em `acompanhe.onrender.com`. Causa: a rota só consultava `process.env.SERVICE_TOKEN`, mas o Render entrega o token como **Secret File** (`SERVICE_TOKEN_FILE=/etc/secrets/servicetokens.json`) — quem já sabia disso era `routes/ops.ts`, com uma cópia local da leitura.

Correção: leitura extraída para `apps/api/src/service-token.ts` (`readServiceToken` com cache de 5s, `esquecerServiceToken`, `caminhoServiceToken`), usada agora por **ops** (inclusive a rotação) e pela **ingestão**. Teste dedicado: `test/service-token.test.ts` (arquivo, env, ausência → `null`, cache vs rotação).
