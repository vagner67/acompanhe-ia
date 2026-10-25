/**
 * Store Prisma do índice próprio (plano-refatoracao §6.2).
 * Postgres real: upsert em transação (processo + partes + movimentos) e busca
 * com facetas. LGPD: só `documentoHash` (SHA-256), nunca CPF em claro.
 */
import { Prisma, type PrismaClient } from "@acompanhe/db";

import {
  facetasDe,
  normalizarNome,
  type BuscaIndice,
  type IndiceFacetas,
  type IndiceStore,
  type ProcessoIndiceDto,
} from "./indice.js";

type Db = PrismaClient;

type LinhaProcesso = Prisma.ProcessoIndiceGetPayload<{ include: { partes: true; movimentos: true } }>;

function paraDto(row: LinhaProcesso): ProcessoIndiceDto {
  return {
    numeroCnj: row.numeroCnj,
    tribunal: row.tribunal,
    uf: row.uf,
    grau: row.grau,
    classe: row.classe,
    assunto: row.assunto,
    orgaoJulgador: row.orgaoJulgador,
    valorCausa: row.valorCausa,
    dataAjuizamento: row.dataAjuizamento,
    status: row.status,
    ultimoMovimentoNome: row.ultimoMovimentoNome,
    ultimoMovimentoData: row.ultimoMovimentoData,
    partes: row.partes.map((p) => ({
      nome: p.nome,
      nomeNormalizado: p.nomeNormalizado,
      documentoHash: p.documentoHash,
      polo: p.polo,
      tipoPessoa: p.tipoPessoa,
      scoreVinculo: p.scoreVinculo,
      motivoVinculo: p.motivoVinculo as ProcessoIndiceDto["partes"][number]["motivoVinculo"],
    })),
    movimentos: row.movimentos.map((m) => ({ codigo: m.codigo, nome: m.nome, dataHora: m.dataHora })),
    fonte: row.fonte,
    atualizadoEm: row.atualizadoEm.toISOString(),
  };
}

export class PrismaIndiceStore implements IndiceStore {
  constructor(private db: Db) {}

  async upsertMuitos(processos: ProcessoIndiceDto[]): Promise<number> {
    let n = 0;
    for (const p of processos) {
      await this.db.$transaction(async (tx) => {
        const dados = {
          tribunal: p.tribunal,
          uf: p.uf,
          grau: p.grau,
          classe: p.classe,
          assunto: p.assunto,
          orgaoJulgador: p.orgaoJulgador,
          valorCausa: p.valorCausa,
          dataAjuizamento: p.dataAjuizamento,
          status: p.status,
          ultimoMovimentoNome: p.ultimoMovimentoNome,
          ultimoMovimentoData: p.ultimoMovimentoData,
          fonte: p.fonte,
          atualizadoEm: new Date(p.atualizadoEm),
        };
        await tx.processoIndice.upsert({
          where: { numeroCnj: p.numeroCnj },
          create: { numeroCnj: p.numeroCnj, ...dados },
          update: dados,
        });
        // partes: reconstruídas a partir do que a fonte informou (nunca fundimos
        // pessoa diferente — só substituímos quando vêm partes novas)
        if (p.partes.length > 0) {
          await tx.parteIndice.deleteMany({ where: { numeroCnj: p.numeroCnj } });
          await tx.parteIndice.createMany({
            data: p.partes.map((parte) => ({
              numeroCnj: p.numeroCnj,
              nome: parte.nome,
              nomeNormalizado: parte.nomeNormalizado || normalizarNome(parte.nome),
              documentoHash: parte.documentoHash,
              polo: parte.polo,
              tipoPessoa: parte.tipoPessoa,
              scoreVinculo: parte.scoreVinculo,
              motivoVinculo: parte.motivoVinculo,
            })),
          });
        }
        if (p.movimentos.length > 0) {
          await tx.movimentoIndice.createMany({
            data: p.movimentos.map((m) => ({
              numeroCnj: p.numeroCnj,
              codigo: m.codigo,
              nome: m.nome,
              dataHora: m.dataHora,
            })),
            skipDuplicates: true,
          });
        }
      });
      n += 1;
    }
    return n;
  }

  async buscar(q: BuscaIndice): Promise<ProcessoIndiceDto[]> {
    const where: Prisma.ProcessoIndiceWhereInput = {};
    if (q.numero) {
      // aceita a forma canônica e a crua (registros gravados antes da padronização)
      where.numeroCnj = { in: [...new Set([q.numero, q.numero.replace(/\D+/g, "")])] };
    }
    if (q.uf) where.uf = q.uf;
    if (q.tribunal) where.tribunal = q.tribunal;
    if (q.ano) where.dataAjuizamento = { startsWith: q.ano };
    if (q.documento) {
      const { chaveDocumento } = await import("./indice.js");
      where.partes = { some: { documentoHash: chaveDocumento(q.documento) } };
    } else if (q.nome) {
      // normalizado + prefixo dos dois primeiros tokens (usa índice do nomeNormalizado)
      const alvo = normalizarNome(q.nome);
      const tokens = alvo.split(" ").filter(Boolean).slice(0, 2);
      where.partes = { some: { AND: tokens.map((t) => ({ nomeNormalizado: { contains: t } })) } };
    }
    const rows = await this.db.processoIndice.findMany({
      where,
      include: { partes: true, movimentos: { orderBy: { dataHora: "desc" }, take: 40 } },
      orderBy: { atualizadoEm: "desc" },
      take: Math.max(1, Math.min(200, q.limite ?? 100)),
    });
    return rows.map(paraDto);
  }

  async facetas(q: BuscaIndice): Promise<IndiceFacetas> {
    return facetasDe(await this.buscar({ ...q, limite: 500 }));
  }

  async total(): Promise<number> {
    return this.db.processoIndice.count();
  }
}
