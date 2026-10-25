/**
 * AnotA — porta de persistência (interface única + implementação em memória).
 *
 * A implementação Prisma fica em `prisma.ts` e obedece exatamente a esta
 * interface; os testes de rota usam a de memória e os de banco usam a Prisma,
 * com o mesmo contrato (foi assim que o NCA pegou, em produção, um store que
 * devolvia histórico na ordem errada — aqui a ordem é documentada).
 */
import type {
  CartaoDto,
  CategoriaDto,
  ContaDto,
  LancamentoDto,
  MetaDto,
  OrcamentoDto,
  TipoLancamento,
} from "./tipos.js";

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

export interface FiltroLancamentos {
  /** data mínima `YYYY-MM-DD` (inclusive) */
  de?: string;
  /** data máxima `YYYY-MM-DD` (inclusive) */
  ate?: string;
  tipo?: TipoLancamento;
  contaId?: string;
  categoriaId?: string;
  status?: "pago" | "pendente";
  /** busca textual em descrição/categoria */
  q?: string;
}

export interface BackupRegistro {
  id: string;
  userId: string;
  email: string;
  criadoEm: string;
  bytes: number;
  itens: number;
  status: "enviado" | "falhou" | "nao_configurado";
  erro: string | null;
  provedor: string;
}

export interface AnotaStore {
  // —— contas
  criarConta(c: ContaDto): Promise<ContaDto>;
  /** todas do usuário, não arquivadas primeiro, ordem de criação */
  listarContas(userId: string): Promise<ContaDto[]>;
  atualizarConta(id: string, userId: string, patch: Partial<Pick<ContaDto, "nome" | "tipo" | "saldoInicialCents" | "arquivada">>): Promise<ContaDto | null>;

  // —— categorias
  criarCategoria(c: CategoriaDto): Promise<CategoriaDto>;
  listarCategorias(userId: string): Promise<CategoriaDto[]>;

  // —— lançamentos (despesas e receitas na mesma visão)
  /** insere em lote (parcelas/importação); devolve na ordem de entrada */
  criarLancamentos(ls: LancamentoDto[]): Promise<LancamentoDto[]>;
  /** SEMPRE em ordem cronológica crescente (contrato) */
  listarLancamentos(userId: string, filtro?: FiltroLancamentos): Promise<LancamentoDto[]>;
  atualizarLancamento(
    id: string,
    userId: string,
    patch: Partial<Pick<LancamentoDto, "amountCents" | "description" | "category" | "categoriaId" | "contaId" | "data" | "vencimento" | "status">>,
  ): Promise<LancamentoDto | null>;
  excluirLancamento(id: string, userId: string): Promise<boolean>;
  /** existe algum lançamento com este fitId? (dedupe de importação) */
  existeFitId(userId: string, fitId: string): Promise<boolean>;

  // —— orçamentos
  salvarOrcamento(o: OrcamentoDto): Promise<OrcamentoDto>;
  listarOrcamentos(userId: string, ym?: string): Promise<OrcamentoDto[]>;
  excluirOrcamento(id: string, userId: string): Promise<boolean>;

  // —— cartões
  criarCartao(c: CartaoDto): Promise<CartaoDto>;
  listarCartoes(userId: string): Promise<CartaoDto[]>;

  // —— metas
  criarMeta(m: MetaDto): Promise<MetaDto>;
  listarMetas(userId: string): Promise<MetaDto[]>;
  atualizarMeta(id: string, userId: string, patch: Partial<Pick<MetaDto, "nome" | "alvoCents" | "guardadoCents" | "prazo">>): Promise<MetaDto | null>;

  // —— notas (mantidas do AnotA antigo)
  criarNota(n: NotaDto): Promise<NotaDto>;
  atualizarNota(id: string, userId: string, patch: Partial<Pick<NotaDto, "title" | "body" | "tags" | "pinned">>): Promise<NotaDto | null>;
  excluirNota(id: string, userId: string): Promise<boolean>;
  /** mais recentes primeiro (contrato do AnotA antigo) */
  listarNotas(userId: string): Promise<NotaDto[]>;

  // —— auditoria de backup
  registrarBackup(b: BackupRegistro): Promise<void>;
  listarBackups(userId: string, limite?: number): Promise<BackupRegistro[]>;
}

const ordem = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class InMemoryAnotaStore implements AnotaStore {
  private contas = new Map<string, ContaDto>();
  private cats = new Map<string, CategoriaDto>();
  private lances = new Map<string, LancamentoDto>();
  private orcs = new Map<string, OrcamentoDto>();
  private cartoes = new Map<string, CartaoDto>();
  private metas = new Map<string, MetaDto>();
  private notas = new Map<string, NotaDto>();
  private backups: BackupRegistro[] = [];

  async criarConta(c: ContaDto) {
    this.contas.set(c.id, c);
    return c;
  }
  async listarContas(userId: string) {
    return [...this.contas.values()].filter((c) => c.userId === userId).sort((a, b) => Number(a.arquivada) - Number(b.arquivada) || ordem(a.criadaEm, b.criadaEm));
  }
  async atualizarConta(id: string, userId: string, patch: Partial<ContaDto>) {
    const c = this.contas.get(id);
    if (!c || c.userId !== userId) return null;
    const novo = { ...c, ...patch };
    this.contas.set(id, novo);
    return novo;
  }

  async criarCategoria(c: CategoriaDto) {
    this.cats.set(c.id, c);
    return c;
  }
  async listarCategorias(userId: string) {
    return [...this.cats.values()].filter((c) => c.userId === userId);
  }

  async criarLancamentos(ls: LancamentoDto[]) {
    for (const l of ls) this.lances.set(l.id, l);
    return ls;
  }
  async listarLancamentos(userId: string, filtro: FiltroLancamentos = {}) {
    return [...this.lances.values()]
      .filter((l) => l.userId === userId)
      .filter((l) => (filtro.de ? l.data >= filtro.de : true))
      .filter((l) => (filtro.ate ? l.data <= filtro.ate : true))
      .filter((l) => (filtro.tipo ? l.tipo === filtro.tipo : true))
      .filter((l) => (filtro.contaId ? l.contaId === filtro.contaId : true))
      .filter((l) => (filtro.categoriaId ? l.categoriaId === filtro.categoriaId : true))
      .filter((l) => (filtro.status ? l.status === filtro.status : true))
      .filter((l) =>
        filtro.q
          ? `${l.description} ${l.category}`.toLowerCase().includes(filtro.q.toLowerCase())
          : true,
      )
      .sort((a, b) => ordem(a.data, b.data));
  }
  async atualizarLancamento(id: string, userId: string, patch: Partial<LancamentoDto>) {
    const l = this.lances.get(id);
    if (!l || l.userId !== userId) return null;
    const novo = { ...l, ...patch };
    this.lances.set(id, novo);
    return novo;
  }
  async excluirLancamento(id: string, userId: string) {
    const l = this.lances.get(id);
    if (!l || l.userId !== userId) return false;
    this.lances.delete(id);
    return true;
  }
  async existeFitId(userId: string, fitId: string) {
    return [...this.lances.values()].some((l) => l.userId === userId && l.fitId === fitId);
  }

  async salvarOrcamento(o: OrcamentoDto) {
    const existente = [...this.orcs.values()].find(
      (x) => x.userId === o.userId && x.categoriaId === o.categoriaId && x.ym === o.ym,
    );
    const final = existente ? { ...existente, limiteCents: o.limiteCents } : o;
    this.orcs.set(final.id, final);
    return final;
  }
  async listarOrcamentos(userId: string, ym?: string) {
    return [...this.orcs.values()].filter((o) => o.userId === userId && (!ym || o.ym === ym));
  }
  async excluirOrcamento(id: string, userId: string) {
    const o = this.orcs.get(id);
    if (!o || o.userId !== userId) return false;
    this.orcs.delete(id);
    return true;
  }

  async criarCartao(c: CartaoDto) {
    this.cartoes.set(c.id, c);
    return c;
  }
  async listarCartoes(userId: string) {
    return [...this.cartoes.values()].filter((c) => c.userId === userId);
  }

  async criarMeta(m: MetaDto) {
    this.metas.set(m.id, m);
    return m;
  }
  async listarMetas(userId: string) {
    return [...this.metas.values()].filter((m) => m.userId === userId);
  }
  async atualizarMeta(id: string, userId: string, patch: Partial<MetaDto>) {
    const m = this.metas.get(id);
    if (!m || m.userId !== userId) return null;
    const novo = { ...m, ...patch };
    this.metas.set(id, novo);
    return novo;
  }

  async criarNota(n: NotaDto) {
    this.notas.set(n.id, n);
    return n;
  }
  async atualizarNota(id: string, userId: string, patch: Partial<NotaDto>) {
    const n = this.notas.get(id);
    if (!n || n.userId !== userId) return null;
    const novo = { ...n, ...patch, updatedAt: new Date().toISOString() };
    this.notas.set(id, novo);
    return novo;
  }
  async excluirNota(id: string, userId: string) {
    const n = this.notas.get(id);
    if (!n || n.userId !== userId) return false;
    this.notas.delete(id);
    return true;
  }
  async listarNotas(userId: string) {
    return [...this.notas.values()].filter((n) => n.userId === userId).sort((a, b) => ordem(b.updatedAt, a.updatedAt));
  }

  async registrarBackup(b: BackupRegistro) {
    this.backups.push(b);
  }
  async listarBackups(userId: string, limite = 20) {
    return this.backups.filter((b) => b.userId === userId).slice(-limite).reverse();
  }
}
