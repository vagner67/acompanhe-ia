/**
 * Entitlements (S1 em memória; S2 = Prisma) — quem pode usar o quê.
 * SKUs canônicos de v2/08 §9.5: investiga, investigaPack, investiga:trial.
 * O efeito "paid" do webhook concede SKU (mesmo contrato do PaymentStore).
 */
export interface EntitlementRecord {
  subjectId: string;
  /** SKUs ativos (ex.: "investiga", "investigaPack", "investiga:trial"). */
  skus: string[];
  /** Expiração da assinatura (ISO). Ausente = sem assinatura recorrente. */
  expiresAt?: string;
  /** Trial 7d — uma única vez por usuário (v2/08 §9.5). */
  trialUsedAt?: string;
  grantedVia?: "pushinpay" | "stars" | "trial" | "manual";
}

/** Porta de entitlements (doc 13, R6) — consumida pelas rotas/serviço. */
export interface Entitlements {
  get(subjectId: string, now?: string): Promise<EntitlementRecord>;
  grant(
    subjectId: string,
    sku: string,
    opts?: { expiresAt?: string; via?: EntitlementRecord["grantedVia"] },
    now?: string,
  ): Promise<EntitlementRecord>;
  useTrial(subjectId: string, trialDays: number, now?: Date, sku?: string): Promise<{ ok: boolean; record?: EntitlementRecord }>;
  isEntitled(subjectId: string, acceptedSkus: string[], now?: string): Promise<boolean>;
}

export class InMemoryEntitlementsStore implements Entitlements {
  private readonly rows = new Map<string, EntitlementRecord>();

  async get(subjectId: string, now = new Date().toISOString()): Promise<EntitlementRecord> {
    const row = this.rows.get(subjectId) ?? { subjectId, skus: [] };
    if (row.expiresAt && row.expiresAt < now) {
      // assinatura vencida: SKUs recorrentes caem; trial também expira.
      return { ...row, skus: [] };
    }
    return row;
  }

  async grant(subjectId: string, sku: string, opts: { expiresAt?: string; via?: EntitlementRecord["grantedVia"] } = {}, now = new Date().toISOString()): Promise<EntitlementRecord> {
    const current = await this.get(subjectId, now);
    const skus = current.skus.includes(sku) ? current.skus : [...current.skus, sku];
    const next: EntitlementRecord = {
      ...current,
      subjectId,
      skus,
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : current.expiresAt ? { expiresAt: current.expiresAt } : {}),
      ...(opts.via ? { grantedVia: opts.via } : current.grantedVia ? { grantedVia: current.grantedVia } : {}),
    };
    this.rows.set(subjectId, next);
    return next;
  }

  /** Ativa trial de 7 dias, uma única vez. false = já usado. */
  async useTrial(subjectId: string, trialDays: number, now = new Date(), sku = "investiga:trial"): Promise<{ ok: boolean; record?: EntitlementRecord }> {
    const iso = now.toISOString();
    const current = await this.get(subjectId, iso);
    if (current.trialUsedAt) return { ok: false };
    const until = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString();
    const next: EntitlementRecord = {
      ...current,
      subjectId,
      skus: [...new Set([...current.skus, sku])],
      expiresAt: current.expiresAt && current.expiresAt > until ? current.expiresAt : until,
      trialUsedAt: iso,
      grantedVia: "trial",
    };
    this.rows.set(subjectId, next);
    return { ok: true, record: next };
  }

  async isEntitled(subjectId: string, acceptedSkus: string[], now = new Date().toISOString()): Promise<boolean> {
    const { skus } = await this.get(subjectId, now);
    return skus.some((s) => acceptedSkus.includes(s));
  }
}
