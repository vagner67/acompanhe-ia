/**
 * Rotas do Núcleo de Coletores Auto-Aperfeiçoável (plano.md §4).
 *
 * Leitura em `/v1/admin/nucleo/*` (RBAC recurso "ops"), igual ao painel de
 * operações. Ação (rodar ciclo) também é admin: nada aqui aceita anônimo.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AdminJwt } from "./admin.js";
import { auditHash, can, type AdminStore } from "../admin/service.js";
import { rodarCicloNucleo } from "../jobs/coleta.js";
import { catalogo, coletorPorId } from "../nucleo/registro.js";
import type { StoreNucleo } from "../nucleo/store.js";
import type { Modulo, Params } from "../nucleo/tipos.js";
import { validarAjustes } from "../nucleo/ia-diagnostico.js";

type AdminClaims = { sub: string; role: string; kind: string };

const MODULOS: Modulo[] = ["juridico", "licitacoes", "concursos", "investiga", "anota", "pagamentos", "operacao"];

export function nucleoRoutes(deps: {
  config: { JWT_SECRET: string };
  store: AdminStore;
  nucleo: StoreNucleo;
  /** injetável nos testes: evita rede real */
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}): (app: FastifyInstance) => Promise<void> {
  const jwt = new AdminJwt(new TextEncoder().encode(`${deps.config.JWT_SECRET}:admin`));

  async function actor(req: FastifyRequest, reply: FastifyReply): Promise<AdminClaims | null> {
    const h = req.headers.authorization;
    const claims = h?.startsWith("Bearer ") ? await jwt.verify(h.slice(7)) : null;
    if (!claims) {
      reply.code(401).send({ error: "admin não autenticado" });
      return null;
    }
    const admin = await deps.store.findAdminById(claims.sub);
    if (!admin || !admin.active) {
      reply.code(401).send({ error: "operador inativo" });
      return null;
    }
    if (!can(claims.role, "ops")) {
      reply.code(403).send({ error: `papel '${claims.role}' sem permissão em 'ops'`, rule: "RBAC" });
      return null;
    }
    return claims as AdminClaims;
  }

  async function audit(claims: AdminClaims | null, action: string, target: string | null, after: unknown, ip: string | null) {
    const prevHash = await deps.store.auditLastHash();
    const base = { actorId: claims?.sub ?? null, actorRole: claims?.role ?? null, action, target, before: null, after, ip, ts: new Date().toISOString() };
    await deps.store.auditAppend({ ...base, prevHash, hash: auditHash(prevHash, base) });
  }

  return async (app) => {
    /** Catálogo: quais coletores existem, em que módulo, com que orçamento. */
    app.get("/v1/admin/nucleo/catalogo", async (req, reply) => {
      const claims = await actor(req, reply);
      if (!claims) return;
      const cat = catalogo();
      return reply.send({
        ok: true,
        total: cat.length,
        porModulo: MODULOS.map((m) => ({ modulo: m, coletores: cat.filter((c) => c.modulo === m).length })).filter((x) => x.coletores > 0),
        coletores: cat,
      });
    });

    /** Estado vigente + score de cada coletor (o que o painel "Fontes" mostra). */
    app.get("/v1/admin/nucleo/estado", async (req, reply) => {
      const claims = await actor(req, reply);
      if (!claims) return;
      const estados = await deps.nucleo.estados();
      const cat = new Map(catalogo().map((c) => [c.id, c]));
      const linhas = estados.map((e) => {
        const c = cat.get(e.coletorId);
        return {
          coletorId: e.coletorId,
          modulo: c?.modulo ?? "?",
          host: c?.host ?? "?",
          versao: e.versao,
          ativo: e.ativo,
          score: e.scoreAtual,
          itens: e.itensUltimaColeta,
          ultimoOkEm: e.ultimoOkEm,
          ultimoErro: e.ultimoErro,
          proximaExecucaoEm: e.proximaExecucaoEm,
          params: e.params,
          atualizadoEm: e.atualizadoEm,
        };
      });
      return reply.send({
        ok: true,
        total: linhas.length,
        saudaveis: linhas.filter((l) => l.ativo && (l.score ?? 0) >= 40).length,
        desativados: linhas.filter((l) => !l.ativo).length,
        semMedicao: catalogo().length - linhas.length,
        coletores: linhas,
      });
    });

    /** Detalhe: métricas, ações (com origem IA/regras) e evidências. */
    app.get<{ Params: { id: string } }>("/v1/admin/nucleo/coletor/:id", async (req, reply) => {
      const claims = await actor(req, reply);
      if (!claims) return;
      const coletor = coletorPorId(req.params.id);
      if (!coletor) return reply.code(404).send({ error: `coletor '${req.params.id}' não existe`, disponiveis: catalogo().map((c) => c.id) });
      const [estado, metricas, acoes] = await Promise.all([
        deps.nucleo.obter(coletor.id),
        deps.nucleo.metricas(coletor.id, 50),
        deps.nucleo.acoes(coletor.id, 30),
      ]);
      return reply.send({
        ok: true,
        coletor: {
          id: coletor.id,
          modulo: coletor.modulo,
          host: coletor.host,
          familia: coletor.familia,
          descricao: coletor.descricao,
          padrao: coletor.padrao,
          espaco: coletor.espaco,
          canarios: coletor.canarios,
          orcamento: coletor.orcamento,
          credencial: coletor.exigirCredencial ?? null,
        },
        estado,
        metricas,
        acoes,
      });
    });

    /** Roda um ciclo agora (mede, diagnostica, aplica o que passar no canário). */
    app.post<{ Body: { coletores?: string[]; modulos?: Modulo[]; maxVizinhos?: number; usarIA?: boolean } }>(
      "/v1/admin/nucleo/ciclo",
      async (req, reply) => {
        const claims = await actor(req, reply);
        if (!claims) return;
        const body = req.body ?? {};
        const ids = Array.isArray(body.coletores) && body.coletores.length > 0 ? body.coletores : null;
        const lista = ids ? ids.map((id) => coletorPorId(id)).filter((c): c is NonNullable<typeof c> => Boolean(c)) : undefined;
        if (ids && lista && lista.length !== ids.length) {
          return reply.code(400).send({ error: "coletor inexistente no pedido", pedidos: ids, existentes: catalogo().map((c) => c.id) });
        }
        const modulos = (body.modulos ?? []).filter((m) => MODULOS.includes(m));
        const r = await rodarCicloNucleo({
          store: deps.nucleo,
          ...(lista ? { coletores: lista } : {}),
          ...(modulos.length > 0 ? { modulos } : {}),
          maxVizinhos: Math.max(0, Math.min(Number(body.maxVizinhos ?? 1), 4)),
          ...(body.usarIA === false ? { usarIA: false } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.env ? { env: deps.env } : {}),
          prazoMs: 120_000,
          registrarEvento: (e) => app.log.info(e, "nucleo"),
        });
        await audit(claims, "nucleo.ciclo", null, { promovidos: r.promovidos, revertidos: r.revertidos }, req.ip);
        return reply.send(r);
      },
    );

    /** Reativa um coletor desligado pelo disjuntor (decisão humana explícita). */
    app.post<{ Params: { id: string } }>("/v1/admin/nucleo/coletor/:id/reativar", async (req, reply) => {
      const claims = await actor(req, reply);
      if (!claims) return;
      const coletor = coletorPorId(req.params.id);
      if (!coletor) return reply.code(404).send({ error: `coletor '${req.params.id}' não existe` });
      const atual = await deps.nucleo.obter(coletor.id);
      const novo = {
        ...(atual ?? {
          coletorId: coletor.id,
          params: { ...coletor.padrao },
          versao: 1,
          scoreAtual: null,
          itensUltimaColeta: 0,
          ultimoOkEm: null,
          ultimoErro: null,
          atualizadoEm: new Date().toISOString(),
        }),
        ativo: true,
        ciclosZerados: 0,
        proximaExecucaoEm: null,
        atualizadoEm: new Date().toISOString(),
      };
      await deps.nucleo.salvar(novo);
      await deps.nucleo.registrarAcao({
        coletorId: coletor.id,
        ts: new Date().toISOString(),
        origem: "regras",
        tipo: "reativar",
        acao: "coletor reativado por operador",
        evidencia: JSON.stringify({ por: claims.sub }),
        resultado: "aplicada",
        motivo: "reativação manual",
        versaoAntes: atual?.versao ?? 1,
        versaoDepois: novo.versao,
        paramsAntes: atual?.params ?? coletor.padrao,
        paramsDepois: novo.params,
      });
      await audit(claims, "nucleo.reativar", coletor.id, { ativo: true }, req.ip);
      return reply.send({ ok: true, coletorId: coletor.id, estado: novo });
    });

    /** Ajuste manual de parâmetro — passa pela mesma validação do espaço de busca. */
    app.put<{ Params: { id: string }; Body: { params?: Params } }>(
      "/v1/admin/nucleo/coletor/:id/params",
      async (req, reply) => {
        const claims = await actor(req, reply);
        if (!claims) return;
        const coletor = coletorPorId(req.params.id);
        if (!coletor) return reply.code(404).send({ error: `coletor '${req.params.id}' não existe` });
        const pedidos = req.body?.params ?? {};
        const atual = (await deps.nucleo.obter(coletor.id)) ?? null;
        const vigentes = atual?.params ?? { ...coletor.padrao };
        const comoAjustes = Object.entries(pedidos).map(([chave, para]) => ({ chave, para, porque: "ajuste manual do operador" }));
        const { aceitos, descartados } = validarAjustes(comoAjustes, coletor.espaco, vigentes);
        if (aceitos.length === 0) {
          return reply.code(400).send({ error: "nenhum parâmetro válido no pedido", descartados, espaco: coletor.espaco });
        }
        const novos: Params = { ...vigentes };
        for (const a of aceitos) novos[a.chave] = a.para;
        const estado = {
          ...(atual ?? {
            coletorId: coletor.id,
            versao: 1,
            ativo: true,
            scoreAtual: null,
            itensUltimaColeta: 0,
            ultimoOkEm: null,
            ultimoErro: null,
            ciclosZerados: 0,
            proximaExecucaoEm: null,
          }),
          params: novos,
          versao: (atual?.versao ?? 1) + 1,
          atualizadoEm: new Date().toISOString(),
        };
        await deps.nucleo.salvar(estado);
        await deps.nucleo.registrarAcao({
          coletorId: coletor.id,
          ts: new Date().toISOString(),
          origem: "regras",
          tipo: "ajuste-manual",
          acao: `operador ${claims.sub}: ${JSON.stringify(vigentes)} → ${JSON.stringify(novos)}`,
          evidencia: JSON.stringify({ aceitos, descartados }),
          resultado: "aplicada",
          motivo: "ajuste manual validado pelo espaço de busca",
          versaoAntes: atual?.versao ?? 1,
          versaoDepois: estado.versao,
          paramsAntes: vigentes,
          paramsDepois: novos,
        });
        await audit(claims, "nucleo.params", coletor.id, { params: novos }, req.ip);
        return reply.send({ ok: true, coletorId: coletor.id, params: novos, versao: estado.versao, descartados });
      },
    );
  };
}
