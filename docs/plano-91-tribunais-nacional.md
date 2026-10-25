# Plano — consulta nacional no Jurídico (91 tribunais por nome, número e CPF)

**Data:** 25/10/2026 · **Escopo:** `apps/api/src/juridico/*`, rotas `/api/processos/*`, tela jurídica
**Regra desta casa:** nada aqui é estimado por analogia — cada linha marcada como "medido" tem `curl`/probe real
com data. O que não foi medido está marcado como **não verificado** e não entra na UI como se funcionasse.

---

## 1. A pergunta, respondida sem rodeio

> "O jurídico precisa consultar em todos os 91 tribunais por nome, número do processo e CPF."

- **Por número do processo: já é possível, nos 91.** DataJud/CNJ (API pública, dado oficial). É o que a tela já
  faz hoje. Nada a inventar aqui.
- **Por nome e por CPF, nos 91, de graça e sem captcha: NÃO existe hoje no Brasil.** Não é limitação do nosso
  código — é a topologia do Judiciário. Medido em 25/10/2026 (tabela §3): a busca por nome/CPF é feita
  **tribunal por tribunal**, em 5 famílias de sistema (e-SAJ, PJe, eproc, Projudi e portais próprios), e quase
  todas exigem **captcha** ou login gov.br.
- **A única fonte nacional por NOME é o DJEN/Comunica (CNJ)**, a API pública da Res. CNJ 455/2022, que aceita
  `nomeParte` e devolve `numero_processo` + `destinatarios` de **qualquer tribunal**. Medido: **HTTP 403
  (CloudFront) para IP fora do Brasil** — inclusive via leitor terceiro (r.jina.ai), o que confirma bloqueio
  por origem, não por host.

**Consequência de engenharia:** o caminho correto não é "raspar 91 sites". É
**(a)** usar DataJud para número (coberto),
**(b)** usar o DJEN como índice nacional de nome (implementado, com egress brasileiro configurável),
**(c)** manter coletores e-SAJ onde a consulta pública é aberta (medidos), e
**(d)** ser explícito na UI sobre o que cada fonte cobre — em vez de prometer 91 e entregar 4.

---

## 2. Pesquisa externa (fontes lidas em 25/10/2026)

| Fonte | O que foi confirmado |
|---|---|
| Swagger oficial CNJ/PCP 1.0.0 (`api.swaggerhub.com/apis/cnj/pcp/1.0.0`) | `GET /api/v1/comunicacao` com `nomeParte`, `numeroOab`, `ufOab`, `nomeAdvogado`, `numeroProcesso`, `dataDisponibilizacaoInicio/Fim`. Resposta: `items[].numero_processo`, `numeroprocessocommascara`, `siglaTribunal`, `data_disponibilizacao`, `tipoComunicacao`, `nomeOrgao`, `nomeClasse`, `texto`, `link`, `hash`, `destinatarios[{nome,polo}]`, `destinatarioadvogados[].advogado{numero_oab,uf_oab}`. Sem chave para leitura. |
| Portal CNJ — Comunicações Processuais | DJEN é o **diário nacional** (Res. 455/2022); portal `comunica.pje.jus.br`; API de produção `comunicaapi.pje.jus.br/api/v1`, homologação `hcomunicaapi.cnj.jus.br/api/v1`. |
| Docs/uso comunitário do DJEN (repo `explorador-djen`, `API_DJEN`, PR #370 de app jurídico) | Campos reais são snake_case (`numero_processo`, `numeroprocessocommascara`, `destinatarios` com `polo` "A"/"P"); paginação por `pagina`/`itensPorPagina`; **teto de 10.000 resultados**, corte silencioso; HTTP 429/500 acontecem e pedem retry. |
| Guias técnicos (chatjuridico/lexnode/nouslegal, 2026) | Geo-bloqueio para IP fora do Brasil, OAB gravada com sufixos diferentes por tribunal, cadernos publicados a partir das ~03:00. |
| Comparativos de plataformas 2026 (Judit, TrackJud, Sials) | Fragmentação em ≥5 famílias (PJe, e-SAJ, eproc, Projudi, portais próprios) e o custo real de manter scrapers: "equipe dedicada só reagindo a mudanças de captcha e layout". Reforça: não raspar 91 sites. |
| Portais de consulta (CNJ/PJe, TJMG, TJCE, TJPE, TJRR, TJMA, Projudi GO/PR, eproc SC/RS, e-SAJ CE/SP) | Todos exibem campos "Nome da Parte"/"CPF CNPJ" — e a maioria exige captcha; alguns escondem nomes de partes para não habilitados. |

---

## 3. Medições reais (probe HTTP, 25/10/2026, egress da sandbox/EUA)

`GET` sem credenciais, timeout 25 s, 12 threads. "campos" = o HTML/JSON contém os campos de busca/retorno.

| Endpoint | HTTP | ms | campos detectados | leitura |
|---|---|---|---|---|
| `comunicaapi.pje.jus.br/api/v1/comunicacao?nomeParte=…` | **403** | 295 | — | geo-bloqueio (idem via r.jina.ai) |
| `comunicaapi.pje.jus.br/api/v1/tribunal` | **403** | 42 | — | bloqueio por origem |
| `hcomunicaapi.cnj.jus.br` (homolog) | **403** | 311 | — | idem |
| `api-publica.datajud.cnj.jus.br` sem chave | 401 | 1010 | — | exige `APIKey` (nós já usamos com chave) |
| `esaj.tjsp.jus.br/cpopg/open.do` | **200** | 1075 | nomeParte, cpf, numeração | aberto, sem captcha |
| `esaj.tjac.jus.br` | **200** | 2613 | nomeParte, cpf, numeração | aberto |
| `esaj.tjce.jus.br` | TLS | 415 | — | TLS fecha p/ Python; Node alcança (já usamos em produção) |
| `esaj.tjms.jus.br` | 200 | 986 | — (portal diferente) | não é e-SAJ de consulta |
| `esaj.tjrn.jus.br` | **403** | 243 | — | WAF |
| `pje-consulta-publica.tjmg.jus.br` | 200 | 1146 | nomeParte, cpf, **captcha** | captcha → fora |
| `pje-consulta.tjce.jus.br`, `pje.cloud.tjpe.jus.br`, `pje.tjrr.jus.br`, `pje.tjma.jus.br` | 200 | ~1–2 s | nomeParte, cpf, **captcha** | captcha → fora |
| `pje.tjes.jus.br`, `pje.tjap.jus.br` | 403 | — | — | WAF/Cloudflare |
| `pje.tjdft.jus.br` | 404 | 769 | — | URL mudou |
| `eproc1g.tjsc.jus.br` | 200 | 2098 | cpf | consulta por CPF; nome exige chave |
| `projudi.tjgo.jus.br/BuscaProcesso` | 200 | 1070 | nomeParte, cpf, **captcha** | captcha → fora |
| `processo.stj.jus.br` | 200 | 491 | nomeParte, cpf, **captcha** | captcha → fora |
| `www3.tjrj.jus.br/consultaprocessual` | 200 | 1003 | — (SPA Angular) | precisa API interna; não verificado |

**Leitura honesta:** o que é automatizável sem burlar captcha, hoje, é **e-SAJ** (4 UFs verificadas em
produção: SP, AC, CE e AL pela base `www2.tjal.jus.br`) + **DJEN** (nacional, exige egress brasileiro) +
**índice próprio**. Todo o resto exigiria resolver captcha (fora de questão: viola termos de uso e é frágil).

---

## 4. Arquitetura entregue

```
                       ┌──────────────────────────── apps/web (Telegram, no Brasil) ─────────────┐
                       │  formulário único: nome · CPF/CNPJ · nº do processo                     │
                       └───────────────────────────────┬─────────────────────────────────────────┘
                                                       │ GET /api/processos/nacional
┌──────────────────────────────────────────────────────▼───────────────────────────────────────┐
│ juridico/nacional.ts — orquestrador (fan-out, timeout por fonte, circuit breaker, dedupe)     │
│   ├── indice próprio   (Postgres, sempre)                                                    │
│   ├── esaj.ts          (N UFs medidas; concorrência limitada; retry/backoff)                  │
│   └── djen.ts          (nacional por nomeParte; egress BR configurável; degradação honesta)   │
└──────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                       │ relatório por fonte (estado real + ms + motivo)
┌──────────────────────────────────────▼───────────────────────────────────────────────────────┐
│ juridico/frota.ts — matriz de cobertura: 91 tribunais × {número, nome, CPF} + estado medido   │
└──────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                       │ métricas por ciclo (canários reais)
┌──────────────────────────────────────▼───────────────────────────────────────────────────────┐
│ juridico/autoaperfeicoamento.ts — hill-climbing auditável + detecção de deriva + rollback     │
│   worker: ciclo a cada AUTO_HORAS (6 h), grava FonteMetrica/FontePerfil e opsEvent            │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 `djen.ts` — índice nacional por nome
- `buscarDjen({ nomeParte?, numeroProcesso?, siglaTribunal?, de?, ate?, pagina, limite })`
- `DJEN_BASE_URL` (default produção) e **`DJEN_RELAY_URL`**: qualquer proxy que faça a requisição sair do
  Brasil (`https://meu-relay-br/…{url}` — o adapter só prefixa). Sem relay e com 403 → estado
  `geo_bloqueado`, nunca erro genérico.
- Normaliza `numero_processo` para CNJ canônico (reusa `formatarNumero`), extrai partes de `destinatarios`,
  agrupa por processo (`agruparDjenPorProcesso`), truncando `texto` em 600 chars.
- Respeita teto de 10.000 resultados, `itensPorPagina` ≤ 50, retry 3× com backoff em 429/5xx, timeout.

### 4.2 `nacional.ts` — orquestrador
- `consultarNacional({ termo, tipo, uf?, limite })` → `{ itens, fontes[], aviso, rodape, cobertura }`.
- Concorrência limitada (`Promise.allSettled` + semáforo), **timeout por fonte**, circuit breaker por fonte
  (3 falhas seguidas = 10 min fora), dedupe por 20 dígitos, ranking por vínculo (documento > nome exato >
  coincidência parcial).
- Se todas as fontes de nome falharem, devolve `itens: []` **com o motivo de cada uma** — nunca lista vazia
  silenciosa.

### 4.3 `frota.ts` — matriz de cobertura (o que a UI mostra)
- 91 tribunais do DataJud × capacidades. `numero: true` para todos; `nome/cpf` só onde há coletor ativo,
  com `verificadoEm` e `limitacao`. `coberturaPorCapacidade()` gera o texto honesto da tela.

---

## 5. Auto-aperfeiçoamento recursivo (a "função" pedida)

Não é enfeite: é um laço fechado com medição real, decisão determinística e rollback.

**Estado:** por fonte, um perfil versionado
`PerfilFonte = { fonteId, timeoutMs, paginas, concorrencia, varianteNome (0=exato, 1=sem acento, 2=sobrenome+nome), usaRelay, versao }`.

**Medição (por ciclo):** para cada fonte ativa, roda **canários** (termos fixos que sabidamente devolvem > 0,
ex.: um nome presente nas fixtures) e registra
`Metrica = { consultas, itens, erros, captchas, timeouts, msP95, canarioItens }`.

**Pontuação (pura, testada):**
```
score = 100 * aproveitamento            # itens/consultas normalizado
      +  40 * confiabilidade            # 1 - erros/consultas
      -   0.05 * msP95/100              # penaliza lentidão
      -  80 * (captcha ? 1 : 0)         # captcha quase elimina a fonte
```
`aproveitamento` é normalizado pelo melhor resultado já visto da fonte (recall relativo), então o score é
comparável entre fontes.

**Mutação (recursiva e limitada):** gera vizinhos do perfil atual — `timeout ±250 ms` (piso 1 s, teto 30 s),
`paginas ±1` (1..10), `concorrencia ±1` (1..4), `varianteNome ±1` (0..2), `usaRelay` alternado. Determinístico
(ordem fixa de mutação) → mesma entrada, mesma decisão.

**Promoção com histerese:** só promove se `score(novo) ≥ score(atual) + ε` (ε = 3 pontos, ~3%). Empate
preserva o atual (evita oscilação). Cada promoção grava `FontePerfil` com `versao++`, `motivo`, métricas e
a decisão anterior — e `rollback(fonteId, versao)` restaura.

**Detecção de deriva (auto-correção):** se o canário devolve HTTP 200 com **0 itens** onde antes devolvia > 0
por `DRIFT_CICLOS` (2) ciclos seguidos → fonte marcada `deriva`, sai da rotação e entra `opsEvent
kind:"fonte_deriva"` (alerta no Telegram via dispatcher). Volta sozinha após 2 canários saudáveis.

**Proteções:** nenhuma mutação pode zerar `paginas`/`timeout`; limite de 1 ciclo por 6 h; ciclo inteiro com
deadline de 120 s; todas as decisões são funções puras testadas (sem `Math.random`, sem relógio implícito).

---

## 6. Rotas novas

| Rota | Auth | Para quê |
|---|---|---|
| `GET /api/processos/nacional?q=&tipo=&uf=` | usuário (+plano) | busca nacional orquestrada (nome/CPF/número) |
| `GET /api/processos/frota` | usuário | matriz de cobertura real (91 × capacidades) |
| `POST /api/processos/frota/probe` | `x-service-token` | roda probe HTTP real e grava métricas |
| `GET /api/processos/auto` | `x-service-token` | perfil vigente + histórico + últimas decisões |
| `POST /api/processos/auto/ciclo` | `x-service-token` | executa um ciclo agora (idempotente por janela) |

## 7. Critérios de aceite

1. Busca por **número** continua funcionando nos 91 tribunais (não regride).
2. Busca por **nome/CPF** devolve, no mínimo: índice próprio + todas as UFs e-SAJ medidas, com estado por fonte.
3. DJEN implementado de ponta a ponta com contrato do swagger oficial; se 403, a UI diz **"bloqueado por
   origem (precisa egress brasileiro)"** — não "sem resultados".
4. `GET /frota` lista os 91 tribunais e marca nome/CPF apenas onde há coletor real.
5. Auto-aperfeiçoamento: ciclo roda, grava perfil versionado, promove só com ganho ≥ 3%, detecta deriva com
   canário zerado, e faz rollback. Testes cobrem promoção, não-promoção, deriva, rollback e limites.
6. Nenhuma dependência de captcha em qualquer caminho.
7. Suíte completa verde (baseline 356 + novos) e smoke real em produção.

## 8. Riscos e limites declarados

| Risco | Tratamento |
|---|---|
| Captcha em PJe/eproc/Projudi/STJ | **não burlamos**. Fica catalogado como `captcha` na matriz e a UI oferece o link oficial. |
| DJEN geo-bloqueado | `DJEN_RELAY_URL` (egress BR) + estado honesto; medido e registrado a cada probe. |
| Mudança de layout e-SAJ | fixtures + detecção de deriva do §5 (canário) → alerta antes de o usuário perceber. |
| Termos de uso/LGPD | consulta pública, 1 req/UF por busca, sem burlar barreira, sem armazenar CPF em claro (`documentoHash`). |
| Bloqueio por volume | semáforo (máx. 4 req concorrentes), backoff, cache de 10 min por termo. |

---

## 9. Implementação e verificação (25/10/2026 ~03h50, ambiente local real)

Tudo abaixo foi **executado**, não projetado. Comandos e saídas reais.

### 9.1 Arquivos entregues

| Arquivo | Papel |
|---|---|
| `apps/api/src/juridico/djen.ts` | adapter DJEN/Comunica (contrato do swagger oficial `cnj/pcp 1.0.0`) |
| `apps/api/src/juridico/frota.ts` | matriz 91 × {número, nome, CPF} + sistemas por UF + `semColetorNome` |
| `apps/api/src/juridico/nacional.ts` | orquestrador (índice + e-SAJ + DJEN), estados honestos, dedupe, retry |
| `apps/api/src/juridico/autoaperfeicoamento.ts` | pontuação, mutações, `decidir` (ε=3), `DetectorDeriva`, store+rollback |
| `apps/api/src/juridico/probe.ts` | medição REAL dos canários (HTTP de verdade) |
| `apps/api/src/jobs/autoaperfeicoamento.ts` | ciclo agendável (AUTO_HORAS, default 6h), não empilha |
| `apps/api/src/routes/processos.ts` | `GET /frota`, `GET /nacional`, `POST /frota/probe`, `GET /auto`, `POST /auto/ciclo` |
| `apps/web/src/api2.ts` + `juridico/logica.ts` + `JuridicoScreen.tsx` | busca nacional na tela, relatório de fontes visível, cobertura real |

### 9.2 Medições do ciclo real (`POST /api/processos/auto/ciclo`, termo "João Carlos")

```
ok True  msTotal 4138
  djen      itens=  0 erros=1 ms=116     ← 403 geo-bloqueado (contado como FALHA)
  esaj-sp   itens=  0 erros=0 ms=881
  esaj-al   itens= 25 erros=0 ms=899
  esaj-ac   itens= 12 erros=0 ms=1393
  esaj-ce   itens=  0 erros=0 ms=847
  decisões: todas "manter" (empate → histerese ε=3 preserva o perfil)
  derivas: []   nuncaFuncionaram: []
```

### 9.3 Busca nacional ao vivo (usuário real, plano jurídica)

```
NACIONAL(nome "João Carlos")   200  926ms  itens: 37
   indice  vazio  | esaj-al ok 25 | esaj-sp ok 0 | esaj-ac ok 12 | esaj-ce ok 0 | djen pulado (403 medido)
NACIONAL(CPF 529.982.247-25)   200  872ms  itens: 0 (vazio é vazio — não inventamos)
NACIONAL(nº 0006903-69.2014...) 200    6ms  itens: 1 (índice próprio)
FROTA 200 — 91 tribunais; número 91/91; nome/CPF 4 (e-SAJ aberto); djen false; 87 sem coletor por nome
```

### 9.4 Bugs reais encontrados pelos testes (e corrigidos)

1. `decidir()` propagava exceção do `medir` → um vizinho com DNS quebrado derrubava o ciclo. Agora vira candidato de score mínimo + motivo "todas as medições falharam".
2. `classificarVinculo()` devolvia **0.3 "coincidência parcial"** quando NENHUM termo do nome aparecia — isso fazia processo errado subir na lista. Agora **0 + "nenhum vínculo identificado"**.
3. Merge de fontes atualizava `score` antes de comparar, então `motivoVinculo` nunca acompanhava o melhor score.
4. DJEN geo-bloqueado contava `erros=0` (pontuação de confiabilidade 40/40 para fonte que não respondeu). Agora bloqueio = falha (score −0.06 no ciclo real).
5. Rotas não recebiam `nacional`/`perfis` injetados no `buildApp` → teste HTTP caía na rede real.
6. **e-SAJ responde "erro" de forma intermitente** (medido: mesma UF alterna vazio/erro em ~200 ms). Retry 3× com backoff 300/900 ms → 3/3 consultas limpas depois da correção; bloqueio e vazio NÃO são repetidos.

### 9.5 Verificação

- `tsc` limpo (API e web).
- Suíte API: **428 passando** (era 356) — 72 testes novos em `djen`, `nacional`, `autoaperfeicoamento`, `autoaperfeicoamento-job`, `nacional-rotas`.
- Suíte web: **17 passando** (era 13).
- E2E Playwright 390×844: `RESULTADOS {itens: 37, foot: "37 processo(s) · E-SAJ AL, E-SAJ AC"}`, `details: 0`, `aria-expanded: 0`, `PLACEHOLDER cabe: true`.

### 9.6 Limite que permanece declarado (não maquiado)

Busca por **nome/CPF** em 91/91 exige o DJEN, e o DJEN responde **403 fora do Brasil** (medido 4×, inclusive via `r.jina.ai`). O código já suporta `DJEN_RELAY_URL` (egress BR) e a fonte aparece como `pulado` com o motivo, nunca como "nenhum resultado". Sem esse relay, cobertura real por nome é **4 UFs** (e-SAJ aberto) + índice próprio.

### 9.7 Produção (`https://acompanhe.onrender.com`, deploy `697148f`, 25/10 03h56)

```
1) login: 200 (184ms)
3) /frota: 200 | 91 tribunais | nome cobertos: 4 | djen: false
4) /nacional "João Carlos": 200 (1005ms) | 37 itens
     indice vazio | esaj-al ok 25 | esaj-sp refinar | esaj-ac ok 12 | esaj-ce refinar | djen pulado
5) /nacional nº 0006903-69.2014.8.11.0037: 200 | tipo cnj | 1 item
6) /auto: 200 | 5 perfis | ε=3
7) /auto/ciclo: 200 (1901ms) | ok | al 25 itens, ac 12, djen erros=1 (403)
   termo curto "José": 0 itens + aviso "e-SAJ AL, e-SAJ SP, e-SAJ AC, e-SAJ CE responderam
   'muitos processos' — refine a busca (nome completo, CPF ou nº do processo)"
E2E produção 390×844: RESULTADOS {itens: 37, foot: "37 processo(s) · E-SAJ AL, E-SAJ AC"},
   details: 0, aria-expanded: 0, PLACEHOLDER cabe: true
```

### 9.8 O que continua faltando para 91/91 por nome (dito sem rodeio)

1. **DJEN exige egress brasileiro** (`DJEN_RELAY_URL`). Com ele, nome/CPF passam de 4 UFs para 91.
2. **Captcha** nos portais PJe/Projudi/STJ: não burlamos — oferecemos o portal oficial.
3. **e-SAJ com termo curto** responde "muitos processos": o produto agora pede refinamento em vez de mentir "0 resultados".
4. **Auto-aperfeiçoamento** hoje otimiza parâmetros por fonte com canário. Próximo passo natural (não implementado, para não prometer): variantes de URL/seletor por família (e-SAJ/PJe) e promoção automática de canário novo quando a deriva é detectada.

---

## 10. Ciclo fechado do auto-aperfeiçoamento (25/10 ~04h15)

A pergunta "o auto-aperfeiçoamento está no app completo?" expôs 4 furos reais. Todos corrigidos e testados.

### 10.1 O que estava errado (medido no código, não suposto)

| # | Furo | Consequência |
|---|---|---|
| 1 | job passava `decidir(vigente, m, async () => m)` | **nunca avaliava vizinhos → nunca promovia nada**. O ciclo era decorativo. |
| 2 | job criava `new InMemoryPerfilStore()` e as rotas outro | o que o ciclo aprendia nunca aparecia em `GET /auto` |
| 3 | `consultarNacional` usava timeout/páginas fixos | o perfil aprendido **não era aplicado** na busca |
| 4 | `perfis` em memória | restart/deploy apagava todo aprendizado |

### 10.2 O que existe agora

- **`probe.ts` mede com o perfil candidato aplicado** (timeout, variante de nome, relay). `medirFonte(fonte, termo, agora, perfil)`.
- **Job avalia de verdade**: `medirCandidato` por vizinho, `maxAvaliacoes=3`, prazo `AUTO_PRAZO_MS` (120 s), e **só otimiza fonte saudável** (ciclo caiu de **90 s → 6 s**; fonte bloqueada não consome requisições).
- **Um store só**: `PerfilStoreResiliente(PrismaPerfilStore)` no `buildApp`, injetado nas rotas **e** no job. Tabelas `FontePerfil` e `FonteMetrica` (o `deploy/start.sh` já roda `prisma db push`).
- **Busca aplica o perfil**: `variarNome()` (0 exato, 1 sem acento, 2 sobrenome+primeiro), timeout por fonte, concorrência do fan-out, relay on/off no DJEN. O relatório devolve `perfilVersao` e a UI mostra "coleta v3".
- **Degradação**: tabela ausente/banco fora → cai para memória, avisa **uma vez** no log, e `GET /auto` responde 200 (antes dava **500 P2021**).
- **Métrica por ciclo** gravada em `FonteMetrica` (10 linhas após 2 ciclos reais).

### 10.3 Prova ao vivo (banco local + Postgres real)

```
POST /auto/ciclo → ok, 6.0 s
  djen     manter  -0.08   · fonte não respondeu neste ciclo — nada a otimizar
  esaj-sp  manter   39.56  · respondeu sem itens — nada a otimizar
  esaj-al  manter  -0.74   · não respondeu
  esaj-ac  manter  139.26  · melhor vizinho (139.77) não supera o atual + ε=3
  esaj-ce  manter   39.47
FonteMetrica: 10 linhas
perfil esaj-ac v3 inserido no Postgres (timeout 5 s, concorrência 1, variante 1)
GET /nacional?uf=ac → fontes[esaj-ac].perfilVersao = 3   ← a busca USOU o perfil do banco
```

"manter" aqui é o resultado **correto** (empate dentro de ε); o que os testes provam é que, quando existe ganho real, ele promove e grava v2 — ver `test/ciclo-fechado.test.ts` e `test/autoaperfeicoamento-job.test.ts`.

### 10.4 Testes

`447 API` + `18 web` (eram 442/17). Novos: `ciclo-fechado.test.ts` (12) cobrindo aplicação do perfil, store compartilhado, Prisma (salvar/vigente/histórico/rollback/métrica/dado sujo) e resiliência; job (12) cobrindo promoção real, custo do ciclo, prazo e deriva.
