/**
 * smoke-pncp.ts — smoke VIVO do módulo Licitação (plano.md §2): busca real no
 * PNCP (/api/search) com sync + radar + link oficial. Falha se a fonte real
 * não responder com dado verdadeiro (nada de 200 vazio).
 */
import { ADMIN_TOKEN, call, login } from "./smoke-lib.js";

async function main(): Promise<void> {
  const auth = await login(777101, "Pncp", "smoke_pncp");
  if (auth.status !== 200 || !auth.token) throw new Error(`login: ${auth.status}`);
  const H = { authorization: `Bearer ${auth.token}` };

  // 1) radar salvo (RF-C03)
  const filtro = await call(
    "POST",
    "/api/licitacoes/filtros",
    { name: "escola MG", filter: { uf: "MG", palavra: "impressos" } },
    H,
  );
  if (filtro.status !== 201) throw new Error(`filtro: ${filtro.status} ${JSON.stringify(filtro.json)}`);
  console.log("1) filtro salvo: 201");

  // 2) busca full-text REAL (RF-C02) — fonte PNCP /api/search
  const busca = await call(
    "POST",
    "/api/licitacoes/busca",
    { q: "material escolar", tiposDocumento: "edital", tamanhoPagina: 10 },
    H,
  );
  if (busca.status !== 200) throw new Error(`busca: ${busca.status} ${JSON.stringify(busca.json).slice(0, 200)}`);
  const tenders = (busca.json.tenders as Array<Record<string, unknown>>) ?? [];
  if (tenders.length < 1) throw new Error("busca real voltou vazia — sem dado verdadeiro");
  const t0 = tenders[0];
  if (!String(t0.sourceUrl ?? "").startsWith("https://pncp.gov.br") && t0.sourceUrl !== null) {
    throw new Error(`RC4: link suspeito ${String(t0.sourceUrl)}`);
  }
  console.log(`2) busca real: ${tenders.length} de ${busca.json.total} | primeiro: ${String(t0.title).slice(0, 60)}`);
  console.log(`   pncpId: ${t0.pncpId} | uf: ${t0.uf} | link: ${t0.sourceUrl}`);

  // 3) sync real de 1 página (RF-C01) — janela de HOJE, pregão eletrônico (6)
  const hoje = new Date();
  const d = (n: number) => {
    const x = new Date(hoje.getTime() - n * 86_400_000);
    return `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, "0")}${String(x.getUTCDate()).padStart(2, "0")}`;
  };
  const sync = await call(
    "POST",
    "/v1/admin/licitacoes/sync",
    { kind: "publicacao", dataInicial: d(3), dataFinal: d(1), codigoModalidadeContratacao: 6, tamanhoPagina: 10 },
    { ...H, "x-admin-token": ADMIN_TOKEN },
  );
  if (sync.status !== 200) throw new Error(`sync: ${sync.status} ${JSON.stringify(sync.json).slice(0, 200)}`);
  console.log(`3) sync real: ${sync.json.upserted} contratações em ${sync.json.pages} página(s)`);

  // 4) acervo consultável (RF-C02 regionalização)
  const lista = await call("GET", "/api/licitacoes?uf=MG", undefined, H);
  if (lista.status !== 200) throw new Error(`lista: ${lista.status}`);
  console.log(`4) acervo: ${lista.json.total} tender(s) em MG`);

  console.log("SMOKE-PNCP OK");
}

main().catch((e) => {
  console.error("SMOKE-PNCP FALHOU:", e instanceof Error ? e.message : e);
  process.exit(1);
});
