# Plano — 91 tribunais + campo único + pesquisa profunda + barra + modo IA de buscador no chat

**Data**: 24/10/2026 · **Status**: PESQUISA CONCLUÍDA → IMPLEMENTAÇÃO
**Pedido**: refatorar a tela jurídica; busca por **nome, CPF e número em campo único** cobrindo **os 91 tribunais do BR**; botão de **pesquisa profunda** de nome → processos de terceiros; **barra de progresso**; integrar **o modo IA de algum buscador** no chat. Plano primeiro → alterar → testar → corrigir → aprovar. Sem alucinação, sem conteúdo sintético/simulado — só fatos medidos. Não alterar funções não relacionadas.

---

## 1. Pesquisa externa — fatos MEDIDOS (24/10/2026)

### 1.1 DataJud — os 91 tribunais (nº de processo)

Fonte: wiki CNJ `datajud-wiki.cnj.jus.br/api-publica/endpoints` + tutorial + **sondagem empírica** (`/tmp/probe91b.py`, `/tmp/probe91c.py`, `/tmp/mapa91.py`):

- **Os 91 aliases oficiais foram testados um a um contra `api-publica.datajud.cnj.jus.br`**: **91/91 respondem** (match_all size=1).
- Os TREs usam a forma **`api_publica_tre-{uf}`** (ex.: `tre-ce`, `tre-sp`) — a forma `api_publica_{uf}` do tutorial antigo do CNJ dá 404. **`tre-df`** (não `tre-dft`).
- **Mapa (J,TR) → alias VERIFICADO empiricamente** (um processo real de cada índice; `/tmp/mapa-jt-alias.json`):
  - J=4 → `trf1..trf6` = 4.01..4.06 · J=5 → `5.01`=**TST e TRT1** (convivem!), 5.02..5.24 = `trt2..trt24`
  - J=6 → 6.01..6.15 e 6.17..6.27 = `tre-{uf}` (ordem própria: 01=AC, 02=AL, 03=AP, 04=AM, …, 15=PB, 17=PE, …, 26=SP, 27=TO); **6.16 = `tse`**
  - J=7 → **7.06 = `stm`** · J=8 → 8.01..8.27 = `tjac..tjto` (8.07=`tjdft`) · **J=9 = Justiça Militar Estadual**: 9.13=`tjmmg`, 9.21=`tjmrs`, 9.26=`tjmsp`
  - J=2 = `stj` (próprios 2.00) — **STJ guarda números de ORIGEM** (um doc do índice `stj` trazia `…8.13` = TJMG) → a busca por nº deve consultar **a corte superior do ramo junto** (8.13 → `tjmg` + `stj`; 5.x → `trtN` + `tst`; 6.x → `tre-uf` + `tse`; 7/9 → `stm`).
- **STF NÃO existe no DataJud** (91 = 4 superiores + 6 TRFs + 27 TJs + 24 TRTs + 27 TREs + 3 militares, sem STF). nº do STF → orientar consulta no portal do STF (link), nunca inventar resultado.

### 1.2 Nome/CPF — portais com busca por NOME verificada (contramedida empírica)

Formato e-SAJ medido (URL `GET {base}/cpopg/search.do?cbPesquisa=NMPARTE|DOCPARTE&dadosConsulta.valorConsulta=…&cdForo=1`; 4 estados reais: `resultados`/`multiplos`/`vazio`/`bloqueado`):

| Tribunal | Base | Estado (24/10) | Fixture |
|---|---|---|---|
| TJAL | `https://www2.tjal.jus.br` | **VERIFICADO** | 3 reais |
| TJSP | `https://esaj.tjsp.jus.br` | **VERIFICADO** | 3 reais |
| **TJAC** | `https://esaj.tjac.jus.br` | **VERIFICADO** (200, NMPARTE+DOCPARTE, sem captcha) | `tjac-nmparte{,-vazio}.html` |
| **TJCE** | `https://esaj.tjce.jus.br` | **VERIFICADO via curl** (TLS Python do sandbox falha; curl/Node alcançam) | `tjce-nmparte{,-vazio}.html` |
| TJAM, TJMS, TJBA, TJSC | e-SAJ | **não alcançáveis do sandbox** (TLS_EOF/conexão em Python **e** curl) → fonte declarada `bloqueado` com link oficial | — |
| TJRS | eproc | inacessível (SSL EOF medido) | — |
| TJGO | Projudi | **recaptcha** medido → não automatizável sem violar | — |
| TJPA | consultaunificada | portão JSF (form `abrir` sem campos) — fluxo não verificável | — |
| PJe (69 órgãos) | pje | inalcançável do sandbox; consulta pública PJe é por **número** (com exceções nome em 2ª instância) | — |

**Conclusão honesta**: busca por **número → 91/91 tribunais** (DataJud). Busca por **nome/CPF → todas as fontes e-SAJ VERIFICADAS (AL, SP, AC, CE)** + aviso claro na UI de que os demais tribunais não oferecem busca pública por nome estável (captcha/migração) e o campo único então busca por número se o texto for nº — nada de resultado inventado.

### 1.3 "Modo IA de algum buscador" para o chat — comparativo (2026)

| Provedor | O que é | Custo | Contrato | Estado |
|---|---|---|---|---|
| **Tavily** | API de busca p/ agentes com `include_answer` (resposta IA + fontes) | **1.000 créditos grátis/mês, sem cartão**; depois $0,0075–0,008/crédito | `POST api.tavily.com/search {query, include_answer, max_results}` → `{answer, results:[{title,url,content}]}` | **recomendado** — exige key do usuário (signup) |
| **Perplexity Sonar** | buscador IA com citações | **sem free tier** (créditos); **Sonar chat completions aposentado em 27/09/2026 → Agent API**; campo `search_results` (antigo `citations` removido) | Agent API `api.perplexity.ai` | implementável, pago |
| **Gemini (Google) + `google_search`** | grounding com fontes | free tier Generative Language (limitado) | `generativelanguage.googleapis.com` + tool `google_search` → groundingMetadata | alternativa |
| **Brave Search API** | busca web + summarizer | free tier pequeno | `api.search.brave.com/res/v1/web/search` | só busca, sem resposta IA |
| **DuckDuckGo HTML** (`html.duckduckgo.com/html/?q=`) | busca real, sem chave | grátis | HTML com `result__a` + `result__snippet` (redirect `uddg` a decodificar) | **MEDIDO: 10 resultados reais** (fixture `ddg/busca-cpc.html`) |
| DDG AI Chat (`duckchat`) | IA do DDG | grátis | exigia header `x-vqd-4` | **MEDIDO: bloqueado** (sem x-vqd) |
| Jina `s.jina.ai` | search+answer | grátis | — | **MEDIDO: fora do ar** |

**Decisão**: (a) **camada base keyless = DuckDuckGo HTML** — resultados REAIS (título+link+trecho) integrados ao chat AGORA, com fontes clicáveis; (b) **camada de resposta IA pluggável**: env `AI_PROVIDER` (`tavily|perplexity|gemini`) + `AI_API_KEY` → resposta gerada **com citações** (links das fontes) — adaptadores Tavily/Perplexity escritos pelos contratos oficiais acima; **sem chave, o chat mostra os resultados reais da web e diz honestamente que a resposta gerada exige chave (Tavily grátis)**. Nunca resposta sem fonte; nunca invenção.

---

## 2. Escopo (o que muda — só relacionado)

1. `cnj.ts` — tabela `ALIAS` completa (91 verificados + `stf` documentado) + `aliasCandidatesFromCnj()` (corte mapeada + superior do ramo, ex.: 8.13→[tjmg,stj], 5.01→[trt1,tst]). Exporta `TRIBUNAIS_DATAJUD` (91, para UI/smoke).
2. `pesquisa.ts` — `BASES_ESAJ` += `ac`, `ce` (fixtures reais); `COBERTURA_UFS` = al, sp, ac, ce; módulos novos `buscaWeb.ts` (DDG) e `buscaIA.ts` (pluggável, keyless).
3. `service.ts` — `pesquisarPorNumero` usa `aliasCandidatesFromCnj` (até 3 índices: própria + superior).
4. `routes/processos.ts` — `pesquisar` passa a informar cobertura dos 91 (nº) e das fontes de nome; **nova rota `POST /api/processos/buscar-web`** (SERVICE_TOKEN) → modo IA/buscador do chat.
5. `screens.tsx` (só tela jurídica) — chip/textos de cobertura honestos (91 nº · e-SAJ nome/CPF · web); **botão "🔎 Buscar na web" no chat** + resposta com cards de fontes (link real) + barra de progresso reutilizada; campo único inalterado (já aceita nome/CPF/nº).
6. Testes: mapa 91 (múltiplos candidatos), parse ddg fixture, buscaIA keyless (resposta só com fontes reais), e-SAJ ac/ce (resultados+vazio), rota buscar-web. Suíte completa + smoke live.

**NÃO mexer**: telegram/bot, pushinpay, admin, RBAC, keep-alive, outras telas.

## 3. Contratos

```
GET /api/processos/pesquisar?consulta=…&tipo=auto|processo|nome|cpf
  → { itens[], fontes[{nome, estado: ok|sem_dados|erro|bloqueado, itens, dica?}],
      consultasExecutadas[], advertencia? }
  CNJ nº → fonte "datajud-<alias>" (91 possíveis); nome/CPF → esaj-al|sp|ac|ce + advertência de cobertura de nome.

POST /api/processos/buscar-web  { pergunta: string }
  → { provedor: "duckduckgo"|"tavily"|"perplexity"|"gemini",
      geradaPorIA: boolean, resposta: string,
      fontes: [{ titulo, url, trecho }] }
  Sem AI_PROVIDER/AI_API_KEY → provedor=duckduckgo, geradaPorIA=false,
      resposta = orientação real montada com os trechos citados + instrução de configuração.
```

UI chat: ao clicar "🔎 Buscar na web", a pergunta vai para `buscar-web`; a resposta aparece no histórico com (i) cabeçalho do provedor, (ii) resposta (gerada ou fontes), (iii) cards título+link+trecho.

## 4. Checklist

- [x] Pesquisa externa exaustiva (aliases 91, e-SAJ, IA APIs)
- [ ] `cnj.ts`: ALIAS completo + candidates + testes
- [ ] `pesquisa.ts`: bases ac/ce + `buscaWeb.ts` + `buscaIA.ts` + testes
- [ ] `service.ts` candidates + rota `buscar-web`
- [ ] UI: chip cobertura, botão web no chat, barra de progresso
- [ ] tsc + suíte completa verde
- [ ] Smoke live (`tools/smoke-busca-live.py` atualizado: 91 nº, nome ac/ce, buscar-web)
- [ ] Commit + push + deploy Render + smoke live
- [ ] Apresentar resultado + pedir aprovação (+ perguntar chave IA se usuário quiser resposta gerada)
