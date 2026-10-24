/**
 * SKUs canônicos — única fonte de preço (doc 08 §9; canônico v1 arquivo 04).
 * Todo preço é DEFAULT: o diretor ajusta em rules_config (doc 05 §3) sem deploy.
 */
export type PlanCode = "anota" | "juridica" | "licitacao" | "concurso" | "investiga";

export interface PlanSku {
  code: PlanCode;
  name: string;
  command: string;
  features: string;
  aiMessagesPerDay: number;
  monthlyCents: number;
  yearlyCents: number;
}

export const PLAN_SKUS: readonly PlanSku[] = [
  {
    code: "anota",
    name: "AnotA",
    command: "anota",
    features:
      "Notas ilimitadas · gastos com foto/OCR · resumo mensal · export CSV · Caderno de Dívidas (até 3 empréstimos ativos) · 3 boosts/mês",
    aiMessagesPerDay: 20,
    monthlyCents: 1490, // R$ 14,90
    yearlyCents: 14900, // R$ 149,00
  },
  {
    code: "juridica",
    name: "Consulta Jurídica",
    command: "juridica",
    features:
      "Monitor de processos (até 50 ativos) · alertas de movimento · explicação IA · 1 consulta humana OAB/mês",
    aiMessagesPerDay: 60,
    monthlyCents: 3990, // R$ 39,90
    yearlyCents: 39900, // R$ 399,00
  },
  {
    code: "licitacao",
    name: "Licitação",
    command: "licitacao",
    features:
      "Radar nacional PNCP · filtros salvos ilimitados · alertas de edital/prazo · resumo IA de edital",
    aiMessagesPerDay: 60,
    monthlyCents: 4990, // R$ 49,90
    yearlyCents: 49900, // R$ 499,00
  },
  {
    code: "concurso",
    name: "Concurso",
    command: "concurso",
    features:
      "Radar DOU+bancas · filtros salvos · linha do tempo · alertas de edital/prazo de inscrição",
    aiMessagesPerDay: 40,
    monthlyCents: 2490, // R$ 24,90
    yearlyCents: 24900, // R$ 249,00
  },
  {
    code: "investiga",
    name: "Investiga",
    command: "investiga",
    features:
      "OSINT avançado: enumeração de username (catálogo versionado) · email (vazamentos HIBP + Gravatar + MX) · telefone (E.164/libphonenumber) · domínio (RDAP + Certificate Transparency + Wayback) · relatório com proveniência (cada achado: fonte+URL+data) · até 10 casos ativos",
    aiMessagesPerDay: 80,
    monthlyCents: 5990, // R$ 59,90 — DEFAULT proposto; diretor ajusta em rules_config (doc 05 §3)
    yearlyCents: 59900, // R$ 599,00 (padrão anual = mensal × 10, igual aos demais planos)
  },
] as const;

export const TRIAL = {
  days: 7, // 7 dias por plano, 1× por usuário (doc 08 §9)
  perUserOnce: true,
  reminderHoursBeforeEnd: 48, // lembrete T-2
} as const;

export const AVULSOS = {
  boostPack: { cents: 990, quantity: 5 }, // R$ 9,90/5 — nunca vende posição em ranking
  extraContract: { cents: 990, days: 30 }, // +1 contrato ativo por 30 d
  investigaPack: { cents: 990, quantity: 5 }, // R$ 9,90/5 consultas avulsas do Investiga (sem assinatura)
} as const;

export function planByCode(code: string): PlanSku | undefined {
  return PLAN_SKUS.find((p) => p.code === code);
}
