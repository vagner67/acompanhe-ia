# plano.md — Auto-aperfeiçoamento em TODO o app (não só no Jurídico)

> Auditoria feita no código em 25/10/2026, com `grep`/leitura de arquivo. Cada afirmação abaixo tem
> caminho e linha. Nada aqui é estimado por memória: os números saíram do repositório.

---

## 0. Resposta direta

**Não. O auto-aperfeiçoamento cobre hoje 1 de 8 módulos do produto e 5 das ~50 fontes externas do app.**

| Dimensão | Total no app | Coberto pelo motor | % |
|---|---|---|---|
| Módulos de produto | 8 (Início, Licitações, Jurídico, Concursos, AnotA, Empréstimos, Investiga, Planos/Admin) | 1 (Jurídico) | 12,5% |
| Fontes externas (hosts distintos) | 50 | 5 (`djen`, `esaj-sp/al/ac/ce`) | 10% |
| Tribunais por número (DataJud) | 91 | **0** (nem o DataJud entra no motor) | 0% |
| Fontes de OSINT | 12 (`osint/sources.ts`) | 0 | 0% |
| Coletores com métrica persistida | 17 call sites de rede | 5 (`FonteMetrica`) | ~29% |
| Coletores com detecção de deriva | 17 | 5 (e **não dispara** em produção — §2/G4) | 0% efetivo |
| Coletores com auto-ajuste de parâmetro | 17 | 5 (aplicado de fato: §10 do plano do jurídico) | ~29% |

Prova de que o motor é exclusivo do Jurídico:

```
apps/api/src/juridico/autoaperfeicoamento.ts   ← motor
apps/api/src/juridico/perfil-prisma.ts         ← persistência
apps/api/src/jobs/autoaperfeicoamento.ts       ← agendador (FONTES_PADRAO = djen + 4 e-SAJ, linha 21)
consumidores: server.ts:301 · routes/processos.ts:353 · juridico/nacional.ts · juridico/probe.ts
fora do jurídico: NENHUM (zero ocorrências em licitacoes/, concursos/, osint/, minhas/, payments/)
```

---

## 1. Auditoria verificável (o que existe em cada módulo HOJE)

Legenda: ✅ existe · ⚠️ parcial · ❌ não existe

| Módulo | Coletor | Arquivo | Retry | Métrica | Deriva | Auto-ajuste | Coleta agendada |
|---|---|---|---|---|---|---|---|
| Jurídico | DataJud (91 tribunais) | `juridico/datajud.ts` | ⚠️ 1 match | ❌ | ❌ | ❌ | por requisição |
| Jurídico | e-SAJ (4 UFs) | `juridico/esaj.ts` + `nacional.ts` | ✅ (3× backoff 300/900 ms) | ✅ | ⚠️ só na rota | ✅ | por requisição |
| Jurídico | DJEN/Comunica | `juridico/djen.ts` | ✅ (retries 429/5xx, 403 sem retry) | ✅ | ⚠️ | ✅ | por requisição |
| Jurídico | Busca web (DDG, Wikipedia) | `juridico/buscaWeb.ts` | ⚠️ 1 match | ❌ | ❌ | ❌ | por requisição |
| Jurídico | Busca IA (tavily/perplexity/gemini) | `juridico/buscaIA.ts` | ❌ fallback sem medição | ❌ | ❌ | ❌ | por requisição |
| Jurídico | Tabela de movimentos CNJ | `juridico/tabela-movimentos.ts` | ❌ | ❌ | ❌ | ❌ | ❌ |
| Licitações | PNCP consulta + search | `licitacoes/pncp.ts` | ✅ **melhor do app** (attempts, backoff 400·2ⁿ, jitter, `Retry-After`) | ❌ | ❌ | ❌ | ❌ (só request) |
| Concursos | DOU / in.gov.br | `concursos/dou.ts` | ⚠️ attempts=3, backoff simples | ❌ | ❌ | ❌ | ❌ (rota `ingestEdicao`) |
| Investiga | 12 fontes (Sherlock, HIBP, Gravatar, RDAP, DNS, crt.sh, Wayback…) | `osint/{sherlock,email,domain,phone}.ts` | ❌ **0 retry em `domain.ts` e `email.ts`** | ❌ | ❌ | ❌ | ❌ |
| AnotA | OCR externo | `minhas/ocr.ts` | ❌ | ❌ | ❌ | ❌ | por requisição |
| Empréstimos | — (cálculo interno, sem rede) | `emprestimos/*` | n/a | n/a | n/a | n/a | n/a |
| Pagamentos | PushinPay | `payments/pushinpay.ts` | ✅ 4 matches | ❌ | ❌ | ❌ | n/a (webhook) |
| Operação | Telegram (entrega) | `worker.ts` + `jobs/runner.ts` | ✅ política 429/403 | ✅ `OpsEvent` | ❌ | ❌ | ✅ loop 30 s |
| Operação | Processos do sistema (api/web/bot/tunnel/worker) | `ops/store.ts` | n/a | ✅ `ServiceProbe` | ❌ | ❌ | via keep-alive |

Telemetria já existente e **subaproveitada**:
- `ServiceProbe` (schema + `ops/store.ts:76`) mede **processos**, não fontes.
- `OpsEvent` é escrito só pelo worker (`worker.ts:119,122,173,182`).
- `SyncRun` existe no schema e **não tem escritor** — o próprio código admite:
  `routes/ops.ts:245` → *"SyncRun sem escritor: não existe ingestão agendada no código (scheduler externo) — tabela real vazia"*.

---

## 2. Lacunas estruturais (por que não cobre o app)

**G1 — Motor acoplado ao Jurídico.** `Metrica`/`PerfilFonte` têm campos de e-SAJ/DJEN; `probe.ts` importa `esaj` e `djen`. Para ligar PNCP seria preciso copiar o motor.

**G2 — Três catálogos de fontes, nenhum unificado.** `juridico/fontes.ts` (`FONTES_INFO`), `osint/sources.ts` (12 fontes), `juridico/frota.ts` (91 tribunais). Não existe um registro único: adicionar fonte em um lugar não a torna visível ao motor.

**G3 — Telemetria por fonte não existe fora do Jurídico.** `FonteMetrica` só recebe as 5 fontes jurídicas. PNCP, DOU, OSINT, OCR, PushinPay não deixam rastro medível: quando quebram, ninguém sabe até o usuário reclamar.

**G4 — 🐞 BUG: a detecção de deriva nunca dispara em produção.** `jobs/autoaperfeicoamento.ts:65` faz
`const detector = opts.detector ?? new DetectorDeriva()`. O agendador (`iniciarAutoAperfeiçoamento`) **não passa** detector → cada ciclo nasce com histórico vazio → `deriva()` exige ≥3 registros + canário já positivo → **sempre `false`**. Só a rota HTTP passa um detector de módulo (`routes/processos.ts`), e mesmo esse vive em memória (some no restart). Correção: detector único no agendador + persistência em `ColetorDeriva`.

**G5 — Não há coleta contínua para aperfeiçoar.** Licitações e Concursos só buscam quando o usuário pede (`routes/concursos.ts:109`, `licitacoes/service.ts:288`). Sem ingestão agendada, não existe série temporal para o motor otimizar — o "auto-aperfeiçoamento" ficaria medindo o vazio.

---

## 3. Arquitetura proposta — NCA (Núcleo de Coletores Auto-Aperfeiçoável)

Objetivo: **um** motor, **n** coletores, mesma garantia em todo o app (medir → decidir → aplicar → detectar deriva → reverter).

### 3.1 Contrato único (`apps/api/src/nucleo/coletor.ts`)

```ts
export interface Coletor<P = Record<string, unknown>> {
  id: string;                        // "pncp-contratacoes", "esaj-sp", "osint-crtsh"
  modulo: "juridico" | "licitacoes" | "concursos" | "investiga" | "anota" | "pagamentos" | "operacao";
  host: string;
  familia: "api-json" | "html" | "sparql" | "rss" | "sdk";
  /** executa com os parâmetros dados e devolve métrica + amostra */
  executar(params: P, ctx: CtxColeta): Promise<ResultadoColeta>;
  /** parâmetros ajustáveis + limites duros (nada de otimizar o que é fixo por contrato) */
  espaco: EspacoParametros<P>;
  /** consultas de controle conhecidas-boa (detectam deriva de contrato/parser) */
  canarios: Canario<P>[];
  /** orçamento: requisições/minuto, requisições/dia e concorrência máxima */
  orcamento: { rpm: number; rpd: number; concorrencia: number };
  /** o que conta como "quebrou": 200 com 0 itens, HTML sem o seletor, JSON sem o campo */
  sinalQuebra(resultado: ResultadoColeta): boolean;
}
```

`ResultadoColeta` é genérico: `{ itens, ms, http, erros, captcha, parcial, amostra }`. Nada de tipo específico de tribunal.

### 3.2 Registro único (`apps/api/src/nucleo/registro.ts`)

Todos os coletores registrados num só lugar. `FONTES_INFO`, `osint/sources.ts` e `frota.ts` passam a **derivar** do registro (sem quebrar as rotas atuais — adaptadores finos). Um teste de arquitetura falha se aparecer fonte fora do registro (padrão já usado em `test/architecture.test.ts`).

### 3.3 Persistência (migrar o padrão que já funciona)

| Tabela | Campos | Para quê |
|---|---|---|
| `ColetorPerfil` | coletorId, versao, params JSON, score, motivo, criadoEm | parâmetros vigentes + histórico (rollback) |
| `ColetorMetrica` | coletorId, ts, itens, erros, captcha, msP95, custo, score | série temporal (base do auto-ajuste) |
| `ColetorDeriva` | coletorId, canarioId, ultimoOk, ciclosZerados, estado | deriva **persistida** entre restarts |
| `ColetorIncidente` | coletorId, tipo, inicio, fim, detalhe | quarentena e MTTR |

Reaproveita `FontePerfil`/`FonteMetrica` já em produção (rename compatível com view/alias).

### 3.4 Motor genérico (`apps/api/src/nucleo/otimizador.ts`)

Extrair o que já valida no jurídico e parametrizar:
- *hill-climbing determinístico* com histerese ε=3 (igual ao atual);
- espaço de busca **vem do coletor** (PNCP: `tamanhoPagina`, `attempts`, `janelaDias`; DOU: `secao`, `attempts`; e-SAJ: `timeoutMs`, `varianteNome`; OSINT: `timeout`, `profundidade`);
- **canary release**: candidato recebe 10% das execuções por N=20 coletas antes de virar vigente;
- **rollback automático** se erro/p95 piorarem > 20% em 24 h;
- orçamento global verificado **antes** de cada mutação (nunca otimizar acelerando bloqueio).

### 3.5 Políticas de execução obrigatórias

- retry só para 429/5xx/timeout, com `Retry-After` + backoff exponencial + jitter (padrão do `pncp.ts` virando base comum);
- **circuit breaker** por coletor (5 falhas seguidas → 15 min de quarentena, estado exposto na API);
- timeout adaptativo: `p95 × 2` da própria série, com piso e teto por coletor;
- **kill-switch** por coletor (`ColetorPerfil` desativado) e global (`AUTO_HABILITADO=0` já existe para o jurídico).

### 3.6 Scheduler único (`apps/api/src/jobs/coleta.ts`)

Substitui o "scheduler externo" inexistente citado em `routes/ops.ts:245`:
- fila de prioridade por módulo, deadline global (padrão 120 s, como hoje);
- **escreve `SyncRun`** a cada execução (encerra a tabela sem escritor) e `ServiceProbe` por coletor;
- `OpsEvent` para deriva, quarentena, promoção e rollback;
- nunca roda dois ciclos do mesmo coletor em paralelo (padrão já aplicado no jurídico).

### 3.7 UI do operador (Admin)
Uma aba **"Fontes"**: por coletor → estado (ok/deriva/quarentena), p95, taxa de erro, versão do perfil, motivo da última decisão e botão de **rollback**. Sem sanfona/chevron (respeitando a restrição de UI já estabelecida).

---

## 4. Fases, critérios de aceite e testes

> Regra de aprovação igual à do jurídico: **nada é dado por pronto sem teste real + smoke em produção.**

### F0 — Fundação (bloqueia todo o resto)
Escopo: contrato, registro, persistência, motor genérico, scheduler; migrar as 5 fontes do jurídico **sem regressão**; corrigir G4.
**Aceite**
- [ ] `npm test` ≥ 447 API / 18 web, sem teste removido;
- [ ] jurídico continua promovendo/não promovendo igual (mesma decisão para o mesmo insumo);
- [ ] deriva dispara no **agendador real** em teste de 2 ciclos (hoje impossível);
- [ ] `SyncRun` com escritor e linha real no painel ops;
- [ ] restart não perde deriva nem perfil (teste de persistência como o da §10.6).
**Testes**: paridade motor antigo×novo (mesmo score para mesma métrica), deriva persistida, orçamento bloqueando mutação, circuit breaker.

### F1 — Jurídico completo
Escopo: DataJud (91) + buscaWeb + buscaIA + ingestão do índice entram no motor (hoje só e-SAJ/DJEN).
**Aceite**
- [ ] 100% das fontes jurídicas com métrica, canário e deriva (hoje 5 de 9);
- [ ] DataJud com p95 e taxa de erro por tribunal visíveis;
- [ ] buscaIA escolhe provedor por **custo/qualidade medidos** (não por ordem do `if`);
- [ ] nenhuma fonte sem classificação de estado na API.

### F2 — Licitações + Concursos
Escopo: PNCP e DOU como coletores + **ingestão agendada** (a cada 30 min, com orçamento).
**Aceite**
- [ ] coleta contínua por 24 h com erro < 2% e 0 bloqueio por 429;
- [ ] janelas de data ajustadas automaticamente (não perder edital por janela curta);
- [ ] `SyncRun` populado por módulo; painel mostra itens novos/hora;
- [ ] deriva detecta mudança de contrato do PNCP (canário com `dataInicial` fixa).

### F3 — Investiga (12 fontes OSINT)
Escopo: métrica + retry + circuit breaker por fonte (hoje `domain.ts`/`email.ts` têm **0 retry**).
**Aceite**
- [ ] dossiê nunca falha inteiro por uma fonte fora (já é o desenho; agora medido);
- [ ] cada fonte com estado explícito (`ok`/`bloqueada`/`sem credencial`) na resposta;
- [ ] HIBP sem chave declarado como "não configurado", nunca como "nada encontrado".

### F4 — AnotA (OCR) e Busca
Escopo: OCR e provedores de busca no motor (custo por página, tempo, taxa de acerto).
**Aceite**: fallback medido, timeout adaptativo, nenhum 500 por provider lento.

### F5 — Pagamentos e Telegram (com aprovação humana)
Escopo: saúde + retry do webhook e da entrega no motor, **sem** auto-ajuste de valores/preços.
**Aceite**: MTTR de webhook < 5 min; nenhuma mutação de parâmetro que afete dinheiro sem aprovação explícita registrada em `ColetorIncidente`.

### F6 — UI do operador "Fontes"
**Aceite**: 1 tela, 1 linha por coletor, rollback em 1 toque, zero sanfona.

---

## 5. Correções que independem do plano (fazer já)

| # | Onde | O quê | Risco |
|---|---|---|---|
| P0 | `jobs/autoaperfeicoamento.ts:65` | criar **um** `DetectorDeriva` no agendador e reutilizar entre ciclos | deriva é pré-requisito de tudo; hoje é código morto em produção |
| P0 | `nucleo/…` (novo) | persistir deriva (`ColetorDeriva`) | sem isso, restart apaga o histórico (mesmo com o fix acima) |
| P1 | `osint/domain.ts`, `osint/email.ts` | retry/backoff mínimo | 3 fontes falham por soluço de rede |
| P1 | `routes/ops.ts:245` | criar escritor de `SyncRun` | métrica de ingestão hoje é inexistente |

---

## 6. Riscos e limites honestos

- **Não burlar captcha** (PJe, Projudi, STJ) — o motor otimiza parâmetro, não fraude. Fonte com captcha fica declarada e aponta o portal oficial.
- **Rate limit é o teto real**: o auto-ajuste pode *piorar* a vida se aumentar concorrência cegamente. Por isso o orçamento é limite duro, não sugestão.
- **LGPD**: CPF só entra como hash nas tabelas de índice (`ParteIndice.documentoHash`); o motor nunca persiste termo de busca cru com CPF.
- **Custo de IA**: tavily/perplexity/gemini têm cota; promover provedor "por velocidade" pode estourar a cota — decisão de promoção precisa incluir custo.
- **Não prometer 91/91 por nome** enquanto o DJEN exigir egress brasileiro (medido: 403 fora do BR). Isso é infraestrutura, não auto-aperfeiçoamento.

---

## 7. Como saberemos que funcionou (métricas do próprio sistema)

1. **Cobertura**: % de coletores com métrica + canário + deriva → meta 100% em F0–F3.
2. **MTTR de deriva**: tempo entre 1ª coleta zerada e alerta no ops → meta < 12 h.
3. **Promoções revertidas**: < 10% (se passar disso, o ε está frouxo ou a métrica é ruidosa).
4. **Coleta contínua**: horas sem gap por módulo → meta 24/7 em F2.
5. **Ruído**: nº de alertas de ops por semana que exigem ação → deve cair com o tempo (auto-correção absorvendo o trivial).

---

## 8. Ordem de execução sugerida

1. **F0** (fundação + P0) — pré-requisito de honestidade: sem isso, "auto-aperfeiçoamento no app" é só no jurídico.
2. **F2** (licitações/concursos) — onde há mais valor imediato: hoje **não há coleta contínua**, então o app depende do usuário pedir.
3. **F1** (fechar o jurídico: DataJud e buscaIA no motor).
4. **F3** (OSINT) — maior superfície de falha silenciosa hoje.
5. **F4/F5/F6**.

Cada fase entra com teste, smoke em produção e atualização deste plano — no mesmo padrão da §9/§10 do `docs/plano-91-tribunais-nacional.md`.

---

## 9. Estado da implementação (25/10/2026) — o que está no código, medido

Esta seção é o oposto de promessa: cada item abaixo aponta o arquivo que existe
e o número que foi medido rodando o ciclo contra a fonte real.

### 9.1 Arquivos entregues

| Arquivo | Papel |
|---|---|
| `apps/api/src/nucleo/tipos.ts` | contrato único de coletor (`Coletor`, `ResultadoColeta`, `ParamSpec`, `CtxColeta`, helpers) |
| `apps/api/src/nucleo/registro.ts` | **12 coletores** reais cobrindo 4 módulos: 4 e-SAJ, DJEN, DataJud, PNCP, DOU, RDAP, crt.sh, Wayback, HIBP |
| `apps/api/src/nucleo/store.ts` | estado versionado + métricas + trilha de ações (Prisma durável e memória resiliente) |
| `apps/api/src/nucleo/ia-diagnostico.ts` | IA de buscador interpretando o erro + validação do que ela pode mudar |
| `apps/api/src/nucleo/otimizador.ts` | ciclo: mede → diagnostica → canário → promove/reverte/desliga |
| `apps/api/src/nucleo/incidentes.ts` | disjuntor por assinatura de falha (captcha, bloqueio, timeout, contrato, credencial, refino) |
| `apps/api/src/nucleo/pontuar.ts` | score + histerese ε=3 |
| `apps/api/src/nucleo/ponte-juridico.ts` | o que o NCA promove no e-SAJ/DJEN chega no perfil que a busca do usuário lê |
| `apps/api/src/nucleo/syncrun.ts` | escritor do `SyncRun` — a tabela que estava sem escritor |
| `apps/api/src/jobs/coleta.ts` | coleta contínua de todos os coletores, com concorrência 3 e prazo duro |
| `apps/api/src/routes/nucleo.ts` | `/v1/admin/nucleo/{catalogo,estado,ciclo,coletor/:id,...}` |
| `apps/web/src/screens.tsx` | aba **Fontes** no painel de operações (ver, rodar ciclo, reativar) |

### 9.2 P0 corrigido

`jobs/autoaperfeicoamento.ts`: o `DetectorDeriva` agora é criado **uma vez** no
agendador e passado a cada ciclo. Teste `nucleo.test.ts` roda três ciclos com
relógio falso e exige o evento `auto.deriva` — antes ele nunca aparecia.

### 9.3 Medições reais do primeiro dia (rede + Postgres de verdade)

| Coletor | Resultado medido | Score |
|---|---|---|
| `pncp-contratacoes` | HTTP 200, **50 itens** | 139,4 |
| `osint-crtsh` | HTTP 200, **81 certificados** | 139,6 |
| `osint-wayback` | HTTP 200, 1 snapshot | 59,9 |
| `osint-rdap` | HTTP 200, 1 registro (após UA identificado) | 59,9 |
| `datajud` | timeout em 15 s → **promovido para 30 s** e passou a responder | 46,5 na v2 |
| `esaj-sp` | HTTP 200 pedindo termo mais específico → diagnóstico `refinar`, ajuste **rejeitado no canário** (não houve ganho medido) | — |
| `djen` | HTTP 403 (geo-bloqueio do sandbox) → recuo, sem martelar | — |
| `dou-busca` | HTTP 502 do in.gov.br → recuo exponencial | — |
| `osint-hibp` | desativado no 1º ciclo: falta `HIBP_API_KEY` | 0 |

Achados que viraram correção de código neste mesmo dia:
- `rdap.org` e `crt.sh` devolvem 403/502 para `user-agent` vazio → passamos a enviar UA identificado (ganho de 0 → 82 itens).
- `HIBP` sem chave era classificado como *timeout* → agora é `credencial`, desliga na primeira falta e diz o motivo.
- e-SAJ com termo amplo devolvia 200 sem lista e era lido como "contrato quebrado" → agora é `refinar` e a correção proposta é trocar a variante do termo, medida antes de aplicar.
- ciclo sequencial gastava 190 s em um host lento → concorrência 3 + timeout por coletor: **1,5 s** no mesmo conjunto.

### 9.4 O que a IA de buscador NÃO faz

- Não aplica nada sem canário: toda proposta passa por medição e ε=3.
- Não mexe em parâmetro fora do `espaco` do coletor — a validação descarta e registra o motivo.
- Não "resolve" captcha, geo-bloqueio ou contrato quebrado com parâmetro; nesses casos ela só classifica e o disjuntor decide.
- Sem `AI_PROVIDER`/`AI_API_KEY` (caso do ambiente atual) o diagnóstico é determinístico sobre o histórico medido, e o registro diz `origem: "regras"` — nunca finge ser IA.

### 9.5 Placar

- API: **492 testes ✔ / 1 skip** (45 arquivos) · web: **18 ✔** · `tsc` 0 erros nos dois.
- Antes desta entrega: 447 / 18. Foram **+45 testes** só no núcleo (`test/nucleo.test.ts`), cobrindo registro, pontuação, regras, validação de IA, canário, rollback, disjuntor, coleta contínua, `SyncRun` e a ponte com o jurídico.

### 9.6 Pendências honestas (F4–F6 ainda abertas)

1. `buscaIA` (busca web) e `sherlock` (OSINT de perfis) ainda não são coletores do NCA.
2. `anota`, `pagamentos` e `operacao` não têm coletor externo — não há o que medir ainda.
3. Sem chave de IA no ambiente, a parte "IA de buscador interpretando" roda em modo determinístico; ligar `AI_PROVIDER=tavily` + `AI_API_KEY` ativa o caminho completo sem mudar código.
4. 91 tribunais → 4 e-SAJ abertos + DataJud + DJEN. Os demais portais exigem captcha/credencial; o núcleo declara isso em vez de simular cobertura.

### 9.7 Prova em produção (25/10, 05:07–05:09 UTC)

Depois do deploy do commit `a32cc52` (`https://acompanhe.onrender.com`):

- `GET /v1/admin/nucleo/catalogo` → **12 coletores** em 4 módulos.
- O agendador contínuo rodou **sozinho 30 s após o boot** e varreu todos os coletores;
  `GET /v1/admin/ops/queues` passou a devolver `syncRuns` reais e o aviso
  “SyncRun sem escritor” **desapareceu**: `datajud 2 itens`, `osint-crtsh 81`,
  `osint-rdap 1`, `osint-wayback 1`, `dou-busca 0 (502 do in.gov.br)`.
- `POST /v1/admin/nucleo/ciclo` (200 em **8,6 s**) mediu PNCP (50 itens) e wayback;
  `osint-crtsh` deu timeout no ciclo seguinte e o disjuntor o colocou em recuo de
  15 min com motivo — sem martelar o host.
- `GET /v1/admin/nucleo/coletor/osint-crtsh` mostrou a série: 81 itens em 302–765 ms
  às 05:08:18–21, depois `timeout` e `502` → o núcleo mediu um canário, ele também
  falhou e a proposta foi **rejeitada** ("nenhum candidato respondeu — nada aplicado").

O e-SAJ de SP, consultado com nome curto ("João Carlos"), responde “foram encontrados
muitos processos, refine sua busca” — o relatório já expõe isso como estado `refinar`,
não como “nenhum processo”.


### 9.8 Auditoria "está no app completo?" (25/10, após deploy `39b55eb`)

Verificado **em produção**, não no código:

| Ponta | Evidência |
|---|---|
| Ciclo jurídico rodando e **aprendendo** | `FontePerfil` com 2 linhas: `esaj-al v2` (páginas 3→4, +5,18 pts) e `esaj-al v3` (timeout 12000→12250 ms, +7,28 pts), ambas com motivo e ε=3 registrados |
| Perfil **usado na busca** | `/api/processos/nacional` e agora também `/api/processos/pesquisar` (nome/CPF) leem `perfisParaBusca` — teste `auto-aplicado.test.ts` prova o termo enviado ao e-SAJ mudando com a variante v4 |
| Núcleo novo medindo **todos os módulos** | `ColetorEstado` 12 linhas, `ColetorMetrica` 50+, `ColetorAcao` 40, `SyncRun` 50+ (`esaj-ac 12 itens`, `djen 403`, `dou 502`) |
| Operador consegue ver | aba **Fontes** no painel (`/admin.html`), sem erro de console, com ciclo sob demanda e reativação |
| Auditar o que foi decidido | visor de BD do painel lista `fonteperfil`, `fontemetrica`, `coletoreestado`, `coletormetrica`, `coletoracao`, `syncrun` |

Três bugs de painel encontrados nesta auditoria e corrigidos (todos existiam antes desta entrega):
1. **`/v1/admin/auth/login` não devolvia `permissions`** → o painel abria em branco ao entrar
   (`TypeError: Cannot read properties of undefined (reading 'join')`). Agora devolve e a tela tolera ausência.
2. **visor de BD usava o nome da tabela** em vez do model do Prisma → `syncRun`,
   `fontePerfil` e outras apareciam como “modelo indisponível”.
3. **`id` BigInt estourava o JSON** do visor → 500 em toda tabela com id numérico.

O que continua **fora** (declarado, não simulado): `buscaIA`/`sherlock` como coletores
do NCA; módulos `anota`, `pagamentos` e `operacao` (não têm fonte externa para medir);
e o modo IA do diagnóstico, que hoje roda determinístico porque o ambiente não tem
`AI_PROVIDER`/`AI_API_KEY`.

### 9.9 IA de buscador finalmente respondendo no ciclo (25/10, com prova de execução)

O §9.8 fechou com uma pendência honesta: o diagnóstico com IA **não respondia** (provedor
gratuito devolvia `402 FREE_LIMIT`). Nesta rodada a camada foi destravada e medida em ciclo real
de 15 coletores — sem dado simulado.

**O que estava errado (tudo medido, nada suposto):**

| Defeito | Evidência | Correção |
|---|---|---|
| Janela de 30 s contada do **início** da chamada | resposta do provedor levava ~11 s → a próxima caía 19 s depois e tomava 402 (`openai: limite gratuito`) | `ultimaChamadaIA` agora é gravado no `finally`: a janela conta do **fim** da resposta |
| Modelo alternativo morto (`qwen-coder`) | `GET text.pollinations.ai/models` lista só `openai-fast` (aliases `openai`); `qwen-coder` → 402 imediato, `mistral` → 404 | `MODELO_ALTERNATIVO = "openai-fast"` + `NUCLEO_IA_MODELOS` por env para trocar sem deploy |
| Coletor em **recuo** nunca era interpretado | ciclo real: 4 coletores `pausada` → `comDiagnosticoIA: []` (o backoff escondia a falha por horas) | fase de IA prioriza `pausada` além de `mantida` com falha |
| “Termo amplo” **desativava** a fonte | `esaj-sp`/`esaj-ce` ficaram OFF com “HTTP 200 sem itens”, mas o portal **responde** (pede refino do nome) | peso `refinar` = ∞: desativar por termo do canário é erro do núcleo, não do portal |

**Prova de execução (ciclo real, 38,8 s, 15 coletores, Postgres local):**
`comDiagnosticoIA: ["djen"]` e o registro em `ColetorAcao`:

```
djen  desativada  origem=ia  provedor=pollinations:openai  confianca=0.95
causa: "HTTP 403 em 58 ms com 0 itens: a API bloqueia IP fora do Brasil
        (configure DJEN_RELAY_URL com egress brasileiro)"
```

Isto é interpretação real do erro: 403 em 58 ms é geo-bloqueio (não é timeout nem contrato),
e a ação aplicada é a honesta — desativar com a causa e a saída de configuração no registro.

**Cobertura do catálogo**: **15 coletores / 4 módulos** (juridico 6, licitacoes 1, concursos 1,
investiga 7 — incluindo `osint-dominio`, `osint-email` e `busca-web`).

**Placar após as mudanças**: API **510 ✔ / 1 skip**, `nucleo.test.ts` **58 ✔**, web **18 ✔**,
`tsc -b --force` sem erro. Testes novos: `refino não desativa`, `coletor em recuo é
interpretado pela IA no mesmo ciclo`.
