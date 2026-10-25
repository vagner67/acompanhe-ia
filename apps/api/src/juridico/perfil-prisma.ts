/**
 * Store Prisma dos perfis de coleta (plano-91-tribunais-nacional §5).
 *
 * Diferente do InMemoryPerfilStore, aqui o que o ciclo aprendeu SOBREVIVE a
 * restart/deploy — e é isso que faz o auto-aperfeiçoamento valer alguma coisa.
 * Cada promoção grava uma linha nova (fonteId + versao únicos) e a métrica do
 * ciclo vai para FonteMetrica (auditoria: dá para ver por que promoveu).
 */
import { PrismaClient, type Prisma } from "@acompanhe/db";

import {
  InMemoryPerfilStore,
  LIMITES,
  PERFIL_PADRAO,
  type Decisao,
  type Metrica,
  type PerfilFonte,
  type PerfilStore,
} from "./autoaperfeicoamento.js";

type LinhaPerfil = Prisma.FontePerfilGetPayload<Record<string, never>>;

function paraPerfil(row: LinhaPerfil): PerfilFonte {
  return {
    fonteId: row.fonteId,
    timeoutMs: row.timeoutMs,
    paginas: row.paginas,
    concorrencia: row.concorrencia,
    varianteNome: (row.varianteNome === 1 ? 1 : row.varianteNome === 2 ? 2 : 0) as 0 | 1 | 2,
    usaRelay: row.usaRelay,
    versao: row.versao,
  };
}

/**
 * Store resiliente: usa o Prisma quando o banco responde e cai para memória
 * quando a tabela ainda não existe (primeiro deploy, db push pendente) ou o
 * banco está fora. O auto-aperfeiçoamento continua funcionando — só não persiste.
 * Sem isso, uma tabela ausente virava 500 na cara do operador.
 */
export class PerfilStoreResiliente implements PerfilStore {
  private readonly memoria = new InMemoryPerfilStore();
  private usandoMemoria = false;
  private avisado = false;

  constructor(
    private readonly primario: PerfilStore,
    private readonly avisar: (msg: string) => void = () => {},
  ) {}

  private cair(e: unknown): void {
    this.usandoMemoria = true;
    if (!this.avisado) {
      this.avisado = true;
      this.avisar(`[perfis] banco indisponível (${(e as Error).message.slice(0, 120)}) — usando memória`);
    }
  }

  get persistindo(): boolean {
    return !this.usandoMemoria;
  }

  async obter(fonteId: string): Promise<PerfilFonte | null> {
    if (this.usandoMemoria) return this.memoria.obter(fonteId);
    try {
      return await this.primario.obter(fonteId);
    } catch (e) {
      this.cair(e);
      return this.memoria.obter(fonteId);
    }
  }

  async salvar(perfil: PerfilFonte, decisao: Decisao): Promise<void> {
    if (!this.usandoMemoria) {
      try {
        await this.primario.salvar(perfil, decisao);
        return;
      } catch (e) {
        this.cair(e);
      }
    }
    await this.memoria.salvar(perfil, decisao);
  }

  async historico(fonteId: string): Promise<PerfilFonte[]> {
    if (this.usandoMemoria) return this.memoria.historico(fonteId);
    try {
      return await this.primario.historico(fonteId);
    } catch (e) {
      this.cair(e);
      return this.memoria.historico(fonteId);
    }
  }

  async rollback(fonteId: string, versao: number): Promise<PerfilFonte | null> {
    // rollback só existe em store com histórico; o contrato PerfilStore é mínimo
    if (this.usandoMemoria) return this.memoria.rollback(fonteId, versao);
    const p = this.primario as { rollback?: (f: string, v: number) => Promise<PerfilFonte | null> };
    if (!p.rollback) return this.memoria.rollback(fonteId, versao);
    try {
      return await p.rollback(fonteId, versao);
    } catch (e) {
      this.cair(e);
      return this.memoria.rollback(fonteId, versao);
    }
  }

  async registrarMetrica(m: Metrica, score: number): Promise<void> {
    if (this.usandoMemoria) return;
    const p = this.primario as { registrarMetrica?: (mm: Metrica, s: number) => Promise<void> };
    if (!p.registrarMetrica) return;
    await p.registrarMetrica(m, score).catch((e) => this.cair(e));
  }
}

export class PrismaPerfilStore implements PerfilStore {
  constructor(private readonly db: PrismaClient) {}

  async obter(fonteId: string): Promise<PerfilFonte | null> {
    const row = await this.db.fontePerfil.findFirst({
      where: { fonteId },
      orderBy: { versao: "desc" },
    });
    return row ? paraPerfil(row) : null;
  }

  async salvar(perfil: PerfilFonte, decisao: Decisao): Promise<void> {
    await this.db.fontePerfil.create({
      data: {
        fonteId: perfil.fonteId,
        versao: perfil.versao,
        timeoutMs: perfil.timeoutMs,
        paginas: perfil.paginas,
        concorrencia: perfil.concorrencia,
        varianteNome: perfil.varianteNome,
        usaRelay: perfil.usaRelay,
        score: decisao.scoreNovo,
        motivo: decisao.motivo.slice(0, 300),
      },
    });
  }

  async historico(fonteId: string): Promise<PerfilFonte[]> {
    const rows = await this.db.fontePerfil.findMany({
      where: { fonteId },
      orderBy: { versao: "asc" },
    });
    return rows.map(paraPerfil);
  }

  /** Volta para uma versão anterior gravando-a como NOVA versão (trilha preservada). */
  async rollback(fonteId: string, versao: number): Promise<PerfilFonte | null> {
    const alvo = await this.db.fontePerfil.findUnique({
      where: { fonteId_versao: { fonteId, versao } },
    });
    if (!alvo) return null;
    const ultima = await this.db.fontePerfil.findFirst({ where: { fonteId }, orderBy: { versao: "desc" } });
    const novaVersao = (ultima?.versao ?? 0) + 1;
    const perfil: PerfilFonte = { ...paraPerfil(alvo), versao: novaVersao };
    await this.db.fontePerfil.create({
      data: {
        fonteId,
        versao: novaVersao,
        timeoutMs: perfil.timeoutMs,
        paginas: perfil.paginas,
        concorrencia: perfil.concorrencia,
        varianteNome: perfil.varianteNome,
        usaRelay: perfil.usaRelay,
        score: alvo.score,
        motivo: `rollback para v${versao}`,
      },
    });
    return perfil;
  }

  /** Grava a métrica do ciclo (auditoria). Falha aqui não pode derrubar o ciclo. */
  async registrarMetrica(m: Metrica, score: number): Promise<void> {
    try {
      await this.db.fonteMetrica.create({
        data: {
          fonteId: m.fonteId,
          consultas: m.consultas,
          itens: m.itens,
          erros: m.erros,
          captchas: m.captchas,
          timeouts: m.timeouts,
          msP95: Math.round(m.msP95),
          canarioItens: m.canarioItens,
          score,
        },
      });
    } catch {
      // métrica é telemetria: perder uma linha não invalida o ciclo
    }
  }
}

/**
 * Perfil vigente de todas as fontes conhecidas, pronto para a busca aplicar.
 * Se o banco não responder, devolve vazio (a busca cai no padrão) — degradação,
 * nunca erro para o usuário.
 */
export async function perfisParaBusca(
  store: PerfilStore,
  fontes: string[],
): Promise<Record<string, PerfilFonte>> {
  const out: Record<string, PerfilFonte> = {};
  for (const f of fontes) {
    const p = await store.obter(f).catch(() => null);
    out[f] = p ?? { fonteId: f, ...PERFIL_PADRAO };
  }
  return out;
}

export { LIMITES };
