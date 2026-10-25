/**
 * "O auto-aperfeiçoamento está no app completo?" — prova por teste.
 *
 * Estes testes amarram as três pontas que fazem o ciclo valer:
 *   1. o perfil gravado no store é usado pela busca por nome/CPF (`/pesquisar`),
 *      que é a que o usuário usa — não só a busca nacional;
 *   2. o login do painel devolve as permissões do papel (sem isso a tela do
 *      operador quebrava ao entrar — crash medido no navegador);
 *   3. o visor de BD do painel inclui as tabelas do auto-aperfeiçoamento
 *      (FontePerfil/FonteMetrica/Coletor*), antes invisíveis ao operador.
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
import { InMemoryPerfilStore, PERFIL_PADRAO } from "../src/juridico/autoaperfeicoamento.js";
import { ensureDiretor, InMemoryAdminStore } from "../src/admin/service.js";
import { pesquisarTerceiros } from "../src/juridico/pesquisa.js";

const BOT = "123456789:TEST_TOKEN_AAA-BBB";

function makeApp(perfis = new InMemoryPerfilStore(), fetchImpl?: typeof fetch) {
  const config = loadConfig({
    BOT_TOKEN: BOT,
    JWT_SECRET: "test-secret-0123456789abcdef",
    PUSHINPAY_WEBHOOK_SECRET: "whsec",
    NODE_ENV: "test",
    ADMIN_TOKEN: "adm-tok",
  } as NodeJS.ProcessEnv);
  const ents = new InMemoryEntitlementsStore();
  const adminStore = new InMemoryAdminStore();
  const app = buildApp({
    config,
    payments: new InMemoryPaymentStore(),
    pushinpay: new PushinpayClient("https://api.pushinpay.com.br", "tok"),
    juridico: {
      store: new InMemoryLegalStore(),
      oabVerified: new Set<string>(),
      indice: new InMemoryIndiceStore(),
      perfis,
      ...(fetchImpl ? { datajudOpts: { fetchImpl } } : {}),
    },
    osint: { entitlements: ents },
    admin: { store: adminStore },
  });
  return { app, ents, perfis, adminStore };
}

async function login(app: ReturnType<typeof makeApp>["app"], id = 99): Promise<string> {
  const initData = signInitData({ auth_date: "1800000000", user: JSON.stringify({ id, first_name: "P" }) }, BOT);
  const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
  return res.json().token as string;
}

/** fetch falso que captura a URL consultada e devolve página sem resultados. */
function capturaUrl(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url));
    return new Response("<html><body>nao encontrado</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("Perfil aprendido vale na busca por nome/CPF", () => {
  it("variante 2 do perfil muda o termo enviado ao e-SAJ (acento/caixa)", async () => {
    const { fetchImpl, urls } = capturaUrl();
    await pesquisarTerceiros("nome", "José Antônio", {
      ufs: ["al"],
      fetchImpl,
      perfis: { "esaj-al": { fonteId: "esaj-al", ...PERFIL_PADRAO, varianteNome: 2, versao: 3 } },
    });
    expect(urls[0]).toContain("JOSE");
    expect(urls[0]).not.toContain("Jos%C3%A9");
  });

  it("variante 0 (fábrica) mantém o termo exato com acento", async () => {
    const { fetchImpl, urls } = capturaUrl();
    await pesquisarTerceiros("nome", "José Antônio", { ufs: ["al"], fetchImpl });
    expect(urls[0]).toContain("Jos");
    expect(urls[0]!.toUpperCase()).not.toContain("JOSE+ANTONIO");
  });

  it("a rota /pesquisar usa o perfil vigente do store (não só a nacional)", async () => {
    const perfis = new InMemoryPerfilStore();
    await perfis.salvar(
      { fonteId: "esaj-al", ...PERFIL_PADRAO, varianteNome: 2, timeoutMs: 9_000, versao: 4 },
      {
        fonteId: "esaj-al",
        acao: "promover",
        scoreAtual: 10,
        scoreNovo: 90,
        motivo: "teste",
        perfil: { fonteId: "esaj-al", ...PERFIL_PADRAO, varianteNome: 2, timeoutMs: 9_000, versao: 4 },
        anteriorVersao: 3,
      },
    );
    const { fetchImpl, urls } = capturaUrl();
    const { app, ents } = makeApp(perfis, fetchImpl);
    const t = await login(app);
    await ents.grant("99", "juridica");
    // sem rede: se a rota não aplicasse o perfil, ainda assim responderia 200 —
    // o que provamos aqui é que a rota lê o store e não explode no caminho.
    const r = await app.inject({
      method: "GET",
      url: "/api/processos/pesquisar?q=Jose+Antonio&uf=al",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.statusCode).toBe(200);
    // o termo foi para o e-SAJ na variante aprendida (v4: sem acento e caixa alta)
    expect(urls.join(" ")).toContain("JOSE");
    await app.close();
  });
});

describe("Painel do operador — permissões e visor do que o ciclo grava", () => {
  it("login devolve permissions do papel (antes quebrava a tela ao entrar)", async () => {
    const { app, adminStore } = makeApp();
    await ensureDiretor(adminStore, "adm-tok");
    const r = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: { email: "diretor@acompanhe.app", password: "adm-tok" },
    });
    const b = r.json();
    expect(r.statusCode).toBe(200);
    expect(b.admin.permissions).toEqual(["*"]);
    await app.close();
  });

  it("visor de BD aceita as tabelas do auto-aperfeiçoamento", async () => {
    const { app, adminStore } = makeApp();
    await ensureDiretor(adminStore, "adm-tok");
    const login1 = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: { email: "diretor@acompanhe.app", password: "adm-tok" },
    });
    const tk = login1.json().token as string;
    for (const tabela of ["fonteperfil", "fontemetrica", "coletoreestado", "coletoracao", "syncrun"]) {
      const r = await app.inject({ method: "GET", url: `/v1/admin/db/${tabela}`, headers: { authorization: `Bearer ${tk}` } });
      // sem DATABASE_URL o visor responde vazio — o que importa é NÃO ser 404 de whitelist
      expect(r.statusCode, tabela).toBe(200);
      // "modelo indisponível" = nome do model errado (bug real medido em produção)
      expect(r.json().error ?? "", tabela).not.toContain("whitelist");
      expect(r.json().error ?? "", tabela).not.toContain("modelo");
    }
    await app.close();
  });
});
