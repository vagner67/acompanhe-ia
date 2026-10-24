/**
 * smoke-juridico.ts — prova viva da Assessoria jurídica (plano.md §4).
 * Consulta REAL no DataJud/CNJ (contrato verificado 23/10/2026) com o número
 * da fixture. Rodar: npx tsx scripts/smoke-juridico.ts
 */
import { fetchProcessos } from "../src/juridico/datajud.js";
import { isValidCnj, formatCnj, parseCnj, cnjDv } from "../src/juridico/cnj.js";
import { mapDoc, InMemoryLegalStore, makeJuridicoService } from "../src/juridico/service.js";

const NUM = "0006903-69.2014.8.11.0037";

console.log(`SMOKE-JURIDICO: DataJud/CNJ — processo ${NUM}`);
if (!isValidCnj(NUM)) throw new Error("DV CNJ falhou");
console.log(`  DV Res. 65/2008: OK (dv=${cnjDv(parseCnj(NUM)!)})`);

const docs = await fetchProcessos("tjmt", { numeroProcesso: NUM.replace(/\D/g, "") }, { attempts: 2 });
if (docs.length === 0) throw new Error("DataJud não achou o processo (mudou o contrato?)");
const doc = docs[0]!;
const c = mapDoc(doc, "tjmt");
console.log(`  classe=${c.classe} | órgão=${c.orgaoJulgador}`);
console.log(`  ajuizamento=${c.dataAjuizamento} | movimentos=${c.movimentosCount} | status=${c.status}`);
if (c.movimentosCount === 0) throw new Error("sem movimentos no doc real");
if (c.nivelSigilo === 0 && c.classe === "processo sigiloso — dados limitados") throw new Error("RB3 falso-positivo");

const store = new InMemoryLegalStore();
const svc = makeJuridicoService({ store });
await svc.acompanhar("smoke-user", NUM, "ativo", "tjmt");
const r = await svc.sincronizar("smoke-user", NUM, "tjmt", doc);
console.log(`  RB5: ${doc.movimentos?.length ?? 0} movimentos → ${r.novos} eventos únicos`);
const dup = await svc.sincronizar("smoke-user", NUM, "tjmt", doc);
if (dup.novos !== 0) throw new Error("RB5 falhou — movimento repetido virou evento");
console.log("SMOKE-JURIDICO OK");
