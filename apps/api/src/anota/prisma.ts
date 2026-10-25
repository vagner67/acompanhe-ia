/**
 * AnotA — persistência real (Prisma/Postgres).
 *
 * Despesas continuam na tabela `Gasto` que já existia (com colunas novas
 * anuláveis) e receitas entram em `AnotaReceita`. O domínio não vê essa divisão:
 * aqui as duas viram `LancamentoDto`.
 *
 * Datas: o banco guarda `DateTime`; o domínio usa `YYYY-MM-DD`. Gravamos à meia-
 * noite UTC e lemos de volta em UTC — sem hora local no meio, que é como um
 * lançamento muda de dia sozinho.
 */
import type { PrismaClient } from "@acompanhe/db";

import type { BackupRegistro, AnotaStore, FiltroLancamentos, NotaDto } from "./store.js";
import type { CartaoDto, CategoriaDto, ContaDto, LancamentoDto, MetaDto, OrcamentoDto } from "./tipos.js";

const dia = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

type LinhaGasto = {
  id: string;
  userId: string;
  amountCents: number;
  category: string;
  description: string;
  spentAt: Date;
  photoRef: string | null;
  ocrText: string | null;
  ocrEngine: string | null;
  createdAt: Date;
  contaId: string | null;
  categoriaId: string | null;
  status: string | null;
  vencimento: Date | null;
  parcelaDe: string | null;
  parcelaNum: number | null;
  parcelasTotal: number | null;
  recorrenteDe: string | null;
  fitId: string | null;
  origem: string | null;
};

type LinhaReceita = {
  id: string;
  userId: string;
  amountCents: number;
  category: string;
  categoriaId: string | null;
  contaId: string | null;
  description: string;
  recebidoEm: Date;
  vencimento: Date | null;
  status: string | null;
  recorrenteDe: string | null;
  fitId: string | null;
  origem: string | null;
  createdAt: Date;
};

function deGasto(r: LinhaGasto): LancamentoDto {
  return {
    id: r.id,
    userId: r.userId,
    tipo: "despesa",
    amountCents: r.amountCents,
    description: r.description,
    category: r.category,
    categoriaId: r.categoriaId,
    contaId: r.contaId,
    data: r.spentAt.toISOString().slice(0, 10),
    vencimento: iso(r.vencimento),
    status: r.status === "pendente" ? "pendente" : "pago",
    photoRef: r.photoRef,
    ocrText: r.ocrText,
    ocrEngine: r.ocrEngine,
    parcelaDe: r.parcelaDe,
    parcelaNum: r.parcelaNum,
    parcelasTotal: r.parcelasTotal,
    recorrenteDe: r.recorrenteDe,
    fitId: r.fitId,
    origem: (r.origem as LancamentoDto["origem"]) ?? "manual",
    createdAt: r.createdAt.toISOString(),
  };
}

function deReceita(r: LinhaReceita): LancamentoDto {
  return {
    id: r.id,
    userId: r.userId,
    tipo: "receita",
    amountCents: r.amountCents,
    description: r.description,
    category: r.category,
    categoriaId: r.categoriaId,
    contaId: r.contaId,
    data: r.recebidoEm.toISOString().slice(0, 10),
    vencimento: iso(r.vencimento),
    status: r.status === "pendente" ? "pendente" : "pago",
    photoRef: null,
    ocrText: null,
    ocrEngine: null,
    parcelaDe: null,
    parcelaNum: null,
    parcelasTotal: null,
    recorrenteDe: r.recorrenteDe,
    fitId: r.fitId,
    origem: (r.origem as LancamentoDto["origem"]) ?? "manual",
    createdAt: r.createdAt.toISOString(),
  };
}

export class PrismaAnotaStore implements AnotaStore {
  constructor(private readonly db: PrismaClient) {}

  async criarConta(c: ContaDto): Promise<ContaDto> {
    const r = await this.db.anotaConta.create({
      data: {
        id: c.id,
        userId: c.userId,
        nome: c.nome,
        tipo: c.tipo,
        saldoInicialCents: c.saldoInicialCents,
        arquivada: c.arquivada,
        criadaEm: new Date(c.criadaEm),
      },
    });
    return { ...c, criadaEm: r.criadaEm.toISOString() };
  }

  async listarContas(userId: string): Promise<ContaDto[]> {
    const rows = await this.db.anotaConta.findMany({ where: { userId }, orderBy: [{ arquivada: "asc" }, { criadaEm: "asc" }] });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      nome: r.nome,
      tipo: r.tipo as ContaDto["tipo"],
      saldoInicialCents: r.saldoInicialCents,
      arquivada: r.arquivada,
      criadaEm: r.criadaEm.toISOString(),
    }));
  }

  async atualizarConta(id: string, userId: string, patch: Partial<ContaDto>): Promise<ContaDto | null> {
    const atual = await this.db.anotaConta.findFirst({ where: { id, userId } });
    if (!atual) return null;
    const r = await this.db.anotaConta.update({
      where: { id },
      data: {
        ...(patch.nome !== undefined ? { nome: patch.nome } : {}),
        ...(patch.tipo !== undefined ? { tipo: patch.tipo } : {}),
        ...(patch.saldoInicialCents !== undefined ? { saldoInicialCents: patch.saldoInicialCents } : {}),
        ...(patch.arquivada !== undefined ? { arquivada: patch.arquivada } : {}),
      },
    });
    return {
      id: r.id,
      userId: r.userId,
      nome: r.nome,
      tipo: r.tipo as ContaDto["tipo"],
      saldoInicialCents: r.saldoInicialCents,
      arquivada: r.arquivada,
      criadaEm: r.criadaEm.toISOString(),
    };
  }

  async criarCategoria(c: CategoriaDto): Promise<CategoriaDto> {
    // `upsert` pelo par (userId, nome, tipo): semear categoria duas vezes não pode estourar
    const r = await this.db.anotaCategoria.upsert({
      where: { userId_nome_tipo: { userId: c.userId, nome: c.nome, tipo: c.tipo } },
      create: { id: c.id, userId: c.userId, nome: c.nome, tipo: c.tipo, cor: c.cor, icone: c.icone, arquivada: c.arquivada },
      update: {},
    });
    return { id: r.id, userId: r.userId, nome: r.nome, tipo: r.tipo as CategoriaDto["tipo"], cor: r.cor, icone: r.icone, arquivada: r.arquivada };
  }

  async listarCategorias(userId: string): Promise<CategoriaDto[]> {
    const rows = await this.db.anotaCategoria.findMany({ where: { userId }, orderBy: [{ tipo: "asc" }, { nome: "asc" }] });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      nome: r.nome,
      tipo: r.tipo as CategoriaDto["tipo"],
      cor: r.cor,
      icone: r.icone,
      arquivada: r.arquivada,
    }));
  }

  async criarLancamentos(ls: LancamentoDto[]): Promise<LancamentoDto[]> {
    const out: LancamentoDto[] = [];
    for (const l of ls) {
      if (l.tipo === "despesa") {
        const r = await this.db.gasto.create({
          data: {
            id: l.id,
            userId: l.userId,
            amountCents: l.amountCents,
            category: l.category,
            categoriaId: l.categoriaId,
            contaId: l.contaId,
            description: l.description,
            spentAt: dia(l.data),
            vencimento: l.vencimento ? dia(l.vencimento) : null,
            status: l.status,
            photoRef: l.photoRef,
            ocrText: l.ocrText,
            ocrEngine: l.ocrEngine,
            parcelaDe: l.parcelaDe,
            parcelaNum: l.parcelaNum,
            parcelasTotal: l.parcelasTotal,
            recorrenteDe: l.recorrenteDe,
            fitId: l.fitId,
            origem: l.origem,
          },
        });
        out.push(deGasto(r as LinhaGasto));
      } else {
        const r = await this.db.anotaReceita.create({
          data: {
            id: l.id,
            userId: l.userId,
            amountCents: l.amountCents,
            category: l.category,
            categoriaId: l.categoriaId,
            contaId: l.contaId,
            description: l.description,
            recebidoEm: dia(l.data),
            vencimento: l.vencimento ? dia(l.vencimento) : null,
            status: l.status,
            recorrenteDe: l.recorrenteDe,
            fitId: l.fitId,
            origem: l.origem,
          },
        });
        out.push(deReceita(r as LinhaReceita));
      }
    }
    return out;
  }

  async listarLancamentos(userId: string, filtro: FiltroLancamentos = {}): Promise<LancamentoDto[]> {
    const ondeDespesa = {
      userId,
      ...(filtro.status ? { status: filtro.status } : {}),
      ...(filtro.contaId ? { contaId: filtro.contaId } : {}),
      ...(filtro.categoriaId ? { categoriaId: filtro.categoriaId } : {}),
      ...(filtro.de || filtro.ate
        ? { spentAt: { ...(filtro.de ? { gte: dia(filtro.de) } : {}), ...(filtro.ate ? { lte: dia(filtro.ate) } : {}) } }
        : {}),
      ...(filtro.q ? { OR: [{ description: { contains: filtro.q, mode: "insensitive" as const } }, { category: { contains: filtro.q, mode: "insensitive" as const } }] } : {}),
    };
    const ondeReceita = {
      userId,
      ...(filtro.status ? { status: filtro.status } : {}),
      ...(filtro.contaId ? { contaId: filtro.contaId } : {}),
      ...(filtro.categoriaId ? { categoriaId: filtro.categoriaId } : {}),
      ...(filtro.de || filtro.ate
        ? { recebidoEm: { ...(filtro.de ? { gte: dia(filtro.de) } : {}), ...(filtro.ate ? { lte: dia(filtro.ate) } : {}) } }
        : {}),
      ...(filtro.q ? { OR: [{ description: { contains: filtro.q, mode: "insensitive" as const } }, { category: { contains: filtro.q, mode: "insensitive" as const } }] } : {}),
    };

    const [gastos, receitas] = await Promise.all([
      filtro.tipo === "receita" ? Promise.resolve([]) : this.db.gasto.findMany({ where: ondeDespesa }),
      filtro.tipo === "despesa" ? Promise.resolve([]) : this.db.anotaReceita.findMany({ where: ondeReceita }),
    ]);
    // ordem cronológica crescente — contrato da interface
    return [...gastos.map((r) => deGasto(r as LinhaGasto)), ...receitas.map((r) => deReceita(r as LinhaReceita))].sort((a, b) =>
      a.data < b.data ? -1 : a.data > b.data ? 1 : a.createdAt < b.createdAt ? -1 : 1,
    );
  }

  async atualizarLancamento(id: string, userId: string, patch: Partial<LancamentoDto>): Promise<LancamentoDto | null> {
    const g = await this.db.gasto.findFirst({ where: { id, userId } });
    if (g) {
      const r = await this.db.gasto.update({
        where: { id },
        data: {
          ...(patch.amountCents !== undefined ? { amountCents: patch.amountCents } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.category !== undefined ? { category: patch.category } : {}),
          ...(patch.categoriaId !== undefined ? { categoriaId: patch.categoriaId } : {}),
          ...(patch.contaId !== undefined ? { contaId: patch.contaId } : {}),
          ...(patch.data !== undefined ? { spentAt: dia(patch.data) } : {}),
          ...(patch.vencimento !== undefined ? { vencimento: patch.vencimento ? dia(patch.vencimento) : null } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
        },
      });
      return deGasto(r as LinhaGasto);
    }
    const rec = await this.db.anotaReceita.findFirst({ where: { id, userId } });
    if (!rec) return null;
    const r = await this.db.anotaReceita.update({
      where: { id },
      data: {
        ...(patch.amountCents !== undefined ? { amountCents: patch.amountCents } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.categoriaId !== undefined ? { categoriaId: patch.categoriaId } : {}),
        ...(patch.contaId !== undefined ? { contaId: patch.contaId } : {}),
        ...(patch.data !== undefined ? { recebidoEm: dia(patch.data) } : {}),
        ...(patch.vencimento !== undefined ? { vencimento: patch.vencimento ? dia(patch.vencimento) : null } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      },
    });
    return deReceita(r as LinhaReceita);
  }

  async excluirLancamento(id: string, userId: string): Promise<boolean> {
    const g = await this.db.gasto.deleteMany({ where: { id, userId } });
    if (g.count > 0) return true;
    const r = await this.db.anotaReceita.deleteMany({ where: { id, userId } });
    return r.count > 0;
  }

  async existeFitId(userId: string, fitId: string): Promise<boolean> {
    const [g, r] = await Promise.all([
      this.db.gasto.findFirst({ where: { userId, fitId }, select: { id: true } }),
      this.db.anotaReceita.findFirst({ where: { userId, fitId }, select: { id: true } }),
    ]);
    return Boolean(g || r);
  }

  async salvarOrcamento(o: OrcamentoDto): Promise<OrcamentoDto> {
    const r = await this.db.anotaOrcamento.upsert({
      where: { userId_categoriaId_ym: { userId: o.userId, categoriaId: o.categoriaId, ym: o.ym } },
      create: { id: o.id, userId: o.userId, categoriaId: o.categoriaId, ym: o.ym, limiteCents: o.limiteCents },
      update: { limiteCents: o.limiteCents },
    });
    return { id: r.id, userId: r.userId, categoriaId: r.categoriaId, ym: r.ym, limiteCents: r.limiteCents };
  }

  async listarOrcamentos(userId: string, ym?: string): Promise<OrcamentoDto[]> {
    const rows = await this.db.anotaOrcamento.findMany({ where: { userId, ...(ym ? { ym } : {}) } });
    return rows.map((r) => ({ id: r.id, userId: r.userId, categoriaId: r.categoriaId, ym: r.ym, limiteCents: r.limiteCents }));
  }

  async excluirOrcamento(id: string, userId: string): Promise<boolean> {
    const r = await this.db.anotaOrcamento.deleteMany({ where: { id, userId } });
    return r.count > 0;
  }

  async criarCartao(c: CartaoDto): Promise<CartaoDto> {
    const r = await this.db.anotaCartao.create({
      data: { id: c.id, userId: c.userId, contaId: c.contaId, nome: c.nome, limiteCents: c.limiteCents, fechamentoDia: c.fechamentoDia, vencimentoDia: c.vencimentoDia },
    });
    return { id: r.id, userId: r.userId, contaId: r.contaId, nome: r.nome, limiteCents: r.limiteCents, fechamentoDia: r.fechamentoDia, vencimentoDia: r.vencimentoDia };
  }

  async listarCartoes(userId: string): Promise<CartaoDto[]> {
    const rows = await this.db.anotaCartao.findMany({ where: { userId } });
    return rows.map((r) => ({ id: r.id, userId: r.userId, contaId: r.contaId, nome: r.nome, limiteCents: r.limiteCents, fechamentoDia: r.fechamentoDia, vencimentoDia: r.vencimentoDia }));
  }

  async criarMeta(m: MetaDto): Promise<MetaDto> {
    const r = await this.db.anotaMeta.create({ data: { id: m.id, userId: m.userId, nome: m.nome, alvoCents: m.alvoCents, guardadoCents: m.guardadoCents, prazo: m.prazo } });
    return { id: r.id, userId: r.userId, nome: r.nome, alvoCents: r.alvoCents, guardadoCents: r.guardadoCents, prazo: r.prazo };
  }

  async listarMetas(userId: string): Promise<MetaDto[]> {
    const rows = await this.db.anotaMeta.findMany({ where: { userId } });
    return rows.map((r) => ({ id: r.id, userId: r.userId, nome: r.nome, alvoCents: r.alvoCents, guardadoCents: r.guardadoCents, prazo: r.prazo }));
  }

  async atualizarMeta(id: string, userId: string, patch: Partial<MetaDto>): Promise<MetaDto | null> {
    const atual = await this.db.anotaMeta.findFirst({ where: { id, userId } });
    if (!atual) return null;
    const r = await this.db.anotaMeta.update({
      where: { id },
      data: {
        ...(patch.nome !== undefined ? { nome: patch.nome } : {}),
        ...(patch.alvoCents !== undefined ? { alvoCents: patch.alvoCents } : {}),
        ...(patch.guardadoCents !== undefined ? { guardadoCents: patch.guardadoCents } : {}),
        ...(patch.prazo !== undefined ? { prazo: patch.prazo } : {}),
      },
    });
    return { id: r.id, userId: r.userId, nome: r.nome, alvoCents: r.alvoCents, guardadoCents: r.guardadoCents, prazo: r.prazo };
  }

  async criarNota(n: NotaDto): Promise<NotaDto> {
    const r = await this.db.nota.create({
      data: { id: n.id, userId: n.userId, title: n.title, body: n.body, tags: n.tags, pinned: n.pinned },
    });
    return { id: r.id, userId: r.userId, title: r.title, body: r.body, tags: (r.tags as string[]) ?? [], pinned: r.pinned, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
  }

  async atualizarNota(id: string, userId: string, patch: Partial<NotaDto>): Promise<NotaDto | null> {
    const atual = await this.db.nota.findFirst({ where: { id, userId } });
    if (!atual) return null;
    const r = await this.db.nota.update({
      where: { id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      },
    });
    return { id: r.id, userId: r.userId, title: r.title, body: r.body, tags: (r.tags as string[]) ?? [], pinned: r.pinned, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
  }

  async excluirNota(id: string, userId: string): Promise<boolean> {
    const r = await this.db.nota.deleteMany({ where: { id, userId } });
    return r.count > 0;
  }

  async listarNotas(userId: string): Promise<NotaDto[]> {
    const rows = await this.db.nota.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
    return rows.map((r) => ({ id: r.id, userId: r.userId, title: r.title, body: r.body, tags: (r.tags as string[]) ?? [], pinned: r.pinned, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() }));
  }

  async registrarBackup(b: BackupRegistro): Promise<void> {
    await this.db.anotaBackup.create({
      data: { id: b.id, userId: b.userId, email: b.email, criadoEm: new Date(b.criadoEm), bytes: b.bytes, itens: b.itens, status: b.status, erro: b.erro, provedor: b.provedor },
    });
  }

  async listarBackups(userId: string, limite = 20): Promise<BackupRegistro[]> {
    const rows = await this.db.anotaBackup.findMany({ where: { userId }, orderBy: { criadoEm: "desc" }, take: limite });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      email: r.email,
      criadoEm: r.criadoEm.toISOString(),
      bytes: r.bytes,
      itens: r.itens,
      status: r.status as BackupRegistro["status"],
      erro: r.erro,
      provedor: r.provedor,
    }));
  }
}
