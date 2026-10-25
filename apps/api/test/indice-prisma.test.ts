/**
 * Contrato do store PRISMA do índice (Postgres real, DB `acompanhe_test`).
 * Prova que o índice funciona de verdade — não só em memória: upsert
 * transacional, busca por nome/documento/número e facetas.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { createDb } from "@acompanhe/db";

import { PrismaIndiceStore } from "../src/juridico/indice-prisma.js";
import { chaveDocumento, processoDoDatajud } from "../src/juridico/indice.js";
import { ingerirDaBuscaEsaj } from "../src/juridico/ingestao.js";
import { parseResultadosEsaj } from "../src/juridico/esaj.js";
import type { DatajudDoc } from "../src/juridico/types.js";

const TEST_URL =
  process.env.DATABASE_URL_TEST ?? "postgresql://postgres:postgres@127.0.0.1:5432/acompanhe_test";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const REAL = (JSON.parse(readFileSync(join(dir, "datajud-capture.json"), "utf8")) as { hit: DatajudDoc }).hit;
const tjal = parseResultadosEsaj(readFileSync(join(dir, "esaj", "tjal-nmparte-positivo.html"), "utf8"), "al", 1);

const db = createDb(TEST_URL);
const store = new PrismaIndiceStore(db);
const agora = new Date("2026-10-25T00:00:00Z");

beforeAll(async () => {
  await db.parteIndice.deleteMany({ where: { numeroCnj: { startsWith: "TESTE" } } });
  await db.processoIndice.deleteMany({ where: { numeroCnj: { contains: "" } } });
});

afterAll(async () => {
  await db.processoIndice.deleteMany({ where: { numeroCnj: { contains: "" } } });
  await db.$disconnect();
});

describe("PrismaIndiceStore (Postgres real)", () => {
  it("grava processo do DataJud (sem partes) e acha por número", async () => {
    const p = processoDoDatajud(REAL, "tjmt", agora);
    expect(await store.upsertMuitos([p])).toBe(1);
    const achados = await store.buscar({ numero: p.numeroCnj });
    expect(achados.length).toBe(1);
    expect(achados[0]!.tribunal).toBe("tjmt");
    expect(achados[0]!.partes).toEqual([]);
    expect(achados[0]!.movimentos.length).toBeGreaterThan(0);
  });

  it("grava busca e-SAJ com partes, acha por nome normalizado e por hash de documento", async () => {
    const itens = ingerirDaBuscaEsaj(tjal.itens.slice(0, 3), "documento", agora, "529.982.247-25");
    expect(await store.upsertMuitos(itens)).toBe(3);
    const nome = itens[0]!.partes[0]!.nome;
    const porNome = await store.buscar({ nome });
    expect(porNome.length).toBeGreaterThan(0);
    expect(porNome[0]!.partes.length).toBeGreaterThan(0);
    const porDoc = await store.buscar({ documento: "52998224725" });
    expect(porDoc.length).toBe(3);
    expect(porDoc[0]!.partes[0]!.documentoHash).toBe(chaveDocumento("52998224725"));
    // documento que não está no índice → vazio honesto
    expect((await store.buscar({ documento: "111.444.777-35" })).length).toBe(0);
  });

  it("upsert é idempotente (2ª gravação não duplica) e facetas agregam", async () => {
    const itens = ingerirDaBuscaEsaj(tjal.itens.slice(0, 3), "documento", agora, "529.982.247-25");
    await store.upsertMuitos(itens);
    const total = await store.total();
    await store.upsertMuitos(itens);
    expect(await store.total()).toBe(total);
    const f = await store.facetas({ nome: itens[0]!.partes[0]!.nome });
    expect(f.tribunais[0]!.valor).toBe("esaj-al");
    expect(f.ufs.length).toBeGreaterThan(0);
  });
});
