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
