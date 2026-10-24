/**
 * smoke-concursos.ts — prova viva do módulo Concursos (plano.md §3).
 * Busca EXATA no DOU real (contrato verificado em 23/10/2026) → classificador
 * → concursos com link oficial do DOU. Rodar: npx tsx scripts/smoke-concursos.ts
 */
import { makeConcursosService, InMemoryContestStore } from "../src/concursos/service.js";

const q = process.env.DOU_QUERY ?? '"concurso público"';
const publishFrom = process.env.DOU_FROM ?? "15/10/2026";
const publishTo = process.env.DOU_TO ?? "22/10/2026";

const store = new InMemoryContestStore();
const svc = makeConcursosService({ store });

console.log(`SMOKE-CONCURSOS: DOU busca "${q}" (${publishFrom}..${publishTo})`);
const r = await svc.ingestBusca({ q, publishFrom, publishTo, s: "do3" });
console.log(`  itens do DOU: ${r.lidos} · concursos detectados: ${r.concursos} · versões: ${r.versoes}`);

if (r.lidos === 0) throw new Error("DOU não retornou itens (mudou o contrato?)");
if (r.concursos === 0) throw new Error("0 concursos — classificador não achou nada na busca exata");

const lista = await svc.list({});
const c = lista[0];
console.log(`  exemplo: "${c!.title.slice(0, 70)}"`);
console.log(`    status=${c!.status} banca=${c!.banca ?? "(não detectada — correto)"} fonte=${c!.sourceUrl.slice(0, 80)}`);
console.log(`    fieldStatus=${c!.fieldStatus} (RD3: texto livre = pendente)`);
if (!c!.sourceUrl.startsWith("https://www.in.gov.br/")) throw new Error("link não é do DOU oficial");
if (c!.fieldStatus !== "pendente") throw new Error("RD3 violado: texto livre validou dado sozinho");

console.log("SMOKE-CONCURSOS OK");
