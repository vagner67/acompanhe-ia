/**
 * Valores que a API, o web e os workers devem concordar — mudar AQUI,
 * nunca como string literal dentro de um app (arquitetura tgstack, docs/architecture.md).
 */

/** Ações gamificadas (XP). Literais destes nomes existem SÓ neste arquivo. */
export const XP = {
  loginDiario: "login_diario",
  notaCriada: "nota_criada",
  gastoCriado: "gasto_criado",
  filtroSalvo: "filtro_salvo",
  syncManual: "sync_manual",
  casoInvestiga: "caso_investiga",
  propostaEmprestimo: "proposta_emprestimo",
  consultaJuridica: "consulta_juridica",
  verificacaoEnviada: "verificacao_enviada",
  assinaturaAtiva: "assinatura_ativa",
} as const;

export type XpAction = (typeof XP)[keyof typeof XP];

/** XP base por ação real (plano §3). */
export const XP_ACTIONS: Record<XpAction, number> = {
  [XP.loginDiario]: 10,
  [XP.notaCriada]: 5,
  [XP.gastoCriado]: 5,
  [XP.filtroSalvo]: 10,
  [XP.syncManual]: 15,
  [XP.casoInvestiga]: 20,
  [XP.propostaEmprestimo]: 25,
  [XP.consultaJuridica]: 15,
  [XP.verificacaoEnviada]: 10,
  [XP.assinaturaAtiva]: 50,
};

/** Prefixos HTTP da API e o esquema de autenticação (docs/arquitetura.md). */
export const API_ROUTES = {
  /** API de produto (mini-app/web) — `Authorization: Bearer <jwt>`. */
  api: "/api",
  /** API de produto com verificação + assinaturas. */
  v1: "/v1",
  /** Painel do administrador (RBAC) — fora do mini-app. */
  admin: "/v1/admin",
  health: "/health",
} as const;

/** Mini-app e web enviam `Authorization: Bearer <jwt de sessão>`. */
export const AUTH_SCHEME = "Bearer";

/** Rota de autenticação de desenvolvimento (NUNCA em produção). */
export const DEV_AUTH_ROUTE = "/api/auth/telegram/dev";

/** Valores permitidos em AlertEvent.status (modelo Prisma). */
export const ALERT_STATUS = {
  queued: "queued",
  delivered: "delivered",
  read: "read",
  silenced: "silenced",
  blocked: "blocked",
  failed: "failed",
} as const;

/** Canais de AlertEvent. */
export const ALERT_CHANNELS = { telegram: "telegram", email: "email" } as const;
