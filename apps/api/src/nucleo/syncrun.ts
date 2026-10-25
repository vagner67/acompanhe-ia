/**
 * Escritor do `SyncRun` (lacuna G5 do plano.md).
 *
 * A tabela existia no schema desde o começo e nunca recebeu uma linha — a rota
 * de ops chegou a documentar "SyncRun sem escritor". Agora cada coletor medido
 * pelo núcleo deixa seu registro de sincronização: quando começou, quando
 * terminou, quantos itens e se falhou.
 */
import type { PrismaClient } from "@acompanhe/db";

import type { SyncRunRegistro } from "../jobs/coleta.js";

export function gravarSyncRunPrisma(db: PrismaClient): (r: SyncRunRegistro) => Promise<void> {
  return async (r) => {
    await db.syncRun.create({
      data: {
        source: r.source,
        region: r.region,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        status: r.status,
        error: r.error,
        items: r.items,
      },
    });
  };
}
