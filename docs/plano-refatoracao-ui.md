# Plano de refatoração de UI — Acompanhe.IA (25/10/2026)

> Pedido do usuário: *"O app não pode ser um painel para o usuário, todo poluído. Deve ser simples, prático,
> funcional, agradável e interativo."* Restrição mantida da rodada anterior: **sem sanfona/colapsável e sem
> setas de expandir** na tela jurídica. Escopo: tela jurídica + casca (header/nav). Nenhuma outra tela é
> alterada.

## 1. Diagnóstico medido (não é opinião)

No print enviado, a tela jurídica abre com **um bloco de diagnóstico técnico** ocupando a tela inteira
(7 sub-cartões de fontes) e **nenhum resultado visível**. Medido no código (`apps/web/src/screens.tsx`,
`JuridicoScreen` = linhas 383–1110):

| Métrica | Antes |
|---|---|
| Linhas de código da tela | **728** |
| Cards empilhados (pior caso) | **7** (busca, cobertura, criticidade, índice, terceiros, processo, chat) |
| Botões visíveis no estado inicial | **10** (🔎 Buscar, 🔬 Profunda, 🗂️ Índice, 🎯 Criticidade, ⚖️ Acompanhar, 🔔 Alertar, 💬 Explicar, 🔄 Sincronizar, + 2) |
| Sub-cartões de fontes sempre renderizados | **7** (cada um com 2–3 linhas de texto técnico) |
| Campos de formulário soltos no topo | 2 (`nome/CPF/nº`, `UF` como input de texto) |
| Texto explicativo antes do primeiro resultado | ~120 palavras em 4 parágrafos |
| Rolagem até o primeiro resultado | **> 1,5 tela** (no print: nada aparece em 844 px) |
| Estados `useState` na mesma função | **9** |

Problemas de casca visíveis no print: header sticky de 84 px com subtítulo quebrado em 2 linhas
("Finanças · Jurídico · Concursos & Licitações · Empréstimos"), nav com **8** abas espremidas (rótulos
truncados) e conteúdo aparecendo por trás da nav.

**Causa raiz:** a tela foi crescendo por *acréscimo*. Diagnóstico do sistema (cobertura de fontes, estado de
cada fonte, versão das regras de risco) foi colocado no fluxo principal do usuário, competindo com a única
coisa que ele quer fazer: buscar e entender um processo.

## 2. Princípios (os que guiaram cada decisão)

1. **Uma ação por tela.** O topo responde "o que eu faço aqui?" — um campo, um botão.
2. **Diagnóstico não é conteúdo de usuário.** Cobertura de fontes, limitações e versão de regras vão para
   um painel sob demanda (*sheet*), não para o fluxo.
3. **Divulgação progressiva por estado, não por sanfona.** O que aparece depende do que o usuário
   digitou/abriu — nunca de um chevron. (Isso respeita a restrição explícita e é melhor que acordeão.)
4. **Resultado antes de explicação.** Nada de parágrafo antes do dado.
5. **Densidade com respiro.** Cartões de 1 linha de altura para cada item; texto acessório em `.mut` com
   no máximo 1 linha e `text-overflow`.
6. **Feedback sempre visível**: skeleton durante a busca, barra de progresso só em operação longa
   (pesquisa profunda), toasts curtos.
7. **Honestidade preservada.** As limitações reais (nome só em AC/AL/CE/SP, DJEN indisponível, DataJud sem
   partes) continuam existindo e visíveis — só não ocupam a tela.

## 3. Arquitetura de informação nova (3 estados, sem sanfona)

### Estado A — Buscar (padrão, tela inteira em ~1 dobra)
```
Jurídico                                    (i)
┌─────────────────────────────────────────────┐
│ 🔍  Nome, CPF ou nº do processo      [Buscar]│
└─────────────────────────────────────────────┘
 detectado: número de processo
 [ex.: nº do processo] [ex.: CPF] [ex.: nome]
 ····· (contexto) ·····
 [ Pesquisa profunda ]        ← só quando nome/CPF
 ─────────────────────────────────────────────
 91 tribunais · nome em AC, AL, CE, SP · como funciona
```
- 1 campo + 1 botão primário. Chips de exemplo **preenchem e buscam** (interativo, 1 toque).
- `UF` deixa de ser input solto: vira chip de filtro dentro do *sheet* "Filtros" (com opção "todos").
- Ações destrutivas/irrelevantes somem até existir um processo (Acompanhar/Alertar/Sincronizar/Explicar
  passam para o estado C).

### Estado B — Resultados (lista unificada)
- Uma única lista, deduplicada por número, ordenada por **grau de vínculo** (score) quando vier do índice
  próprio; senão pela ordem da fonte.
- Cada linha: número (mono) · partes (1 linha) · tribunal/classe (1 linha) · selo `87%` (só índice) ·
  `›`. Toque abre o processo.
- Cabeçalho compacto com a consulta e "editar".
- Rodapé: 1 linha `N processos · fontes: e-SAJ SP, índice · ver detalhes` → *sheet* "Onde buscamos"
  (é onde vivem os 7 estados de fonte que hoje ocupam a tela).

### Estado C — Processo aberto
- `‹ voltar` + número + selo de status.
- Resumo do assistente (1 parágrafo).
- 6 fatos em grade 2 colunas (compactos).
- **Criticidade inline** (score/10 + faixa + até 3 justificativas + `risco-v1`) — não é mais card separado.
  Se o processo não estiver no índice, o bloco aparece como "calcular criticidade" (1 toque).
- Movimentações: 5 primeiras + `ver todas (N)` (paginação por botão, não sanfona).
- Ações como linha de botões pequenos: Acompanhar · Alertar · Sincronizar · Perguntar.
- Assistente (chat) no fim, com sugestões.

### Sheets (modais) — o que sai do fluxo
- **Como funciona**: cobertura real (91 tribunais; nome/CPF em AC, AL, CE, SP), por que o DataJud não serve
  para nome, estado de cada fonte com data de verificação, o que o índice próprio é, DJEN indisponível.
- **Filtros**: UF/tribunal/ano.
- **Onde buscamos** (pós-busca): estado por fonte, avisos e rodapé legal.

## 4. Casca (shell)

- Header: 1 linha, 52 px — marca + nome do usuário. O subtítulo "Finanças · Jurídico · …" sai (é o mesmo
  menu da nav, repetido).
- Nav: 5 destinos visíveis — **Início · Licitações · Jurídico · Concursos · Mais** — com
  `Mais` abrindo um *sheet* com Anota, Empréstimos, Investiga e Planos (todos continuam acessíveis; nada é
  removido). Aba ativa com indicador e rótulo legível em 360 px.
- `padding-bottom` com `env(safe-area-inset-bottom)` e fundo da nav mais opaco: nada de conteúdo
  atravessado.

## 5. Mudanças por arquivo

| Arquivo | Mudança |
|---|---|
| `apps/web/src/juridico/logica.ts` | **novo** — funções puras testáveis: `detectarTipo`, `unificarResultados`, `acoesDoEstado`, `resumoCobertura`, `faixaCriticidade`, `encurtar` |
| `apps/web/src/juridico/ui.tsx` | **novo** — `Sheet` (modal acessível: `role=dialog`, Esc, foco), `Chip`, `Skeleton`, `EmptyState`, `ScoreBadge` |
| `apps/web/src/juridico/JuridicoScreen.tsx` | **novo** — a tela, em 3 estados |
| `apps/web/src/screens.tsx` | remove a `JuridicoScreen` antiga (728 linhas) e reexporta a nova; resto intocado |
| `apps/web/src/App.tsx` | header compacto, nav 5 + `Mais` (sheet), imports |
| `apps/web/src/styles.css` | `.field`, `.sheet`, `.result`, `.stat-grid`, `.nav-sheet`, safe-area |
| `apps/web/test/*.test.ts` | **novo** — vitest para `logica.ts` |

## 6. Critérios de aceite (verificáveis)

1. Estado inicial: **≤ 2 botões** e **0 cards de diagnóstico** visíveis; 1 campo de busca.
2. Primeiro resultado alcançável **sem rolar** (procurar por número devolve lista acima da dobra).
3. Cobertura/limitações continuam **acessíveis em 1 toque** (sheet "Como funciona") e o texto é o mesmo
   dado real (`/api/processos/fontes`), sem inventar.
4. Zero `<details>` e zero "seta de expandir" na tela jurídica.
5. Nenhuma regressão nas funções existentes: busca por nº, por nome, pesquisa profunda, índice, criticidade,
   acompanhar, alertar, sincronizar, chat, falar com advogado.
6. `tsc --noEmit` limpo no web, `vite build` ok, testes novos verdes, suíte da API inalterada
   (355 passed / 1 skipped).
7. Medição em navegador real (390×844, DPR 3): altura do bloco de busca e posição do primeiro resultado.

## 7. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Esconder demais e o usuário não achar o índice/profunda | ações contextuais no estado A + linha "como funciona" sempre visível |
| Perda de função ao compactar | checklist do item 6.5 testado manualmente + testes de lógica para o dedupe/unificação |
| Nav com "Mais" esconder Planos | Planos com destaque dentro do sheet + badge de trial quando houver |
| Layout em telas estreitas (360 px) | teste em 360 e 390; rótulos com `min-width:0` e ellipsis |

---

## 8. Resultado medido (Playwright, 390×844 @2x, dados reais)

Script: `/home/user/tools/e2e-ui-juridico.cjs` (login por `initData` assinado, API + Postgres + DataJud + e-SAJ reais).

| Métrica | Antes (print do usuário) | Depois (medido) |
|---|---|---|
| Botões de conteúdo na 1ª dobra | 10 | **3** (+ chips de exemplo/UF) |
| Cards de diagnóstico na 1ª dobra | 7 (todos) | **0** (sheet "Como funciona") |
| Campos de formulário | 2 soltos (nº + UF) | **1** (UF virou chip) |
| Palavras antes do 1º resultado | ~120 | **48** (inclui rodapé honesto) |
| Altura até o campo de busca | >600 px | **135 px** |
| 1º resultado na dobra | não aparecia | **y=284 px** (com "Acompanhados") |
| Abas na nav | 8 (rótulos truncados) | **5** legíveis (4 + Mais) |
| Linhas de código da tela | 728 (num arquivo de 1.961) | 640 em módulo próprio + 120 de lógica pura |
| `<details>` / setas de expandir no jurídico | 1 (`ver dados técnicos`) | **0** |

Fluxos verificados no navegador (todos verdes): busca por nº → processo (6 fatos, criticidade inline `1/10 baixo
risco-v1`, 5 movimentações), busca por nome → **37 processos** de e-SAJ AL/AC em lista única, Acompanhar
(idempotente: "já está na sua lista"), Acompanhados no estado inicial, sheet "Como funciona" com as 7 fontes e
suas limitações reais, sheet "Mais" com AnotA/Empréstimos/Investiga/Planos.

## 9. Bugs reais encontrados durante a refatoração (e corrigidos)

1. **`Acompanhar` e `Abrir` mandavam a UF como `alias`.** `POST /api/processos/:cnj/acompanhar` recebia
   `alias:"mt"` (ou `"todas"`) e falhava; com o DataJud devolvendo o número **sem máscara**, os endpoints
   `/:cnj` respondiam **422 "CNJ inválido"** com DV válido. Corrigido em duas frentes: a UI não manda mais
   alias (o servidor deriva do próprio CNJ) e `routes/processos.ts` ganhou `cnjCanonico()`, usado em
   `GET /:cnj`, `POST /:cnj/acompanhar|alertar|sync|perguntar` e `GET /buscar` — aceita as duas formas do número.
2. **Nome do processo aparecia como "(não consultado)".** Ao acompanhar, o registro nasce sem dados do
   tribunal (só sincroniza depois). A lista "Acompanhados" agora mostra o último movimento quando existe e,
   quando não existe, diz honestamente "ainda sem dados do tribunal — toque para sincronizar".
3. **Erro de UX:** tocar "Acompanhar" num processo já acompanhado mostrava toast de falha. 409 é resultado
   esperado → toast informativo.
4. **Legibilidade dos selos de fonte:** nome + situação + data espremidos em 1 linha quebravam o selo em 3
   linhas. Layout passou a 3 linhas (nome/selo, limite, data).

## 10. Verificação final

- `tsc --noEmit` limpo em `apps/web` e `apps/api`.
- `corepack pnpm test` (raiz, agora com o web incluído): **356 passed / 1 skipped** na API,
  **13 passed** no web, **12 passed** no shared — **0 falhas**.
- `vite build` + `tsc -b` da API ok; app servindo o `web/dist` novo.
- Screenshots: `tools/ui-juridico-{1-inicial,2-como-funciona,3-processo,4-resultados,5-mais,6-acompanhados}.png`.
