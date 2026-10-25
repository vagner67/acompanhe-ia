# Plano — Busca unificada (nome · CPF/CNPJ · nº do processo) + Pesquisa profunda de processos de terceiros — tela Jurídico

**Data**: 24/10/2026 · **Escopo**: somente o bloco de busca da tela Jurídico + rotas novas. Nada mais é alterado.
**Regra de ouro do usuário**: sem alucinar, sem sintetizar, nada genérico/superficial/fictício/simulado/sintético.
Plano primeiro → alterar → testar → aprovar.

## 1. Pedido (aceitação)

1. Na tela Jurídico, **um campo único** de busca aceita **nome, CPF ou número de processo** (auto-detecção).
2. **Um botão de "pesquisa profunda"** de **nome** relacionado a **processos de terceiros** (processos em que o nome figura como parte — autor/réu etc.).
3. **Barra de progresso** enquanto a consulta é realizada — com progresso real (etapas que de fato acontecem), nunca animação decorativa.
4. Não alterar funções não relacionadas (Acompanhar/Alertar/Explicar/Sincronizar, chat, paywall, worker, admin, pagamentos, OAB — intactos).

## 2. Evidências medidas em 24/10/2026 (o plano só usa o que foi VERIFICADO)

### 2.1 DataJud NÃO serve para nome/CPF (medido, não presumido)
- `query_string "Silva"` → 5514 hits, **todos** de `orgaoJulgador.nome` (nome de desembargadora — ex.: "Gabinete 21 - Desembargadora Juanita Cruz da Silva Clait Duarte").
- Frase `"Maria da Silva"` → 0 hits · `"006903692014"` (dígitos tipo CPF) → 0 hits.
- Campos `partes.nome`, `nomeParte`, `participantes.nome`, `nomeSucedido`, `advogados.nome` → 0 hits (não existem no índice).
- **Conclusão**: o DataJud só consulta por **número CNJ** (fluxo atual continua sendo a fonte oficial do card de processo).

### 2.2 e-SAJ `cpopg/search.do` — consulta pública por NOME e DOCUMENTO, SEM captcha (verificado ao vivo)
- Formulário TJAL (`www2.tjal.jus.br/cpopg/open.do`): `cbPesquisa` ∈ {NUMPROC, **NMPARTE**, **DOCPARTE**, NMADVOGADO, NUMOAB, …}; zero captcha no form.
- URL real: `GET {base}/cpopg/search.do?conversationId=&cbPesquisa=NMPARTE&dadosConsulta.valorConsulta={NOME}&cdForo=1` (+ `&paginaConsulta={n}`).
- **4 estados de resposta REAIS mapeados** (textos literais medidos):
  1. `resultados` — lista `divProcesso…/linkProcesso` com "N Processos" (ex.: "29 Processos", 2 páginas);
  2. `multiplos` — "Foram encontrados muitos processos para os parâmetros informados. Por favor, refine sua busca." (nome comum demais);
  3. `vazio` — "Não existem informações disponíveis para os parâmetros informados.";
  4. `bloqueado` — página com "captcha"/erro de acesso (resposta honesta, sem contornar).
- **Formato das linhas** (igual em TJAL e TJSP — medido): `divProcesso{codigo}` → `linkProcesso` (CNJ) · `tipoDeParticipacao` ("Autor:"/"Réu:") · `nomeParte` · `classeProcesso` · `assuntoPrincipalProcesso` · `dataLocalDistribuicaoProcesso` (data + local) · agrupamento por `foroDosProcessos` (h2) · total "NN Processos" · paginação `paginaConsulta`.
- **Fontes verificadas** (abertas, sem captcha, neste sandbox):
  | UF | base e-SAJ | prova |
  |----|-----------|-------|
  | AL | `https://www2.tjal.jus.br` | positivo "JOAO CARLOS DA SILVA" → **29 processos**; MUITOS; VAZIO; DOCPARTE VAZIO |
  | SP | `https://esaj.tjsp.jus.br` | positivo "JOAO CARLOS DA SILVA" → **19 processos** (mesma estrutura); VAZIO |
- **Não verificadas / bloqueadas** (declaradas; NÃO entram agora): TJGO (reCAPTCHA no form) · TJRS e TJCE (TLS encerrado por este sandbox — pendente) · TRF1 (página sem form utilizável) · demais UFs.
- CPF/CNPJ: canal `DOCPARTE` verificado (estado `vazio` real capturado). Não existe fonte pública que devolva o **nome** a partir do CPF (Receita exige captcha) — **fora de escopo declarado**; o CPF/CNPJ busca processos pelo documento nas fontes acima.

### 2.3 Fixtures reais capturadas (banco de testes — `apps/api/test/fixtures/esaj/`)
`tjal-nmparte-positivo.html` (29 proc/2 pág) · `tjal-nmparte-muitos.html` · `tjal-nmparte-vazio.html` · `tjal-docparte-vazio.html` · `tjsp-nmparte-joao.html` (19 proc) · `tjsp-nmparte-vazio.html`.

## 3. Contrato novo (adiciona; não modifica o existente)

### 3.1 Detecção do campo único — `apps/api/src/juridico/deteccao.ts` (novo)
`detectarConsulta(q)` → `{ tipo: "cnj" | "cpf" | "cnpj" | "nome", valor, formato?, advertencia? }`
- **CNJ**: 20 dígitos ou `NNNNNNN-DD.AAAA.J.TR.OOOO` com DV válido (Res. 65/2008 — `cnjDv` existente em `cnj.ts`). DV errado → 422 honesto ("dígitos verificadores não conferem").
- **CPF**: 11 dígitos com DVs válidos (módulo 11 real). Inválido → 422 (nunca busca CPF inválido).
- **CNPJ**: 14 dígitos com DVs válidos (módulo 11 real).
- **nome**: ≥3 letras; 1 palavra só → `advertencia: "informe nome e sobrenome para reduzir homônimos"` (busca prossegue — a fonte decide).
- Fora disso → 422: "informe nome, CPF/CNPJ ou número do processo".

### 3.2 Cliente e-SAJ — `apps/api/src/juridico/esaj.ts` (novo)
- `ESAJ_BASE = { al: www2.tjal.jus.br, sp: esaj.tjsp.jus.br }` (só verificadas; extensível por registro honesto).
- `consultarEsaj({ uf, tipo: "NMPARTE"|"DOCPARTE", valor, pagina, fetchImpl })` → `{ estado, total, pagina, ultimaPagina, itens: ProcessoTercero[] }` com timeout 45s, UA próprio, retry 1×.
- `parseResultadosEsaj(html, uf)` — classifica os 4 estados pelos textos literais medidos e extrai as linhas no formato da §2.2 (parser único para AL/SP — estrutura idêntica medida).
- `ProcessoTercero = { numeroProcesso, codigoInterno, uf, foro, classe, assunto, participacao, nomeParte, dataDistribuicao, localDistribuicao, fonte, url }`.
- Qualquer bloqueio/erro → estado honesto (`bloqueado`/`erro`), **nunca** resultado fabricado.

### 3.3 Orquestração — `apps/api/src/juridico/pesquisa.ts` (novo)
- `pesquisarTerceiros(q, { ufs, pagina, fetchImpl })` — roda as fontes (1 UF × 1 página por chamada) e agrega com os estados por fonte; homônimos sempre advertidos.
- `detalharProcessos(cnjs, { datajud })` — cruzamento REAL: cada CNJ achado → DataJud (status, classe, órgão, valor, último movimento); item sem dado → `status: "não informado"` honesto.

### 3.4 Rotas novas (`routes/processos.ts` — só adições; rotas atuais intactas)
- `GET /api/processos/pesquisar?q=&uf=&pagina=` → paywall `PLANS_WITH_JURIDICA` (igual à buscar atual) → `{ tipo, advertencia?, fontes: [{ uf, estado, total, ultimaPagina, itens }] }`.
  - `q` zod 3..120; `uf` = sigla ou "todas"; `pagina` 1..10; CNJ → 422 com dica "use a busca de processo"; CPF inválido → 422 honesto.
- `GET /api/processos/detalhes-lote?cnjs=a,b,…` (1..30) → paywall idem → `{ itens: [{ numeroProcesso, status, classe, orgaoJulgador, valorDaCausa, ultimoMovimento, dataAjuizamento }] }` via DataJud real.

### 3.5 UI — `JuridicoScreen` (só o bloco de busca) + `api2.ts` (só o bloco jurídico)
- Campo único "Nome, CPF ou número do processo" (substitui o campo "Número CNJ") + campo UF (mantido; "todas" possível na pesquisa profunda).
- Chip de detecção em tempo real ("parece: número do processo / CPF / CNPJ / nome") — servidor é a autoridade; chip é só leitura do formato.
- **[🔎 Buscar]**: CNJ → fluxo atual **intacto** (card/valor/status — nada muda); CPF/CNPJ/nome → lista de **processos de terceiros** (rápida: 1 página por fonte).
- **[🔬 Pesquisa profunda]** (nome/CPF/CNPJ): percorre **todas as fontes verificadas × todas as páginas** (até `ultimaPagina`, máx. 10) + **cruza cada CNJ com DataJud** (status/valor/último movimento por processo).
- **Barra de progresso determinada por etapas REAIS**: cada resposta HTTP concluída = 1 etapa (rótulo ex.: "TJAL — página 2 · etapa 3/5"); o total cresce quando a fonte revela mais páginas (progresso verdadeiro, recalculado); barra some no fim. Durante o primeiro fetch: etapa "consultando {fonte}…" já visível. Zero animação decorativa.
- Cards de terceiros: CNJ · participação + nome da parte · classe · assunto · foro/data · status (quando cruzado) · botão **"Abrir"** → preenche o campo com o CNJ e dispara o fluxo atual de card (reutilização, sem alterar nada).
- Rodapé honesto da lista: homônimos possíveis (confirmar por CPF/idade) · sigilosos não aparecem · cobertura AL/SP (demais UFs = portal do tribunal) · "conteúdo informativo, não é parecer jurídico".

## 4. Testes (prova — nada sem teste verde)

1. `deteccao.test.ts`: CPF/CNPJ/CNJ válidos e inválidos (DVs reais calculados), nome 1 palavra (advertência), lixo → 422.
2. `esaj.test.ts`: parser × as 6 fixtures REAIS — estados e contagens exatas (29/19 processos, MUITOS, VAZIO, DOCPARTE VAZIO), campos da 1ª linha (valores literais da fixture), páginas, bloqueio (HTML de contrato declarado).
3. `pesquisa.test.ts`: rotas (403 paywall · 422s honestos · 200 com fetch mockado pelas fixtures · CNJ → dica · detalhes-lote com Datajud mockado — inclui item sem dado = honesto).
4. Regressão: `tsc` api/web/shared = 0 e vitest completo verde (baseline 263/0/1).
5. Smoke ao vivo pós-deploy: nome real em AL e SP com itens reais; CPF aleatório → vazio honesto; barra/bundle novos no JS entregue; fluxo CNJ intacto.

## 5. Não será alterado (pedido expresso)

Acompanhar, Alertar, Explicar, Sincronizar, chat/assistente, timeline, `alertasAtivos`, worker/dispatcher, admin, pagamentos, OAB/consulta humana, bot Telegram, ops. Rotas `buscar/perguntar/alertar/sync` atuais mantêm contrato.

## 6. Fora de escopo (declarado)

- Resolver captcha (e-SAJ/TJGO) — não faremos.
- JusBrasil/Escavador/consultorias — paywall de terceiros.
- Descobrir nome/renda a partir de CPF (fontes públicas exigem captcha) — impossível sem alucinar.
- UFs não verificadas (demais tribunais): a UI diz honestamente "cobertura atual: AL e SP".
- Sigilo: processos sigilosos não aparecem nas consultas públicas — informado no rodapé.

## 7. Status final

(ver seção abaixo — implementado, testado e implantado em 24/10/2026)

---

## Status final (24/10/2026) — IMPLEMENTADO ✓

- Novos: `deteccao.ts` (DV CPF/CNPJ módulo 11 real + CNJ Res. 65), `esaj.ts` (cliente + parser 4 estados reais), `pesquisa.ts` (multi-UF + cruzamento DataJud). Rotas `GET /api/processos/pesquisar` e `GET /api/processos/detalhes-lote` (paywall idem). UI: campo único + chip de detecção + [🔎 Buscar][🔬 Pesquisa profunda] + barra de progresso por etapas reais + cards de processos de terceiros + rodapé honesto. Nada mais foi alterado.
- Testes: `deteccao.test.ts` 7/7 · `esaj.test.ts` 9/9 (fixtures reais: 29/19 processos, MUITOS, VAZIO, DOCPARTE VAZIO) · `pesquisa.test.ts` 6/6 (paywall/422s/estados/cruzamento). **Suíte completa 285 passed / 0 failed / 1 skipped**; `tsc` api/web/shared = 0.
- Deploy + smoke ao vivo (`tools/smoke-busca-live.py`) **14/14 ✓** em https://acompanhe.onrender.com (commit `e55aa8c`): nome real "João Carlos da Silva" → **44 processos de terceiros reais** (AL `resultados` + SP `resultados`; ex.: `0724866-89.2026.8.02.0001 · Autor · João Carlos dos Santos Silva · Procedimento Comum Cível`) · CPF sem registros → `vazio` honesto · CNJ → 422 com dica · CPF com DV errado → 422 · cruzamento DataJud real (`status=ativo · classe=Procedimento Comum Cível`) · fluxo CNJ intacto · bundle contém a UI nova (campo único/Pesquisa profunda/barra).
- Ajuste pós-smoke: alias `8.02=tjal` (e `8.26=tjsp`) verificados ao vivo no DataJud (`api_publica_tjal` 200+hits) — cruzamento AL/SP funcionando.
