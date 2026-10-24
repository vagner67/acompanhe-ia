# Plano de teste fim a fim — múltiplos usuários (2026-10-24)

> Regras deste plano (pedido do usuário, 24/10): **sem simulação, sem síntese, nada genérico/superficial.**
> Todo caso de teste amarra numa rota/tela real do código (arquivo:linha abaixo). Nada é marcado
> concluído sem prova colhida por ferramenta (stdout de script, resposta HTTP crua, log).
> Erros encontrados vão para `docs/e2e-erros.md` com evidência e são corrigidos antes do fim.

---

## 1. Superfície real testável (inventário do código, 24/10)

Rotas registradas em `apps/api/src/server.ts:113-189` + módulos:

| Módulo | Rotas (evidência `grep app.(get|post|...)`) | Arquivo |
|---|---|---|
| Auth/sessão | `POST /api/auth/telegram`, `POST /api/auth/telegram/dev`, `GET /api/me` | `server.ts:113,133,145` |
| Webhook pagamento | `POST /api/webhooks/pushinpay` | `server.ts:155` |
| Health | `GET /health` (prova Postgres) | `server.ts:189` |
| AnotA/gastos | `GET|POST /api/minhas/notas`, `PUT|DELETE /api/minhas/notas/:id`, `GET|POST /api/minhas/gastos`, `PUT|DELETE /api/minhas/gastos/:id`, `POST /api/minhas/gastos/ocr`, `GET /api/minhas/resumo`, `GET /api/minhas/export.csv`, `GET /api/minhas/emprestimos`, `GET /api/minhas/dividas` | `routes/minhas.ts:66-205` |
| Perfil/verificação | `GET|POST /api/minhas/verificacao`, `POST /api/minhas/perfil` | `routes/minhas.ts:205-229` |
| Planos/assinaturas | `GET /api/planos`, `POST /api/assinaturas/checkout`, `GET /api/assinaturas`, `POST /api/assinaturas/trial`, `GET /api/assinaturas/pagamentos` | `routes/assinaturas.ts:60-113` |
| Concursos | `GET /api/concursos`, `GET /api/concursos/:externalId`, `GET /api/concursos/alertas`, `POST /v1/admin/concursos/ingesta` | `routes/concursos.ts:66-92` |
| Empréstimos | `GET /api/feed/emprestimos`, `POST /api/loan-requests`, `POST /api/loan-requests/:id/interesse`, `GET /api/loan-matches`, `GET /api/loan-matches/:id`, `POST .../aceitar`, `POST .../rodadas`, `POST /api/payments/declare`, `POST /api/payments/confirm` | `routes/emprestimos.ts:48-136` |
| Investiga | `POST|GET /v1/investiga/cases`, `GET cases/:id`, `POST cases/:id/run`, `GET cases/:id/report|alerts|export.csv|export.pdf`, `GET /v1/investiga/quota`, `POST /v1/admin/investiga/trial` | `routes/investiga.ts:91-204` |
| Gamificação | `GET /api/gamificacao`, `POST /api/gamificacao/acao`, `GET|POST /api/gamificacao/ranking` | `gamificacao/routes.ts:27-49` |
| Admin (RBAC) | `POST /v1/admin/auth/login|password`, `GET /v1/admin/auth/me|kpis|operadores|verificacoes|rules|audit|db/:tabela`, `POST operadores|operadores/:id/active|verificacoes/:userId/aprovar|reprovar|assinaturas/conceder|rules|rules/:id/rollback` | `routes/admin.ts:105-263` |

Telas do app — 8 abas em `apps/web/src/App.tsx:8-16` (inicio, anota, licitacoes, concursos, juridico, emprestimos, investiga, planos) + `AdminScreen` (`screens.tsx:899`) **fora do app** em `/admin.html`.
SKUs reais (`packages/shared/src/skus.ts:19-65`): anota R$14,90 · juridica R$39,90 · licitacao R$49,90 · concurso R$24,90 · investiga R$59,90 · trial 7 dias (`/api/planos` confirmado ao vivo).

Licitações/PNCP e Jurídico são chamadas de rede reais (PNCP/tribunais) — casos marcam `rede-externa` e aceitam falha de rede como **S4-externo**, não como bug do app.

---

## 2. Matriz de usuários (criação real, não simulada)

Criados por `POST /api/auth/telegram/dev` (real, porta 5173/3000) + rotas admin + `prisma` quando o
estado não tem API (ex.: expirar trial). Script: `tools/e2e/create-users.mjs` (fase 1).

| ID | persona | estado inicial (como criar, de verdade) | o que testa |
|---|---|---|---|
| `e2e-u1` | Léo, curioso, sem plano | dev-auth cru | onboarding, bloqueios de plano, trial oferecido |
| `e2e-u2` | Marina, trial ativo | `POST /api/assinaturas/trial` | tudo liberado no trial, XP/missões |
| `e2e-u3` | Carlos, trial **expirado** | trial + `UPDATE` Prisma em `Subscription.endsAt` no passado | paywall correto em cada produto |
| `e2e-u4` | Ana, assinante AnotA | `POST /v1/admin/assinaturas/conceder {planCode:"anota"}` | AnotA liberado, demais bloqueados |
| `e2e-u5` | Rui, assinante Investiga | conceder `investiga` | cases, run, relatório, quota, exportações |
| `e2e-u6` | Bia, usuária pesada | dev-auth + seed de 10 notas/10 gastos/2 dívidas via API | busca, export.csv, resumo, OCR, paginação |
| `e2e-u7` | João, verificação pendente | `POST /api/minhas/verificacao` com documento | fluxo aprovar/reprovar no admin |
| `e2e-u8` | Diretor + 1 operador | login `ADMIN_TOKEN` (`admin.ts:105`); operador criado por ele (`POST /v1/admin/operadores`) | RBAC: operador só `/api/*`, diretor `/v1/admin/*` |

Todos com `tgUserId` estável (`e2e-uN`) para reexecução idempotente. Nada de usuário genérico "test1/test2" — cada um tem persona e cobertura declarada.

---

## 3. Casos de teste fim a fim (cada um: pré-condição → passos reais → esperado → prova)

Formato da prova esperada: linha de stdout do runner com `CÓDIGO | status/resultado | evidência`.

### F1 — Autenticação e sessão
- **TC-A01** dev-auth emite JWT (`POST /api/auth/telegram/dev {"userId":"e2e-u2"}`) → `token` JWT assinado; `GET /api/me` devolve `tgUserId=e2e-u2`.
- **TC-A02** `GET /api/me` sem token → 401; token adulterado → 401. Prova: status codes crus.
- **TC-A03** dev-auth em produção responde 404 (já coberto por `dev-auth.test.ts`; mantém na regressão).

### F2 — Home e gamificação
- **TC-G01** `POST /api/gamificacao/acao {"acao":"nota_criada"}` → xpGanho>0, missão avança (`gamificacao/routes.ts:33`).
- **TC-G02** duas ações iguais seguidas → política de XP real (sem duplicar quando não deve); `GET /api/gamificacao` reflete o total.
- **TC-G03** `POST /api/gamificacao/ranking` + `GET` → ranking lista usuários e2e com posições.

### F3 — AnotA (notas + gastos) — `routes/minhas.ts`
- **TC-N01** CRUD completo de notas: POST → GET(:id) → PUT(pin/tags) → GET?q= → DELETE → GET 404/ausente.
- **TC-N02** busca e export: `GET /api/minhas/export.csv` contém cabeçalho + linhas do usuário **e apenas dele**.
- **TC-N03** gastos CRUD + categorias; `GET /api/minhas/resumo` bate com a soma dos gastos criados (conferência numérica exata).
- **TC-N04** OCR real: `POST /api/minhas/gastos/ocr` com imagem de comprovante (arquivo real em `tools/e2e/fixtures/`) → retorna valor/data ou erro explícito do tesseract — nunca 500 sem corpo.
- **TC-N05** isolamento: nota de `e2e-u2` **não** aparece nas buscas de `e2e-u4` (autorização cruzada).

### F4 — Licitações (rede externa PNCP)
- **TC-L01** busca/lista carrega ou erro de rede tratado com mensagem na tela (S4 se externo).
- **TC-L02** favoritar/salvar licitação persiste (API ou storage — conforme implementação real; caso documenta qual).

### F5 — Concursos — `routes/concursos.ts`
- **TC-C01** `GET /api/concursos` lista reais; `GET /api/concursos/:externalId` detalhe.
- **TC-C02** `GET /api/concursos/alertas` + ação de alerta na tela → alerta do usuário criado.
- **TC-C03** `POST /v1/admin/concursos/ingesta` (diretor) ingere e aparece na lista.

### F6 — Jurídico (rede externa)
- **TC-J01** consulta jurídica retorna resultado ou erro externo tratado (S4 se externo).

### F7 — Empréstimos — `routes/emprestimos.ts`
- **TC-E01** `POST /api/loan-requests` (u4 pede empréstimo) → `GET /api/feed/emprestimos` (u6 vê) → `POST /api/loan-requests/:id/interesse` → match criado.
- **TC-E02** `POST /api/loan-matches/:id/aceitar` + `POST /api/loan-matches/:id/rodadas` → rodada registrada.
- **TC-E03** `POST /api/payments/declare` + `POST /api/payments/confirm` → pagamento confirmado, dívida atualiza em `GET /api/minhas/dividas`.
- **TC-E04** valores negativos/ausentes → 4xx validado (nunca 500).

### F8 — Investiga — `routes/investiga.ts`
- **TC-I01** `POST /v1/investiga/cases` (u5) → `GET cases/:id` → `POST cases/:id/run` (Sherlock real de `tools/`) → `GET cases/:id/report` com achados.
- **TC-I02** `GET cases/:id/alerts` + `export.csv` + `export.pdf` → arquivos não vazios, cabeçalhos corretos.
- **TC-I03** `GET /v1/investiga/quota` → cota do plano; usuário sem plano tenta `POST cases` → bloqueio honesto (4xx com mensagem).
- **TC-I04** `POST /v1/admin/investiga/trial` (diretor) concede → quota reflete.

### F9 — Planos e assinaturas — `routes/assinaturas.ts`
- **TC-P01** `GET /api/planos` → 5 SKUs + trialDias=7 (valores exatos de `skus.ts`).
- **TC-P02** `POST /api/assinaturas/checkout` com `idempotencyKey` → estado atual **real**: `503 PUSHINPAY_NOT_CONFIGURED` (PushinPay fora, decisão do usuário 23/10 — **não é bug**, registrar como `estado-conhecido`). Re-executar quando `PUSHINPAY_TOKEN` existir.
- **TC-P03** `POST /api/assinaturas/trial` para `e2e-u1` → trial ativo; segunda chamada → idempotente/negado.
- **TC-P04** `POST /v1/admin/assinaturas/conceder` → `GET /api/assinaturas` do usuário reflete o plano.
- **TC-P05** trial expirado (u3): cada produto bloqueia com mensagem + CTA de plano (validação por API e por tela).

### F10 — Verificação de identidade
- **TC-V01** `POST /api/minhas/verificacao` (u7) → `GET /v1/admin/verificacoes` lista pendente → `POST .../aprovar` → `GET /api/minhas/verificacao` mostra aprovada.
- **TC-V02** reprova com motivo → aparece para o usuário.

### F11 — Painel admin (fora do app) — `routes/admin.ts` + `admin.html`
- **TC-R01** login diretor (`ADMIN_TOKEN`) → `GET /v1/admin/kpis` bate com os dados reais criados pelos testes (conferência de contagens).
- **TC-R02** RBAC: operador logado chamando `/v1/admin/*` → 403; chamando `/api/*` do app → 200.
- **TC-R03** operadores: criar, desativar (`operadores/:id/active`), listar.
- **TC-R04** rules: criar regra de preço → rollback (`rules/:id/rollback`) → preço volta (ex.: investiga 5990).
- **TC-R05** audit: ações dos casos anteriores aparecem em `GET /v1/admin/audit`.
- **TC-R06** `GET /v1/admin/db/:tabela` só para diretor; operador 403.
- **TC-R07** senha: `POST /v1/admin/auth/password` troca e loga com a nova (troca de volta no fim).

### F12 — Bot Telegram (@acompanha_bot)
- **TC-B01** `getMe` ok; `setChatMenuButton` aponta para a URL do túnel atual (evidência: resposta da API).
- **TC-B02** `/start` no chat real do usuário (quando ele enviar) → botão "Abrir o app" com a URL nova (evidência: `message_id` + log `[bot] update chat_id=...`).
- **TC-B03** webapp abre pelo botão (teste manual guiado + print/relato do usuário).

### F13 — Segurança e robustez
- **TC-S01** rotas inexistentes → 404 JSON; corpo vazio em POST → 4xx (não 500).
- **TC-S02** `GET /health` → `{"db":"ok"}`; com Postgres parado (teste controlado no fim) → 503.
- **TC-S03** JWT de um usuário em rota de outro recurso → sem vazamento (reforço de TC-N05 em notas, gastos, cases, dívidas).

### F14 — Concorrência e persistência
- **TC-X01** 5 usuários fazem POST simultâneo (Promise.all real) → todos 2xx, contagens corretas.
- **TC-X02** reler tudo após os testes (mesmo banco) → dados persistem (prova: SELECT/GET).

---

## 4. Harness de execução (mecânica real)

| Nível | O quê | Como roda | Saída |
|---|---|---|---|
| 1 | Regressão da suíte atual (222) | `npx vitest run` na raiz | verde/vermelho |
| 2 | Runner E2E dos fluxos acima | `node tools/e2e/run-e2e.mjs` contra o stack ao vivo (portas 3000/5173) | `docs/relatorio-e2e.md` + `docs/e2e-erros.md` |
| 3 | Smoke do bot | script `tools/e2e/bot-smoke.mjs` (getMe, menu button, sendMessage p/ chat real quando houver) | anexado ao relatório |

O runner cria os usuários (fase 1), executa os TCs em ordem de dependência (F1→F14) e **para em cada falha
apenas para registrar** — segue testando o resto (para o relatório completo), nunca descarta falha.

---

## 5. Relatório de erros (`docs/e2e-erros.md`) — formato obrigatório por bug

```
### [S?] TC-XXX — título curto
- Severidade: S1 (impede uso) | S2 (funcionalidade quebrada) | S3 (degrada) | S4 (externo/cosmético)
- Repro: comando/curl exato ou passos na tela
- Esperado: X — Atual: Y (resposta crua/colada)
- Evidência: stdout/print/arquivo anexado (sem evidência não vale)
- Suspeita de causa: arquivo:linha (quando o teste apontar)
- Status: aberto → corrigido → re-testado (TC-XXX verde)
```

Prioridade de correção: S1 → S2 → S3. S4-externo fica registrado, sem correção no app.
Estado "PushinPay não configurado" entra como `estado-conhecido`, não como bug.

---

## 6. Ordem de execução e critérios de conclusão

**Fases:** P0 religar stack (Postgres/API/web/túnel/bot — já feito) → P1 criar usuários → P2 F1+F13 (base) →
P3 produtos (F3–F8) → P4 monetização (F9–F10) → P5 admin/RBAC (F11) → P6 bot (F12) → P7 F14 + regressão (nível 1) → relatório.

**Critérios de fim (todos obrigatórios):**
1. Todos os TCs executados com resultado registrado (não vale "não rodou").
2. Zero bugs S1/S2 abertos — os demais documentados com evidência e plano de correção.
3. Suíte de regressão verde no final.
4. `docs/relatorio-e2e.md` publicado com: usuários criados, TCs por fluxo (passou/falhou/S4), bugs por severidade, evidências anexadas.
5. Nada marcado feito sem prova por ferramenta colada no relatório.
