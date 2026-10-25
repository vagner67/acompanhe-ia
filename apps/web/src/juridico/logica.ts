/**
 * Lógica pura da tela jurídica — extraída para poder ser testada sem DOM.
 * Nada aqui fala com a rede: recebe respostas da API e devolve o que a UI mostra.
 * Plano: docs/plano-refatoracao-ui.md §5.
 */
import type { CatalogoFontes, DetalheTercero, ItemIndice, ProcessoTercero, ResultadoEsaj } from "../api2";

export type TipoConsulta = "" | "cnj" | "cpf" | "cnpj" | "nome";

export const ROTULO_TIPO: Record<TipoConsulta, string> = {
  "": "",
  cnj: "número de processo",
  cpf: "CPF",
  cnpj: "CNPJ",
  nome: "nome",
};

/** Só olha formato — quem decide se o DV é válido é o servidor (fonte única). */
export function detectarTipo(texto: string): TipoConsulta {
  if (!texto.trim()) return "";
  const digitos = texto.replace(/\D+/g, "");
  if (digitos.length === 20) return "cnj";
  if (digitos.length === 11) return "cpf";
  if (digitos.length === 14) return "cnpj";
  return "nome";
}

export const soDigitos = (s: string) => s.replace(/\D+/g, "");

/** Item único exibido na lista de resultados — índice próprio e e-SAJ se fundem aqui. */
export interface ItemUnificado {
  chave: string;
  numero: string;
  partes: string | null;
  tribunal: string | null;
  classe: string | null;
  assunto: string | null;
  orgao: string | null;
  ultimoMovimento: string | null;
  dataMovimento: string | null;
  status: string | null;
  /** grau de certeza do vínculo (0–1) — só existe para o índice próprio */
  score: number | null;
  motivoLegivel: string | null;
  fontes: string[];
  url: string | null;
}

const vazio = (s: string | null | undefined) => !s || !s.trim();

/**
 * Deduplica por número (compara só dígitos, porque as fontes divergem na máscara),
 * enriquece o item de e-SAJ com o cruzamento do DataJud e ordena por vínculo.
 * O índice próprio ganha quando o mesmo número aparece nas duas origens.
 */
export function unificarResultados(
  indice: ItemIndice[] | null | undefined,
  terceiros: ProcessoTercero[] | null | undefined,
  detalhes: Record<string, DetalheTercero> | null | undefined,
): ItemUnificado[] {
  const porNumero = new Map<string, ItemUnificado>();

  for (const it of indice ?? []) {
    const p = it.processo;
    const chave = soDigitos(p.numeroCnj);
    porNumero.set(chave, {
      chave,
      numero: p.numeroCnj,
      partes: it.parteEncontrada,
      tribunal: p.tribunal,
      classe: p.classe,
      assunto: p.assunto,
      orgao: p.orgaoJulgador,
      ultimoMovimento: p.ultimoMovimentoNome,
      dataMovimento: p.ultimoMovimentoData,
      status: null,
      score: it.score,
      motivoLegivel: it.motivoLegivel,
      fontes: [p.fonte],
      url: null,
    });
  }

  for (const t of terceiros ?? []) {
    const chave = soDigitos(t.numeroProcesso);
    const det = detalhes?.[t.numeroProcesso] ?? detalhes?.[chave];
    const existente = porNumero.get(chave);
    if (existente) {
      if (vazio(existente.partes)) existente.partes = t.nomeParte;
      if (vazio(existente.classe)) existente.classe = t.classe;
      if (vazio(existente.assunto)) existente.assunto = t.assunto;
      existente.status = existente.status ?? det?.status ?? null;
      existente.ultimoMovimento = existente.ultimoMovimento ?? det?.ultimoMovimento?.nome ?? null;
      existente.url = existente.url ?? t.url;
      if (!existente.fontes.includes(t.fonte)) existente.fontes.push(t.fonte);
      continue;
    }
    porNumero.set(chave, {
      chave,
      numero: t.numeroProcesso,
      partes: t.nomeParte,
      tribunal: t.uf ? `e-SAJ ${t.uf.toUpperCase()}` : t.fonte,
      classe: t.classe,
      assunto: t.assunto,
      orgao: t.foro ?? det?.orgaoJulgador ?? null,
      ultimoMovimento: det?.ultimoMovimento?.nome ?? null,
      dataMovimento: det?.ultimoMovimento?.dataHora ?? null,
      status: det?.status ?? null,
      score: null,
      motivoLegivel: null,
      fontes: [t.fonte],
      url: t.url,
    });
  }

  return [...porNumero.values()].sort((a, b) => {
    const sa = a.score ?? -1;
    const sb = b.score ?? -1;
    if (sb !== sa) return sb - sa;
    return a.numero < b.numero ? -1 : 1;
  });
}

export type AcaoId = "buscar" | "profunda" | "abrir" | "indice" | "acompanhar" | "alertar" | "sincronizar" | "perguntar";

/**
 * Quais ações fazem sentido agora. Divulgação progressiva por ESTADO (não por
 * sanfona): nada de chevron, nada de acordeão.
 */
export function acoesDoEstado(tipo: TipoConsulta, temProcesso: boolean): AcaoId[] {
  if (!tipo) return ["buscar"];
  if (tipo === "cnj") return temProcesso ? ["abrir", "acompanhar", "alertar", "sincronizar", "perguntar"] : ["abrir", "indice"];
  return temProcesso ? ["buscar", "profunda", "acompanhar", "alertar", "perguntar"] : ["buscar", "profunda"];
}

/** Uma linha só — é o que sobra da antiga "cobertura real" na tela. */
export function resumoCobertura(cat: CatalogoFontes | null | undefined): string {
  const tribunais = cat?.cobertura?.numero?.tribunais;
  const ufs = cat?.cobertura?.nome?.ufs ?? [];
  const partes: string[] = [];
  if (typeof tribunais === "number" && tribunais > 0) partes.push(`${tribunais} tribunais por número`);
  if (ufs.length) partes.push(`nome/CPF em ${ufs.map((u) => u.toUpperCase()).join(", ")}`);
  return partes.join(" · ") || "fontes públicas verificadas";
}

export interface ContagemFonte {
  fonte: string;
  uf: string;
  estado: ResultadoEsaj["estado"];
  itens: number;
  total: number | null;
}

/** Rodapé curto + insumo do sheet "Onde buscamos". */
export function contarPorFonte(fontes: ResultadoEsaj[] | null | undefined): ContagemFonte[] {
  const mapa = new Map<string, ContagemFonte>();
  for (const f of fontes ?? []) {
    const atual = mapa.get(f.fonte);
    if (atual && atual.estado === "resultados" && f.estado !== "resultados") continue;
    mapa.set(f.fonte, {
      fonte: f.fonte,
      uf: f.uf,
      estado: f.estado,
      itens: (atual?.itens ?? 0) + f.itens.length,
      total: f.total ?? atual?.total ?? null,
    });
  }
  return [...mapa.values()];
}

export const TEXTO_ESTADO_FONTE: Record<ResultadoEsaj["estado"], string> = {
  resultados: "consultada com sucesso",
  multiplos: "muitos resultados para o termo — refine o nome",
  vazio: "sem registros públicos para esta consulta",
  bloqueado: "bloqueou o acesso no momento",
  erro: "indisponível agora",
};

export function faixaCriticidade(n: number): { rotulo: string; cor: string } {
  if (n <= 2) return { rotulo: "baixo", cor: "var(--good)" };
  if (n <= 5) return { rotulo: "médio", cor: "var(--warn)" };
  if (n <= 8) return { rotulo: "alto", cor: "#ff8a5c" };
  return { rotulo: "crítico", cor: "var(--bad)" };
}

export function encurtar(s: string | null | undefined, max = 60): string {
  const t = (s ?? "").trim();
  if (!t) return "—";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Exemplos clicáveis do estado vazio — preenchem o campo e disparam a busca. */
export const EXEMPLOS: Array<{ rotulo: string; valor: string }> = [
  { rotulo: "nº do processo", valor: "0006903-69.2014.8.11.0037" },
  { rotulo: "CPF", valor: "529.982.247-25" },
  { rotulo: "nome", valor: "Maria da Silva" },
];
