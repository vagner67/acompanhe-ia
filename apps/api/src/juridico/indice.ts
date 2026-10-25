import { formatarNumero } from "./cnj.js";

/**
 * Índice próprio de processos (padrão P1/P2 do Jusbrasil: pipeline
 * coleta → armazenamento → índice → consulta, desacoplado da resposta ao
 * usuário) + padrão P3 (vínculo processo↔pessoa com grau de certeza, como
 * `confianca_associacao` do Jusbrasil e o `motivo` de match do Escavador).
 *
 * HONESTIDADE ESTRUTURAL (medido em 25/10/2026): o DataJud NÃO publica nomes de
 * partes (o `_source` traz numeroProcesso, classe, orgaoJulgador, movimentos,
 * grau, nivelSigilo, dataAjuizamento — sem `partes`). Portanto:
 *  - por NÚMERO: o índice é alimentado pelo DataJud (91 tribunais);
 *  - por NOME/CPF: o índice só recebe nomes das fontes que os publicam (e-SAJ)
 *    e dos processos que o próprio usuário acompanha — nunca inventamos parte.
 */
import { createHash } from "node:crypto";

import type { DatajudDoc } from "./types.js";
import type { ProcessoTercero } from "./esaj.js";

/** Motivos de vínculo — inspirados nos códigos públicos do Escavador e no
 * `confianca_associacao` do Jusbrasil. Nunca "afirmamos" vínculo sem base. */
export type MotivoVinculo =
  | "documento_informado"
  | "documento_algoritmo"
  | "mesmo_advogado_outro_processo"
  | "nome_exato_estado"
  | "nome_exato_municipio"
  | "sem_documento";

/** Peso do vínculo (0–1). Documento informado = 1.0; nome sozinho nunca passa de 0.5. */
export const PESO_VINCULO: Record<MotivoVinculo, number> = {
  documento_informado: 1,
  documento_algoritmo: 0.9,
  mesmo_advogado_outro_processo: 0.8,
  nome_exato_estado: 0.5,
  nome_exato_municipio: 0.5,
  sem_documento: 0.5,
};

export const MOTIVO_LEGIVEL: Record<MotivoVinculo, string> = {
  documento_informado: "documento informado pela própria fonte",
  documento_algoritmo: "documento associado por algoritmo (nome único)",
  mesmo_advogado_outro_processo: "mesmo advogado em outro processo",
  nome_exato_estado: "nome exato, único no estado",
  nome_exato_municipio: "nome exato, único no município",
  sem_documento: "apenas nome (fonte não informou o documento) — pode ser homônimo",
};

export interface ParteIndiceDto {
  nome: string;
  nomeNormalizado: string;
  /** SHA-256 dos dígitos do documento (LGPD: nunca guardamos CPF em claro). */
  documentoHash: string | null;
  polo: string | null;
  tipoPessoa: string | null;
  scoreVinculo: number;
  motivoVinculo: MotivoVinculo;
}

export interface MovimentoIndiceDto {
  codigo: number;
  nome: string;
  dataHora: string;
}

export interface ProcessoIndiceDto {
  numeroCnj: string;
  tribunal: string;
  uf: string | null;
  grau: string | null;
  classe: string | null;
  assunto: string | null;
  orgaoJulgador: string | null;
  valorCausa: number | null;
  dataAjuizamento: string | null;
  status: string | null;
  ultimoMovimentoNome: string | null;
  ultimoMovimentoData: string | null;
  partes: ParteIndiceDto[];
  movimentos: MovimentoIndiceDto[];
  fonte: string;
  atualizadoEm: string;
}

export interface BuscaIndice {
  nome?: string;
  documento?: string;
  numero?: string;
  uf?: string;
  tribunal?: string;
  ano?: string;
  limite?: number;
}

export interface ResultadoIndice {
  processo: ProcessoIndiceDto;
  score: number;
  motivo: MotivoVinculo | "numero";
  motivoLegivel: string;
  parteEncontrada: string | null;
}

export interface IndiceFacetas {
  tribunais: Array<{ valor: string; total: number }>;
  anos: Array<{ valor: string; total: number }>;
  ufs: Array<{ valor: string; total: number }>;
}

export interface IndiceStore {
  upsertMuitos(processos: ProcessoIndiceDto[]): Promise<number>;
  buscar(q: BuscaIndice): Promise<ProcessoIndiceDto[]>;
  facetas(q: BuscaIndice): Promise<IndiceFacetas>;
  total(): Promise<number>;
}

/** Normalização canônica: maiúsculas, sem acento, espaços colapsados. */
export function normalizarNome(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Hash do documento (só dígitos) — LGPD: o índice não guarda CPF/CNPJ em claro. */
export function chaveDocumento(documento: string): string {
  const digitos = documento.replace(/\D+/g, "");
  return createHash("sha256").update(digitos).digest("hex");
}

/** `yyyyMMddHHmmss` (DataJud) → ISO `yyyy-MM-dd`. Null quando ausente/inválido. */
export function dataAjuizamentoIso(bruto: string | undefined): string | null {
  if (!bruto || bruto.length < 8) return null;
  return `${bruto.slice(0, 4)}-${bruto.slice(4, 6)}-${bruto.slice(6, 8)}`;
}

/**
 * Converte um documento do DataJud em registro do índice.
 * SEM partes (o DataJud não as publica) — o índice não inventa nome de parte.
 */
export function processoDoDatajud(doc: DatajudDoc, alias: string, agora = new Date()): ProcessoIndiceDto {
  const movs = (doc.movimentos ?? [])
    .map((m) => ({ codigo: m.codigo, nome: m.nome, dataHora: m.dataHora }))
    .sort((a, b) => (a.dataHora < b.dataHora ? 1 : -1));
  const ultimo = movs[0];
  return {
    numeroCnj: formatarNumero(doc.numeroProcesso) ?? doc.numeroProcesso,
    tribunal: alias,
    uf: null,
    grau: doc.grau ?? null,
    classe: doc.classe?.nome ?? null,
    assunto: doc.assunto?.nome ?? null,
    orgaoJulgador: doc.orgaoJulgador?.nome ?? null,
    valorCausa: doc.valores?.valorDaCausa ?? null,
    dataAjuizamento: dataAjuizamentoIso(doc.dataAjuizamento),
    status: null,
    ultimoMovimentoNome: ultimo?.nome ?? null,
    ultimoMovimentoData: ultimo?.dataHora ?? null,
    partes: [],
    movimentos: movs.slice(0, 40),
    fonte: `datajud-${alias}`,
    atualizadoEm: agora.toISOString(),
  };
}

/**
 * Converte um resultado e-SAJ em registro do índice.
 * - busca por DOCUMENTO → vínculo `documento_informado` (peso 1)
 * - busca por NOME → `sem_documento` (peso 0.5, avisando homônimo)
 */
export function processoDaBuscaEsaj(
  item: ProcessoTercero,
  tipoBusca: "nome" | "documento",
  agora = new Date(),
  documento?: string,
): ProcessoIndiceDto {
  const motivo: MotivoVinculo = tipoBusca === "documento" ? "documento_informado" : "sem_documento";
  const partes: ParteIndiceDto[] = item.nomeParte
    ? [
        {
          nome: item.nomeParte,
          nomeNormalizado: normalizarNome(item.nomeParte),
          documentoHash: tipoBusca === "documento" && documento ? chaveDocumento(documento) : null,
          polo: item.participacao ?? null,
          tipoPessoa: null,
          scoreVinculo: PESO_VINCULO[motivo],
          motivoVinculo: motivo,
        },
      ]
    : [];
  return {
    numeroCnj: formatarNumero(item.numeroProcesso) ?? item.numeroProcesso,
    tribunal: `esaj-${item.uf}`,
    uf: item.uf,
    grau: null,
    classe: item.classe,
    assunto: item.assunto,
    orgaoJulgador: item.foro,
    valorCausa: null,
    dataAjuizamento: item.dataDistribuicao,
    status: null,
    ultimoMovimentoNome: null,
    ultimoMovimentoData: null,
    partes,
    movimentos: [],
    fonte: item.fonte,
    atualizadoEm: agora.toISOString(),
  };
}

/** Sobrepõe dados (mantém partes já conhecidas quando o novo registro não as traz). */
export function mesclarProcesso(antigo: ProcessoIndiceDto, novo: ProcessoIndiceDto): ProcessoIndiceDto {
  const partes = novo.partes.length > 0 ? novo.partes : antigo.partes;
  const movimentos = novo.movimentos.length > 0 ? novo.movimentos : antigo.movimentos;
  return {
    ...antigo,
    ...novo,
    partes,
    movimentos,
    classe: novo.classe ?? antigo.classe,
    assunto: novo.assunto ?? antigo.assunto,
    orgaoJulgador: novo.orgaoJulgador ?? antigo.orgaoJulgador,
    valorCausa: novo.valorCausa ?? antigo.valorCausa,
    dataAjuizamento: novo.dataAjuizamento ?? antigo.dataAjuizamento,
    status: novo.status ?? antigo.status,
    uf: novo.uf ?? antigo.uf,
    atualizadoEm: novo.atualizadoEm,
  };
}

/** Similaridade de tokens (0–1) — determinística, sem dependência externa. */
export function similaridadeNome(a: string, b: string): number {
  const ta = new Set(normalizarNome(a).split(" ").filter(Boolean));
  const tb = new Set(normalizarNome(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.max(ta.size, tb.size);
}

/**
 * Ranking dos resultados de uma busca: casa número (exato), documento (hash
 * exato) ou nome (similaridade ≥ 0.6, ordenado por score de vínculo e depois
 * por similaridade). Nunca retorna item cujo vínculo não foi estabelecido.
 */
export function ranquear(processos: ProcessoIndiceDto[], q: BuscaIndice): ResultadoIndice[] {
  const limite = Math.max(1, Math.min(100, q.limite ?? 30));
  const filtrados = processos.filter((p) => {
    if (q.uf && p.uf && p.uf !== q.uf) return false;
    if (q.tribunal && p.tribunal !== q.tribunal) return false;
    if (q.ano && !(p.dataAjuizamento ?? "").startsWith(q.ano)) return false;
    return true;
  });
  const out: ResultadoIndice[] = [];
  if (q.numero) {
    const alvo = q.numero.replace(/\D+/g, "");
    for (const p of filtrados) {
      if (p.numeroCnj.replace(/\D+/g, "") !== alvo) continue;
      out.push({
        processo: p,
        score: 1,
        motivo: "numero",
        motivoLegivel: "número do processo (identificador único)",
        parteEncontrada: null,
      });
    }
    return out.slice(0, limite);
  }
  const hash = q.documento ? chaveDocumento(q.documento) : null;
  const nomeAlvo = q.nome ? normalizarNome(q.nome) : null;
  for (const p of filtrados) {
    if (hash) {
      const parte = p.partes.find((x) => x.documentoHash === hash);
      if (!parte) continue;
      out.push({
        processo: p,
        score: parte.scoreVinculo,
        motivo: parte.motivoVinculo,
        motivoLegivel: MOTIVO_LEGIVEL[parte.motivoVinculo],
        parteEncontrada: parte.nome,
      });
      continue;
    }
    if (nomeAlvo) {
      let melhor: ParteIndiceDto | null = null;
      let sim = 0;
      for (const parte of p.partes) {
        const s = similaridadeNome(parte.nomeNormalizado, nomeAlvo);
        if (s >= 0.6 && s > sim) {
          melhor = parte;
          sim = s;
        }
      }
      if (!melhor) continue;
      const score = Math.round(melhor.scoreVinculo * sim * 100) / 100;
      out.push({
        processo: p,
        score,
        motivo: melhor.motivoVinculo,
        motivoLegivel: MOTIVO_LEGIVEL[melhor.motivoVinculo],
        parteEncontrada: melhor.nome,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || (a.processo.numeroCnj < b.processo.numeroCnj ? 1 : -1)).slice(0, limite);
}

/** Facetas por tribunal/ano/UF — o "faceting" que o Jusbrasil expõe por data e diário. */
export function facetasDe(processos: ProcessoIndiceDto[]): IndiceFacetas {
  const conta = (vals: Array<string | null>) => {
    const m = new Map<string, number>();
    for (const v of vals) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()]
      .map(([valor, total]) => ({ valor, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  };
  return {
    tribunais: conta(processos.map((p) => p.tribunal)),
    anos: conta(processos.map((p) => (p.dataAjuizamento ? p.dataAjuizamento.slice(0, 4) : null))),
    ufs: conta(processos.map((p) => p.uf)),
  };
}

/** Store em memória (testes e modo sem banco). */
export class InMemoryIndiceStore implements IndiceStore {
  private map = new Map<string, ProcessoIndiceDto>();

  async upsertMuitos(processos: ProcessoIndiceDto[]): Promise<number> {
    let n = 0;
    for (const p of processos) {
      const antigo = this.map.get(p.numeroCnj);
      this.map.set(p.numeroCnj, antigo ? mesclarProcesso(antigo, p) : p);
      n += 1;
    }
    return n;
  }

  async buscar(q: BuscaIndice): Promise<ProcessoIndiceDto[]> {
    const todos = [...this.map.values()];
    if (q.numero) {
      const alvo = q.numero.replace(/\D+/g, "");
      return todos.filter((p) => p.numeroCnj.replace(/\D+/g, "") === alvo);
    }
    if (q.documento) {
      const h = chaveDocumento(q.documento);
      return todos.filter((p) => p.partes.some((x) => x.documentoHash === h));
    }
    if (q.nome) {
      const alvo = normalizarNome(q.nome);
      return todos.filter((p) => p.partes.some((x) => similaridadeNome(x.nomeNormalizado, alvo) >= 0.6));
    }
    return todos;
  }

  async facetas(q: BuscaIndice): Promise<IndiceFacetas> {
    return facetasDe(await this.buscar(q));
  }

  async total(): Promise<number> {
    return this.map.size;
  }
}
