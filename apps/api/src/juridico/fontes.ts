/**
 * Catálogo de fontes do Jurídico (padrão P7 — "registro de capacidade por fonte",
 * como o `origens`/`tribunais/sistemas` do Escavador e os filtros por diário do
 * Jusbrasil). A UI e as rotas consultam ESTE catálogo — nunca listas soltas —
 * para que a cobertura exibida seja exatamente a cobertura real.
 *
 * Regra: nada entra aqui sem `verificadoEm` (data de verificação empírica).
 * Ver docs/plano-refatoracao-juridico-jusbrasil-escavador.md §6.1.
 */
import { ESAJ_BASES } from "./esaj.js";
import { TRIBUNAIS_DATAJUD } from "./cnj.js";

export type Capacidade = "numero" | "nome" | "cpf" | "cnpj" | "oab";
export type TipoFonte = "indice" | "datajud" | "esaj" | "djen";

export interface FonteInfo {
  id: string;
  nome: string;
  tipo: TipoFonte;
  capacidades: Capacidade[];
  /** null = cobertura nacional */
  ufs: string[] | null;
  estado: "ativo" | "indisponivel" | "planejado";
  verificadoEm: string; // AAAA-MM-DD
  limitacao?: string;
}

const NOMES_UF: Record<string, string> = {
  ac: "Acre",
  al: "Alagoas",
  ce: "Ceará",
  sp: "São Paulo",
};

export const FONTES_INFO: FonteInfo[] = [
  {
    id: "indice",
    nome: "Índice próprio Acompanhe.IA",
    tipo: "indice",
    capacidades: ["numero", "nome", "cpf", "cnpj"],
    ufs: null,
    estado: "ativo",
    verificadoEm: "2026-10-25",
    limitacao:
      "cresce conforme a ingestão: nomes vêm das fontes públicas que os publicam e dos processos que você acompanha; documento só é vinculado quando a fonte informa ou quando a busca foi feita pelo próprio documento",
  },
  {
    id: "datajud",
    nome: `DataJud/CNJ (${TRIBUNAIS_DATAJUD.length} tribunais)`,
    tipo: "datajud",
    capacidades: ["numero"],
    ufs: null,
    estado: "ativo",
    verificadoEm: "2026-10-24",
    limitacao: "não publica nomes de partes nem CPF (medido: o _source não traz `partes`) — por isso não serve para busca por nome",
  },
  ...Object.keys(ESAJ_BASES).map<FonteInfo>((uf) => ({
    id: `esaj-${uf}`,
    nome: `e-SAJ ${uf.toUpperCase()} — ${NOMES_UF[uf] ?? uf.toUpperCase()}`,
    tipo: "esaj",
    capacidades: ["numero", "nome", "cpf", "cnpj"],
    ufs: [uf],
    estado: "ativo",
    verificadoEm: "2026-10-24",
    limitacao: "consulta pública por nome/documento; não publica o CPF das partes nos resultados (vínculo por documento só na busca por documento)",
  })),
  {
    id: "djen",
    nome: "DJEN/Comunica (CNJ) — publicações",
    tipo: "djen",
    capacidades: ["numero", "nome", "oab"],
    ufs: null,
    estado: "indisponivel",
    verificadoEm: "2026-10-25",
    limitacao:
      "API pública sem chave (Res. 455/2022) BLOQUEIA IP fora do Brasil (HTTP 403 CloudFront medido em 25/10/2026); requer egress brasileiro — decisão adiada pelo usuário",
  },
];

export interface Cobertura {
  numero: { fontes: number; tribunais: number };
  nome: { fontes: string[]; ufs: string[] };
  documento: { fontes: string[]; ufs: string[] };
}

/** Resumo de cobertura derivado do catálogo (fonte única da verdade na UI). */
export function cobertura(fontes: FonteInfo[] = FONTES_INFO): Cobertura {
  const ativas = fontes.filter((f) => f.estado === "ativo");
  const numeros = ativas.filter((f) => f.capacidades.includes("numero"));
  const nomes = ativas.filter((f) => f.capacidades.includes("nome") && f.tipo === "esaj");
  const docs = ativas.filter((f) => f.capacidades.includes("cpf") && f.tipo === "esaj");
  const ufsDe = (lista: FonteInfo[]) =>
    [...new Set(lista.flatMap((f) => f.ufs ?? []))].sort();
  return {
    numero: { fontes: numeros.length, tribunais: TRIBUNAIS_DATAJUD.length },
    nome: { fontes: nomes.map((f) => f.id).sort(), ufs: ufsDe(nomes) },
    documento: { fontes: docs.map((f) => f.id).sort(), ufs: ufsDe(docs) },
  };
}

/** Fontes que aceitam uma capacidade — usado pelas rotas para decidir o caminho. */
export function fontesPara(cap: Capacidade, fontes: FonteInfo[] = FONTES_INFO): FonteInfo[] {
  return fontes.filter((f) => f.estado === "ativo" && f.capacidades.includes(cap));
}
