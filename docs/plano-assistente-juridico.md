# Plano — Assistente Jurídico conversacional (substitui o JSON cru)

**Problema (reprovado pelo usuário em 24/10)**: o card "Processo" devolve `JSON.stringify(processo)` cru e o "Explicar" é uma frase fixa simulada (`O movimento "X" indica uma etapa processual…`). O usuário pediu: 4 botões práticos (**Buscar · Acompanhar · Alertar · Explicar**) + assistente com quem o usuário **conversa (pergunta e recebe resposta)** em linguagem fácil — **sem alucinar, sem nada genérico/superficial/simulado**.

## 1. Princípio inegociável (o que torna "sem alucinar" verdadeiro)

O assistente é um **motor de respostas fundamentadas (grounded)**: cada frase sai de
(a) dados REAIS do processo (DataJud/CNJ), (b) a **tabela oficial de movimentos do CNJ**
(975 códigos — `tabela-movimentos.ts`, capturados de `dpj.cnj.jus.br/sgt/api/v1.0/movimentos.csv`),
(c) glossário jurídico-curado com **base legal citada** (CPC art. 203; DL 911/69; Tema 1.279 STJ;
Súmula 72 STJ; Res. 46/2007 CNJ) e (d) nada mais. O que não estiver nesses quatro → resposta
**honestamente negativa** ("isso não consta nos dados públicos do processo") + saída para
advogado com OAB verificada (RF-B07). **Toda** resposta sai com `RODAPE_INFORMATIVO` (RF-B08).
Motor pluggable: se `LLM_API_KEY` existir no futuro, um provider generativo pode ser ligado
sem quebrar o contrato; o padrão é o grounded (único que não alucina).

## 2. Contrato de API (novos endpoints — os existentes intactos)

| Rota | O que faz | Regras |
|---|---|---|
| `GET /api/processos/buscar?cnj=&alias=` | **Buscar**: pré-visualiza o processo (mapDoc) SEM registrar | 401; paywall `PLANS_WITH_JURIDICA`; nunca cria caso |
| `POST /api/processos/:cnj/perguntar` `{question}` | **Explicar/Conversar**: `{resposta, fontes[], sugestoes[], rodape}` | 401/403 paywall; pergunta 3..500; sigilo→`SIGILO_MSG`; sempre rodapé |
| `POST /api/processos/:cnj/alertar` | **Alertar**: liga `alertasAtivos` no caso + emite `AlertEvent("novo_movimento")` de confirmação + devolve histórico | 401; idempotente; dedupe `alertDedupeKey` |
| `POST /api/processos/:cnj/sync` (existente, +) | quando `novos>0 && alertasAtivos` → emite alerta real via `AlertSink` (dispatcher→worker→Telegram) | RF-B04 |

`GET /api/processos/:cnj` passa a devolver também `resumo` (projeção em linguagem simples) para
o card — sem quebrar consumidores (chave nova).

## 3. Assistente — intenções cobertas (com dados reais)

status/situação · valor da causa · movimentos (histórico/últimos) · o que significa movimento X
(glossário oficial + impacto: ℹ️ informativo / ⚠️ atenção / 🔴 crítico) · o que é a classe da ação
(grounded DL 911/69 p/ Busca e Apreensão em Alienação Fiduciária etc.) · onde tramita/órgão ·
datas (ajuizamento) · prazos (o que observar — com base legal citada) · próximo passo/o que fazer
(categorias de impacto) · grâu/instância · sigilo · resumo do processo · alertas · advogado/OAB
(RF-B07) · fallback honesto + sugestões.

## 4. Frontend (JuridicoScreen — zero JSON)

- Form CNJ+UF e **4 botões**: 🔎 Buscar · ⚖️ Acompanhar · 🔔 Alertar · 💬 Explicar (abre o chat).
- **Card Processo**: chip de status (ativo/suspenso/arquivado), campos em linguagem humana
  ("Tipo de ação", "Onde tramita", "Quando começou", "Valor da causa", "Última movimentação"),
  **timeline de movimentos** (data · nome oficial · badge de impacto · explicação no toque),
  projeção/fase. Dados técnicos (`raw`) atrás de `<details>` "ver dados técnicos" — nunca à vista.
- **Chat do assistente**: bolhas, sugestões clicáveis, "digitando…", resposta com `fontes`
  (ex.: "DataJud — movimento 51 Conclusão, 25/09/2014") + rodapé fixo + botão "Falar com advogado".
- Design system vigente (dark, glass, bento) — tokens `--acc/--good/--warn/--bad` do styles.css.

## 5. Persistência

`LegalCase.alertasAtivos Boolean @default(false)` (Prisma + `LegalStore` + InMemory + contract
tests). `prisma db push` no boot do container já cobre o cloud.

## 6. Testes (verde obrigatório; nada marcado sem stdout)

1. `assistente.test.ts` (novo): fixture real (doc de 94 movimentos) × intenções — toda resposta
   tem rodapé; status/valor/movimentos citam dados reais; movimento 51 → explicação grounded;
   pergunta fora do escopo → fallback honesto (nunca inventa); sigilo → só `SIGILO_MSG`.
2. `juridico.test.ts` (estendido): buscar NÃO cria caso; perguntar 401/403/200; alertar idempotente
   + evento emitido; sync com `alertasAtivos` emite `novo_movimento` (mock AlertSink); sem flag → não emite.
3. Regressão total: vitest completo + `tsc` ×3 + build web.
4. Deploy (autoDeploy commit) + smoke real em https://acompanhe.onrender.com.

## 7. Fora de escopo (declarado)

Geração de texto livre por LLM (exige `LLM_API_KEY` — inexistente; a engine grounded é o padrão
anti-alucinação); parecer jurídico (ato privativo — Lei 8.906/994 art. 1º, RF-B08); alterar os
fluxos de OAB/consulta humana (RF-B07 permanece como está).

---

## Status final (24/10/2026) — CONCLUÍDO ✓

- `tsc` api/web/shared = 0; suíte completa **263 passed / 0 failed / 1 skipped** (assistente.test.ts 17/17 com fixture real de 94 movimentos).
- Bugs corrigidos no ciclo: 10 regex de intenção com `\b` após stems (não casavam "resuma", "prazos", "movimentos"…) + coluna `alertasAtivos` em `acompanhe_test` + cenário do alerta (2ª sync sem movimentos novos).
- Deploy: commit `5635f2d` → autoDeploy Render → **LIVE**.
- Smoke E2E ao vivo (`tools/smoke-juridico-live.py`) **14/14 ✓**: paywall honesto 403 sem plano · buscar 200 com dados reais (DataJud ao vivo) + resumo humano + rodapé · perguntar → `intencao=status` grounded ("DESCONHECIDO" honesto quando não derivável) · alertar flag + idempotente · bundle JS contém a UI nova (Alertar/chat).
