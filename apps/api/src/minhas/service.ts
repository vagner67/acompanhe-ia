/**
 * AnotA — notas + gastos (plano anota). OCR via OcrProvider injetável:
 * sem credencial/configuração o provider padrão NÃO inventa texto (engine
 * "manual") — o usuário informa o valor; ao configurar um provider real
 * (tesseract/API), a extração entra sem mudar o resto do fluxo.
 */
export interface NotaDto {
  id: string;
  userId: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GastoDto {
  id: string;
  userId: string;
  amountCents: number;
  category: string;
  description: string;
  spentAt: string;
  photoRef: string | null;
  ocrText: string | null;
  ocrEngine: string | null;
  createdAt: string;
}

export interface MinhasStore {
  createNota(n: NotaDto): Promise<NotaDto>;
  updateNota(id: string, userId: string, patch: Partial<Pick<NotaDto, "title" | "body" | "tags" | "pinned">>): Promise<NotaDto | null>;
  deleteNota(id: string, userId: string): Promise<boolean>;
  listNotas(userId: string): Promise<NotaDto[]>;
  createGasto(g: GastoDto): Promise<GastoDto>;
  updateGasto(id: string, userId: string, patch: Partial<Pick<GastoDto, "amountCents" | "category" | "description" | "spentAt" | "photoRef" | "ocrText" | "ocrEngine">>): Promise<GastoDto | null>;
  deleteGasto(id: string, userId: string): Promise<boolean>;
  listGastos(userId: string): Promise<GastoDto[]>;
}

export class InMemoryMinhasStore implements MinhasStore {
  private notas = new Map<string, NotaDto>();
  private gastos = new Map<string, GastoDto>();

  async createNota(n: NotaDto) {
    this.notas.set(n.id, n);
    return n;
  }
  async updateNota(id: string, userId: string, patch: Partial<NotaDto>) {
    const n = this.notas.get(id);
    if (!n || n.userId !== userId) return null;
    const next = { ...n, ...patch, updatedAt: new Date().toISOString() };
    this.notas.set(id, next);
    return next;
  }
  async deleteNota(id: string, userId: string) {
    const n = this.notas.get(id);
    if (!n || n.userId !== userId) return false;
    this.notas.delete(id);
    return true;
  }
  async listNotas(userId: string) {
    return [...this.notas.values()].filter((n) => n.userId === userId).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
  async createGasto(g: GastoDto) {
    this.gastos.set(g.id, g);
    return g;
  }
  async updateGasto(id: string, userId: string, patch: Partial<GastoDto>) {
    const g = this.gastos.get(id);
    if (!g || g.userId !== userId) return null;
    const next = { ...g, ...patch };
    this.gastos.set(id, next);
    return next;
  }
  async deleteGasto(id: string, userId: string) {
    const g = this.gastos.get(id);
    if (!g || g.userId !== userId) return false;
    this.gastos.delete(id);
    return true;
  }
  async listGastos(userId: string) {
    return [...this.gastos.values()].filter((g) => g.userId === userId).sort((a, b) => (a.spentAt < b.spentAt ? 1 : -1));
  }
}

/** Porta de OCR (foto do comprovante → texto). Provider real via config. */
export interface OcrProvider {
  readonly engine: string;
  extract(imageBase64: string): Promise<{ text: string | null; engine: string }>;
}

/** Provider honesto: sem OCR configurado NÃO inventa texto. */
export const manualOcr: OcrProvider = {
  engine: "manual",
  async extract() {
    return { text: null, engine: "manual" };
  },
};

export function resumoMensal(gastos: GastoDto[], ym: string): {
  ym: string;
  totalCents: number;
  porCategoria: Array<{ category: string; totalCents: number; count: number }>;
  gastos: GastoDto[];
} {
  const doMes = gastos.filter((g) => g.spentAt.slice(0, 7) === ym);
  const cats = new Map<string, { totalCents: number; count: number }>();
  for (const g of doMes) {
    const c = cats.get(g.category) ?? { totalCents: 0, count: 0 };
    cats.set(g.category, { totalCents: c.totalCents + g.amountCents, count: c.count + 1 });
  }
  return {
    ym,
    totalCents: doMes.reduce((s, g) => s + g.amountCents, 0),
    porCategoria: [...cats.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.totalCents - a.totalCents),
    gastos: doMes,
  };
}

export function exportCsv(notas: NotaDto[], gastos: GastoDto[]): string {
  const esc = (s: string) => `"${s.replaceAll('"', '""')}"`;
  const linhas = ["tipo,id,data,titulo,descricao,valor_cents,categoria,tags"];
  for (const n of notas) {
    linhas.push(["nota", n.id, n.updatedAt, esc(n.title), esc(n.body), "", "", esc(n.tags.join("|"))].join(","));
  }
  for (const g of gastos) {
    linhas.push(["gasto", g.id, g.spentAt, "", esc(g.description), String(g.amountCents), g.category, ""].join(","));
  }
  return linhas.join("\n") + "\n";
}
