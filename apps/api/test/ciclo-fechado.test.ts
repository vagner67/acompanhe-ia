/**
 * Fechamento do ciclo do auto-aperfeiçoamento (plano-91-tribunais §5).
 *
 * O que estes testes provam — e que antes NÃO era verdade:
 *  1. o perfil aprendido é APLICADO na busca (timeout, concorrência, variante de nome, relay);
 *  2. o job e as rotas usam o MESMO store (o que o ciclo promove aparece em GET /auto);
 *  3. o store Prisma persiste versões/histórico/rollback e grava métricas;
 *  4. nada disso derruba a busca quando o store falha.
 */
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { InMemoryEntitlementsStore } from "../src/entitlements.js";
import { signInitData } from "../src/security/telegram-initdata.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";
import { InMemoryLegalStore } from "../src/juridico/service.js";
import { InMemoryIndiceStore } from "../src/juridico/indice.js";
import {
  InMemoryPerfilStore,
  PERFIL_PADRAO,
  type Decisao,
  type Metrica,
  type PerfilFonte,
} from "../src/juridico/autoaperfeicoamento.js";
import { variarNome } from "../src/juridico/nacional.js";
import { PrismaPerfilStore, perfisParaBusca } from "../src/juridico/perfil-prisma.js";
import { rodarCicloAuto } from "../src/jobs/autoaperfeicoamento.js";

const BOT = "123456789:TEST_TOKEN_AAA-BBB";
const SERVICE = "svc-token-teste";

const decisao = (scoreNovo: number): Decisao => ({
  fonteId: "esaj-sp",
  acao: "promover",
  scoreAtual: 40,
  scoreNovo,
  motivo: "ganho de 12 pts com timeout 9000ms",
  perfil: { fonteId: "esaj-sp", ...PERFIL_PADRAO, timeoutMs: 9_000, versao: 2 },
  anteriorVersao: 1,
});

const metrica = (fonteId: string, p: Partial<Metrica> = {}): Metrica => ({
  fonteId, coletadaEm: "2026-10-25T04:00:00Z", consultas: 1, itens: 5, erros: 0,
  captchas: 0, timeouts: 0, msP95: 900, canarioItens: 5, ...p,
});

function makeApp(perfis?: InMemoryPerfilStore, nacional?: (termo: string, o: unknown) => Promise<unknown>) {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "adm-tok",
  } as NodeJS.ProcessEnv);
  const ents = new InMemoryEntitlementsStore();
  const app = buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
    juridico: {
      store: new InMemoryLegalStore(),
      oabVerified: new Set<string>(),
      indice: new InMemoryIndiceStore(),
      serviceToken: () => SERVICE,
      ...(perfis ? { perfis } : {}),
      ...(nacional ? { nacional: nacional as never } : {}),
    },
    osint: { entitlements: ents },
  });
  return { app, ents };
}

async function login(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id: 88, first_name: "P" }) }, BOT);
  const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
  return res.json().token as string;
}

describe("Perfil APLICADO na busca — o que faltava para o ciclo fechar", () => {
  it("timeout, concorrência e versão do perfil chegam ao orquestrador", async () => {
    const store = new InMemoryPerfilStore();
    await store.salvar({ fonteId: "esaj-sp", ...PERFIL_PADRAO, timeoutMs: 7_000, concorrencia: 1, varianteNome: 1, versao: 2 }, decisao(60));
    let recebido: Record<string, PerfilFonte> | undefined;
    const { app, ents } = makeApp(store, async (_t, o) => {
      recebido = (o as { perfis?: Record<string, PerfilFonte> }).perfis;
      return {
        tipo: "nome", termo: "x", itens: [], fontes: [], aviso: null, rodape: "r",
        cobertura: { tribunais: 91, numero: 91, nome: 4, cpf: 4, ufsAbertas: [], djen: false }, msTotal: 1,
      };
    });
    const t = await login(app);
    await ents.grant("88", "juridica");
    await app.inject({ method: "GET", url: "/api/processos/nacional?q=Joao+Carlos", headers: { authorization: `Bearer ${t}` } });
    expect(recebido?.["esaj-sp"]?.timeoutMs).toBe(7_000);
    expect(recebido?.["esaj-sp"]?.concorrencia).toBe(1);
    expect(recebido?.["esaj-sp"]?.varianteNome).toBe(1);
    expect(recebido?.["esaj-sp"]?.versao).toBe(2);
    expect(recebido?.["djen"]).toBeDefined(); // fonte sem perfil cai no padrão, não fica undefined
    expect(recebido?.["djen"]?.versao).toBe(1);
    await app.close();
  });

  it("store quebrado não derruba a busca (degrada para o padrão)", async () => {
    const quebrado = {
      obter: async () => {
        throw new Error("db offline");
      },
      salvar: async () => {},
      historico: async () => [],
    };
    const { app, ents } = makeApp(quebrado as never, async () => ({
      tipo: "nome", termo: "x", itens: [], fontes: [], aviso: null, rodape: "r",
      cobertura: { tribunais: 91, numero: 91, nome: 4, cpf: 4, ufsAbertas: [], djen: false }, msTotal: 1,
    }));
    const t = await login(app);
    await ents.grant("88", "juridica");
    const r = await app.inject({ method: "GET", url: "/api/processos/nacional?q=Joao+Carlos", headers: { authorization: `Bearer ${t}` } });
    expect(r.statusCode).toBe(200);
    await app.close();
  });

  it("variarNome respeita as 3 variantes do perfil", () => {
    expect(variarNome("João Carlos da Silva", 0)).toBe("João Carlos da Silva");
    expect(variarNome("João Carlos da Silva", 1)).toBe("Joao Carlos da Silva");
    expect(variarNome("João Carlos da Silva", 2)).toBe("Silva João");
    expect(variarNome("João", 2)).toBe("João"); // nome único não muda
  });

  it("perfisParaBusca devolve o padrão para fonte sem histórico", async () => {
    const p = await perfisParaBusca(new InMemoryPerfilStore(), ["esaj-ac", "djen"]);
    expect(p["esaj-ac"]!.versao).toBe(1);
    expect(p["esaj-ac"]!.timeoutMs).toBe(PERFIL_PADRAO.timeoutMs);
    expect(Object.keys(p)).toEqual(["esaj-ac", "djen"]);
  });
});

describe("Job e rotas no MESMO store — o ciclo aparece em GET /auto", () => {
  it("ciclo que promove aparece no perfil vigente da API", async () => {
    const store = new InMemoryPerfilStore();
    const { app } = makeApp(store);

    // ciclo com medição injetada: atual fraco, vizinho com timeout maior ótimo
    await rodarCicloAuto({
      store,
      fontes: ["esaj-sp"],
      medir: async () => [metrica("esaj-sp", { msP95: 25_000, itens: 1, canarioItens: 0 })],
      medirCandidato: async (_f, cand) =>
        cand.timeoutMs > 12_000
          ? metrica("esaj-sp", { msP95: 300, itens: 20, canarioItens: 20, melhorRecall: 20 })
          : metrica("esaj-sp", { msP95: 25_000, itens: 1, canarioItens: 0 }),
    });

    const r = await app.inject({ method: "GET", url: "/api/processos/auto", headers: { "x-service-token": SERVICE } });
    const corpo = r.json();
    const perfil = corpo.perfis.find((p: { fonteId: string }) => p.fonteId === "esaj-sp");
    expect(perfil).toBeDefined();
    expect(perfil.versoes).toBeGreaterThan(0); // o que o job gravou está visível
    expect(perfil.vigente.versao).toBeGreaterThanOrEqual(1);
    await app.close();
  });
});

describe("Store Prisma — persistência real do que foi aprendido", () => {
  /** Fake mínimo do PrismaClient com as 2 tabelas usadas (mesmo contrato). */
  function fakeDb() {
    const perfis: Array<Record<string, unknown>> = [];
    const metricas: Array<Record<string, unknown>> = [];
    return {
      perfis,
      metricas,
      fontePerfil: {
        findFirst: async ({ where, orderBy }: { where: { fonteId: string }; orderBy: { versao: "desc" | "asc" } }) => {
          const ls = perfis.filter((p) => p.fonteId === where.fonteId).sort((a, b) => Number(a.versao) - Number(b.versao));
          return orderBy.versao === "desc" ? (ls[ls.length - 1] ?? null) : (ls[0] ?? null);
        },
        findMany: async ({ where, orderBy }: { where: { fonteId: string }; orderBy: { versao: "asc" } }) =>
          perfis.filter((p) => p.fonteId === where.fonteId).sort((a, b) => (orderBy.versao === "asc" ? Number(a.versao) - Number(b.versao) : Number(b.versao) - Number(a.versao))),
        findUnique: async ({ where }: { where: { fonteId_versao: { fonteId: string; versao: number } } }) =>
          perfis.find((p) => p.fonteId === where.fonteId_versao.fonteId && p.versao === where.fonteId_versao.versao) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          perfis.push(data);
          return data;
        },
      },
      fonteMetrica: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          metricas.push(data);
          return data;
        },
      },
    };
  }

  it("salva, lê o vigente (maior versão) e mantém histórico ordenado", async () => {
    const db = fakeDb();
    const store = new PrismaPerfilStore(db as never);
    await store.salvar({ fonteId: "esaj-sp", ...PERFIL_PADRAO, timeoutMs: 5_000, versao: 2 }, decisao(55));
    await store.salvar({ fonteId: "esaj-sp", ...PERFIL_PADRAO, timeoutMs: 3_000, versao: 3 }, decisao(61));
    const vigente = await store.obter("esaj-sp");
    expect(vigente?.versao).toBe(3);
    expect(vigente?.timeoutMs).toBe(3_000);
    expect((await store.historico("esaj-sp")).map((p) => p.versao)).toEqual([2, 3]);
  });

  it("rollback grava NOVA versão com a config antiga (trilha preservada)", async () => {
    const db = fakeDb();
    const store = new PrismaPerfilStore(db as never);
    await store.salvar({ fonteId: "djen", ...PERFIL_PADRAO, timeoutMs: 5_000, versao: 2 }, decisao(50));
    await store.salvar({ fonteId: "djen", ...PERFIL_PADRAO, timeoutMs: 9_000, versao: 3 }, decisao(60));
    const voltou = await store.rollback("djen", 2);
    expect(voltou?.versao).toBe(4);
    expect(voltou?.timeoutMs).toBe(5_000);
    expect((await store.obter("djen"))?.timeoutMs).toBe(5_000); // vigente é o rollback
    expect(db.perfis).toHaveLength(3); // nada foi apagado
  });

  it("rollback de versão inexistente devolve null", async () => {
    const store = new PrismaPerfilStore(fakeDb() as never);
    expect(await store.rollback("esaj-sp", 99)).toBeNull();
  });

  it("métrica do ciclo é gravada; falha de métrica não lança", async () => {
    const db = fakeDb();
    const store = new PrismaPerfilStore(db as never);
    await store.registrarMetrica(metrica("esaj-sp"), 120.5);
    expect(db.metricas).toHaveLength(1);
    expect(db.metricas[0]!.score).toBe(120.5);

    const ruim = { fonteMetrica: { create: async () => { throw new Error("tabela ausente"); } } };
    const s2 = new PrismaPerfilStore(ruim as never);
    await expect(s2.registrarMetrica(metrica("x"), 1)).resolves.toBeUndefined();
  });

  it("varianteNome fora da faixa é normalizada ao ler do banco (defesa contra dado sujo)", async () => {
    const db = fakeDb();
    db.perfis.push({ fonteId: "esaj-ac", versao: 2, timeoutMs: 1000, paginas: 1, concorrencia: 1, varianteNome: 9, usaRelay: false, score: 1 });
    const p = await new PrismaPerfilStore(db as never).obter("esaj-ac");
    expect(p?.varianteNome).toBe(0);
  });
});

describe("Resiliência — banco sem a tabela não pode virar 500", () => {
  /** Simula P2021 (tabela ausente): todo acesso ao Prisma explode. */
  const prismaQuebrado = {
    fontePerfil: {
      findFirst: async () => {
        throw new Error("P2021: The table public.FontePerfil does not exist");
      },
      findMany: async () => {
        throw new Error("P2021");
      },
      findUnique: async () => {
        throw new Error("P2021");
      },
      create: async () => {
        throw new Error("P2021");
      },
    },
    fonteMetrica: {
      create: async () => {
        throw new Error("P2021");
      },
    },
  };

  it("cai para memória e continua operando (com aviso único)", async () => {
    const { PerfilStoreResiliente } = await import("../src/juridico/perfil-prisma.js");
    const avisos: string[] = [];
    const store = new PerfilStoreResiliente(new PrismaPerfilStore(prismaQuebrado as never), (m) => avisos.push(m));

    expect(await store.obter("esaj-sp")).toBeNull(); // não lança
    await store.salvar({ fonteId: "esaj-sp", ...PERFIL_PADRAO, timeoutMs: 4_000, versao: 2 }, decisao(70));
    expect((await store.obter("esaj-sp"))!.timeoutMs).toBe(4_000); // agora vem da memória
    expect(await store.historico("esaj-sp")).toHaveLength(1);
    await store.registrarMetrica(metrica("esaj-sp"), 1);
    expect(avisos).toHaveLength(1); // avisa uma vez, não a cada chamada
    expect(store.persistindo).toBe(false);
  });

  it("GET /auto responde 200 mesmo com banco quebrado", async () => {
    const { PerfilStoreResiliente } = await import("../src/juridico/perfil-prisma.js");
    const store = new PerfilStoreResiliente(new PrismaPerfilStore(prismaQuebrado as never));
    const { app } = makeApp(store as never);
    const r = await app.inject({ method: "GET", url: "/api/processos/auto", headers: { "x-service-token": SERVICE } });
    expect(r.statusCode).toBe(200);
    expect(r.json().perfis.length).toBeGreaterThan(0);
    await app.close();
  });
});
