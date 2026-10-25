/**
 * Ponte NCA → busca do app (plano.md §3.8, lacuna G1).
 *
 * O núcleo mede e aprende parâmetros por coletor. Para o aprendizado chegar de
 * fato na consulta que o usuário faz, o que o NCA promove nos coletores do
 * Jurídico é espelhado no `PerfilStore` que `consultarNacional` lê.
 *
 * Sem isto o NCA seria mais um caderno paralelo — exatamente o problema que o
 * plano apontou (três catálogos, dois motores, nenhum efeito na ponta).
 *
 * Regra: só espelha parâmetro que EXISTE nos dois lados (hoje: `varianteNome`).
 * Nada de inventar correspondência.
 */
import { perfilVigente, type PerfilStore } from "../juridico/autoaperfeicoamento.js";
import type { Params } from "./tipos.js";

export interface PromocaoNucleo {
  coletorId: string;
  params: Params;
  versao: number;
  score: number;
  motivo: string;
}

/** Coletores do NCA que alimentam a busca do app (mesmos ids de `FONTES`). */
const ESPELHADOS = new Set(["esaj-sp", "esaj-al", "esaj-ac", "esaj-ce", "djen", "datajud"]);

export function sincronizarComPerfis(store: PerfilStore): (p: PromocaoNucleo) => Promise<boolean> {
  return async (p) => {
    if (!ESPELHADOS.has(p.coletorId)) return false;
    const variante = p.params["varianteNome"];
    if (variante === undefined) return false; // nada aprendido que a busca use
    const atual = await perfilVigente(store, p.coletorId);
    const varianteNome = (Number(variante) === 1 ? 1 : Number(variante) === 2 ? 2 : 0) as 0 | 1 | 2;
    if (atual.varianteNome === varianteNome && atual.versao >= p.versao) return false;
    await store.salvar(
      { ...atual, fonteId: p.coletorId, varianteNome, versao: Math.max(atual.versao, p.versao) },
      {
        fonteId: p.coletorId,
        acao: "promover",
        scoreAtual: p.score,
        scoreNovo: p.score,
        motivo: `NCA: ${p.motivo}`,
        perfil: { ...atual, fonteId: p.coletorId, varianteNome, versao: Math.max(atual.versao, p.versao) },
        anteriorVersao: atual.versao,
      },
    );
    return true;
  };
}
