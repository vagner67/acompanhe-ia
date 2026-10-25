/**
 * Medição real das fontes (canários) — alimenta o auto-aperfeiçoamento.
 * Cada medição é uma consulta HTTP de verdade; o resultado vira `Metrica`.
 * Nada é simulado: se a fonte bloquear, isso aparece como erro/captcha.
 */
import { consultarEsaj } from "./esaj.js";
import { buscarDjen } from "./djen.js";
import type { Metrica } from "./autoaperfeicoamento.js";

export const CANARIOS: Record<string, string> = {
  // termo de controle por fonte: nome que sabidamente aparece nas fixtures/produção
  "esaj-sp": "João Carlos",
  "esaj-al": "João Carlos",
  "esaj-ac": "João Carlos",
  "esaj-ce": "João Carlos",
  djen: "João Carlos",
};

export async function medirFonte(fonteId: string, termo: string, agora: string): Promise<Metrica> {
  const t0 = Date.now();
  if (fonteId === "djen") {
    const r = await buscarDjen({ nomeParte: termo, pagina: 1, limite: 20 });
    // geo_bloqueado/bloqueado/indisponivel/erro = a fonte NÃO respondeu.
    // Contar bloqueio como sucesso inflaria a confiabilidade do DJEN (medido: 403).
    const erro = r.estado !== "ok" && r.estado !== "sem_resultados";
    return {
      fonteId,
      coletadaEm: agora,
      consultas: 1,
      itens: r.itens.length,
      erros: erro ? 1 : 0,
      captchas: 0, // DJEN não usa captcha; bloqueio é geo (conta como erro)
      timeouts: r.estado === "rate_limit" ? 1 : 0,
      msP95: Date.now() - t0,
      canarioItens: r.itens.length,
    };
  }
  if (fonteId.startsWith("esaj-")) {
    const uf = fonteId.slice("esaj-".length);
    const r = await consultarEsaj(uf, "NMPARTE", termo, 1);
    const bloqueado = r.estado === "bloqueado";
    return {
      fonteId,
      coletadaEm: agora,
      consultas: 1,
      itens: r.itens.length,
      erros: bloqueado || r.estado === "erro" ? 1 : 0,
      captchas: bloqueado ? 1 : 0,
      timeouts: 0,
      msP95: Date.now() - t0,
      canarioItens: r.itens.length,
    };
  }
  return {
    fonteId,
    coletadaEm: agora,
    consultas: 1,
    itens: 0,
    erros: 1,
    captchas: 0,
    timeouts: 0,
    msP95: Date.now() - t0,
    canarioItens: 0,
  };
}

export async function medirFontes(fonteIds: string[], termo: string, agora: string): Promise<Metrica[]> {
  const out: Metrica[] = [];
  for (const id of fonteIds) out.push(await medirFonte(id, CANARIOS[id] ?? termo, agora));
  return out;
}
