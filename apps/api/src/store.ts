/**
 * Porta de persistência (S1 = in-memory; S2+ = Prisma sobre Postgres — DDL doc 09).
 * Regras de domínio não mudam quando a implementação trocar.
 */

export interface PaymentRecord {
  providerIdLower: string; // id normalizado (doc 08 §2: id lower/upper)
  amountCents: number;
  currency: "BRL" | "XTR";
  channel: "pushinpay" | "stars";
  status: "created" | "processing" | "paid" | "expired" | "investigation";
  refType?: string;
  refId?: string;
  userId?: string;
  createdAt: string;
  paidAt?: string;
  investigationReason?: string;
  effectApplied: boolean; // idempotência: duplo webhook = 1 efeito
}

export interface PaymentStore {
  findByProviderId(providerIdLower: string): Promise<PaymentRecord | null>;
  save(record: PaymentRecord): Promise<void>;
  /** aplica efeito (ex.: liberar plano) atomicamente; true = aplicado AGORA, false = já aplicado */
  applyPaidEffect(providerIdLower: string, paidAt: string): Promise<boolean>;
  flagInvestigation(providerIdLower: string, reason: string): Promise<void>;
  listByUser(userId: string): Promise<PaymentRecord[]>;
}

export class InMemoryPaymentStore implements PaymentStore {
  private readonly rows = new Map<string, PaymentRecord>();

  async findByProviderId(id: string): Promise<PaymentRecord | null> {
    return this.rows.get(id.toLowerCase()) ?? null;
  }

  async save(record: PaymentRecord): Promise<void> {
    const key = record.providerIdLower.toLowerCase();
    const existing = this.rows.get(key);
    if (existing) {
      this.rows.set(key, { ...existing, ...record, providerIdLower: key });
    } else {
      this.rows.set(key, { ...record, providerIdLower: key });
    }
  }

  async applyPaidEffect(id: string, paidAt: string): Promise<boolean> {
    const row = this.rows.get(id.toLowerCase());
    if (!row) return false;
    if (row.effectApplied) return false; // já liberado — idempotente
    this.rows.set(row.providerIdLower, { ...row, status: "paid", paidAt, effectApplied: true });
    return true;
  }

  async flagInvestigation(id: string, reason: string): Promise<void> {
    const row = this.rows.get(id.toLowerCase());
    if (!row) return;
    this.rows.set(row.providerIdLower, { ...row, status: "investigation", investigationReason: reason });
  }

  async listByUser(userId: string): Promise<PaymentRecord[]> {
    return [...this.rows.values()].filter((r) => r.userId === userId);
  }
}
