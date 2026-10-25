/**
 * Persistência do núcleo (plano.md §3.3).
 *
 * O motor antigo guardava perfil em memória e deriva em memória — restart apagava
 * o aprendizado. Aqui cada coletor tem estado versionado, série de métricas e
 * trilha de ações (com a origem: `ia` ou `regras`), tudo durável.
 */
import { Prisma, PrismaClient } from "@acompanhe/db";

import type { Params } from "./tipos.js";

export interface EstadoColetor {
  coletorId: string;
  params: Params;
  versao: number;
  ativo: boolean;
  scoreAtual: number | null;
  itensUltimaColeta: number;
  ultimoOkEm: string | null;
  ultimoErro: string | null;
  /** ciclos seguidos sem entregar o mínimo do canário (sinal de deriva) */
  ciclosZerados: number;
  proximaExecucaoEm: string | null;
  atualizadoEm: string;
}

export interface MetricaColeta {
  coletorId: string;
  ts: string;
  http: number | null;
  ms: number;
  itens: number;
  ok: boolean;
  erro: string | null;
  captcha: boolean;
  bloqueio: boolean;
  score: number;
}

export interface RegistroAcao {
  coletorId: string;
  ts: string;
  origem: "ia" | "regras";
  tipo: string;
  acao: string;
  evidencia: string;
  resultado: "aplicada" | "rejeitada" | "revertida" | "mantida" | "desativada";
  motivo: string;
  versaoAntes: number;
  versaoDepois: number;
  /** snapshots para rollback real (params vigentes antes/depois da ação) */
  paramsAntes?: Params;
  paramsDepois?: Params;
}

export interface StoreNucleo {
  obter(coletorId: string): Promise<EstadoColetor | null>;
  salvar(estado: EstadoColetor): Promise<void>;
  registrarMetrica(m: MetricaColeta): Promise<void>;
  registrarAcao(a: RegistroAcao): Promise<void>;
  /** série medida — SEMPRE da mais antiga para a mais recente (contrato) */
  metricas(coletorId: string, limite?: number): Promise<MetricaColeta[]>;
  /**
   * ações registradas — SEMPRE da mais antiga para a mais recente (contrato).
   * A ordem é parte do contrato porque o motor lê o histórico de trás para
   * frente para achar a última decisão: as duas implementações discordavam
   * (memória: asc; Prisma: desc) e o rollback nunca fechava.
   */
  acoes(coletorId: string, limite?: number): Promise<RegistroAcao[]>;
  estados(): Promise<EstadoColetor[]>;
}

export function estadoInicial(coletorId: string, params: Params, agora = new Date().toISOString()): EstadoColetor {
  return {
    coletorId,
    params: { ...params },
    versao: 1,
    ativo: true,
    scoreAtual: null,
    itensUltimaColeta: 0,
    ultimoOkEm: null,
    ultimoErro: null,
    ciclosZerados: 0,
    proximaExecucaoEm: null,
    atualizadoEm: agora,
  };
}

export class InMemoryNucleoStore implements StoreNucleo {
  private mapa = new Map<string, EstadoColetor>();
  private mets = new Map<string, MetricaColeta[]>();
  private acs = new Map<string, RegistroAcao[]>();

  async obter(coletorId: string): Promise<EstadoColetor | null> {
    return this.mapa.get(coletorId) ?? null;
  }

  async salvar(estado: EstadoColetor): Promise<void> {
    this.mapa.set(estado.coletorId, { ...estado, params: { ...estado.params } });
  }

  async registrarMetrica(m: MetricaColeta): Promise<void> {
    const l = this.mets.get(m.coletorId) ?? [];
    l.push(m);
    while (l.length > 500) l.shift();
    this.mets.set(m.coletorId, l);
  }

  async registrarAcao(a: RegistroAcao): Promise<void> {
    const l = this.acs.get(a.coletorId) ?? [];
    l.push(a);
    while (l.length > 200) l.shift();
    this.acs.set(a.coletorId, l);
  }

  async metricas(coletorId: string, limite = 50): Promise<MetricaColeta[]> {
    return (this.mets.get(coletorId) ?? []).slice(-limite);
  }

  async acoes(coletorId: string, limite = 50): Promise<RegistroAcao[]> {
    return (this.acs.get(coletorId) ?? []).slice(-limite);
  }

  async estados(): Promise<EstadoColetor[]> {
    return [...this.mapa.values()];
  }
}

// ───────────────────────── Prisma (durável) ─────────────────────────

type LinhaEstado = Prisma.ColetorEstadoGetPayload<Record<string, never>>;

function paraEstado(row: LinhaEstado): EstadoColetor {
  return {
    coletorId: row.coletorId,
    params: (row.params ?? {}) as Params,
    versao: row.versao,
    ativo: row.ativo,
    scoreAtual: row.scoreAtual,
    itensUltimaColeta: row.itensUltimaColeta,
    ultimoOkEm: row.ultimoOkEm ? row.ultimoOkEm.toISOString() : null,
    ultimoErro: row.ultimoErro,
    ciclosZerados: row.ciclosZerados,
    proximaExecucaoEm: row.proximaExecucaoEm ? row.proximaExecucaoEm.toISOString() : null,
    atualizadoEm: row.atualizadoEm.toISOString(),
  };
}

export class PrismaNucleoStore implements StoreNucleo {
  constructor(private readonly db: PrismaClient) {}

  async obter(coletorId: string): Promise<EstadoColetor | null> {
    const row = await this.db.coletorEstado.findUnique({ where: { coletorId } });
    return row ? paraEstado(row) : null;
  }

  async salvar(estado: EstadoColetor): Promise<void> {
    const data = {
      params: estado.params as Prisma.InputJsonValue,
      versao: estado.versao,
      ativo: estado.ativo,
      scoreAtual: estado.scoreAtual,
      itensUltimaColeta: estado.itensUltimaColeta,
      ultimoOkEm: estado.ultimoOkEm ? new Date(estado.ultimoOkEm) : null,
      ultimoErro: estado.ultimoErro,
      ciclosZerados: estado.ciclosZerados,
      proximaExecucaoEm: estado.proximaExecucaoEm ? new Date(estado.proximaExecucaoEm) : null,
      atualizadoEm: new Date(estado.atualizadoEm),
    };
    await this.db.coletorEstado.upsert({
      where: { coletorId: estado.coletorId },
      create: { coletorId: estado.coletorId, ...data },
      update: data,
    });
  }

  async registrarMetrica(m: MetricaColeta): Promise<void> {
    await this.db.coletorMetrica.create({
      data: {
        coletorId: m.coletorId,
        ts: new Date(m.ts),
        http: m.http,
        ms: Math.round(m.ms),
        itens: m.itens,
        ok: m.ok,
        erro: m.erro ? m.erro.slice(0, 300) : null,
        captcha: m.captcha,
        bloqueio: m.bloqueio,
        score: m.score,
      },
    });
  }

  async registrarAcao(a: RegistroAcao): Promise<void> {
    await this.db.coletorAcao.create({
      data: {
        coletorId: a.coletorId,
        ts: new Date(a.ts),
        origem: a.origem,
        tipo: a.tipo,
        acao: a.acao.slice(0, 500),
        evidencia: a.evidencia.slice(0, 1500),
        resultado: a.resultado,
        motivo: a.motivo.slice(0, 500),
        versaoAntes: a.versaoAntes,
        versaoDepois: a.versaoDepois,
        paramsAntes: a.paramsAntes ? (a.paramsAntes as Prisma.InputJsonValue) : Prisma.DbNull,
        paramsDepois: a.paramsDepois ? (a.paramsDepois as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
  }

  async metricas(coletorId: string, limite = 50): Promise<MetricaColeta[]> {
    const rows = await this.db.coletorMetrica.findMany({
      where: { coletorId },
      orderBy: { ts: "desc" },
      take: limite,
    });
    return rows
      .map((r) => ({
        coletorId: r.coletorId,
        ts: r.ts.toISOString(),
        http: r.http,
        ms: r.ms,
        itens: r.itens,
        ok: r.ok,
        erro: r.erro,
        captcha: r.captcha,
        bloqueio: r.bloqueio,
        score: r.score,
      }))
      .reverse(); // desc + take = as N mais recentes; devolve em ordem cronológica
  }

  async acoes(coletorId: string, limite = 50): Promise<RegistroAcao[]> {
    const rows = await this.db.coletorAcao.findMany({
      where: { coletorId },
      orderBy: { ts: "desc" },
      take: limite,
    });
    // desc + take = as N mais recentes; o contrato devolve em ordem cronológica
    return rows.reverse().map((r) => ({
      coletorId: r.coletorId,
      ts: r.ts.toISOString(),
      origem: r.origem === "ia" ? "ia" : "regras",
      tipo: r.tipo,
      acao: r.acao,
      evidencia: r.evidencia,
      resultado: r.resultado as RegistroAcao["resultado"],
      motivo: r.motivo,
      versaoAntes: r.versaoAntes,
      versaoDepois: r.versaoDepois,
      ...(r.paramsAntes ? { paramsAntes: r.paramsAntes as Params } : {}),
      ...(r.paramsDepois ? { paramsDepois: r.paramsDepois as Params } : {}),
    }));
  }

  async estados(): Promise<EstadoColetor[]> {
    const rows = await this.db.coletorEstado.findMany({ orderBy: { coletorId: "asc" } });
    return rows.map(paraEstado);
  }
}

/**
 * Banco fora ou tabela ainda não criada (primeiro deploy) não pode derrubar o
 * auto-aperfeiçoamento: cai para memória e avisa uma vez.
 */
export class NucleoStoreResiliente implements StoreNucleo {
  private readonly memoria = new InMemoryNucleoStore();
  private emMemoria = false;
  private avisou = false;

  constructor(
    private readonly primario: StoreNucleo,
    private readonly avisar: (msg: string) => void = () => {},
  ) {}

  get persistindo(): boolean {
    return !this.emMemoria;
  }

  private cair(e: unknown): void {
    this.emMemoria = true;
    if (!this.avisou) {
      this.avisou = true;
      this.avisar(`[nucleo] store indisponível (${(e as Error).message.slice(0, 120)}) — usando memória`);
    }
  }

  private async com<T>(fn: () => Promise<T>, padrao: () => Promise<T>): Promise<T> {
    if (this.emMemoria) return padrao();
    try {
      return await fn();
    } catch (e) {
      this.cair(e);
      return padrao();
    }
  }

  obter(id: string) { return this.com(() => this.primario.obter(id), () => this.memoria.obter(id)); }
  salvar(e: EstadoColetor) { return this.com(() => this.primario.salvar(e), () => this.memoria.salvar(e)); }
  registrarMetrica(m: MetricaColeta) { return this.com(() => this.primario.registrarMetrica(m), () => this.memoria.registrarMetrica(m)); }
  registrarAcao(a: RegistroAcao) { return this.com(() => this.primario.registrarAcao(a), () => this.memoria.registrarAcao(a)); }
  metricas(id: string, l?: number) { return this.com(() => this.primario.metricas(id, l), () => this.memoria.metricas(id, l)); }
  acoes(id: string, l?: number) { return this.com(() => this.primario.acoes(id, l), () => this.memoria.acoes(id, l)); }
  estados() { return this.com(() => this.primario.estados(), () => this.memoria.estados()); }
}
