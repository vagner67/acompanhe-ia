# Plano — união de produtos (AnotA ↔ Empréstimo · Jurídico ↔ Investiga)

**Data:** 25/10/2026 · **Autor:** execução assistida
**Regra do pedido:** plano primeiro, depois execução; sem alucinar, sem sintetizar, sem simulação —
só dado real e funcional. Nada aqui é estimativa: os números de linha e as rotas foram medidos no
código que está no repositório.

---

## 0. Resposta curta à pergunta

> **Status em 25/10/2026, fim do dia: as duas uniões estão FEITAS e testadas** — ver §6, que é o
> registro do que foi executado, com os arquivos e rotas reais (dois pontos deste plano mudaram na
> execução e estão corrigidos lá: a ponte da União A mora em `emprestimos/ponte-anota.ts`, e a rota
> de volta da União B é `POST /v1/investiga/cases/from-processo`). O texto de §1–§5 fica como plano
> original; §6 é a verdade do que rodou.

**O AnotA NÃO foi unido ao empréstimo.** Na refatoração de hoje eles foram **separados**: o AnotA
ganhou rota, domínio, store e tela próprios (`apps/api/src/anota/*`, `routes/anota.ts`,
`apps/web/src/anota/*`) e o módulo de empréstimo ficou com `emprestimos/` + `routes/emprestimos.ts`.
O único resíduo de acoplamento (OCR e o store antigo de notas/gastos morando em `src/minhas/`) já
foi cortado.

Ou seja: hoje são **dois produtos que não se falam**. Este plano faz a união pedida — uma união de
**dado e de tela**, não de arquivo: cada produto continua com seu domínio, e a ponte tem nome,
contrato e teste.

---

## 1. Estado real medido (o que existe hoje, sem inventar)

| Peça | Arquivo | Linhas | O que já faz de verdade |
| --- | --- | --- | --- |
| Empréstimo (domínio) | `apps/api/src/emprestimos/service.ts` | 280 | pedido → match bilateral (72 h) → rodadas (até 3) → aceite → pagamento `declared`/`confirmed`/`disputed`, `LoanStore` com 13 métodos |
| Calculadora | `apps/api/src/emprestimos/calculadora.ts` | 94 | `calcularEmprestimo` (juros simples/compostos, correção, mora) e `agendaParcelas` (PMT) |
| Rotas de empréstimo | `apps/api/src/routes/emprestimos.ts` | 148 | `/api/feed/emprestimos`, `/api/loan-requests`, `/api/loan-requests/:id/interesse`, `/api/loan-matches/:id/{aceitar,rodadas}`, `/api/payments/{declare,confirm}` |
| Minhas (empréstimo do usuário) | `apps/api/src/routes/minhas.ts` | 101 | `/api/minhas/emprestimos`, `/api/minhas/dividas`, `/api/minhas/verificacao`, `/api/minhas/perfil` |
| AnotA (domínio) | `apps/api/src/anota/dominio.ts` + `store.ts` + `routes/anota.ts` | 1.176 | contas, categorias, lançamentos (parcelas/recorrência), resumo, orçamento, cartão/fatura, metas, relatório, import CSV/OFX, export, OCR, notas, backup |
| Jurídico — busca por parte | `apps/api/src/juridico/pesquisa.ts` + `esaj.ts` | 349 | `pesquisarTerceiros(nome|cpf|cnpj)` em 4 e-SAJ verificados (AL, SP, AC, CE) + DataJud por CNJ; cada item traz `numeroProcesso`, `nomeParte`, `participacao`, `uf`, `fonte`, `url` |
| Jurídico — detecção | `apps/api/src/juridico/deteccao.ts` | 130 | `detectarConsulta` decide nome × CPF × CNPJ × CNJ (com DV real) |
| Jurídico — rotas | `apps/api/src/routes/processos.ts` | 728 | `/api/processos/pesquisar`, `/buscar`, `/detalhes-lote`, `/nacional`, `/:cnj`, `/:cnj/explicar`, `/risco`, `/:cnj/alertar`, `/frota` |
| Investiga (domínio) | `apps/api/src/osint/service.ts` | 362 | caso com `legalBasis`/`purpose`, alvos `username|email|phone|domain|name|url`, checks com quota diária, achados com proveniência, correlação, relatório com sha256 |
| Investiga — rotas | `apps/api/src/routes/investiga.ts` | 344 | `/v1/investiga/cases` (CRUD + `/run`, `/report`, `/alerts`, `/export.csv|pdf`), `/v1/investiga/quota`, **`/v1/investiga/cases/:id/juridico` (GET/POST)** e **`/v1/investiga/cases/from-processo` (POST)** |
| UI AnotA | `apps/web/src/anota/AnotaScreen.tsx` | 247 | **7 abas** (Resumo, Lançamentos, Planejar, Relatório, **Empréstimos**, Notas, Backup) |
| UI Empréstimo | `apps/web/src/screens.tsx` (`EmprestimosScreen`) | — | feed, proposta, matches, verificação |
| UI Jurídico | `apps/web/src/juridico/JuridicoScreen.tsx` | 810 | buscar → resultados → processo (movimentos, risco, assistente) |
| UI Investiga | `apps/web/src/screens.tsx` (`InvestigaScreen`) | — | criar caso, rodar, estimativa, monitor, export |

**O que falta para "unir" (a lacuna real):**

1. Um pagamento de empréstimo **não aparece em lugar nenhum do AnotA** — o usuário tem que digitar
   a despesa na mão, e o AnotA não sabe que existe um contrato.
2. O AnotA **não conhece** o contrato: parcelas, saldo devedor, quem deve para quem.
3. O Investiga **não consulta o Jurídico**: um caso OSINT com nome de pessoa não procura processos.
4. O Jurídico **não alimenta o Investiga**: achou uma parte num processo, não há como investigá-la.

---

## 2. União A — AnotA ↔ Empréstimo

### 2.1 Princípio

O empréstimo continua sendo do módulo dele (`LoanStore`, `calculadora`, regras RE1/A3). O AnotA
continua sendo o dono do dinheiro do dia a dia. A união é feita por **lançamentos reais**: cada
contrato aceito vira lançamentos no AnotA com `fitId` determinístico, e cada pagamento
declarado/confirmado atualiza o lançamento correspondente. Nada é copiado à mão, nada é simulado —
se o contrato existe no `LoanStore`, os números do AnotA saem dele.

### 2.2 Módulo de ponte — `apps/api/src/emprestimos/ponte-anota.ts` (novo)

> **Correção feita na execução:** a ponte **não** pode morar em `anota/`. O guarda de arquitetura
> (`apps/api/test/architecture.test.ts`) proíbe `anota/` importar `emprestimos/` — e essa regra é
> boa: o AnotA não deve depender do domínio de empréstimo. A ponte ficou do lado do empréstimo
> (`emprestimos/ponte-anota.ts`), que é quem conhece os dois lados; `routes/emprestimos.ts` recebeu
> a dep opcional `anota?` e `routes/anota.ts` recebeu `loans?`. Dois guardas novos travam isso
> (ponte única nas duas direções).

Funções **puras** (testáveis sem HTTP e sem banco):

```ts
// quem deve/paga o quê
contratoParaAnotA(match: LoanMatchDto, pedido: LoanRequestDto, userId: string): ContratoNoAnota
// { matchId, papel: "devedor"|"credor", tipo: "despesa"|"receita",
//   principalCents, totalCents, jurosCents, formula, meses, parcelaCents,
//   parcelas: [{ n, vencimento, valorCents, fitId }] }

lancamentosDoContrato(c: ContratoNoAnota, userId: string, opts: { contaId?, categoriaId?, categoria? }): LancamentoDto[]
lancamentoDoPagamento(p: PaymentDto, c: ContratoNoAnota, userId: string, opts): LancamentoDto
resumoContratos(contratos, lancamentos, pagamentosPorMatch): { contratos: [...], totais }
```

Regras fechadas:

- **Valores**: `calcularEmprestimo({ principalCents, jurosMesBps, meses, jurosTipo })` → `totalCents`;
  parcelas por `parcelar(totalCents, meses, primeiraData)` (a última parcela fecha o centavo).
  Nenhum número é inventado: tudo vem do pedido + calculadora.
- **Vencimentos**: mensais a partir de `max(data do aceite, hoje)` — o primeiro vence no ato, o
  enésimo em +n−1 meses (função `addMeses` já existente no domínio do AnotA).
- **`fitId`**: `loan:<matchId>:<n>` para parcela e `loan-pay:<paymentId>` para pagamento. É o que
  garante idempotência: lançar duas vezes não duplica (o store já tem `existeFitId`).
- **Sinal**: devedor (`match.requestUserId`) → `despesa`; credor (`match.offerUserId`) → `receita`.
- **Status**: parcelas nascem `pendente` (o dinheiro ainda não saiu); pagamento `declared` nasce
  `pendente` e vira `pago` quando `confirmed`; `disputed` fica `pendente` e aparece marcado.
- **Só contrato `aceito`** entra. `pendente`/`recusado`/`expirado` ficam de fora — e a rota diz isso.

### 2.3 Rotas novas (em `routes/anota.ts`, que passa a receber `loans: LoanStore`)

| Rota | O que faz |
| --- | --- |
| `GET /api/anota/emprestimos` | lista os contratos do usuário com papel, principal, total, parcela, quantas parcelas já foram lançadas no AnotA, quanto está pago/declarado e saldo devedor; totais `aPagarCents` / `aReceberCents` |
| `POST /api/anota/emprestimos/:matchId/lancar` | cria no AnotA as N parcelas do contrato (idempotente; devolve `criados` e `jaExistiam`) |
| `POST /api/anota/emprestimos/:matchId/pagamentos/:paymentId/lancar` | lança um pagamento específico; se já existe, sincroniza o status em vez de duplicar |

### 2.4 Gancho automático no fluxo de pagamento

`routes/emprestimos.ts` ganha dep opcional `anota?: { store: AnotaStore }`. Depois de
`POST /api/payments/declare` e `POST /api/payments/confirm`, se o AnotA estiver disponível:
cria/atualiza o lançamento do pagamento. Falha nessa sincronização **não derruba o pagamento**
(é registrada na resposta em `anotA: { sincronizado: false, motivo }`) — o pagamento é regra
financeira do produto empréstimo, o espelho no AnotA é conveniência.

### 2.5 UI — nova aba no AnotA

`apps/web/src/anota/Emprestimos.tsx`, dentro da `AnotaScreen` como 7ª aba **“🤝 Empréstimos”**:

- um cartão por contrato: papel (devo/recebo), principal, total com juros, parcela, vencimento da
  próxima, barra de progresso das parcelas lançadas, saldo devedor;
- botão **“Lançar parcelas no AnotA”** (mostra `criados`/`jaExistiam` e recarrega o resumo);
- lista de pagamentos com status real (`declarado` / `confirmado` / `contestado`) e botão para
  lançar o que ainda não está no AnotA;
- totais no topo: *a pagar* e *a receber* — e o aviso de que esses valores já entram no Resumo do mês.

### 2.6 Testes da União A (`apps/api/test/anota-emprestimos.test.ts`)

1. domínio: contrato de R$ 1.000 em 4× a 3% a.m. → soma das parcelas = `totalCents` da calculadora;
2. devedor gera despesa, credor gera receita; `fitId` distinto por parcela;
3. rota `lancar` cria N lançamentos e o **resumo do mês** passa a mostrar as parcelas pendentes em `apagarCents`;
4. rodar `lancar` duas vezes → `criados: 0`, `jaExistiam: N` (idempotência pelo `fitId`);
5. `POST /api/payments/declare` com AnotA ligado → aparece lançamento pendente; `confirm` → vira pago;
6. contrato `pendente`/`recusado` não entra na lista nem aceita `lancar` (422 com motivo).

---

## 3. União B — Jurídico ↔ Investiga

### 3.1 Princípio

O Jurídico sabe achar processo por **nome/CPF/CNPJ** (`pesquisarTerceiros` → 4 e-SAJ + DataJud) e
devolve a parte (`nomeParte`, `participacao`, `url`). O Investiga sabe transformar um alvo em
achados com proveniência, quota e relatório assinado. A união usa **exatamente isso**:

### 3.2 Módulo de ponte — `apps/api/src/osint/juridico.ts` (novo)

```ts
// alvo do caso → consulta jurídica (só o que tem fonte real)
classificarAlvo(alvo: OsintTarget): { alvo, tipo: "nome"|"cpf"|"cnpj", valor } | { alvo, motivo }
// roda a busca real e converte o resultado em achados COM proveniência
buscarJuridicoDoCaso(caso, deps): Promise<{ achados: OsintFinding[]; porAlvo: [...]; avisos: string[] }>
// jurídico → investiga
casoAPartirDeProcesso(item: ProcessoTercero, extra): CreateCaseInput
```

Mapeamento honesto de status (nada de "não achei" quando a fonte caiu):

| Resposta real da fonte | `FindingStatus` no Investiga |
| --- | --- |
| e-SAJ `resultados` com item | `found` (com `evidenceUrl` do processo) |
| e-SAJ `vazio` | `not_found` |
| e-SAJ `multiplos` (“refine sua busca”) | `unknown` — a busca não foi conclusiva |
| e-SAJ `bloqueado` / `erro`, DataJud fora | `unavailable` / `error` |
| alvo `email`/`phone`/`domain`/`username` | `unavailable` com motivo “sem fonte jurídica para este tipo de alvo” |

`sourceId` = `juridico:esaj-<uf>` ou `juridico:datajud-<alias>`; `evidenceUrl` = URL real do e-SAJ;
`raw` = `{ numeroProcesso, classe, assunto, participacao, nomeParte, uf, foro, fonte }`.

### 3.3 Rotas novas

**Investiga → Jurídico** (em `routes/investiga.ts`):

| Rota | O que faz |
| --- | --- |
| `POST /v1/investiga/cases/:id/juridico` | roda a busca jurídica para os alvos do caso, grava os achados e devolve `{ alvo, tipo, estado, itens, avisos }` |
| `GET /v1/investiga/cases/:id/juridico` | lista os achados jurídicos já gravados (`sourceId` começando com `juridico:`) |

Gating: exige plano Investiga (já existente) **e** plano Jurídico (`PLANS_WITH_JURIDICA`); sem o
segundo devolve 403 com a regra escrita, sem consultar nada.

**Jurídico → Investiga** (em `routes/processos.ts`):

| Rota | O que faz |
| --- | --- |
| `POST /v1/investiga/cases/from-processo` | recebe `{ numeroProcesso, nomeParte, uf, participacao? }` vindos de um item da busca, cria um caso OSINT real com alvo `name` = `nomeParte`, `legalBasis`/`purpose` declarados na hora e devolve o caso criado. Sem `nomeParte` → **422** “a fonte não devolveu parte identificável neste processo” (nunca inventa alvo) |

### 3.4 UI

- **Investiga** (`apps/web/src/screens.tsx` → `InvestigaScreen`): em cada caso, botão
  **“⚖️ Buscar processos (Jurídico)”** e a lista de retorno (CNJ, classe, parte, fonte, link).
- **Jurídico** (`JuridicoScreen`): em cada resultado da lista, botão **“🔎 Investigar parte”** quando
  houver `nomeParte` — cria o caso no Investiga e mostra o id; sem nome, o botão não aparece (e a
  tela explica o motivo).

### 3.5 Testes da União B (`apps/api/test/ponte-juridico-investiga.test.ts`)

Fixtures **reais** já capturadas em `test/fixtures/esaj/` (`tjsp-nmparte-joao.html`,
`tjal-nmparte-positivo.html`, `tjal-nmparte-muitos.html`, `tjac-nmparte-vazio.html`):

1. caso com alvo `name` → `found` com `evidenceUrl` do processo e `sourceId juridico:esaj-sp`;
2. `multiplos` → `unknown` (não vira “não encontrado”);
3. `vazio` → `not_found`;
4. alvo `email` → `unavailable` com motivo escrito;
5. caso de outro usuário → 404; sem plano Jurídico → 403 (e nenhuma chamada de rede);
6. `POST /v1/investiga/cases/from-processo` cria caso com `targets:[{kind:"name", value: nomeParte}]`;
7. sem `nomeParte` → 422, e **nenhum** caso é criado.

---

## 4. Ordem de execução

1. `apps/api/src/emprestimos/ponte-anota.ts` + rotas + gancho no pagamento → testes (União A).
2. `apps/web/src/anota/Emprestimos.tsx` + aba → build + teste de lógica.
3. `apps/api/src/osint/juridico.ts` + rotas das duas direções → testes (União B).
4. UI: botão no Investiga e no Jurídico → build.
5. Suíte completa (api + web + shared) + E2E HTTP real dos dois fluxos com Postgres local.
6. Deploy + smoke em produção.

## 5. Limites declarados (para não virar promessa vazia)

- **Empréstimo não move dinheiro** (RE1) — o AnotA também não move: ele registra. A união é de
  registro, não de liquidação.
- **Nenhuma fonte jurídica nova** é adicionada; a união usa os 4 e-SAJ verificados + DataJud. UF
  fora da cobertura continua respondendo com advertência honesta.
- **CPF/CNPJ não é tipo de alvo do Investiga** (o contrato do shared tem 6 kinds). A ponte aceita
  documento quando o caso tem esse valor em um alvo textual e classifica com `detectarConsulta` —
  sem inventar um 7º kind (isso mudaria o contrato congelado do doc 13).
- **Quota do Investiga não é consumida** pela busca jurídica (ela não passa pelo `QuotaGate`); a
  busca jurídica tem seus próprios limites no módulo jurídico.

---

## 6. O que foi executado de fato (registro de 25/10/2026)

Tudo abaixo está no repositório e medido por teste; nenhum item é estimativa.

### 6.1 União A — AnotA ↔ Empréstimo

| Peça | Onde | Prova |
| --- | --- | --- |
| Ponte única | `apps/api/src/emprestimos/ponte-anota.ts` — `contratoParaAnotA` (`fitId` `loan:<matchId>:<n>`), `sincronizarPagamentoNoAnota` (`loan-pay:<paymentId>` só para pagamento avulso) | `test/anota-emprestimos.test.ts` 12/12 |
| Rotas | `routes/anota.ts` (também recebe `loans?`) e `routes/emprestimos.ts` (recebe `anota?`): `GET /api/anota/emprestimos`, `POST /api/anota/emprestimos/:matchId/lancar`, `POST /api/anota/emprestimos/:matchId/pagamentos/:paymentId/lancar` | idem |
| Espelho do pagamento | `espelharPagamento(matchId, paymentId)` chamado no `declare` e no `confirm`; a parcela manda — **nunca** se cria linha paralela (dobraria o saldo) | idem + E2E |
| Tela | `apps/web/src/anota/Emprestimos.tsx`, 7ª aba “🤝 Empréstimos” do `AnotaScreen` (totais a pagar/a receber, barra de parcelas lançadas, declaração aguardando confirmação, botão de lançar) | `tsc -b` limpo |

### 6.2 União B — Jurídico ↔ Investiga

| Peça | Onde | Prova |
| --- | --- | --- |
| Ponte única | `apps/api/src/osint/juridico.ts` — `classificarAlvo` (usa `detectarConsulta`, valida DV de CPF/CNPJ), `statusDoEstado`, `buscarJuridicoDoCaso`, `casoAPartirDeProcesso`, `MAX_ITENS_POR_FONTE = 10` | `test/ponte-juridico-investiga.test.ts` 15/15 com fixtures HTML reais |
| Rotas | `routes/investiga.ts`: `POST|GET /v1/investiga/cases/:id/juridico` (403 sem `PLANS_WITH_JURIDICA`, sem chamada de rede) e `POST /v1/investiga/cases/from-processo` (422 sem nome de parte, **nenhum** caso criado) | idem |
| Dep | `server.ts` injeta `osint.juridico` (`buscar`/`fetchImpl`/`ufs`) | boot real |
| Tela | `InvestigaScreen`: botão “⚖️ Buscar processos (Jurídico)” por caso, com os processos reais e link da fonte; `JuridicoScreen`: “🔎 Investigar esta parte no Investiga” em cada resultado | `tsc -b` limpo |
| Métodos de API | `apps/web/src/api2.ts`: `invJuridicoBuscar`, `invJuridicoListar`, `invCasoDeProcesso`, `anotaEmprestimos`, `anotaEmprestimoLancar`, `anotaEmprestimoPagamentoLancar` | build da web |

### 6.3 Desvios de desenho (decididos na execução, não são pendências)

1. **Ponte da União A fora de `anota/`** — o guarda `architecture.test.ts` proíbe `anota/` importar
   `emprestimos/`; a ponte vive em `emprestimos/ponte-anota.ts` e dois guardas novos travam a ponte
   única nas duas direções (11/11 no arquivo).
2. **Rota de volta é `POST /v1/investiga/cases/from-processo`**, registrada no plugin
   `investigaRoutes` — não `/api/processos/investigar`. Entitlement e limite de casos ficam
   delegados ao `service.createCase`, num lugar só.
3. **Nada de 7º `OsintTargetKind`**: CPF/CNPJ encontrado no caso é classificado por
   `detectarConsulta`, que valida dígito verificador; alvo `email/username/domain/url` não tem fonte
   jurídica e devolve motivo escrito (`unavailable`), não "não encontrado".
4. **Achado `found` sempre tem `evidenceUrl`**: o antigo “achado-resumo” da 11ª linha não apontava
   evidência e foi **removido** — o excedente da página virou aviso com o total informado pela fonte.

### 6.4 Placar final medido

- `apps/api`: **583 passam / 1 pulado** (49 arquivos) — inclui 12 da União A, 15 da União B, 11 dos
  guardas de arquitetura.
- `apps/web`: 18/18.
- `node scripts/e2e-uniao.mjs` (API real + Postgres real, sem mock de fetch): **11/11** — contrato de
  4× R$ 280,00, 4 parcelas lançadas, 1 paga após confirmação, saldo R$ 840,00, e busca jurídica real
  nos 4 e-SAJ retornando 33 achados com URL de evidência.
- `node scripts/e2e-anota.mjs`: **22/22**.
- `tsc -b --force` na API: 0 erros.
