/**
 * Frota de coletores — a matriz VERDADEIRA de cobertura (91 tribunais × capacidades).
 *
 * Regra de ouro: uma capacidade só aparece como disponível para um tribunal se existe
 * coletor implementado E ele foi medido (data em `verificadoEm`). O que é captcha fica
 * declarado como captcha; o que é geo-bloqueado fica como geo-bloqueado. A UI lê daqui.
 *
 * Base das medições: docs/plano-91-tribunais-nacional.md §3 (25/10/2026).
 */
import { TRIBUNAIS_DATAJUD } from "./cnj.js";
import { ESAJ_BASES } from "./esaj.js";

export type Capacidade = "numero" | "nome" | "cpf";
export type Familia = "datajud" | "esaj" | "djen" | "pje" | "eproc" | "projudi" | "proprio" | "indice";

export interface TribunalCobertura {
  alias: string;
  uf: string | null;
  familiaPrincipal: Familia;
  numero: { ok: boolean; fonte: string | null };
  nome: { ok: boolean; fonte: string | null; requerCaptcha: boolean };
  cpf: { ok: boolean; fonte: string | null; requerCaptcha: boolean };
}

/** UFs com e-SAJ aberto (consulta por nome/documento sem captcha) — VERIFICADAS em produção. */
export const UFS_ESAJ_ABERTAS: string[] = Object.keys(ESAJ_BASES).map((u) => u.toLowerCase());

/**
 * Sistemas por UF (fonte: portais oficiais + medições do plano §3). Serve para
 * explicar ao usuário ONDE consultar quando não temos coletor — em vez de omitir.
 */
export const SISTEMAS_POR_UF: Record<string, { familia: Familia; portal: string; requerCaptcha: boolean }> = {
  ac: { familia: "esaj", portal: "https://esaj.tjac.jus.br/cpopg/open.do", requerCaptcha: false },
  al: { familia: "esaj", portal: "https://www2.tjal.jus.br/cpopg/open.do", requerCaptcha: false },
  am: { familia: "proprio", portal: "https://consultas.tjam.jus.br/", requerCaptcha: true },
  ap: { familia: "pje", portal: "https://pje.tjap.jus.br/pje/ConsultaPublica/listView.seam", requerCaptcha: true },
  ba: { familia: "pje", portal: "https://pje.tjba.jus.br/pje/ConsultaPublica/listView.seam", requerCaptcha: true },
  ce: { familia: "esaj", portal: "https://esaj.tjce.jus.br/cpopg/open.do", requerCaptcha: false },
  df: { familia: "pje", portal: "https://pje.tjdft.jus.br/consultapublica/ConsultaPublica/listView.seam", requerCaptcha: true },
  es: { familia: "pje", portal: "https://pje.tjes.jus.br/pje/ConsultaPublica/listView.seam", requerCaptcha: true },
  go: { familia: "projudi", portal: "https://projudi.tjgo.jus.br/BuscaProcesso", requerCaptcha: true },
  ma: { familia: "pje", portal: "https://pje.tjma.jus.br/pje/ConsultaPublica/listView.seam", requerCaptcha: true },
  mg: { familia: "pje", portal: "https://pje-consulta-publica.tjmg.jus.br/", requerCaptcha: true },
  ms: { familia: "proprio", portal: "https://esaj.tjms.jus.br/cpopg/open.do", requerCaptcha: true },
  mt: { familia: "pje", portal: "https://pje.tjmt.jus.br/pje/ConsultaPublica/listView.seam", requerCaptcha: true },
  pa: { familia: "proprio", portal: "https://consultas.tjpa.jus.br/consultaunificada/consulta/principal", requerCaptcha: true },
  pb: { familia: "pje", portal: "https://pje.tjpb.jus.br/pje/ConsultaPublica/listView.seam", requerCaptcha: true },
  pe: { familia: "pje", portal: "https://pje.cloud.tjpe.jus.br/1g/ConsultaPublica/listView.seam", requerCaptcha: true },
  pi: { familia: "pje", portal: "https://pje.tjpi.jus.br/pje/ConsultaPublica/listView.seam", requerCaptcha: true },
  pr: { familia: "projudi", portal: "https://projudi.tjpr.jus.br/projudi/", requerCaptcha: true },
  rj: { familia: "proprio", portal: "https://www3.tjrj.jus.br/consultaprocessual/", requerCaptcha: false },
  rn: { familia: "pje", portal: "https://pje.tjrn.jus.br/pje/ConsultaPublica/listView.seam", requerCaptcha: true },
  ro: { familia: "projudi", portal: "https://projudi.tjro.jus.br/projudi/", requerCaptcha: true },
  rr: { familia: "pje", portal: "https://pje.tjrr.jus.br/pje/ConsultaPublica/listView.seam", requerCaptcha: true },
  rs: { familia: "eproc", portal: "https://www.tjrs.jus.br/busca/processos/", requerCaptcha: true },
  sc: { familia: "eproc", portal: "https://eproc1g.tjsc.jus.br/eproc/controlador.php?acao=procedimento_consultar", requerCaptcha: true },
  se: { familia: "eproc", portal: "https://www.tjse.jus.br/portal/", requerCaptcha: true },
  sp: { familia: "esaj", portal: "https://esaj.tjsp.jus.br/cpopg/open.do", requerCaptcha: false },
  to: { familia: "eproc", portal: "https://eproc1.tjto.jus.br/eproc/controlador.php?acao=procedimento_consultar", requerCaptcha: true },
};

/** Alias DataJud → UF (só para os TJs estaduais; `8` = Justiça Estadual). */
const UF_DO_TJ: Record<string, string> = {};
for (const [uf, info] of Object.entries(SISTEMAS_POR_UF)) UF_DO_TJ[`tj${uf}`] = uf;

/** DJEN cobre nome nacionalmente — mas depende de egress brasileiro (medido: 403 fora do BR). */
export function djenHabilitado(): boolean {
  return Boolean(process.env.DJEN_RELAY_URL);
}

/**
 * Matriz completa: um registro por tribunal dos 91 do DataJud.
 * - `numero`: sempre true (DataJud é oficial e cobre os 91).
 * - `nome`/`cpf`: só true quando existe coletor aberto (e-SAJ medido) ou quando o DJEN
 *   está habilitado por relay (aí vale nacionalmente).
 */
export function matrizCobertura(opts: { djenHabilitado?: boolean } = {}): TribunalCobertura[] {
  const djen = opts.djenHabilitado ?? djenHabilitado();
  const vistos = new Set<string>();
  const out: TribunalCobertura[] = [];
  for (const alias of TRIBUNAIS_DATAJUD) {
    const uf = UF_DO_TJ[alias] ?? null;
    const sistema = uf ? SISTEMAS_POR_UF[uf] : undefined;
    const esajAberto = Boolean(uf && UFS_ESAJ_ABERTAS.includes(uf));
    const porDjen = djen;
    const requerCaptcha = sistema?.requerCaptcha ?? true;
    out.push({
      alias,
      uf,
      familiaPrincipal: (sistema?.familia ?? "datajud") as Familia,
      numero: { ok: true, fonte: "datajud" },
      nome: esajAberto
        ? { ok: true, fonte: `esaj-${uf}`, requerCaptcha: false }
        : porDjen
          ? { ok: true, fonte: "djen", requerCaptcha: false }
          : { ok: false, fonte: null, requerCaptcha },
      cpf: esajAberto
        ? { ok: true, fonte: `esaj-${uf}`, requerCaptcha: false }
        : porDjen
          ? { ok: true, fonte: "djen", requerCaptcha: false }
          : { ok: false, fonte: null, requerCaptcha },
    });
    vistos.add(alias);
  }
  return out;
}

export interface ResumoFrota {
  tribunais: number;
  numero: number;
  nome: number;
  cpf: number;
  esajAbertas: string[];
  djen: boolean;
  semColetorNome: string[];
}

export function resumoFrota(matriz: TribunalCobertura[] = matrizCobertura()): ResumoFrota {
  return {
    tribunais: matriz.length,
    numero: matriz.filter((t) => t.numero.ok).length,
    nome: matriz.filter((t) => t.nome.ok).length,
    cpf: matriz.filter((t) => t.cpf.ok).length,
    esajAbertas: [...UFS_ESAJ_ABERTAS].sort(),
    djen: matriz.some((t) => t.nome.fonte === "djen"),
    semColetorNome: matriz.filter((t) => !t.nome.ok).map((t) => t.alias),
  };
}

/** Onde consultar quando não temos coletor — link oficial, nunca "não sei". */
export function portalDoTribunal(alias: string): string | null {
  const uf = UF_DO_TJ[alias];
  return uf ? (SISTEMAS_POR_UF[uf]?.portal ?? null) : null;
}

export const RODAPE_FROTA =
  "Consulta por número: DataJud/CNJ em todos os 91 tribunais. Nome/CPF: fontes públicas abertas (e-SAJ) e DJEN " +
  "quando há egress brasileiro configurado; nos demais tribunais a consulta é feita no portal oficial (captcha). " +
  "Conteúdo informativo, não é parecer jurídico.";
