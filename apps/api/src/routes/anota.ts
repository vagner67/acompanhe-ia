/**
 * Rotas do AnotA — controle financeiro (`/api/anota/*`).
 *
 * Antes o AnotA morava dentro de `routes/minhas.ts` junto com empréstimos,
 * verificação e perfil. Aqui ele tem arquivo próprio; `minhas.ts` continua
 * atendendo o resto (e mantém os apelidos antigos de notas/gastos para não
 * quebrar bot, testes e o app já instalado).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  exportarCsv,
  faturaCartao,
  importarCsv,
  orcamentoVsRealizado,
  parseOfx,
  parcelar,
  ocorrenciasRecorrentes,
  relatorioMensal,
  resumoMes,
  saldoConsolidado,
  saldoConta,
  ultimosMeses,
  valorParaCents,
} from "../anota/dominio.js";
import { emailValido, instrucaoDeConfiguracao, provedorDeEmail, type EmailProvider } from "../anota/email.js";
import type { AnotaStore, BackupRegistro, NotaDto } from "../anota/store.js";
import {
  CATEGORIAS_INICIAIS,
  type CartaoDto,
  type CategoriaDto,
  type ContaDto,
  type LancamentoDto,
  type MetaDto,
  type OrcamentoDto,
  ehDataValida,
  ehYmValido,
  TIPOS_CONTA,
} from "../anota/tipos.js";
import { criarZip } from "../anota/zip.js";
import type { OcrProvider } from "../minhas/service.js";
import { manualOcr } from "../minhas/service.js";
import type { JwtService } from "../security/jwt.js";

/** `exactOptionalPropertyTypes` está ligado: patch com chave `undefined` não é
 *  "ausente". Este utilitário remove as chaves indefinidas antes de ir ao store. */
function limpar<T extends object>(o: T): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<{
    [K in keyof T]: Exclude<T[K], undefined>;
  }>;
}

const isoHoje = () => new Date().toISOString().slice(0, 10);
const ymHoje = () => new Date().toISOString().slice(0, 7);

const contaSchema = z.object({
  nome: z.string().min(1).max(80),
  tipo: z.enum(["caixa", "banco", "cartao", "poupanca"]).default("caixa"),
  saldoInicialCents: z.number().int().min(-100_000_000_00).max(100_000_000_00).default(0),
});

const categoriaSchema = z.object({
  nome: z.string().min(1).max(40),
  tipo: z.enum(["despesa", "receita"]).default("despesa"),
  cor: z.string().max(20).optional(),
  icone: z.string().max(20).optional(),
});

const lancamentoSchema = z.object({
  tipo: z.enum(["despesa", "receita"]).default("despesa"),
  amountCents: z.number().int().positive().max(100_000_000_00),
  description: z.string().min(1).max(300),
  category: z.string().min(1).max(40).default("outros"),
  categoriaId: z.string().uuid().nullable().optional(),
  contaId: z.string().uuid().nullable().optional(),
  data: z.string().refine(ehDataValida, "data deve ser YYYY-MM-DD válida").optional(),
  vencimento: z.string().refine(ehDataValida, "vencimento deve ser YYYY-MM-DD válida").nullable().optional(),
  status: z.enum(["pago", "pendente"]).default("pago"),
  /** parcelamento (2..48) — gera N lançamentos, sobra na última */
  parcelas: z.number().int().min(1).max(48).default(1),
  /** recorrência mensal: quantas ocorrências criar a partir de `data` (1..60) */
  repeticoes: z.number().int().min(1).max(60).default(1),
  ocrText: z.string().max(4000).optional(),
});

const orcamentoSchema = z.object({
  categoriaId: z.string().uuid(),
  ym: z.string().refine(ehYmValido, "ym deve ser YYYY-MM"),
  limiteCents: z.number().int().positive().max(100_000_000_00),
});

const cartaoSchema = z.object({
  contaId: z.string().uuid(),
  nome: z.string().min(1).max(60),
  limiteCents: z.number().int().min(0).max(100_000_000_00).default(0),
  fechamentoDia: z.number().int().min(1).max(28).default(1),
  vencimentoDia: z.number().int().min(1).max(28).default(10),
});

const metaSchema = z.object({
  nome: z.string().min(1).max(80),
  alvoCents: z.number().int().positive().max(100_000_000_00),
  guardadoCents: z.number().int().min(0).max(100_000_000_00).default(0),
  prazo: z.string().refine(ehDataValida, "prazo deve ser YYYY-MM-DD").nullable().optional(),
});

const notaSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10000).default(""),
  tags: z.array(z.string().min(1).max(24)).max(8).default([]),
  pinned: z.boolean().default(false),
});

export interface AnotaDeps {
  jwt: JwtService;
  store: AnotaStore;
  ocr?: OcrProvider;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** injetável nos testes; em produção vem de `provedorDeEmail(env)` */
  emailProvider?: EmailProvider | null;
  agora?: () => Date;
}

export function anotaRoutes(deps: AnotaDeps): (app: FastifyInstance) => Promise<void> {
  const ocr = deps.ocr ?? manualOcr;
  const env = deps.env ?? process.env;
  const agora = deps.agora ?? (() => new Date());

  async function subject(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "não autenticado" });
      return null;
    }
    try {
      const claims = await deps.jwt.verify(h.slice(7));
      if (!claims?.sub) {
        reply.code(401).send({ error: "sessão inválida" });
        return null;
      }
      return claims.sub;
    } catch {
      reply.code(401).send({ error: "sessão inválida" });
      return null;
    }
  }

  /** Garante as categorias iniciais na primeira vez que o usuário aparece. */
  async function categoriasDo(userId: string): Promise<CategoriaDto[]> {
    const existentes = await deps.store.listarCategorias(userId);
    if (existentes.length > 0) return existentes;
    for (const c of CATEGORIAS_INICIAIS) {
      await deps.store.criarCategoria({
        id: randomUUID(),
        userId,
        nome: c.nome,
        tipo: c.tipo,
        cor: null,
        icone: null,
        arquivada: false,
      });
    }
    return deps.store.listarCategorias(userId);
  }

  function novoLancamento(userId: string, base: Partial<LancamentoDto> & {
    tipo: "despesa" | "receita";
    amountCents: number;
    description: string;
    category: string;
    data: string;
  }): LancamentoDto {
    return {
      id: randomUUID(),
      userId,
      tipo: base.tipo,
      amountCents: base.amountCents,
      description: base.description,
      category: base.category,
      categoriaId: base.categoriaId ?? null,
      contaId: base.contaId ?? null,
      data: base.data,
      vencimento: base.vencimento ?? null,
      status: base.status ?? "pago",
      photoRef: null,
      ocrText: base.ocrText ?? null,
      ocrEngine: base.ocrText ? "manual" : null,
      parcelaDe: base.parcelaDe ?? null,
      parcelaNum: base.parcelaNum ?? null,
      parcelasTotal: base.parcelasTotal ?? null,
      recorrenteDe: base.recorrenteDe ?? null,
      fitId: base.fitId ?? null,
      origem: base.origem ?? "manual",
      createdAt: agora().toISOString(),
    };
  }

  /** Monta o ZIP de backup com os dados do próprio usuário. */
  async function gerarBackup(userId: string): Promise<{ zip: Buffer; itens: number; nomeArquivo: string }> {
    const [contas, categorias, lancamentos, orcamentos, cartoes, metas, notas] = await Promise.all([
      deps.store.listarContas(userId),
      deps.store.listarCategorias(userId),
      deps.store.listarLancamentos(userId),
      deps.store.listarOrcamentos(userId),
      deps.store.listarCartoes(userId),
      deps.store.listarMetas(userId),
      deps.store.listarNotas(userId),
    ]);
    const itens = lancamentos.length + notas.length + contas.length + orcamentos.length + cartoes.length + metas.length;
    const nomeArquivo = `anota-backup-${userId.slice(0, 8)}-${agora().toISOString().slice(0, 10)}.zip`;
    const manifesto = {
      geradoEm: agora().toISOString(),
      userId,
      contagens: {
        contas: contas.length,
        categorias: categorias.length,
        lancamentos: lancamentos.length,
        orcamentos: orcamentos.length,
        cartoes: cartoes.length,
        metas: metas.length,
        notas: notas.length,
      },
      observacao:
        "Valores monetários estão em centavos (inteiros). Datas em YYYY-MM-DD. Este é o backup do AnotA do próprio usuário.",
    };
    const csv = exportarCsv(lancamentos);
    const zip = criarZip([
      { nome: "MANIFEST.json", conteudo: JSON.stringify(manifesto, null, 2) },
      { nome: "lancamentos.csv", conteudo: csv },
      { nome: "lancamentos.json", conteudo: JSON.stringify(lancamentos, null, 2) },
      { nome: "contas.json", conteudo: JSON.stringify(contas, null, 2) },
      { nome: "categorias.json", conteudo: JSON.stringify(categorias, null, 2) },
      { nome: "orcamentos.json", conteudo: JSON.stringify(orcamentos, null, 2) },
      { nome: "cartoes.json", conteudo: JSON.stringify(cartoes, null, 2) },
      { nome: "metas.json", conteudo: JSON.stringify(metas, null, 2) },
      { nome: "notas.json", conteudo: JSON.stringify(notas, null, 2) },
    ]);
    return { zip, itens, nomeArquivo };
  }

  return async (app) => {
    // ───────────────────────── contas (carteiras) ─────────────────────────
    app.get("/api/anota/contas", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const [contas, lancamentos] = await Promise.all([deps.store.listarContas(userId), deps.store.listarLancamentos(userId)]);
      return reply.send({
        contas: contas.map((c) => ({ ...c, saldoCents: saldoConta(c, lancamentos) })),
        saldoConsolidadoCents: saldoConsolidado(contas, lancamentos),
      });
    });

    app.post("/api/anota/contas", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = contaSchema.parse(req.body);
      const conta: ContaDto = {
        id: randomUUID(),
        userId,
        nome: body.nome,
        tipo: body.tipo,
        saldoInicialCents: body.saldoInicialCents,
        arquivada: false,
        criadaEm: agora().toISOString(),
      };
      return reply.code(201).send({ conta: await deps.store.criarConta(conta) });
    });

    app.put<{ Params: { id: string } }>("/api/anota/contas/:id", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const patch = contaSchema.partial().parse(req.body);
      const conta = await deps.store.atualizarConta(req.params.id, userId, limpar(patch));
      if (!conta) return reply.code(404).send({ error: "conta não encontrada" });
      return reply.send({ conta });
    });

    // ───────────────────────── categorias ─────────────────────────
    app.get("/api/anota/categorias", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      return reply.send({ categorias: await categoriasDo(userId) });
    });

    app.post("/api/anota/categorias", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = categoriaSchema.parse(req.body);
      const categoria = await deps.store.criarCategoria({
        id: randomUUID(),
        userId,
        nome: body.nome,
        tipo: body.tipo,
        cor: body.cor ?? null,
        icone: body.icone ?? null,
        arquivada: false,
      });
      return reply.code(201).send({ categoria });
    });

    // ───────────────────────── lançamentos ─────────────────────────
    app.get("/api/anota/lancamentos", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const q = req.query as { de?: string; ate?: string; tipo?: "despesa" | "receita"; contaId?: string; status?: "pago" | "pendente"; q?: string; ym?: string };
      const filtro = {
        ...(q.de ? { de: q.de } : q.ym ? { de: `${q.ym}-01`, ate: `${q.ym}-31` } : {}),
        ...(q.ate ? { ate: q.ate } : {}),
        ...(q.tipo ? { tipo: q.tipo } : {}),
        ...(q.contaId ? { contaId: q.contaId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.q ? { q: q.q } : {}),
      };
      return reply.send({ lancamentos: await deps.store.listarLancamentos(userId, filtro) });
    });

    app.post("/api/anota/lancamentos", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = lancamentoSchema.parse(req.body);
      const data = body.data ?? isoHoje();
      const cats = await categoriasDo(userId);
      const categoria = body.categoriaId ? cats.find((c) => c.id === body.categoriaId) : cats.find((c) => c.nome === body.category && c.tipo === body.tipo);
      const categoriaId = categoria?.id ?? null;
      const category = categoria?.nome ?? body.category;

      // parcelamento: N lançamentos, cada um com seu vencimento, soma exata
      if (body.parcelas > 1) {
        if (body.tipo !== "despesa") return reply.code(422).send({ error: "parcelamento só vale para despesa" });
        const pai = randomUUID();
        const venc = body.vencimento ?? data;
        const partes = parcelar(body.amountCents, body.parcelas, venc);
        const criados = await deps.store.criarLancamentos(
          partes.map((p) =>
            novoLancamento(userId, {
              tipo: "despesa",
              amountCents: p.amountCents,
              description: `${body.description} (${p.num}/${p.total})`,
              category,
              categoriaId,
              contaId: body.contaId ?? null,
              data: p.vencimento,
              vencimento: p.vencimento,
              status: body.status,
              parcelaDe: pai,
              parcelaNum: p.num,
              parcelasTotal: p.total,
            }),
          ),
        );
        return reply.code(201).send({ lancamentos: criados, parcelamento: { parcelas: body.parcelas, totalCents: body.amountCents } });
      }

      // recorrência: ocorrências mensais a partir da data informada
      if (body.repeticoes > 1) {
        const pai = randomUUID();
        // `ocorrenciasRecorrentes` recebe o mês-limite (YYYY-MM), não uma data
        const ateYm = addMeses(data, body.repeticoes - 1).slice(0, 7);
        const ocorrencias = ocorrenciasRecorrentes({ data, amountCents: body.amountCents }, ateYm, body.repeticoes);
        const criados = await deps.store.criarLancamentos(
          ocorrencias.map((o, i) =>
            novoLancamento(userId, {
              tipo: body.tipo,
              amountCents: o.amountCents,
              description: `${body.description}${i === 0 ? "" : ` (${i + 1}/${ocorrencias.length})`}`,
              category,
              categoriaId,
              contaId: body.contaId ?? null,
              data: o.competencia,
              vencimento: o.competencia,
              status: body.status,
              recorrenteDe: i === 0 ? null : pai,
            }),
          ),
        );
        return reply.code(201).send({ lancamentos: criados, recorrencia: { repeticoes: ocorrencias.length } });
      }

      const criado = await deps.store.criarLancamentos([
        novoLancamento(userId, {
          tipo: body.tipo,
          amountCents: body.amountCents,
          description: body.description,
          category,
          categoriaId,
          contaId: body.contaId ?? null,
          data,
          vencimento: body.vencimento ?? null,
          status: body.status,
          ...(body.ocrText ? { ocrText: body.ocrText } : {}),
        }),
      ]);
      return reply.code(201).send({ lancamento: criado[0] });
    });

    app.put<{ Params: { id: string } }>("/api/anota/lancamentos/:id", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = lancamentoSchema.partial().parse(req.body);
      const lancamento = await deps.store.atualizarLancamento(req.params.id, userId, {
        ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.categoriaId !== undefined ? { categoriaId: body.categoriaId } : {}),
        ...(body.contaId !== undefined ? { contaId: body.contaId } : {}),
        ...(body.data !== undefined ? { data: body.data } : {}),
        ...(body.vencimento !== undefined ? { vencimento: body.vencimento } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      });
      if (!lancamento) return reply.code(404).send({ error: "lançamento não encontrado" });
      return reply.send({ lancamento });
    });

    app.delete<{ Params: { id: string } }>("/api/anota/lancamentos/:id", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const ok = await deps.store.excluirLancamento(req.params.id, userId);
      return ok ? reply.send({ ok: true }) : reply.code(404).send({ error: "lançamento não encontrado" });
    });

    // ───────────────────────── resumo + orçamento + cartões + metas ─────────────────────────
    app.get("/api/anota/resumo", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const ym = (req.query as { ym?: string }).ym ?? ymHoje();
      if (!ehYmValido(ym)) return reply.code(422).send({ error: "ym deve ser YYYY-MM" });
      const [contas, lancamentos, orcamentos, cartoes, metas] = await Promise.all([
        deps.store.listarContas(userId),
        deps.store.listarLancamentos(userId),
        deps.store.listarOrcamentos(userId, ym),
        deps.store.listarCartoes(userId),
        deps.store.listarMetas(userId),
      ]);
      return reply.send({
        ym,
        resumo: resumoMes(lancamentos, ym),
        contas: contas.map((c) => ({ ...c, saldoCents: saldoConta(c, lancamentos) })),
        saldoConsolidadoCents: saldoConsolidado(contas, lancamentos),
        orcamentos: orcamentoVsRealizado(orcamentos, lancamentos, ym),
        faturas: cartoes.map((c) => faturaCartao(c, lancamentos, ym)),
        metas: metas.map((m) => ({ ...m, pct: m.alvoCents > 0 ? Math.round((m.guardadoCents / m.alvoCents) * 1000) / 10 : 0 })),
      });
    });

    app.get("/api/anota/orcamentos", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const ym = (req.query as { ym?: string }).ym;
      if (ym && !ehYmValido(ym)) return reply.code(422).send({ error: "ym deve ser YYYY-MM" });
      const [orcamentos, lancamentos] = await Promise.all([
        deps.store.listarOrcamentos(userId, ym),
        deps.store.listarLancamentos(userId),
      ]);
      const alvo = ym ?? ymHoje();
      return reply.send({ orcamentos: orcamentoVsRealizado(orcamentos, lancamentos, alvo), ym: alvo });
    });

    app.post("/api/anota/orcamentos", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = orcamentoSchema.parse(req.body);
      const cat = (await categoriasDo(userId)).find((c) => c.id === body.categoriaId);
      if (!cat) return reply.code(422).send({ error: "categoria não existe para este usuário" });
      const orc: OrcamentoDto = { id: randomUUID(), userId, categoriaId: body.categoriaId, ym: body.ym, limiteCents: body.limiteCents };
      return reply.code(201).send({ orcamento: await deps.store.salvarOrcamento(orc) });
    });

    app.delete<{ Params: { id: string } }>("/api/anota/orcamentos/:id", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const ok = await deps.store.excluirOrcamento(req.params.id, userId);
      return ok ? reply.send({ ok: true }) : reply.code(404).send({ error: "orçamento não encontrado" });
    });

    app.get("/api/anota/cartoes", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      return reply.send({ cartoes: await deps.store.listarCartoes(userId) });
    });

    app.post("/api/anota/cartoes", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = cartaoSchema.parse(req.body);
      const conta = (await deps.store.listarContas(userId)).find((c) => c.id === body.contaId);
      if (!conta) return reply.code(422).send({ error: "conta do cartão não existe para este usuário" });
      const cartao: CartaoDto = { id: randomUUID(), userId, ...body };
      return reply.code(201).send({ cartao: await deps.store.criarCartao(cartao) });
    });

    app.get<{ Params: { id: string } }>("/api/anota/cartoes/:id/fatura", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const ym = (req.query as { ym?: string }).ym ?? ymHoje();
      if (!ehYmValido(ym)) return reply.code(422).send({ error: "ym deve ser YYYY-MM" });
      const cartao = (await deps.store.listarCartoes(userId)).find((c) => c.id === req.params.id);
      if (!cartao) return reply.code(404).send({ error: "cartão não encontrado" });
      return reply.send({ fatura: faturaCartao(cartao, await deps.store.listarLancamentos(userId), ym) });
    });

    app.get("/api/anota/metas", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const metas = await deps.store.listarMetas(userId);
      return reply.send({ metas: metas.map((m) => ({ ...m, pct: m.alvoCents > 0 ? Math.round((m.guardadoCents / m.alvoCents) * 1000) / 10 : 0 })) });
    });

    app.post("/api/anota/metas", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = metaSchema.parse(req.body);
      const meta: MetaDto = { id: randomUUID(), userId, nome: body.nome, alvoCents: body.alvoCents, guardadoCents: body.guardadoCents, prazo: body.prazo ?? null };
      return reply.code(201).send({ meta: await deps.store.criarMeta(meta) });
    });

    app.patch<{ Params: { id: string } }>("/api/anota/metas/:id", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const meta = await deps.store.atualizarMeta(req.params.id, userId, limpar(metaSchema.partial().parse(req.body)));
      if (!meta) return reply.code(404).send({ error: "meta não encontrada" });
      return reply.send({ meta });
    });

    // ───────────────────────── relatório ─────────────────────────
    app.get("/api/anota/relatorio", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const q = req.query as { meses?: string; ym?: string };
      const meses = Math.min(Math.max(Number(q.meses ?? 6) || 6, 1), 24);
      const ym = q.ym ?? ymHoje();
      if (!ehYmValido(ym)) return reply.code(422).send({ error: "ym deve ser YYYY-MM" });
      const janela = ultimosMeses(ym, meses);
      const lancamentos = await deps.store.listarLancamentos(userId, { de: `${janela[0]}-01` });
      return reply.send({ ym, meses: janela, linhas: relatorioMensal(lancamentos, janela) });
    });

    // ───────────────────────── importação / exportação ─────────────────────────
    app.post("/api/anota/importar", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = z
        .object({
          formato: z.enum(["csv", "ofx"]),
          conteudo: z.string().min(1).max(5_000_000),
          contaId: z.string().uuid().optional(),
          categoria: z.string().max(40).default("outros"),
        })
        .parse(req.body);

      const cats = await categoriasDo(userId);
      const paraLancamento = async (
        tipo: "despesa" | "receita",
        data: string,
        description: string,
        category: string,
        amountCents: number,
        fitId: string | null,
        origem: "csv" | "ofx",
      ): Promise<LancamentoDto | null> => {
        if (fitId && (await deps.store.existeFitId(userId, fitId))) return null; // já importado
        const cat = cats.find((c) => c.nome.toLowerCase() === category.toLowerCase() && c.tipo === tipo) ?? cats.find((c) => c.nome === "outros");
        return novoLancamento(userId, {
          tipo,
          amountCents,
          description,
          category: cat?.nome ?? category,
          categoriaId: cat?.id ?? null,
          contaId: body.contaId ?? null,
          data,
          status: "pago",
          fitId,
          origem,
        });
      };

      if (body.formato === "csv") {
        const lido = importarCsv(body.conteudo);
        // CSV de banco raramente tem FITID. Sem chave estável, reimportar o
        // mesmo arquivo duplicaria tudo — então usamos uma chave natural
        // (data + tipo + valor + descrição) com contador de ocorrência, que é
        // determinística para o mesmo arquivo e não engole dois lançamentos
        // legítimos iguais no mesmo dia.
        const ocorrencias = new Map<string, number>();
        const novos: LancamentoDto[] = [];
        for (const l of lido.linhas) {
          let fitId = l.fitId;
          if (!fitId) {
            const base = `csv:${l.data}:${l.tipo}:${l.amountCents}:${l.description.toLowerCase()}`.slice(0, 100);
            const n = (ocorrencias.get(base) ?? 0) + 1;
            ocorrencias.set(base, n);
            fitId = `${base}#${n}`;
          }
          const novo = await paraLancamento(l.tipo, l.data, l.description, l.category, l.amountCents, fitId, "csv");
          if (novo) novos.push(novo);
        }
        const criados = await deps.store.criarLancamentos(novos);
        return reply.send({ importados: criados.length, ignorados: lido.linhas.length - novos.length, erros: lido.erros });
      }

      const lido = parseOfx(body.conteudo);
      const novos: LancamentoDto[] = [];
      for (const t of lido.transacoes) {
        const tipo: "despesa" | "receita" = t.valorCents < 0 ? "despesa" : "receita";
        const n = await paraLancamento(tipo, t.data, t.descricao, body.categoria, Math.abs(t.valorCents), t.fitId, "ofx");
        if (n) novos.push(n);
      }
      const criados = await deps.store.criarLancamentos(novos);
      return reply.send({
        importados: criados.length,
        ignorados: lido.transacoes.length - novos.length,
        duplicadasNoArquivo: lido.duplicadasNoArquivo,
        formato: lido.formato,
        erros: [],
      });
    });

    app.get("/api/anota/export.csv", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const q = req.query as { de?: string; ate?: string };
      const lancamentos = await deps.store.listarLancamentos(userId, {
        ...(q.de ? { de: q.de } : {}),
        ...(q.ate ? { ate: q.ate } : {}),
      });
      const csv = exportarCsv(lancamentos);
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="anota-lancamentos.csv"')
        .send(csv);
    });

    // ───────────────────────── OCR de cupom ─────────────────────────
    app.post("/api/anota/ocr", async (req, reply) => {
      const body = z.object({ imageBase64: z.string().min(10).max(3_500_000) }).safeParse(req.body);
      if (!body.success) return reply.code(422).send({ error: "imageBase64 obrigatório (base64 da foto)" });
      const b64 = body.data.imageBase64.replace(/^data:[^,]+,/, "");
      let bytes: Buffer;
      try {
        if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new Error("não é base64");
        bytes = Buffer.from(b64, "base64");
        if (bytes.length < 24) throw new Error("curto demais");
      } catch {
        return reply.code(400).send({ error: "imageBase64 inválido — envie o base64 de uma imagem (PNG/JPEG/WEBP)" });
      }
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
      if (!isPng && !isJpeg && !isWebp) return reply.code(400).send({ error: "conteúdo não é imagem PNG/JPEG/WEBP" });
      const r = await ocr.extract(b64);
      const texto = r.text ?? "";
      return { texto, chars: texto.length, engine: r.engine };
    });

    // ───────────────────────── notas (o AnotA original) ─────────────────────────
    app.get("/api/anota/notas", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const q = (req.query as { q?: string }).q;
      const notas = await deps.store.listarNotas(userId);
      if (!q) return reply.send({ notas });
      const termo = q.toLowerCase();
      return reply.send({ notas: notas.filter((n) => `${n.title} ${n.body} ${n.tags.join(" ")}`.toLowerCase().includes(termo)) });
    });

    app.post("/api/anota/notas", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = notaSchema.parse(req.body);
      const agoraIso = agora().toISOString();
      const nota: NotaDto = { id: randomUUID(), userId, title: body.title, body: body.body, tags: body.tags, pinned: body.pinned, createdAt: agoraIso, updatedAt: agoraIso };
      return reply.code(201).send({ nota: await deps.store.criarNota(nota) });
    });

    app.put<{ Params: { id: string } }>("/api/anota/notas/:id", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const nota = await deps.store.atualizarNota(req.params.id, userId, limpar(notaSchema.partial().parse(req.body)));
      if (!nota) return reply.code(404).send({ error: "nota não encontrada" });
      return reply.send({ nota });
    });

    app.delete<{ Params: { id: string } }>("/api/anota/notas/:id", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const ok = await deps.store.excluirNota(req.params.id, userId);
      return ok ? reply.send({ ok: true }) : reply.code(404).send({ error: "nota não encontrada" });
    });

    // ───────────────────────── backup por e-mail ─────────────────────────
    app.get("/api/anota/backup", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const historico = await deps.store.listarBackups(userId, 10);
      const provedor = deps.emailProvider ?? provedorDeEmail(env, deps.fetchImpl ?? fetch);
      return reply.send({
        historico,
        emailSugerido: historico[0]?.email ?? null,
        envioConfigurado: Boolean(provedor),
        provedor: provedor?.nome ?? null,
        instrucao: provedor ? null : instrucaoDeConfiguracao(),
      });
    });

    /** Baixa o ZIP direto (funciona mesmo sem provedor de e-mail configurado). */
    app.get("/api/anota/backup/arquivo", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const { zip, nomeArquivo } = await gerarBackup(userId);
      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", `attachment; filename="${nomeArquivo}"`)
        .send(zip);
    });

    app.post("/api/anota/backup", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = z.object({ email: z.string().min(5).max(160) }).parse(req.body);
      const email = body.email.trim().toLowerCase();
      if (!emailValido(email)) return reply.code(422).send({ error: "e-mail inválido" });

      const { zip, itens, nomeArquivo } = await gerarBackup(userId);
      const provedor = deps.emailProvider ?? provedorDeEmail(env, deps.fetchImpl ?? fetch);
      const registro: BackupRegistro = {
        id: randomUUID(),
        userId,
        email,
        criadoEm: agora().toISOString(),
        bytes: zip.length,
        itens,
        status: "nao_configurado",
        erro: null,
        provedor: provedor?.nome ?? "nenhum",
      };

      if (!provedor) {
        registro.erro = instrucaoDeConfiguracao();
        await deps.store.registrarBackup(registro);
        return reply.code(503).send({
          status: "nao_configurado",
          erro: "envio de e-mail não configurado neste ambiente",
          instrucao: registro.erro,
          downloadDisponivel: "/api/anota/backup/arquivo",
          itens,
          bytes: zip.length,
        });
      }

      const r = await provedor.enviar({
        para: email,
        assunto: "Seu backup do AnotA (Acompanhe.IA)",
        texto:
          `Segue em anexo o backup dos seus dados do AnotA gerado em ${registro.criadoEm}.\n\n` +
          `Conteúdo: ${itens} registros (contas, lançamentos, orçamentos, cartões, metas e notas).\n` +
          `Os valores estão em centavos e as datas em AAAA-MM-DD; o arquivo MANIFEST.json dentro do ZIP resume tudo.\n\n` +
          `Acompanhe.IA — AnotA`,
        anexo: { nomeArquivo, conteudo: zip, contentType: "application/zip" },
      });

      registro.status = r.status;
      registro.provedor = r.provedor;
      registro.erro = r.status === "enviado" ? null : ("erro" in r ? r.erro : null);
      await deps.store.registrarBackup(registro);

      if (r.status === "enviado") {
        return reply.send({ status: "enviado", email, provedor: r.provedor, itens, bytes: zip.length });
      }
      return reply.code(502).send({ status: r.status, email, erro: registro.erro, itens, bytes: zip.length, downloadDisponivel: "/api/anota/backup/arquivo" });
    });

    // ───────────────── apelidos das rotas antigas (compatibilidade) ─────────────────
    // O app já instalado, o bot e os testes antigos chamam `/api/minhas/*`. Aqui
    // os mesmos dados são servidos com o formato ANTIGO, sem duplicar lógica.
    // São SOMENTE LEITURA: escrever no AnotA é em /api/anota/* (uma porta só).
    app.get("/api/minhas/notas", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const q = (req.query as { q?: string }).q?.toLowerCase();
      const notas = await deps.store.listarNotas(userId);
      return reply.send({ notas: q ? notas.filter((n) => `${n.title} ${n.body} ${n.tags.join(" ")}`.toLowerCase().includes(q)) : notas });
    });

    app.get("/api/minhas/gastos", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const mes = (req.query as { mes?: string }).mes;
      const lancamentos = await deps.store.listarLancamentos(userId, {
        tipo: "despesa",
        ...(mes && ehYmValido(mes) ? { de: `${mes}-01`, ate: `${mes}-31` } : {}),
      });
      // formato antigo: `spentAt` em vez de `data`
      return reply.send({
        gastos: lancamentos.map((l) => ({
          id: l.id,
          userId: l.userId,
          amountCents: l.amountCents,
          category: l.category,
          description: l.description,
          spentAt: l.data,
          photoRef: l.photoRef,
          ocrText: l.ocrText,
          ocrEngine: l.ocrEngine,
          createdAt: l.createdAt,
        })),
        ocrEngine: ocr.engine,
      });
    });

    app.get("/api/minhas/resumo", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const ym = (req.query as { mes?: string; ym?: string }).ym ?? (req.query as { mes?: string }).mes ?? ymHoje();
      if (!ehYmValido(ym)) return reply.code(422).send({ error: "mês deve ser YYYY-MM" });
      const r = resumoMes(await deps.store.listarLancamentos(userId), ym);
      const topCategorias = r.porCategoria.filter((c) => c.tipo === "despesa").slice(0, 5).map((c) => [c.categoria, c.totalCents] as [string, number]);
      // o cliente antigo tipava o retorno sem o envelope `resumo` — mando os dois
      return reply.send({
        resumo: { totalCents: r.despesasCents, topCategorias, porCategoria: r.porCategoria },
        totalCents: r.despesasCents,
        topCategorias,
        porCategoria: r.porCategoria,
      });
    });

    app.get("/api/minhas/export.csv", async (req, reply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const csv = exportarCsv(await deps.store.listarLancamentos(userId));
      return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="acompanhe-anota.csv"').send(csv);
    });

    // utilidades exportadas via rota só para não virar código morto em teste
    app.get("/api/anota/util/valor", async (req, reply) => {
      const t = (req.query as { t?: string }).t ?? "";
      return reply.send({ cents: valorParaCents(t), tiposConta: TIPOS_CONTA });
    });
  };
}

/** `2026-01-31` + 2 meses → `2026-03-31` (clamp para o último dia do mês). */
function addMeses(data: string, meses: number): string {
  const [a, m, d] = data.split("-").map(Number);
  const zero = m! - 1 + meses;
  const ano = a! + Math.floor(zero / 12);
  const mes = (zero % 12) + 1;
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return `${ano}-${String(mes).padStart(2, "0")}-${String(Math.min(d!, ultimo)).padStart(2, "0")}`;
}
