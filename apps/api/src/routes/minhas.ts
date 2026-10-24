/**
 * Minhas — AnotA (notas/gastos/resumo/CSV) + empréstimos do usuário +
 * verificação V1 + perfil/região (plano §1.1/§1.6).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { JwtService } from "../security/jwt.js";
import type { LoanStore } from "../emprestimos/service.js";
import type { VerificacaoStore as VerStore } from "../emprestimos/verificacao.js";
import type { MinhasStore, OcrProvider } from "../minhas/service.js";
import { exportCsv, manualOcr, resumoMensal, type GastoDto, type NotaDto } from "../minhas/service.js";

const notaSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10000).default(""),
  tags: z.array(z.string().min(1).max(24)).max(8).default([]),
  pinned: z.boolean().default(false),
});

const gastoSchema = z.object({
  amountCents: z.number().int().positive(),
  category: z.string().min(1).max(40),
  description: z.string().min(1).max(300),
  spentAt: z.string().min(4).max(40),
  photoBase64: z.string().max(400_000).optional(),
  ocrText: z.string().max(4000).optional(),
});

const verificacaoSchema = z.object({
  docTipo: z.enum(["cnh", "rg", "cpf", "passaporte"]),
  selfieAt: z.string().min(4).max(40).optional(),
});

const perfilSchema = z.object({ uf: z.string().length(2), cityIbge: z.number().int().positive() });

export function minhasRoutes(deps: {
  jwt: JwtService;
  store: MinhasStore;
  loans: LoanStore;
  verificacao: VerStore;
  ocr?: OcrProvider;
  upsertUser?: (userId: string, p: { uf: string; cityIbge: number }) => Promise<void>;
}): (app: FastifyInstance) => Promise<void> {
  const ocr = deps.ocr ?? manualOcr;

  async function subject(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "não autenticado" });
      return null;
    }
    try {
      const claims = await deps.jwt.verify(h.slice(7));
      return claims?.sub ?? null;
    } catch {
      reply.code(401).send({ error: "sessão inválida" });
      return null;
    }
  }

  return async (app) => {
    // ————— Notas (AnotA) —————
    app.get("/api/minhas/notas", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      return reply.send({ notas: await deps.store.listNotas(userId) });
    });

    app.post("/api/minhas/notas", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = notaSchema.parse(req.body);
      const ts = new Date().toISOString();
      const nota = await deps.store.createNota({ id: randomUUID(), userId, ...body, createdAt: ts, updatedAt: ts });
      return reply.code(201).send({ nota });
    });

    app.put("/api/minhas/notas/:id", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = notaSchema.partial().parse(req.body);
      const patch: Partial<Pick<NotaDto, "title" | "body" | "tags" | "pinned">> = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.body !== undefined) patch.body = body.body;
      if (body.tags !== undefined) patch.tags = body.tags;
      if (body.pinned !== undefined) patch.pinned = body.pinned;
      const nota = await deps.store.updateNota((req.params as { id: string }).id, userId, patch);
      if (!nota) return reply.code(404).send({ error: "nota não encontrada" });
      return reply.send({ nota });
    });

    app.delete("/api/minhas/notas/:id", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const ok = await deps.store.deleteNota((req.params as { id: string }).id, userId);
      return ok ? reply.send({ ok: true }) : reply.code(404).send({ error: "nota não encontrada" });
    });

    // ————— Gastos (AnotA; OCR via provider — nunca inventa texto) —————
    app.get("/api/minhas/gastos", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      return reply.send({ gastos: await deps.store.listGastos(userId), ocrEngine: ocr.engine });
    });

    app.post("/api/minhas/gastos", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = gastoSchema.parse(req.body);
      let ocrText: string | null = body.ocrText ?? null;
      let ocrEngine: string | null = body.ocrText ? "manual" : null;
      if (!ocrText && body.photoBase64) {
        const r = await ocr.extract(body.photoBase64);
        ocrText = r.text;
        ocrEngine = r.engine;
      }
      const gasto: GastoDto = await deps.store.createGasto({
        id: randomUUID(),
        userId,
        amountCents: body.amountCents,
        category: body.category,
        description: body.description,
        spentAt: body.spentAt,
        photoRef: body.photoBase64 ? `inline:${Date.now()}` : null,
        ocrText,
        ocrEngine,
        createdAt: new Date().toISOString(),
      });
      return reply.code(201).send({ gasto, ocr: { engine: ocrEngine, textoExtraido: ocrText !== null } });
    });

    app.put("/api/minhas/gastos/:id", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = gastoSchema.partial().parse(req.body);
      const gasto = await deps.store.updateGasto((req.params as { id: string }).id, userId, {
        ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.spentAt !== undefined ? { spentAt: body.spentAt } : {}),
        ...(body.ocrText !== undefined ? { ocrText: body.ocrText, ocrEngine: "manual" } : {}),
      });
      if (!gasto) return reply.code(404).send({ error: "gasto não encontrado" });
      return reply.send({ gasto });
    });

    app.delete("/api/minhas/gastos/:id", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const ok = await deps.store.deleteGasto((req.params as { id: string }).id, userId);
      return ok ? reply.send({ ok: true }) : reply.code(404).send({ error: "gasto não encontrado" });
    });

    // ————— Resumo mensal + export CSV —————
    app.post("/api/minhas/gastos/ocr", async (req: FastifyRequest, reply: FastifyReply) => {
      const body = z.object({ imageBase64: z.string().min(10).max(3_500_000) }).safeParse(req.body);
      if (!body.success) return reply.code(422).send({ error: "imageBase64 obrigatório (base64 da foto)" });
      const b64 = body.data.imageBase64.replace(/^data:[^,]+,/, "");
      // 24/10 (deep): lixo não vira "OCR falhou" 200 — imagem inválida é 400.
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
      if (!isPng && !isJpeg && !isWebp) {
        return reply.code(400).send({ error: "conteúdo não é imagem PNG/JPEG/WEBP" });
      }
      const r = await ocr.extract(b64);
      const texto = r.text ?? "";
      return { texto, chars: texto.length, engine: r.engine };
    });

    app.get("/api/minhas/resumo", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const ym = (req.query as { ym?: string }).ym ?? new Date().toISOString().slice(0, 7);
      return reply.send({ resumo: resumoMensal(await deps.store.listGastos(userId), ym) });
    });

    app.get("/api/minhas/export.csv", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const csv = exportCsv(await deps.store.listNotas(userId), await deps.store.listGastos(userId));
      return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="acompanhe-anota.csv"').send(csv);
    });

    // ————— Empréstimos do usuário + Caderno de Dívidas —————
    app.get("/api/minhas/emprestimos", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const matches = await deps.loans.listMatches(userId);
      const detalhes = [];
      for (const m of matches) {
        detalhes.push({ match: m, rodadas: await deps.loans.listRodadas(m.id), pagamentos: await deps.loans.listPayments(m.id) });
      }
      return reply.send({ matches: detalhes, rule: "RF-E05 · agenda dos dois lados" });
    });

    app.get("/api/minhas/dividas", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const matches = await deps.loans.listMatches(userId);
      const ativos = [];
      for (const m of matches.filter((x) => x.status === "aceito")) {
        ativos.push({ matchId: m.id, requestId: m.requestId, expiraEm: m.expiraEm, pagamentos: await deps.loans.listPayments(m.id) });
      }
      return reply.send({ dividas: ativos, limiteAtivos: 3, rule: "Caderno de Dívidas (plano anota)" });
    });

    // ————— Verificação V1 (A3: obrigatória para empréstimo) —————
    app.get("/api/minhas/verificacao", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const v = await deps.verificacao.getVerification(userId);
      return reply.send({ verificacao: v ?? { userId, v1Status: "none" }, sinais: await deps.verificacao.listSignals(userId) });
    });

    app.post("/api/minhas/verificacao", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = verificacaoSchema.parse(req.body);
      const atual = await deps.verificacao.getVerification(userId);
      if (atual?.v1Status === "approved") return reply.send({ ok: true, v1Status: "approved" });
      await deps.verificacao.setVerification({
        userId,
        v1Status: "pending",
        docTipo: body.docTipo,
        selfieAt: body.selfieAt ?? new Date().toISOString(),
        approvedAt: null,
      });
      return reply.code(201).send({ ok: true, v1Status: "pending", rule: "aprovação humana no painel (A3)" });
    });

    // ————— Perfil/região (onboarding) —————
    app.post("/api/minhas/perfil", async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = await subject(req, reply);
      if (!userId) return;
      const body = perfilSchema.parse(req.body);
      await deps.upsertUser?.(userId, body);
      return reply.send({ ok: true, ...body });
    });
  };
}
