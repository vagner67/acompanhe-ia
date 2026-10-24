/**
 * Verificação de identidade e gate V1 (plano.md §5.1) — RF-E02 + A3.
 * A3: V1+ OBRIGATÓRIO; sem `v1_status == "approved"` → 403 em POST /api/loan-requests.
 * trust_signals: sinais de confiança (Serasa/device) — avaliação quente/fria (doc 06).
 */
export type V1Status = "none" | "pending" | "approved" | "rejected";

export interface UserVerification {
  userId: string;
  v1Status: V1Status;
  v2Status?: V1Status;
  selfieAt?: string | null;
  docTipo?: string | null;
  approvedAt?: string | null;
  /** Motivo da reprovação — visível ao usuário (correção e2e 24/10: era só audit). */
  rejectReason?: string | null;
}

export interface TrustSignal {
  userId: string;
  kind: "serasa" | "device" | "tempo_conta" | "assinatura" | "pagamento";
  value: number; // 0..100
  at: string;
}

export interface VerificacaoStore {
  getVerification(userId: string): Promise<UserVerification | undefined>;
  setVerification(v: UserVerification): Promise<void>;
  /** Lista por status V1 — painel do admin (correção e2e 24/10: endpoint era stub). */
  listVerifications(status: V1Status): Promise<UserVerification[]>;
  addSignal(s: TrustSignal): Promise<void>;
  listSignals(userId: string): Promise<TrustSignal[]>;
}

export class InMemoryVerificacaoStore implements VerificacaoStore {
  private ver = new Map<string, UserVerification>();
  private sig = new Map<string, TrustSignal[]>();

  async getVerification(userId: string) {
    return this.ver.get(userId);
  }

  async setVerification(v: UserVerification) {
    this.ver.set(v.userId, v);
  }

  async listVerifications(status: V1Status) {
    return [...this.ver.values()].filter((v) => v.v1Status === status);
  }

  async addSignal(s: TrustSignal) {
    const l = this.sig.get(s.userId) ?? [];
    l.push(s);
    this.sig.set(s.userId, l);
  }

  async listSignals(userId: string) {
    return this.sig.get(userId) ?? [];
  }
}

export class V1NaoAprovadoError extends Error {
  readonly statusCode = 403;
  constructor() {
    super("verificação V1+ obrigatória para solicitar empréstimo (A3)");
  }
}

/** Gate A3 — lançar ANTES de persistir qualquer loan_request. */
export async function exigirV1(store: VerificacaoStore, userId: string): Promise<void> {
  const v = await store.getVerification(userId);
  if (!v || v.v1Status !== "approved") throw new V1NaoAprovadoError();
}

/**
 * Avaliação quente/fria (doc 06): média dos sinais conhecidos, sem inventar
 * dado — sinal ausente não conta (não é 0, é ausente).
 */
export async function scoreConfianca(store: VerificacaoStore, userId: string): Promise<number | null> {
  const sig = await store.listSignals(userId);
  if (sig.length === 0) return null;
  return Math.round(sig.reduce((a, s) => a + s.value, 0) / sig.length);
}

/** E1 = R$ 300 (A4) — teto por nível; nível = min(verificação, histórico). */
export const ESCADA = [
  { nivel: "E1", tetoCents: 30_000 },
  { nivel: "E2", tetoCents: 70_000 },
  { nivel: "E3", tetoCents: 150_000 },
  { nivel: "E4", tetoCents: 500_000 },
  { nivel: "E5", tetoCents: 1_500_000 },
] as const;

export function tetoPorNivel(nivel: string): number {
  return ESCADA.find((e) => e.nivel === nivel)?.tetoCents ?? ESCADA[0].tetoCents;
}
