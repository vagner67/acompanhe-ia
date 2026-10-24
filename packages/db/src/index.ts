/**
 * @acompanhe/db — client Prisma gerado a partir de `prisma/schema.prisma`
 * (DDL doc 09 + models Osint alinhados ao contrato congelado doc 13 §4).
 * Porta de fábrica: `createDb(url)` permite apontar para `acompanhe_test`
 * nos testes sem tocar no código de domínio.
 */
import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

export function createDb(url?: string): PrismaClient {
  return url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
}
