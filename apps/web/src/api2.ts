/** Cliente da API — URLs relativas (proxy do Vite dev server). */
import { getInitData } from "./telegram";

const BASE = import.meta.env.VITE_API_BASE ?? "";

export interface Sessao {
  token: string;
  user: { id: string; tgUserId: string; firstName: string; username: string | null };
}

let sessao: Sessao | null = null;
export function setSessao(s: Sessao | null) {
  sessao = s;
}
export function getSessao() {
  return sessao;
}

function headers(token?: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
}

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function authenticate(): Promise<Sessao> {
  const res = await fetch(`${BASE}/api/auth/telegram`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ initData: getInitData() }),
  });
  const s = await j<Sessao>(res);
  sessao = s;
  return s;
}

export function api(token: string) {
  const get = <T>(url: string) => fetch(`${BASE}${url}`, { headers: headers(token) }).then(j<T>);
  const post = <T>(url: string, body?: unknown) =>
    fetch(`${BASE}${url}`, { method: "POST", headers: headers(token), body: body === undefined ? "{}" : JSON.stringify(body) }).then(j<T>);
  const patch = <T>(url: string, body: unknown) =>
    fetch(`${BASE}${url}`, { method: "PATCH", headers: headers(token), body: JSON.stringify(body) }).then(j<T>);
  const del = <T>(url: string) => fetch(`${BASE}${url}`, { method: "DELETE", headers: headers(token) }).then(j<T>);

  return {
    me: () => get<{ tgUserId: string; username: string | null }>("/api/me"),
    // —— planos/assinaturas ——
    planos: () => get<{ planos: PlanoDto[]; trialDias: number; trialDisponivel: boolean }>("/api/planos"),
    assinatura: () => get<StatusAssinatura>("/api/assinaturas"),
    checkout: (planCode: string, period: "monthly" | "yearly") =>
      post<{ paymentId?: string; pix?: { copiaECola?: string; qrCodeBase64?: string } | null; aviso?: string; error?: string }>(
        "/api/assinaturas/checkout",
        { planCode, period, idempotencyKey: `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
      ),
    trial: (planCode: string) => post<{ ok: boolean; rule?: string; record?: { expiresAt: string } }>("/api/assinaturas/trial", { planCode }),
    pagamentos: () => get<{ pagamentos: Array<{ id: string; planCode: string; amountCents: number; status: string; createdAt: string }> }>("/api/assinaturas/pagamentos"),
    // —— gamificação ——
    gamificacao: () => get<Gamificacao>("/api/gamificacao"),
    acao: (acao: string) => post<AwardResult>("/api/gamificacao/acao", { acao }),
    rankingToggle: (participar: boolean) => post("/api/gamificacao/ranking", { participar }),
    // —— AnotA (minhas) ——
    notas: () => get<{ notas: NotaDto[] }>("/api/minhas/notas"),
    notaCriar: (nota: { title: string; body?: string; tags?: string[] }) => post<{ nota: NotaDto }>("/api/minhas/notas", nota),
    notaBuscar: (q: string) => get<{ notas: NotaDto[] }>(`/api/minhas/notas?q=${encodeURIComponent(q)}`),
    gastos: (mes?: string) => get<{ gastos: GastoDto[] }>(`/api/minhas/gastos${mes ? `?mes=${mes}` : ""}`),
    gastoCriar: (g: { amountCents: number; category: string; description: string; spentAt: string }) => post<{ gasto: GastoDto }>("/api/minhas/gastos", g),
    gastoExcluir: (id: string) => del(`/api/minhas/gastos/${id}`),
    ocr: (imageBase64: string) => post<{ texto: string; chars: number }>("/api/minhas/gastos/ocr", { imageBase64 }),
    resumo: (mes: string) => get<{ totalCents: number; porCategoria: Record<string, number>; topCategorias: Array<[string, number]> }>(`/api/minhas/resumo?mes=${mes}`),
    exportCsv: (mes: string) => fetch(`${BASE}/api/minhas/export.csv?mes=${mes}`, { headers: headers(token) }).then((r) => r.text()),
    verificacao: () => get<{ status: string; level: string | null; campos: unknown | null }>("/api/minhas/verificacao"),
    verificacaoEnviar: (campos: { docTipo: "cnh" | "rg" | "cpf" | "passaporte"; selfieAt?: string }) => post<{ ok: boolean }>("/api/minhas/verificacao", campos),
    perfil: () => get<{ perfil: Record<string, unknown> }>("/api/minhas/perfil"),
    perfilSalvar: (p: { uf: string; cityIbge: number }) => post("/api/minhas/perfil", p),
    emprestimos: () => get<{ requests: LoanRequestDto[] }>("/api/minhas/emprestimos"),
    dividas: () => get<{ totalCents: number; abertos: number; items: LoanMatchDto[] }>("/api/minhas/dividas"),
    // —— Investiga ——
    invQuota: () => get<{ window: { used: number; limit: number; resetAt: string } }>("/v1/investiga/quota"),
    invCasos: () => get<{ cases: Array<{ id: string; title: string; status: string; createdAt: string }> }>("/v1/investiga/cases"),
    invCriarCaso: (title: string) => post<{ case: { id: string } }>("/v1/investiga/cases", { title }),
    invDocumento: (caseId: string, doc: string, kind?: string) =>
      post<{ document: { id: string; kind: string; ref: string } }>(`/v1/investiga/cases/${caseId}/documents`, { content: doc, ...(kind ? { kind } : {}) }),
    invConsulta: (caseId: string, documentId: string) => post<{ finding: { id: string } }>(`/v1/investiga/cases/${caseId}/queries`, { documentId }),
    invEstimativa: (caseId: string, alvo: string) =>
      post<{ monthlyCents: number; note: string }>(`/v1/investiga/cases/${caseId}/estimativa`, { nome: alvo }),
    invAlerta: (caseId: string, nome: string) =>
      post<{ monitor: { topic: string } }>(`/v1/investiga/cases/${caseId}/monitor`, { nome, topic: `osint_${caseId}` }),
    invDeepDive: (caseId: string, nome: string, extra?: unknown) =>
      post<{ relatorio: string; findings: number }>(`/v1/investiga/cases/${caseId}/deep-dive`, { nome, ...(extra ? { extra } : {}) }),
    // —— Licitações ——
    licitacoesBusca: (q: string, ufs?: string) =>
      get<{ items: Array<Record<string, unknown>>; count: number }>(`/api/licitacoes/busca?q=${encodeURIComponent(q)}${ufs ? `&ufs=${ufs}` : ""}`),
    licitacoesInteresses: () => get<{ interests: Array<{ topic: string; query: unknown }> }>("/api/licitacoes/interesses"),
    licitacaoInteresse: (topic: string, query: unknown) => post("/api/licitacoes/interesses", { topic, query }),
    licitacaoRemoverInteresse: (topic: string) => del(`/api/licitacoes/interesses/${topic}`),
    filtros: (produto: "licitacoes" | "concursos") => get<{ filters: Array<{ name: string; filter: unknown }> }>(`/api/${produto}/filtros`),
    filtroSalvar: (produto: "licitacoes" | "concursos", name: string, filter: unknown) => post(`/${produto === "licitacoes" ? "api/licitacoes" : "api/concursos"}/filtros`, { name, filter }),
    filtroExcluir: (produto: "licitacoes" | "concursos", name: string) =>
      del(`/${produto === "licitacoes" ? "api/licitacoes" : "api/concursos"}/filtros/${encodeURIComponent(name)}`),
    // —— Concursos ——
    concursos: (q: string) => get<{ items: Array<Record<string, unknown>>; count: number }>(`/api/concursos?q=${encodeURIComponent(q)}`),
    concursoTimeline: (externalId: string) => get<{ timeline: Array<Record<string, unknown>> }>(`/api/concursos/${externalId}/timeline`),
    // —— Jurídico ——
    processo: (cnj: string) =>
      get<{ processo: Record<string, unknown>; movimentos: LegalEventDto[]; resumo: string }>(`/api/processos/${encodeURIComponent(cnj)}`),
    processoExplicar: (cnj: string) => get<{ explicacao: string; atos: unknown[] }>(`/api/processos/${encodeURIComponent(cnj)}/explicar`),
    processoAcompanhar: (cnj: string, uf: string) => post(`/api/processos/${encodeURIComponent(cnj)}/acompanhar`, { alias: uf.toLowerCase() }),
    processoSync: (cnj: string) => post<{ novos: number; sigiloso: boolean }>(`/api/processos/${encodeURIComponent(cnj)}/sync`, {}),
    processoBuscar: (cnj: string, uf: string) =>
      get<{ processo: Record<string, unknown>; movimentos: LegalEventDto[]; resumo: string; rodape: string }>(
        `/api/processos/buscar?cnj=${encodeURIComponent(cnj)}&alias=${encodeURIComponent(uf.toLowerCase())}`,
      ),
    processoPerguntar: (cnj: string, question: string) =>
      post<RespostaAssistente>(`/api/processos/${encodeURIComponent(cnj)}/perguntar`, { question }),
    processoAlertar: (cnj: string) =>
      post<{ alertasAtivos: boolean; alertas: Array<{ detail: string; kind: string }> }>(`/api/processos/${encodeURIComponent(cnj)}/alertar`, {}),
    processoPesquisar: (q: string, uf: string, pagina: number) =>
      get<PesquisaTerceiros>(
        `/api/processos/pesquisar?q=${encodeURIComponent(q)}&uf=${encodeURIComponent(uf)}&pagina=${pagina}`,
      ),
    processoDetalhesLote: (cnjs: string[]) =>
      get<{ itens: DetalheTercero[]; rodape: string }>(`/api/processos/detalhes-lote?cnjs=${encodeURIComponent(cnjs.join(","))}`),
    processoBuscarWeb: (pergunta: string) => post<RespostaBuscador>("/api/processos/buscar-web", { pergunta }),
    juridicoConsulta: (cnj: string, uf: string) => post<{ id: string; consolidado?: boolean }>("/api/juridico/consultas", { cnj, uf }),
    // —— Empréstimos ——
    feed: () => get<{ items: LoanRequestDto[] }>("/api/feed/emprestimos"),
    proposta: (p: { valorCents: number; taxaPct: number; parcelas: number; finalidade: string; uf: string }) => post<{ request: LoanRequestDto }>("/api/loan-requests", p),
    interesse: (id: string) => post<{ matchId: string; expiraEm: string }>("/api/loan-requests/${id}/interesse".replace("${id}", id), {}),
    matches: () => get<{ matches: LoanMatchDto[] }>("/api/loan-matches"),
    match: (id: string) => get<{ match: LoanMatchDto; rodadas: Array<{ by: string; proposta: string; at: string }> }>(`/api/loan-matches/${id}`),
    aceitar: (id: string) => post<{ match: LoanMatchDto }>(`/api/loan-matches/${id}/aceitar`, {}),
    rodada: (id: string, r: { roundNumber: number; annualRatePct: number; amountCents: number; installmentCount: number }) =>
      post(`/api/loan-matches/${id}/rodadas`, r),
    pagamento: (stage: "declared" | "confirmed", matchId: string) => post(`/api/payments/${stage === "declared" ? "declare" : "confirm"}`, { matchId }),
    // —— Admin ——
  };
}

export function adminApi(token: string) {
  const get = <T>(url: string) => fetch(`${BASE}${url}`, { headers: headers(token) }).then(j<T>);
  const post = <T>(url: string, body?: unknown) =>
    fetch(`${BASE}${url}`, { method: "POST", headers: headers(token), body: body === undefined ? "{}" : JSON.stringify(body) }).then(j<T>);
  return {
    login: (email: string, password: string) => post<{ token: string; admin: { id: string; email: string; role: string } }>("/v1/admin/auth/login", { email, password }),
    me: () => get<{ admin: { id: string; email: string; role: string; permissions: string[] } }>("/v1/admin/auth/me"),
    kpis: () => get<Record<string, unknown>>("/v1/admin/kpis"),
    operadores: () => get<{ operadores: Array<{ id: string; email: string; role: string; active: boolean }> }>("/v1/admin/operadores"),
    operadorCriar: (o: { email: string; role: string; password: string }) => post<{ operador: { id: string; email: string; role: string } }>("/v1/admin/operadores", o),
    operadorToggle: (id: string, active: boolean) => post(`/v1/admin/operadores/${id}/active`, { active }),
    verificacoes: () => get<{ verificacoes: Array<{ userId: string; level: string; status: string; payload: unknown }> }>("/v1/admin/verificacoes"),
    verifAprovar: (userId: string, level: string) => post(`/v1/admin/verificacoes/${userId}/aprovar`, { level }),
    verifReprovar: (userId: string, motivo: string) => post(`/v1/admin/verificacoes/${userId}/reprovar`, { motivo }),
    conceder: (userId: string, sku: string, dias: number) => post("/v1/admin/assinaturas/conceder", { userId, sku, dias }),
    rules: () => get<{ rules: Array<{ id: number; scope: string; key: string; value: unknown; version: number; active: boolean }> }>("/v1/admin/rules"),
    ruleCriar: (r: { scope: string; key: string; valueJson: unknown }) => post<{ rule: { id: string; version: number } }>("/v1/admin/rules", r),
    ruleRollback: (id: string) => post<{ ok: boolean }>(`/v1/admin/rules/${id}/rollback`),
    audit: () => get<{ entries: Array<Record<string, unknown>>; cadeiaOk: boolean }>("/v1/admin/audit"),
    db: (tabela: string, limite = 50) => get<{ rows: Array<Record<string, unknown>> }>(`/v1/admin/db/${tabela}?limite=${limite}`),
    // —— Ops (plano-painel-ops §3.3) ——
    opsOverview: () => get<Record<string, unknown>>("/v1/admin/ops/overview"),
    opsServices: () => get<{ servicos: Array<Record<string, unknown>> }>("/v1/admin/ops/services"),
    opsTimeline: (limit = 100) => get<{ entries: Array<Record<string, unknown>>; cadeiaOk: boolean; fontes: string[] }>(`/v1/admin/ops/timeline?limit=${limit}`),
    opsProbes: (service: string, hours = 24) =>
      get<{ total: number; pontos: Array<Record<string, unknown>> }>(`/v1/admin/ops/probes?service=${encodeURIComponent(service)}&hours=${hours}`),
    opsQueues: () => get<Record<string, unknown>>("/v1/admin/ops/queues"),
    opsLogs: (service: string, lines = 100) => get<{ tail: string }>(`/v1/admin/ops/logs?service=${encodeURIComponent(service)}&lines=${lines}`),
    opsTests: () => get<{ runs: Array<Record<string, unknown>> }>("/v1/admin/ops/tests"),
    opsFlags: () => get<{ flags: Array<Record<string, unknown>> }>("/v1/admin/ops/flags"),
    opsFlagSet: (key: string, enabled: boolean, payload?: unknown) => post<{ flag: Record<string, unknown> }>(
      "/v1/admin/ops/flags",
      { key, enabled, payload },
    ),
    opsRotate: () => post<{ ok: boolean }>("/v1/admin/ops/rotate-service-token"),
  };
}

// —— DTOs ——
export interface PlanoDto {
  code: string;
  name: string;
  monthlyCents: number;
  yearlyCents: number;
  features?: string;
  priceOverridden?: boolean;
}
export interface StatusAssinatura {
  entitlement: { subjectId: string; skus: string[]; expiresAt?: string; trialUsedAt?: string };
  assinaturas: Array<{ sku: string; expiresAt: string }>;
  trialDisponivel: boolean;
  trialDias: number;
  pushinpayConfigurado?: boolean;
}
export interface NotaDto {
  id: string;
  title: string;
  body?: string;
  tags: string[];
  pinned?: boolean;
  createdAt: string;
}
export interface GastoDto {
  id: string;
  description: string;
  amountCents: number;
  category: string;
  spentAt: string;
}
export interface LoanRequestDto {
  id: string;
  userId: string;
  valorCents: number;
  taxaPct: number;
  parcelas: number;
  finalidade: string;
  uf: string;
  status: string;
}
export interface LoanMatchDto {
  id: string;
  requestId: string;
  borrowerId: string;
  lenderId: string | null;
  status: string;
  expiraEm: string | null;
}
export interface LegalEventDto {
  numeroProcesso: string;
  codigo: number;
  nome: string;
  dataHora: string;
  tribunal: string;
}
export interface RespostaAssistente {
  resposta: string;
  fontes: string[];
  sugestoes: string[];
  rodape: string;
  intencao: string;
  acompanhado?: boolean;
}
export interface FonteWebDto {
  titulo: string;
  url: string;
  trecho: string;
}
export interface RespostaBuscador {
  provedor: "duckduckgo" | "tavily" | "perplexity" | "gemini";
  geradaPorIA: boolean;
  resposta: string;
  fontes: FonteWebDto[];
  diagnostico: { backend: string; status: number; bytes: number; motivo?: string }[];
  rodape: string;
}
export interface ProcessoTercero {
  numeroProcesso: string;
  codigoInterno: string | null;
  uf: string;
  foro: string | null;
  classe: string | null;
  assunto: string | null;
  participacao: string | null;
  nomeParte: string | null;
  dataDistribuicao: string | null;
  localDistribuicao: string | null;
  fonte: string;
  url: string;
}
export interface ResultadoEsaj {
  estado: "resultados" | "multiplos" | "vazio" | "bloqueado" | "erro";
  uf: string;
  fonte: string;
  total: number | null;
  pagina: number;
  ultimaPagina: number;
  itens: ProcessoTercero[];
}
export interface PesquisaTerceiros {
  tipo: "nome" | "cpf" | "cnpj";
  formato?: string;
  advertencia?: string;
  fontes: ResultadoEsaj[];
  itens: ProcessoTercero[];
  rodape: string;
}
export interface DetalheTercero {
  numeroProcesso: string;
  status: string | null;
  classe: string | null;
  orgaoJulgador: string | null;
  valorDaCausa: number | null;
  ultimoMovimento: { nome: string; dataHora: string } | null;
  dataAjuizamento: string | null;
  fonte: string;
}
export interface Gamificacao {
  perfil: { xp: number; level: number; streak: number; ufOptIn: boolean };
  levelInfo: { level: number; nextAt: number | null; progress: number };
  conquistas: Array<{ badge: string; at: string }>;
  catalogoConquistas: Array<{ code: string; title: string; desc: string }>;
  missoes: Array<{ code: string; progress: number; done: boolean }>;
  catalogoMissoes: Array<{ code: string; title: string; xp: number; meta: number }>;
}
export interface AwardResult {
  xpGanho: number;
  xpTotal: number;
  level: number;
  streak: number;
  novasConquistas: string[];
}
