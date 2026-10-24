/**
 * Filtros salvos — licitações e concursos (planos prometem "filtros salvos").
 * Storage: UserFilter (Postgres) / memória nos testes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { JwtService } from "./security/jwt.js";

export interface FiltroDto {
  id: string;
  userId: string;
  product: "licitacao" | "concurso";
  name: string;
  filter: Record<string, unknown>;
  createdAt: string;
}

export interface FiltroStore {
  save(f: FiltroDto): Promise<FiltroDto>;
  list(userId: string, product: string): Promise<FiltroDto[]>;
  remove(id: string, userId: string): Promise<boolean>;
}

export class InMemoryFiltroStore implements FiltroStore {
  private rows = new Map<string, FiltroDto>();
  private seq = 0;

  async save(f: FiltroDto) {
    for (const [id, r] of this.rows) {
      if (r.userId === f.userId && r.product === f.product && r.name === f.name) {
        const next = { ...r, filter: f.filter };
        this.rows.set(id, next);
        return next;
      }
    }
    const id = f.id || `f_${++this.seq}`;
    const next = { ...f, id };
    this.rows.set(id, next);
    return next;
  }

  async remove(idOrName: string, userId: string) {
    // 24/10: o app exclui pelo NOME (DELETE /filtros/:name); o id interno não viaja.
    const direto = this.rows.get(idOrName);
    if (direto && direto.userId === userId) {
      this.rows.delete(idOrName);
      return true;
    }
    for (const [id, r] of this.rows) {
      if (r.userId === userId && r.name === idOrName) {
        this.rows.delete(id);
        return true;
      }
    }
    return false;
  }

  async list(userId: string, product: string) {
    return [...this.rows.values()].filter((r) => r.userId === userId && r.product === product);
  }
}

/** Persistência real (UserFilter/Postgres) — o radar não pode sumir no restart. */
export class PrismaFiltroStore implements FiltroStore {
  constructor(private db: {
    userFilter: {
      upsert: (a: unknown) => Promise<{ id: string }>;
      findMany: (a: unknown) => Promise<Array<{ id: string; userId: string; product: string; name: string; query: unknown; createdAt: Date }>>;
      deleteMany: (a: unknown) => Promise<{ count: number }>;
    };
  }) {}

  async save(f: FiltroDto): Promise<FiltroDto> {
    const row = await this.db.userFilter.upsert({
      where: { userId_product_name: { userId: f.userId, product: f.product, name: f.name } },
      create: { userId: f.userId, product: f.product, name: f.name, query: f.filter as object },
      update: { query: f.filter as object },
    });
    return { ...f, id: row.id };
  }

  async list(userId: string, product: string): Promise<FiltroDto[]> {
    const rows = await this.db.userFilter.findMany({ where: { userId, product }, orderBy: { createdAt: "desc" } });
    return rows.map((r) => ({ id: r.id, userId: r.userId, product: r.product as FiltroDto["product"], name: r.name, filter: r.query as Record<string, unknown>, createdAt: r.createdAt.toISOString() }));
  }

  async remove(idOrName: string, userId: string): Promise<boolean> {
    const r = await this.db.userFilter.deleteMany({
      where: { userId, OR: [{ id: idOrName }, { name: idOrName }] },
    });
    return r.count > 0;
  }
}

const filtroSchema = z.object({
  name: z.string().min(1).max(80),
  filter: z.record(z.unknown()),
});

export function filtrosRoutes(product: "licitacao" | "concurso", deps: { jwt: JwtService; store: FiltroStore }): (app: FastifyInstance) => Promise<void> {
  async function subject(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "não autenticado" });
      return null;
    }
    try {
      return (await deps.jwt.verify(h.slice(7)))?.sub ?? null;
    } catch {
      reply.code(401).send({ error: "sessão inválida" });
      return null;
    }
  }

  return async (app) => {
    app.get(`/api/${product === "licitacao" ? "licitacoes" : "concursos"}/filtros`, async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const lista = await deps.store.list(userId, product);
      return reply.send({ filtros: lista, filters: lista });
    });

    app.post(`/api/${product === "licitacao" ? "licitacoes" : "concursos"}/filtros`, async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = filtroSchema.parse(req.body);
      const filtro = await deps.store.save({
        id: "",
        userId,
        product,
        name: body.name,
        filter: body.filter,
        createdAt: new Date().toISOString(),
      });
      return reply.code(201).send({ filtro });
    });

    app.delete(`/api/${product === "licitacao" ? "licitacoes" : "concursos"}/filtros/:id`, async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const ok = await deps.store.remove((req.params as { id: string }).id, userId);
      return ok ? reply.send({ ok: true }) : reply.code(404).send({ error: "filtro não encontrado" });
    });
  };
}
