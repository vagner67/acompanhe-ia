/**
 * Gamificação — XP por ação REAL, streak diário, níveis, conquistas e missões
 * semanais (plano §3). Ranking é OPT-IN (nunca vende posição — AVULSOS skus.ts).
 */
import { XP_ACTIONS, XP, type XpAction } from "@acompanhe/shared";

export { XP_ACTIONS, type XpAction };

export const LEVEL_THRESHOLDS = [0, 100, 250, 500, 900, 1400, 2000, 2800, 3800, 5000];

export function levelFor(xp: number): { level: number; nextAt: number | null; progress: number } {
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) if (xp >= LEVEL_THRESHOLDS[i]!) level = i + 1;
  const nextAt = level < LEVEL_THRESHOLDS.length ? LEVEL_THRESHOLDS[level]! : null;
  const cur = LEVEL_THRESHOLDS[level - 1]!;
  const progress = nextAt ? Math.min(1, (xp - cur) / (nextAt - cur)) : 1;
  return { level, nextAt, progress };
}

export const BADGES: Array<{ code: string; title: string; desc: string }> = [
  { code: "primeira_nota", title: "📝 Primeira nota", desc: "Criou a primeira nota no AnotA" },
  { code: "primeiro_gasto", title: "💸 Primeiro gasto", desc: "Lançou o primeiro gasto" },
  { code: "radar_configurado", title: "🎯 Radar configurado", desc: "Salvou um filtro de licitação ou concurso" },
  { code: "primeiro_caso", title: "🔎 Primeiro caso", desc: "Abriu um caso no Investiga" },
  { code: "primeira_proposta", title: "🤝 Primeira proposta", desc: "Publicou uma proposta de empréstimo" },
  { code: "semana_completa", title: "🔥 Semana completa", desc: "7 dias seguidos de atividade" },
  { code: "explorador", title: "🧭 Explorador", desc: "Usou 3 produtos diferentes em 7 dias" },
  { code: "mes_em_dia", title: "✅ Mês em dia", desc: "10 gastos lançados no mês" },
];

const BADGE_RULES: Record<string, (ctx: { action: XpAction; streak: number; produtos: number; gastosNoMes: number }) => boolean> = {
  primeira_nota: (c) => c.action === XP.notaCriada,
  primeiro_gasto: (c) => c.action === XP.gastoCriado,
  radar_configurado: (c) => c.action === XP.filtroSalvo,
  primeiro_caso: (c) => c.action === XP.casoInvestiga,
  primeira_proposta: (c) => c.action === XP.propostaEmprestimo,
  semana_completa: (c) => c.streak >= 7,
  explorador: (c) => c.produtos >= 3,
  mes_em_dia: (c) => c.gastosNoMes >= 10,
};

export interface GameProfileDto {
  userId: string;
  xp: number;
  level: number;
  streak: number;
  lastActionAt: string | null;
  ufOptIn: boolean;
}

export interface GameStore {
  getProfile(userId: string): Promise<GameProfileDto>;
  saveProfile(p: GameProfileDto): Promise<void>;
  addEvent(userId: string, action: string, xp: number, at: string): Promise<void>;
  countActionSince(userId: string, action: string, sinceIso: string): Promise<number>;
  distinctProductsSince(userId: string, sinceIso: string): Promise<number>;
  addBadge(userId: string, badge: string, at: string): Promise<void>;
  listBadges(userId: string): Promise<Array<{ badge: string; at: string }>>;
  missionBump(userId: string, code: string, period: string): Promise<{ progress: number; done: boolean }>;
  listMissions(userId: string, period: string): Promise<Array<{ code: string; progress: number; done: boolean }>>;
  ranking(uf: string, limit: number): Promise<Array<{ userId: string; xp: number; level: number }>>;
}

export class InMemoryGameStore implements GameStore {
  private profiles = new Map<string, GameProfileDto>();
  private events: Array<{ userId: string; action: string; xp: number; at: string }> = [];
  private badges = new Map<string, Array<{ badge: string; at: string }>>();
  private missions = new Map<string, { code: string; progress: number; done: boolean }>();

  async getProfile(userId: string) {
    return this.profiles.get(userId) ?? { userId, xp: 0, level: 1, streak: 0, lastActionAt: null, ufOptIn: false };
  }
  async saveProfile(p: GameProfileDto) {
    this.profiles.set(p.userId, p);
  }
  async addEvent(userId: string, action: string, xp: number, at: string) {
    this.events.push({ userId, action, xp, at });
  }
  async countActionSince(userId: string, action: string, sinceIso: string) {
    return this.events.filter((e) => e.userId === userId && e.action === action && e.at >= sinceIso).length;
  }
  async distinctProductsSince(userId: string, sinceIso: string) {
    const prods = new Set<string>();
    const mapa: Record<string, string> = {
      [XP.notaCriada]: "anota",
      [XP.gastoCriado]: "anota",
      [XP.filtroSalvo]: "radar",
      [XP.casoInvestiga]: "investiga",
      [XP.propostaEmprestimo]: "emprestimo",
      [XP.consultaJuridica]: "juridico",
    };
    for (const e of this.events) {
      if (e.userId === userId && e.at >= sinceIso && mapa[e.action]) prods.add(mapa[e.action]!);
    }
    return prods.size;
  }
  async addBadge(userId: string, badge: string, at: string) {
    const l = this.badges.get(userId) ?? [];
    if (!l.some((b) => b.badge === badge)) l.push({ badge, at });
    this.badges.set(userId, l);
  }
  async listBadges(userId: string) {
    return this.badges.get(userId) ?? [];
  }
  async missionBump(userId: string, code: string, period: string) {
    const k = `${userId}|${code}|${period}`;
    const m = this.missions.get(k) ?? { code, progress: 0, done: false };
    if (!m.done) {
      m.progress += 1;
      if (m.progress >= missaoMeta(code)) m.done = true;
    }
    this.missions.set(k, m);
    return { progress: m.progress, done: m.done };
  }
  async listMissions(userId: string, period: string) {
    return MISSIONS.map((m) => {
      const row = this.missions.get(`${userId}|${m.code}|${period}`);
      return { code: m.code, progress: row?.progress ?? 0, done: row?.done ?? false };
    });
  }
  async ranking(uf: string, limit: number) {
    void uf;
    return [...this.profiles.values()]
      .filter((p) => p.ufOptIn)
      .sort((a, b) => b.xp - a.xp)
      .slice(0, limit)
      .map((p) => ({ userId: p.userId, xp: p.xp, level: p.level }));
  }
}

export const MISSIONS = [
  { code: "m_notas_5", title: "Crie 5 notas", xp: 30, meta: 5, kind: "weekly" },
  { code: "m_gastos_5", title: "Lance 5 gastos", xp: 30, meta: 5, kind: "weekly" },
  { code: "m_filtros_2", title: "Salve 2 filtros de radar", xp: 30, meta: 2, kind: "weekly" },
] as const;

function missaoMeta(code: string): number {
  return MISSIONS.find((m) => m.code === code)?.meta ?? 1;
}

export function isoWeek(d: Date = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export interface AwardResult {
  xpGanho: number;
  xpTotal: number;
  level: number;
  streak: number;
  novasConquistas: string[];
  missao?: { code: string; progress: number; done: boolean; xp: number };
}

export function makeGameService(store: GameStore, now: () => Date = () => new Date()) {
  /** Registra ação (whitelist) e devolve o resultado gamificado. */
  async function award(userId: string, action: XpAction): Promise<AwardResult> {
    const base = XP_ACTIONS[action];
    if (base === undefined) throw new Error("ação desconhecida");
    const t = now();
    const hoje = dayKey(t.toISOString());
    const p = await store.getProfile(userId);

    // 1 acao de login diario por dia (as demais liberadas por fluxo real)
    if (action === XP.loginDiario && (await store.countActionSince(userId, action, `${hoje}T00:00:00.000Z`)) > 0) {
      return { xpGanho: 0, xpTotal: p.xp, level: levelFor(p.xp).level, streak: p.streak, novasConquistas: [] };
    }

    // streak: mesma conta de dias = 1/dia; ontem = +1; antes = reinicia
    let streak = p.streak;
    const last = p.lastActionAt ? dayKey(p.lastActionAt) : null;
    if (last !== hoje) {
      const ontem = dayKey(new Date(t.getTime() - 86400000).toISOString());
      streak = last === ontem ? p.streak + 1 : 1;
    }
    let xpGanho = base;
    if (streak === 7) xpGanho += 50;
    if (streak === 30) xpGanho += 200;

    const xpTotal = p.xp + xpGanho;
    const { level } = levelFor(xpTotal);
    await store.saveProfile({ userId, xp: xpTotal, level, streak, lastActionAt: t.toISOString(), ufOptIn: p.ufOptIn });
    await store.addEvent(userId, action, xpGanho, t.toISOString());

    // conquistas
    const jaTem = new Set((await store.listBadges(userId)).map((b) => b.badge));
    const produtos = await store.distinctProductsSince(userId, new Date(t.getTime() - 7 * 86400000).toISOString());
    const gastosNoMes = await store.countActionSince(userId, XP.gastoCriado, `${hoje.slice(0, 7)}-01T00:00:00.000Z`);
    const novasConquistas: string[] = [];
    for (const [code, rule] of Object.entries(BADGE_RULES)) {
      if (!jaTem.has(code) && rule({ action, streak, produtos, gastosNoMes })) {
        await store.addBadge(userId, code, t.toISOString());
        novasConquistas.push(code);
      }
    }

    // missões semanais (ações que contam)
    const missaoMapa: Partial<Record<XpAction, string>> = {
      [XP.notaCriada]: "m_notas_5",
      [XP.gastoCriado]: "m_gastos_5",
      [XP.filtroSalvo]: "m_filtros_2",
    };
    const codigo = missaoMapa[action];
    let missao: AwardResult["missao"];
    if (codigo) {
      const r = await store.missionBump(userId, codigo, isoWeek(t));
      const meta = MISSIONS.find((m) => m.code === codigo)!;
      if (r.done && r.progress === missaoMeta(codigo)) {
        // recompensa única ao concluir
        await store.saveProfile({ userId, xp: (await store.getProfile(userId)).xp + meta.xp, level: levelFor((await store.getProfile(userId)).xp + meta.xp).level, streak, lastActionAt: t.toISOString(), ufOptIn: p.ufOptIn });
      }
      missao = { code: codigo, progress: r.progress, done: r.done, xp: meta.xp };
    }

    return { xpGanho, xpTotal: (await store.getProfile(userId)).xp, level: (await store.getProfile(userId)).level, streak, novasConquistas, ...(missao ? { missao } : {}) };
  }

  async function snapshot(userId: string) {
    const p = await store.getProfile(userId);
    return {
      perfil: p,
      levelInfo: levelFor(p.xp),
      conquistas: await store.listBadges(userId),
      catalogoConquistas: BADGES,
      missoes: await store.listMissions(userId, isoWeek()),
      catalogoMissoes: MISSIONS,
    };
  }

  async function toggleRanking(userId: string, optIn: boolean) {
    const p = await store.getProfile(userId);
    await store.saveProfile({ ...p, ufOptIn: optIn });
    return { ufOptIn: optIn };
  }

  return { award, snapshot, toggleRanking };
}
