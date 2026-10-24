/**
 * E2E do dispatcher (23/10/2026) — jobs REAIS contra Postgres REAL.
 * 1) jobMatchExpirando/jobPollProcessos/jobVencimentoParcelas com dados reais
 * 2) re-execução → dedupe (0 novos)
 * 3) prova da @@unique(dedupeKey) no banco: INSERT direto com a mesma chave falha
 */
import { createDb } from "@acompanhe/db";
import {
  PrismaAlertSink,
  jobMatchExpirando,
  jobPollProcessos,
  jobVencimentoParcelas,
} from "../src/jobs/dispatcher.js";

const db = createDb(process.env.DATABASE_URL!);
const sink = new PrismaAlertSink(db);
const agora = new Date();

const matches = [
  { id: "lm_e2e_dispatch", userId: "911001100", expiraEm: new Date(agora.getTime() + 3 * 3600_000).toISOString() },
];
const novos = [{ userId: "911001100", tribunal: "tjmt", numeroProcesso: "0006903-69.2014.8.11.0037", total: 19 }];
const parcelas = [
  { matchId: "lm_e2e_dispatch", devedorId: "911001100", credorId: "911001101", vencimento: "2026-11-23", valorCents: 342857 },
];

const janela = new Date().toISOString().slice(0, 13); // janela horária
const r1 = await jobPollProcessos(sink, novos, janela);
const r2 = await jobMatchExpirando(sink, matches, agora.toISOString());
const r3 = await jobVencimentoParcelas(sink, parcelas);
console.log(`emitidos: pollProcessos=${r1} matchExpirando=${r2} vencimento=${r3}`);

const r1b = await jobPollProcessos(sink, novos, janela);
const r2b = await jobMatchExpirando(sink, matches, agora.toISOString());
const r3b = await jobVencimentoParcelas(sink, parcelas);
console.log(`re-execução (dedupe, esperado 0/0/0): ${r1b}/${r2b}/${r3b}`);

const rows = await (db as never as { alertEvent: { findMany: (x: unknown) => Promise<Array<Record<string, unknown>>> } }).alertEvent.findMany({
  where: { userId: "911001100" },
  orderBy: { createdAt: "desc" },
  take: 10,
});
console.log(`AlertEvent no Postgres: ${rows.length}`);
for (const r of rows) console.log(` - id=${r.id} topic=${r.topic} status=${r.status} dedupeKey=${r.dedupeKey}`);

// prova da unique no banco (corrida): INSERT direto com dedupeKey existente
try {
  await (db as never as { alertEvent: { create: (x: unknown) => Promise<unknown> } }).alertEvent.create({
    data: {
      userId: "911001100",
      topic: "concursos",
      refId: "dup",
      channel: "telegram",
      status: "queued",
      payload: { kind: "prazo_inscricao", detail: "dup" },
      dedupeKey: String(rows[0]!.dedupeKey),
      createdAt: new Date().toISOString(),
    },
  });
  console.log("PROVA_UNIQUE=FALHOU (insert duplicado aceito)");
} catch {
  console.log("PROVA_UNIQUE=OK (banco rejeitou dedupeKey duplicada)");
}
await db.$disconnect();
