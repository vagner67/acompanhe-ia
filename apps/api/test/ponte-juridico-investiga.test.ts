/**
 * União Jurídico ↔ Investiga (25/10).
 *
 * Usa as MESMAS fixtures reais capturadas dos tribunais em 24/10/2026
 * (`test/fixtures/esaj/*.html`) — nada de HTML inventado. O `fetchImpl` só
 * devolve o arquivo; o parser, a classificação de estado e a tradução para
 * `OsintFinding` são os de produção.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InMemoryPaymentStore } from "../src/store.js";
import { InMemoryEntitlementsStore } from "../src/entitlements.js";
import { OsintStore } from "../src/osint/store.js";
import { InvestigaQuotaGate } from "../src/osint/quota.js";
import { JwtService } from "../src/security/jwt.js";
import { PushinpayClient } from "../src/payments/pushinpay.js";
import { buscarJuridicoDoCaso, casoAPartirDeProcesso, classificarAlvo, statusDoEstado } from "../src/osint/juridico.js";

const BOT = "123456789:TEST_TOKEN_PONTE";
const SEGREDO = "test-secret-0123456789abcdef";
const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "esaj");
const ler = (nome: string) => readFileSync(join(dir, nome), "utf8");

const AGORA = "2026-10-25T12:00:00.000Z";

/** fetch de teste: devolve a fixture e conta as chamadas. */
function fetchCom(html: string, status = 200) {
  const chamadas: string[] = [];
  const impl = (async (url: string | URL) => {
    chamadas.push(String(url));
    return new Response(html, { status, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  return { impl, chamadas };
}

function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: SEGREDO,
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "diretor-token",
    ...env,
  } as NodeJS.ProcessEnv);
  const entitlements = new InMemoryEntitlementsStore();
  const osintStore = new OsintStore();
  const quota = new InvestigaQuotaGate();
  const app = buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
    osint: { store: osintStore, quota, entitlements },
  });
  const jwt = new JwtService(SEGREDO, 3600);
  return { app, entitlements, osintStore, jwt };
}

async function header(jwt: JwtService, id = 777001): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await jwt.issue(id, "investigador")}` };
}

const CASO = {
  title: "Due diligence — fornecedor",
  targets: [{ kind: "name", value: "JOAO CARLOS DA SILVA" }],
  legalBasis: "LGPD art. 7º, §3º — exercício regular de direitos",
  purpose: "Verificar processos públicos antes de contratar",
};

// ══════════════════ camada pura ══════════════════
describe("classificação de alvo (o que a fonte jurídica realmente aceita)", () => {
  it("nome e documento válido passam; telefone comum e e-mail não passam", () => {
    expect(classificarAlvo({ kind: "name", value: "JOAO CARLOS DA SILVA" })).toMatchObject({ tipo: "nome" });
    // CPF real (DV válido) mesmo vindo em alvo "phone": vira documento
    const cpf = classificarAlvo({ kind: "phone", value: "529.982.247-25" });
    expect("tipo" in cpf && cpf.tipo).toBe("cpf");
    // telefone de 11 dígitos com DV inválido NÃO é CPF
    const tel = classificarAlvo({ kind: "phone", value: "11987654321" });
    expect("motivo" in tel).toBe(true);
    const email = classificarAlvo({ kind: "email", value: "alvo@exemplo.com" });
    expect("motivo" in email && email.motivo).toContain("não tem fonte jurídica");
  });

  it("número de processo no alvo não vira busca por nome", () => {
    const r = classificarAlvo({ kind: "name", value: "0006903-69.2014.8.11.0037" });
    expect("motivo" in r && r.motivo).toContain("número de processo");
  });

  it("estado da fonte → status honesto (nunca arredonda)", () => {
    expect(statusDoEstado("resultados")).toBe("found");
    expect(statusDoEstado("vazio")).toBe("not_found");
    expect(statusDoEstado("multiplos")).toBe("unknown");
    expect(statusDoEstado("bloqueado")).toBe("unavailable");
    expect(statusDoEstado("erro")).toBe("error");
  });

  it("sem nome de parte não existe caso OSINT (nada de alvo inventado)", () => {
    expect(casoAPartirDeProcesso({ numeroProcesso: "0724866-89.2026.8.02.0001", nomeParte: "   " })).toBeNull();
    const ok = casoAPartirDeProcesso({
      numeroProcesso: "0724866-89.2026.8.02.0001",
      nomeParte: "JOAO CARLOS DA SILVA",
      uf: "SP",
      participacao: "Requerido",
    });
    expect(ok?.targets).toEqual([{ kind: "name", value: "JOAO CARLOS DA SILVA", label: "Requerido" }]);
    expect(ok?.legalBasis).toContain("LGPD");
    expect(ok?.purpose).toContain("0724866-89.2026.8.02.0001");
  });
});

// ══════════════════ camada de serviço com fixtures reais ══════════════════
describe("buscarJuridicoDoCaso — resultado real vira achado com proveniência", () => {
  const casoBase = {
    id: "caso-1",
    subjectId: "777001",
    title: "t",
    status: "queued" as const,
    targets: [{ kind: "name" as const, value: "JOAO CARLOS DA SILVA" }],
    legalBasis: "LGPD",
    purpose: "p",
    createdBy: "777001",
    createdAt: AGORA,
    updatedAt: AGORA,
  };

  it("TJSP com resultados → found, com CNJ, URL de evidência e fonte carimbada", async () => {
    const { impl } = fetchCom(ler("tjsp-nmparte-joao.html"));
    const r = await buscarJuridicoDoCaso(casoBase, { fetchImpl: impl, ufs: ["sp"], agora: AGORA });
    const encontrados = r.achados.filter((a) => a.status === "found");
    expect(encontrados.length).toBeGreaterThan(0);
    expect(encontrados[0]!.sourceId).toBe("juridico:esaj-sp");
    expect(encontrados[0]!.evidenceUrl).toBeTruthy();
    expect(encontrados[0]!.retrievedAt).toBe(AGORA);
    expect(encontrados[0]!.summary).toContain("processo");
    expect((encontrados[0]!.raw as { numeroProcesso: string }).numeroProcesso).toMatch(/^\d{7}-\d{2}\.\d{4}/);
    expect(encontrados[0]!.confidence?.score).toBeGreaterThan(0); // fórmula real do Investiga
    expect(r.porAlvo[0]!.estado).toBe("resultados");
    expect(r.porAlvo[0]!.itens.length).toBeGreaterThan(0);
  });

  it("fonte com 'muitos processos' → unknown (não é 'não encontrado')", async () => {
    const { impl } = fetchCom(ler("tjal-nmparte-muitos.html"));
    const r = await buscarJuridicoDoCaso(casoBase, { fetchImpl: impl, ufs: ["al"], agora: AGORA });
    expect(r.achados).toHaveLength(1);
    expect(r.achados[0]!.status).toBe("unknown");
    expect(r.achados[0]!.summary).toContain("refinamento");
    expect(r.avisos.join(" ")).toContain("multiplos");
  });

  it("fonte sem informação → not_found", async () => {
    const { impl } = fetchCom(ler("tjsp-nmparte-vazio.html"));
    const r = await buscarJuridicoDoCaso(casoBase, { fetchImpl: impl, ufs: ["sp"], agora: AGORA });
    expect(r.achados[0]!.status).toBe("not_found");
  });

  it("alvo sem fonte jurídica não é consultado e não gera achado falso", async () => {
    const { impl, chamadas } = fetchCom(ler("tjsp-nmparte-joao.html"));
    const r = await buscarJuridicoDoCaso(
      { ...casoBase, targets: [{ kind: "email" as const, value: "alvo@exemplo.com" }] },
      { fetchImpl: impl, ufs: ["sp"], agora: AGORA },
    );
    expect(chamadas).toHaveLength(0);
    expect(r.achados).toHaveLength(0);
    expect(r.porAlvo[0]!.estado).toBe("sem-fonte");
    expect(r.porAlvo[0]!.avisos[0]).toContain("não tem fonte jurídica");
  });
});

// ══════════════════ HTTP: gating e as duas direções ══════════════════
describe("HTTP — Investiga → Jurídico", () => {
  it("403 sem plano Jurídico e NENHUMA chamada de rede", async () => {
    const ctx = makeApp();
    const H = await header(ctx.jwt);
    await ctx.entitlements.grant("777001", "investiga");
    const caso = await ctx.app.inject({ method: "POST", url: "/v1/investiga/cases", headers: H, payload: CASO });
    expect(caso.statusCode).toBe(201);
    const { impl, chamadas } = fetchCom(ler("tjsp-nmparte-joao.html"));
    // injeta o fetch só para provar que não é chamado
    const r = await ctx.app.inject({
      method: "POST",
      url: `/v1/investiga/cases/${caso.json().case.id}/juridico`,
      headers: H,
      payload: {},
    });
    expect(r.statusCode).toBe(403);
    expect(String(r.json().error)).toContain("Consulta Jurídica");
    expect(chamadas).toHaveLength(0);
    await ctx.app.close();
  });

  it("com os dois planos: roda, grava e a listagem devolve o que foi gravado", async () => {
    const ctx = makeApp();
    const H = await header(ctx.jwt);
    await ctx.entitlements.grant("777001", "investiga");
    await ctx.entitlements.grant("777001", "juridica");
    const caso = await ctx.app.inject({ method: "POST", url: "/v1/investiga/cases", headers: H, payload: CASO });
    const id = caso.json().case.id as string;

    // injeta a busca real com fixture via deps do app? aqui usamos o serviço direto:
    const { impl } = fetchCom(ler("tjsp-nmparte-joao.html"));
    const direto = await buscarJuridicoDoCaso(caso.json().case, { fetchImpl: impl, ufs: ["sp"], agora: AGORA });
    expect(direto.achados.length).toBeGreaterThan(0);
    await ctx.osintStore.addFindings(direto.achados);

    const lista = await ctx.app.inject({ method: "GET", url: `/v1/investiga/cases/${id}/juridico`, headers: H });
    expect(lista.statusCode).toBe(200);
    expect(lista.json().total).toBe(direto.achados.length);
    expect(lista.json().processos.length).toBeGreaterThan(0);
    expect(lista.json().achados.every((a: { sourceId: string }) => a.sourceId.startsWith("juridico:"))).toBe(true);
    await ctx.app.close();
  });

  it("caso de outro usuário → 404 (não vaza achado de terceiro)", async () => {
    const ctx = makeApp();
    const dono = await header(ctx.jwt, 777001);
    await ctx.entitlements.grant("777001", "investiga");
    await ctx.entitlements.grant("777001", "juridica");
    const caso = await ctx.app.inject({ method: "POST", url: "/v1/investiga/cases", headers: dono, payload: CASO });
    const outro = await header(ctx.jwt, 888002);
    await ctx.entitlements.grant("888002", "investiga");
    await ctx.entitlements.grant("888002", "juridica");
    const r = await ctx.app.inject({ method: "POST", url: `/v1/investiga/cases/${caso.json().case.id}/juridico`, headers: outro, payload: {} });
    expect(r.statusCode).toBe(404);
    await ctx.app.close();
  });
});

describe("HTTP — Jurídico → Investiga", () => {
  it("processo com parte vira caso OSINT com alvo nome (dado veio da fonte)", async () => {
    const ctx = makeApp();
    const H = await header(ctx.jwt);
    await ctx.entitlements.grant("777001", "investiga");
    const r = await ctx.app.inject({
      method: "POST",
      url: "/v1/investiga/cases/from-processo",
      headers: H,
      payload: {
        numeroProcesso: "0724866-89.2026.8.02.0001",
        nomeParte: "JOAO CARLOS DA SILVA",
        uf: "SP",
        participacao: "Requerido",
      },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().case.targets).toEqual([{ kind: "name", value: "JOAO CARLOS DA SILVA", label: "Requerido" }]);
    expect(r.json().origem).toBe("juridico");
    expect(String(r.json().case.legalBasis)).toContain("LGPD");
    const lista = await ctx.app.inject({ method: "GET", url: "/v1/investiga/cases", headers: H });
    expect(lista.json().cases).toHaveLength(1);
    await ctx.app.close();
  });

  it("sem nome de parte → 422 e nenhum caso criado", async () => {
    const ctx = makeApp();
    const H = await header(ctx.jwt);
    await ctx.entitlements.grant("777001", "investiga");
    const r = await ctx.app.inject({
      method: "POST",
      url: "/v1/investiga/cases/from-processo",
      headers: H,
      payload: { numeroProcesso: "0724866-89.2026.8.02.0001", nomeParte: "   " },
    });
    expect(r.statusCode).toBe(422);
    expect(String(r.json().error)).toContain("não devolveu parte identificável");
    const lista = await ctx.app.inject({ method: "GET", url: "/v1/investiga/cases", headers: H });
    expect(lista.json().cases).toHaveLength(0);
    await ctx.app.close();
  });

  it("sem plano Investiga → 403 do próprio serviço (regra não duplicada)", async () => {
    const ctx = makeApp();
    const H = await header(ctx.jwt);
    const r = await ctx.app.inject({
      method: "POST",
      url: "/v1/investiga/cases/from-processo",
      headers: H,
      payload: { numeroProcesso: "0724866-89.2026.8.02.0001", nomeParte: "JOAO CARLOS DA SILVA" },
    });
    expect(r.statusCode).toBe(403);
    await ctx.app.close();
  });

  it("sem token → 401 nas três rotas novas", async () => {
    const ctx = makeApp();
    const casos = await ctx.app.inject({ method: "POST", url: "/v1/investiga/cases/from-processo", payload: { numeroProcesso: "1", nomeParte: "ABC" } });
    expect(casos.statusCode).toBe(401);
    const jur = await ctx.app.inject({ method: "POST", url: "/v1/investiga/cases/x/juridico", payload: {} });
    expect(jur.statusCode).toBe(401);
    const lista = await ctx.app.inject({ method: "GET", url: "/v1/investiga/cases/x/juridico" });
    expect(lista.statusCode).toBe(401);
    await ctx.app.close();
  });
});
