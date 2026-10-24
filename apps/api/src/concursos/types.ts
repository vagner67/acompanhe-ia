/**
 * Concursos — tipos do módulo (plano.md §3). Shapes REAIS capturados em
 * 23/10/2026 (fixtures/dou-capture.json = leiturajornal DO1; fixtures/
 * dou-busca-capture.json = /consulta/-/buscar/dou DO3). Dois shapes coexistem
 * (embed da edição vs busca) — o mapeador trata os dois.
 */

/** Item do jsonArray do DOU (leiturajornal OU busca) — 23/10/2026. */
export interface DouItemRaw {
  pubName: string; // DO1 | DO2 | DO3
  title: string;
  titulo?: string | null;
  subTitulo?: string | null;
  content: string;
  pubDate: string; // dd/mm/yyyy
  urlTitle: string;
  numberPage?: string | null;
  editionNumber?: string | null;
  artType?: string | null;
  hierarchyStr?: string | null;
  hierarchyList?: Array<{ id?: number; level?: number; name?: string; value?: string }> | null;
  displayDate?: string | null;
  displayDateSortable?: string | null;
  classPK?: string | number | null;
  score?: number | null;
}

export type ContestStatus =
  | "previsto"
  | "autorizado"
  | "edital_publicado"
  | "inscricoes_abertas"
  | "homologado";

export interface ContestDto {
  /** RD2: hash(órgão+banca+ano+nº edital); fallback documentado = hash(urlTitle). */
  externalId: string;
  identitySource: "edital" | "url";
  title: string;
  organ: string;
  banca?: string | null;
  uf?: string | null;
  cityIbge?: number | null;
  status: ContestStatus;
  salaryCents?: number | null;
  level?: string | null;
  /** RD4: link da publicação oficial (DOU) — campo REAL (urlTitle → url do DOU). */
  sourceUrl: string;
  inscricoesFrom?: string | null;
  inscricoesTo?: string | null;
  provaAt?: string | null;
  /** RD3: vagas/salário só "validado" com 2 fontes ou confirmação humana. */
  fieldStatus: "pendente" | "validado";
  /** RD2: retificação = versão vinculada, nunca substitui o original. */
  parentVersion?: string | null;
  raw: unknown;
}
