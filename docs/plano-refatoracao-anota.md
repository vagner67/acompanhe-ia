# Plano de refatoração do AnotA (controle financeiro do Acompanhe.IA)

> Escrito em 25/10/2026. Regra desta entrega: **nada de suposição**. Cada afirmação sobre o
> estado atual cita arquivo e linha do repositório; cada afirmação sobre "o que um app de
> controle financeiro tem" cita fonte pública (URL + data de acesso). Onde não há fonte, está
> escrito "não pesquisado" em vez de inventado.

---

## 1. O que o AnotA é hoje (inventário medido no código)

| Arquivo | Linhas | Papel atual |
|---|---|---|
| `apps/api/src/routes/minhas.ts` | 252 | **16 rotas no mesmo arquivo**: AnotA (notas, gastos, OCR, resumo, CSV) + empréstimos + caderno de dívidas + verificação V1 + perfil/região |
| `apps/api/src/minhas/service.ts` | 132 | `NotaDto`, `GastoDto`, `MinhasStore` (+ memória), `OcrProvider`/`manualOcr`, `resumoMensal()`, `exportCsv()` |
| `apps/api/src/store-prisma.ts` | — | implementação Prisma de `createNota/listNotas/…` e `createGasto/listGastos/…` |
| `packages/db/prisma/schema.prisma` | 629–655 | modelos `Nota` e `Gasto` **somente** |
| `apps/web/src/screens.tsx` | 542–740 (199) | `AnotaScreen`: uma função com 12 `useState`, duas abas (Notas/Gastos), sem edição |
| `apps/web/src/api2.ts` | 65–73 | clientes `notas/notaCriar/notaBuscar/gastos/gastoCriar/gastoExcluir/ocr/resumo/exportCsv` |
| `apps/api/test/assinaturas-minhas.test.ts` | 211 | cobre empréstimos + verificação + notas/gastos |

**Funcionalidades reais hoje** (não prometidas — implementadas):

1. Notas: criar, listar, buscar por termo, editar (`PUT`), excluir (`DELETE`), tags, `pinned`.
2. Gastos: criar (descrição, valor em centavos, categoria, data), listar, editar, excluir.
3. OCR de cupom: `POST /api/minhas/gastos/ocr` valida assinatura PNG/JPEG/WEBP antes de tentar;
   provider padrão é `manual` — **não inventa texto** quando não há OCR configurado.
4. Resumo mensal: total do mês + total por categoria (`resumoMensal`).
5. Export CSV de notas + gastos (`/api/minhas/export.csv`).
6. Gamificação: `XP.notaCriada` / `XP.gastoCriado` chamados pela tela.

**Lacunas estruturais medidas:**

- `minhas.ts` mistura 4 domínios (AnotA, empréstimos, verificação, perfil) — qualquer mudança no
  AnotA mexe num arquivo compartilhado com empréstimos.
- `resumo` devolve `porCategoria` como lista (`{category,totalCents,count}[]`) no servidor, mas o
  cliente web (`api2.ts:72`) declara `porCategoria: Record<string, number>` e a tela usa
  `topCategorias` — **três formatos para o mesmo dado**, contrato não documentado.
- `GET /api/minhas/gastos?mes=` e `?q=` são aceitos pelo cliente, mas a rota **ignora o filtro**
  (`listGastos(userId)` sem filtro) — o filtro é aplicado no cliente.
- Categoria é `string` livre no schema, validada só por `z.string().min(1).max(40)`; a lista de
  categorias está *hardcoded* no componente (`screens.tsx`: mercado, aluguel, transporte, saúde,
  educação, lazer, outros).
- Não existe receita: só saída de dinheiro. Sem receita não há saldo, sobra, nem orçamento.
- Não existe conta/carteira: todo gasto é um lançamento solto, sem origem.
- Não existe orçamento/limite por categoria, nem comparação mês a mês.
- Não existe data de competência × vencimento, nem `pago/pendente` (só `spentAt`).
- Não existe edição na UI (a rota `PUT` existe; a tela não usa).
- Não existe backup/export para o usuário fora do CSV, nem envio por e-mail.

---

## 2. O que um app de controle financeiro oferece (pesquisa com fonte)

Levantamento feito em 25/10/2026. Cito a fonte de cada bloco; nada aqui foi inferido "de memória".

| Bloco de funcionalidade | Evidência (fonte) |
|---|---|
| Registrar **receitas e despesas**, categorizar, criar **categorias personalizadas** | App Store, ficha oficial do Organizze (desenvolvedor): "Registre receitas e despesas · Crie categorias personalizadas · Cadastre despesas fixas, parceladas e recorrentes" — https://apps.apple.com/br/app/organizze-finan%C3%A7as-pessoais/id677699286 |
| **Contas e cartões de crédito em um só lugar**, com **fatura** | mesma ficha: "Acompanhe suas contas fixas, despesas e faturas sem precisar abrir diferentes aplicativos" |
| **Orçamento com limite por categoria** | mesma ficha: "Crie limites por categoria e acompanhe seu orçamento durante o mês" |
| **Planejamento / previsão de saldo** e lançamentos futuros | mesma ficha: "comparar receitas e despesas, visualizar lançamentos futuros e acompanhar previsões de saldo" |
| **Relatórios e gráficos** por categoria, evolução no tempo | mesma ficha: "Os relatórios financeiros mostram seus gastos por categoria" |
| **Controle de saldos por conta**, cartão, **metas/objetivos**, projeção de saldos, integração bancária | Tabela comparativa iDinheiro: "Controle de despesas · Controle de saldos · Gerenciamento de cartão de crédito · Planejamento financeiro · Objetivos · Integração com Bancos · Projeção de saldos" — https://www.idinheiro.com.br/financaspessoais/app-controle-financeiro-pessoal-gratis/ |
| **Orçamento** por categoria + **metas** + **relatórios/análises** | SPC Brasil, "5 aplicativos para controle financeiro" — https://www.spcbrasil.com.br/blog/aplicativos-para-controle-financeiro |
| **Parcelamento, fixas × variáveis, filtros por conta/categoria/subcategoria, exportar Excel/PDF/CSV/XLS, anexar comprovante, notificação de vencimento** | Ficha "Minhas Finanças" na Microsoft Store: "transações parceladas, fixas e variáveis · Exporte seus dados para Excel, PDF, CSV e XLS · relatórios filtrados por conta, categoria, subcategoria · notificações de vencimento · anexe comprovantes" — https://apps.microsoft.com/detail/9nmdtz8hx2jt |
| **Contas (caixa/banco/cartão/poupança)**, categorias de receita e despesa, exportar CSV/Excel | Ficha "Budget Manager" no Google Play — https://play.google.com/store/apps/details?id=com.diegoapps.budgetmanager |
| **Marcar como pago / pendente / atrasado**, fixas e parceladas, filtros por mês/ano | Ficha "ControlFin" no Google Play — https://play.google.com/store/apps/details?id=com.jsd.controlfin |
| **Importação de extrato bancário** (OFX legado; Open Finance como substituto) | Conta Azul (base de conhecimento): "O OFX continua útil para bancos sem integração e para trazer períodos antigos" — https://ajuda.contaazul.com/hc/pt-br/articles/45352937618701 |
| **Open Finance é regulado pelo Banco Central** (Resolução Conjunta nº 1, de 04/05/2020); escopo inclui saldo, transações, cartões, crédito, câmbio e investimentos | BCB, Resolução Conjunta nº 1/2020 — https://normativos.bcb.gov.br/Lists/Normativos/Attachments/51028/Res_Conj_0001_v4_P.pdf ; escopo por art. 5º resumido em https://www.pluggy.ai/blog/conciliacao-bancaria-open-finance |
| **Formato OFX**: `STMTTRN` (transação), `TRNTYPE`, `DTPOSTED` (YYYYMMDD), `TRNAMT` (decimal com sinal: negativo = saída), `FITID` (id único do banco, chave de deduplicação), `NAME`/`MEMO`; OFX 1.x é SGML (tags internas sem fechamento), 2.x é XML | https://bankxlsx.com/blog/ofx-file-format-explained-tags-structure e https://capyparse.com/blog/what-is-an-ofx-file |

**Conclusão da pesquisa (o que é "essencial", não "enfeite"):**
os apps de referência convergem em sete blocos — **(1)** lançamentos de receita e despesa com
categoria, **(2)** contas/carteiras com saldo, **(3)** orçamento por categoria, **(4)** recorrência
(fixa), parcelamento e status pago/pendente, **(5)** cartão com fatura, **(6)** relatórios
(mês a mês, por categoria) e exportação, **(7)** importação de extrato (OFX/CSV) e, quando houver
parceria regulada, Open Finance. Metas e categorias personalizadas aparecem como diferenciais
recorrentes.

---

## 3. Escopo aprovado para esta refatoração

Pedido do usuário (25/10): *"Estrutura + lacunas essenciais … e também cartão/fatura, metas,
import CSV/OFX e categorias personalizadas"*. Portanto:

**Dentro:**
1. Separar o AnotA de empréstimos/verificação/perfil: `apps/api/src/anota/*` + `routes/anota.ts`
   (as rotas antigas de AnotA saem de `minhas.ts`, que fica com os outros domínios).
2. Domínio novo: **conta/carteira** (saldo), **receita**, **orçamento por categoria**,
   **categoria personalizada**, **cartão + fatura**, **meta**, **recorrência e parcelamento**,
   **status pago/pendente**, **relatório mês a mês**, **importação CSV/OFX**, **exportação** e
   **backup por e-mail** (o usuário digita o e-mail na tela do AnotA).
3. Tela do AnotA reescrita em componentes pequenos (`apps/web/src/anota/`), mantendo a regra de
   UI já acordada: simples, sem sanfona/colapsável, sem seta de expandir.
4. Testes de domínio (funções puras), de rota (HTTP) e do Prisma (Postgres local), e E2E de API
   com dados reais.

**Fora (declarado, não simulado):**
- **Open Finance**: exige ser participante autorizado pelo BCB ou contratar agregador
  (Pluggy/Belvo). Não vou fingir integração; fica como porta documentada (§7).
- Investimentos, cripto, câmbio, previdência: fora do escopo.
- Multiusuário/família, offline, PIN: não pedidos.
- Nada fora do AnotA é tocado: empréstimos, verificação, perfil, jurídico, licitações, concursos,
  investiga e o NCA continuam como estão (só o `import` de `minhas.ts` muda porque as rotas do
  AnotA saem de lá — mudança mecânica, coberta por teste).

---

## 4. Arquitetura alvo

```
apps/api/src/anota/
  tipos.ts        DTOs + contratos (Conta, Categoria, Lancamento, Orcamento, Cartao, Meta)
  dominio.ts      funções PURAS: saldo, orçamento vs realizado, fatura, parcelamento,
                  recorrência, relatório mês a mês, CSV (export/import), OFX (parse+dedupe)
  service.ts      AnotaStore (interface) + InMemoryAnotaStore
  prisma.ts       PrismaAnotaStore (implementa a mesma interface)
  email.ts        BackupEmailProvider: SMTP (nodemailer) | Resend (HTTP) | nenhum
apps/api/src/routes/anota.ts   rotas /api/anota/*
apps/api/src/routes/minhas.ts  fica só com empréstimos/dívidas/verificação/perfil
apps/web/src/anota/*.tsx       telas: Resumo, Lancamentos, Contas, Orcamento, Cartoes, Metas,
                               Relatorio, Notas, Backup
```

**Compatibilidade:** as rotas `/api/minhas/notas|gastos|resumo|export.csv|gastos/ocr` continuam
respondendo (aliases finos para as novas), para não quebrar bot, testes antigos e o app já
instalado. As novas rotas vivem em `/api/anota/*`. Os modelos `Nota` e `Gasto` do Prisma são
mantidos e **estendidos com colunas anuláveis** (nada de reescrever dados existentes).

### Modelo de dados (aditivo — `prisma db push` no boot já aplica)

| Modelo | Campos principais |
|---|---|
| `AnotaConta` | `id, userId, nome, tipo(caixa|banco|cartao|poupanca), saldoInicialCents, arquivada` |
| `AnotaCategoria` | `id, userId, nome, tipo(despesa|receita), cor, icone, arquivada` |
| `Gasto` (existe) | + `contaId?, categoriaId?, status(pago|pendente), vencimento?, parcelaDe?, parcelaNum?, parcelasTotal?, fitId?, origem(manual|csv|ofx)` |
| `AnotaReceita` | espelho de `Gasto` para entradas (`amountCents`, `contaId`, `categoriaId`, `recebidoEm`, status…) |
| `AnotaOrcamento` | `id, userId, categoriaId, ym, limiteCents` (único por user+categoria+mês) |
| `AnotaCartao` | `id, userId, contaId, nome, limiteCents, fechamentoDia, vencimentoDia` |
| `AnotaMeta` | `id, userId, nome, alvoCents, guardadoCents, prazo?` |
| `AnotaBackup` | `id, userId, email, criadoEm, bytes, itens, status, erro` (auditoria do envio) |

Regras de dinheiro: **inteiro em centavos** em todo o domínio (nada de float), como já é hoje.

---

## 5. Fases e critérios de aceite

| Fase | Entrega | Critério de aceite (verificável) |
|---|---|---|
| F0 | Backup do código atual | `.zip` + `MANIFEST.json` com SHA-256 de cada arquivo; restauração conferida por hash |
| F1 | Domínio puro + testes | `saldo`, `orcamentoVsRealizado`, `fatura`, `parcelar` (com arredondamento sem perder centavo), `recorrencias`, `relatorioMensal`, `parseOfx` (SGML e XML, dedupe por `FITID`), `importCsv` — todos com teste determinístico |
| F2 | Store + rotas | `/api/anota/*` com 401 sem token, validação zod, isolamento por `userId` (teste de um usuário não ler dado do outro) |
| F3 | Prisma | mesmos casos rodando contra Postgres local; `db push` aplica sem perder linha existente |
| F4 | Web | `tsc` limpo, tela sem sanfona, todos os fluxos usáveis no celular |
| F5 | Backup por e-mail | provedor real (SMTP) testado contra servidor SMTP local; sem credencial → **503 com motivo**, nunca "enviado" falso |
| F6 | Regressão | suíte completa da API + web verde; aliases antigos respondendo; bot/telegram intacto |

---

## 6. Backup e e-mail (pedido explícito do usuário)

- **F0**: antes de qualquer alteração, empacoto o AnotA atual (código-fonte, schema, testes) num
  `.zip` com manifesto de hashes; o arquivo fica no workspace para download imediato.
- **No app**: tela *Backup* do AnotA com **campo de e-mail digitado pelo usuário**. O e-mail fica
  salvo no perfil do próprio usuário; o botão gera o `.zip` no servidor (dados dele: contas,
  lançamentos, orçamentos, metas, notas) e envia pelo provedor configurado.
- **Provedores suportados** (nessa ordem): `SMTP_*` via nodemailer, `RESEND_API_KEY` via HTTP.
  Sem nenhum dos dois o endpoint responde **503 `email_nao_configurado`** com instrução — o
  arquivo continua disponível para download. Não há simulação de envio.

---

## 7. Riscos e decisões registradas

1. **`db push` em produção** já roda no boot (`deploy/start.sh`); mudanças são **aditivas**
   (modelos novos + colunas anuláveis), então dados existentes não são reescritos.
2. **Contrato antigo**: manter aliases custa pouco e evita quebrar bot/testes; a limpeza dos
   aliases fica para quando houver certeza de que nenhum cliente os usa.
3. **Open Finance** fica fora até existir agregador contratado — decisão do usuário, registrada
   aqui para não virar promessa vazia.
4. **Categorias**: hoje são string livre; migro para tabela própria com seed das 7 categorias
   atuais, aceitando string antiga na importação (compatibilidade).
5. **Arredondamento de parcelamento**: a soma das parcelas tem de fechar exatamente o total
   (a última parcela absorve a diferença de centavos) — teste dedicado.

---

## 8. Fontes consultadas (todas acessadas em 25/10/2026)

- Organizze — ficha oficial na App Store (BR): https://apps.apple.com/br/app/organizze-finan%C3%A7as-pessoais/id677699286
- iDinheiro — comparativo de apps de controle financeiro: https://www.idinheiro.com.br/financaspessoais/app-controle-financeiro-pessoal-gratis/
- SPC Brasil — "5 aplicativos para controle financeiro": https://www.spcbrasil.com.br/blog/aplicativos-para-controle-financeiro
- Microsoft Store — "Minhas Finanças" (lista de recursos): https://apps.microsoft.com/detail/9nmdtz8hx2jt
- Google Play — "Budget Manager": https://play.google.com/store/apps/details?id=com.diegoapps.budgetmanager
- Google Play — "ControlFin": https://play.google.com/store/apps/details?id=com.jsd.controlfin
- Conta Azul — integração bancária via OFX: https://ajuda.contaazul.com/hc/pt-br/articles/45352937618701
- Banco Central do Brasil — Resolução Conjunta nº 1/2020 (Open Finance): https://normativos.bcb.gov.br/Lists/Normativos/Attachments/51028/Res_Conj_0001_v4_P.pdf
- Pluggy — conciliação bancária e escopo do Open Finance: https://www.pluggy.ai/blog/conciliacao-bancaria-open-finance
- BankXLSX — estrutura de arquivo OFX: https://bankxlsx.com/blog/ofx-file-format-explained-tags-structure
- CapyParse — OFX 1.x (SGML) × 2.x (XML): https://capyparse.com/blog/what-is-an-ofx-file

---

## 9. Execução — o que foi entregue (25/10/2026)

### 9.1 Backend (novo pacote `apps/api/src/anota/`)

| Arquivo | Papel |
| --- | --- |
| `tipos.ts` | DTOs (Conta, Categoria, Lançamento, Orçamento, Cartão, Fatura, Meta, Nota, Backup). Dinheiro sempre em **centavos inteiros**; datas `YYYY-MM-DD`; mês `YYYY-MM`. |
| `dominio.ts` | Regras puras: `saldoConta`, `resumoMes`, `orcamentoStatus`, `parcelar`, `ocorrenciasRecorrentes`, `faturaCartao`, `relatorio`, `importarCsv`, `parseOfx`, `exportarCsv`. Zero I/O — por isso é testável de ponta a ponta. |
| `store.ts` | `AnotaStore` (interface) + `InMemoryAnotaStore` usado nos testes de rota. |
| `prisma.ts` | `PrismaAnotaStore` — persistência real (Postgres). |
| `zip.ts` | Escritor de ZIP próprio (deflate + CRC32 + diretório central), sem dependência nova. |
| `email.ts` | Provedores honestos: SMTP (nodemailer) → Resend → `null`. Sem provedor, `enviarEmail` devolve `nao_configurado`; **nunca** finge envio. |

Rotas em `apps/api/src/routes/anota.ts` (todas escopadas por `claims.sub`):

`GET/POST/PUT /api/anota/contas` · `GET/POST /api/anota/categorias` · `GET/POST/PUT/DELETE
/api/anota/lancamentos` (parcelas 2..48, recorrência 1..60) · `GET /api/anota/resumo?ym=` ·
`GET/POST/DELETE /api/anota/orcamentos` · `GET/POST /api/anota/cartoes` +
`GET /api/anota/cartoes/:id/fatura?ym=` · `GET/POST/PATCH /api/anota/metas` ·
`GET /api/anota/relatorio?ym=&meses=` · `POST /api/anota/importar` (csv/ofx com dedupe) ·
`GET /api/anota/export.csv` · `POST /api/anota/ocr` ·
`GET/POST/PUT/DELETE /api/anota/notas` · `GET /api/anota/backup`, `GET /api/anota/backup/arquivo`,
`POST /api/anota/backup`.

**Aliases antigos** (`/api/minhas/notas`, `/gastos?mes=`, `/resumo?mes=`, `/export.csv`) continuam
respondendo no formato velho (`spentAt`, `topCategorias`) e são **somente leitura** — escrita do
AnotA tem uma porta só: `/api/anota/*`.

### 9.2 Frontend (`apps/web/src/anota/`)

`AnotaScreen.tsx` (casca com 6 abas) + `ui.ts`, `Lancamentos.tsx`, `Planejar.tsx`,
`Relatorio.tsx`, `Backup.tsx`. A regra da tela foi respeitada: **sem sanfona, sem seta de
expandir**, nada de painel poluído — cada assunto é uma aba, cada ação é um toque.

Tela *Backup*: campo **“Seu e-mail”** (o usuário digita o próprio endereço, `emailSugerido` vem
só como conveniência), botão **Enviar para meu e-mail**, botão **Baixar ZIP agora**, aviso
explícito quando o servidor não tem provedor e histórico de envios com status real
(`enviado` / `falhou` / `nao_configurado`).

### 9.3 Bugs reais encontrados e corrigidos no caminho

1. **Recorrência com data completa** — `ocorrenciasRecorrentes` recebe mês `YYYY-MM`; passar
   `2026-03-10` devolvia 500 “mês inválido”. Corrigido para `addMeses(...).slice(0,7)`.
2. **OFX 1.x SGML detectado como XML** — o SGML também fecha `</STMTTRN>`; a detecção agora só
   olha `<?xml` / `<?OFX`.
3. **CSV reimportado duplicava tudo** — o importador de CSV não lia identificador de linha.
   Agora lê `fitid`/`fit_id`/`id`/`documento` e, quando não há, usa chave natural
   `data+tipo+valor+descrição` com contador de ocorrência (dois cafés iguais no mesmo dia
   continuam sendo dois lançamentos; reimportar o mesmo arquivo não cria nada).
4. **`exactOptionalPropertyTypes`** — patches opcionais vazavam `undefined` para o Prisma;
   helper `limpar()` resolve nos três pontos de atualização.

### 9.4 Testes executados (resultado real, 25/10/2026)

- `tsc -b --force` em `apps/api` e `apps/web`: **0 erros**.
- `vitest run test/anota.test.ts`: **37 ✔** — domínio puro, rotas por `inject`, ZIP, e-mail
  (**SMTP real** em socket TCP), dedupe de CSV/OFX e `PrismaAnotaStore` contra o Postgres local.
- Suíte completa da API: **552 ✔ / 1 skip** (47 arquivos). Web: **18 ✔**. Shared: **12 ✔**.
- **E2E `apps/api/scripts/e2e-anota.mjs`: 22/22 passos verdes** — sobe `dist/server.js` de
  verdade contra o Postgres local, com servidor SMTP de verdade, e percorre login → conta →
  categoria → lançamentos (à vista, 3x somando o total, recorrente 3 meses) → import CSV com e
  sem FITID → OFX → resumo → orçamento → cartão/fatura → meta → relatório → export.csv → OCR →
  backup por e-mail (o socket SMTP recebe a mensagem com o ZIP anexado) → download do ZIP →
  histórico → 401 sem token. Rodar: `node scripts/e2e-anota.mjs` depois de `tsc -b`.
- **OCR**: com tesseract ausente o endpoint devolve `texto: ""` e `engine: "manual"` — nada
  inventado (o E2E falha se algum engine “manual” devolver texto).

### 9.5 O que continua fora (declarado, não fingido)

- **Open Finance**: sem agregador contratado. Importação é por CSV/OFX.
- **Envio de e-mail em produção**: o Render hoje **não tem** `SMTP_*` nem `RESEND_*`. A tela
  avisa e o ZIP sai por download; ao configurar SMTP/Resend o mesmo botão passa a enviar.
- **`SMTP_*` e `RESEND_*` não foram inventados** em env nenhum — nada de credencial de mentira.

### 9.6 Acoplamento que sobrou — e foi cortado (25/10, depois da entrega)

Na primeira entrega o AnotA já tinha rota, store e tela próprios, mas **ainda dependia de código
físico do módulo de empréstimos**:

- `routes/anota.ts` importava `OcrProvider` e `manualOcr` de `src/minhas/service.ts`;
- `server.ts` montava o OCR do AnotA a partir de `src/minhas/ocr.ts` (`detectTesseract`);
- `src/minhas/service.ts` e `PrismaMinhasStore` (em `store-prisma.ts`) eram o store antigo de
  notas/gastos — código **do AnotA morando dentro do módulo de empréstimos**;
- `minhasRoutes` recebia `store: MinhasStore` e **nunca usava** o parâmetro.

Cortado: o OCR foi para `apps/api/src/anota/ocr.ts` (porta + `manualOcr` + `TesseractOcr`),
`src/minhas/` foi **removido**, `PrismaMinhasStore` foi apagado (o AnotA já tem
`PrismaAnotaStore`) e `minhasRoutes` ficou só com `jwt`, `loans`, `verificacao`, `upsertUser`.
Empréstimo, verificação e perfil seguem com o mesmo comportamento — nenhuma rota mudou.

Para não voltar por descuido, duas regras entraram no `test/architecture.test.ts`:

1. nada em `apps/api/src/anota/` pode importar `emprestimos/`, `juridico/`, `licitacoes`,
   `concursos`, `osint/`, `nucleo/`, `routes/minhas` ou `minhas/`;
2. `apps/api/src/minhas` não existe e nenhuma rota importa de lá.

Resultado depois do corte: `tsc -b --force` 0 erros, suíte da API **552 ✔ / 1 skip**
(`architecture.test.ts` foi de 7 para 9 testes), `anota.test.ts` **37 ✔**,
E2E **22/22**.

**Estado da separação:** AnotA e empréstimo são produtos separados em rota, domínio, store e
tela (abas “AnotA” e “Empréstimos” no app). O único elo que existe é de **dado**, não de código:
`GET /api/minhas/dividas` (Caderno de Dívidas) e o AnotA olham o mesmo usuário — se um dia as
parcelas do empréstimo tiverem de aparecer como despesa no AnotA, isso entra como integração
explícita, com teste, e não como import cruzado.
