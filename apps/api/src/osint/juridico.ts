/**
 * Ponte Jurídico ↔ Investiga (união pedida em 25/10).
 *
 * O que já existia e é reusado **sem cópia**: `pesquisarTerceiros` (e-SAJ por
 * nome/CPF/CNPJ + DataJud por CNJ) e `detectarConsulta` (nome × CPF × CNPJ × CNJ
 * com validação de dígito verificador). O que este arquivo acrescenta é a
 * tradução do resultado jurídico para o contrato do Investiga — `OsintFinding`
 * com proveniência, status honesto e data de coleta — e a volta: um processo com
 * parte identificada vira caso OSINT.
 *
 * REGRA DE OURO: status da fonte é traduzido, nunca arredondado. "A fonte pediu
 * refinamento" NÃO é "não encontrado"; "a fonte bloqueou" NÃO é "não existe".
 */
import { randomUUID } from "node:crypto";

import type { OsintCase, OsintFinding, OsintTarget } from "@acompanhe/shared";

import { detectarConsulta } from "../juridico/deteccao.js";
import { pesquisarTerceiros } from "../juridico/pesquisa.js";
import type { ProcessoTercero, ResultadoEsaj } from "../juridico/esaj.js";
import { annotateConfidence } from "./confidence.js";

export type TipoConsultaJuridica = "nome" | "cpf" | "cnpj";

export interface AlvoComFonteJuridica {
  alvo: OsintTarget;
  tipo: TipoConsultaJuridica;
  valor: string;
}

export interface AlvoSemFonteJuridica {
  alvo: OsintTarget;
  motivo: string;
}

const MAX_ITENS_POR_FONTE = 10;

/**
 * Decide se um alvo do Investiga tem consulta jurídica real.
 *
 * O contrato do Investiga tem 6 tipos (username/email/phone/domain/name/url) e
 * **nenhum** tipo "documento". Em vez de inventar um 7º tipo (o contrato está
 * congelado no doc 13), a decisão usa `detectarConsulta`, que valida o DV de
 * CPF/CNPJ — é o que separa um telefone de 11 dígitos de um CPF de verdade.
 */
export function classificarAlvo(alvo: OsintTarget): AlvoComFonteJuridica | AlvoSemFonteJuridica {
  if (alvo.kind === "name" || alvo.kind === "phone") {
    const det = detectarConsulta(alvo.value);
    if (det.erro) return { alvo, motivo: det.erro };
    if (det.tipo === "cnj") {
      return { alvo, motivo: "o alvo é um número de processo — use a busca de processo no Jurídico" };
    }
    if (det.tipo === "nome" || det.tipo === "cpf" || det.tipo === "cnpj") {
      return { alvo, tipo: det.tipo, valor: det.valor };
    }
    return { alvo, motivo: `a detecção não reconheceu "${alvo.value}" como nome, CPF ou CNPJ` };
  }
  return {
    alvo,
    motivo: `alvo do tipo "${alvo.kind}" não tem fonte jurídica por nome/documento`,
  };
}

export interface FontesDoAlvo {
  fonte: string;
  estado: ResultadoEsaj["estado"];
  total: number | null;
  itens: number;
}

export interface ResultadoAlvo {
  alvo: OsintTarget;
  tipo: TipoConsultaJuridica | null;
  estado: ResultadoEsaj["estado"] | "sem-fonte";
  fontes: FontesDoAlvo[];
  itens: Array<{
    numeroProcesso: string;
    uf: string;
    classe: string | null;
    assunto: string | null;
    nomeParte: string | null;
    participacao: string | null;
    foro: string | null;
    dataDistribuicao: string | null;
    fonte: string;
    url: string;
  }>;
  avisos: string[];
}

/** Tradução honesta: estado da fonte → status do achado no Investiga. */
export function statusDoEstado(estado: ResultadoEsaj["estado"]): OsintFinding["status"] {
  switch (estado) {
    case "resultados":
      return "found";
    case "vazio":
      return "not_found";
    case "multiplos":
      return "unknown"; // "refine sua busca" não é ausência de processo
    case "bloqueado":
      return "unavailable";
    case "erro":
    default:
      return "error";
  }
}

function achadosDaFonte(fonte: ResultadoEsaj, consulta: AlvoComFonteJuridica, agora: string, casoId: string): OsintFinding[] {
  const base = {
    caseId: casoId,
    sourceId: `juridico:${fonte.fonte}`,
    retrievedAt: agora,
    inference: false,
  };
  const rotuloConsulta = `${consulta.tipo.toUpperCase()} "${consulta.valor}"`;

  if (fonte.estado === "resultados" && fonte.itens.length > 0) {
    const itens = fonte.itens.slice(0, MAX_ITENS_POR_FONTE);
    const achados: OsintFinding[] = itens.map((item: ProcessoTercero) => ({
      ...base,
      id: randomUUID(),
      status: "found" as const,
      summary:
        `${fonte.fonte.toUpperCase()}: processo ${item.numeroProcesso}` +
        (item.nomeParte ? ` · parte ${item.nomeParte}` : "") +
        (item.participacao ? ` (${item.participacao})` : "") +
        (item.classe ? ` · ${item.classe}` : "") +
        ` — encontrado por ${rotuloConsulta}`,
      evidenceUrl: item.url,
      raw: {
        numeroProcesso: item.numeroProcesso,
        uf: item.uf,
        foro: item.foro,
        classe: item.classe,
        assunto: item.assunto,
        nomeParte: item.nomeParte,
        participacao: item.participacao,
        dataDistribuicao: item.dataDistribuicao,
        localDistribuicao: item.localDistribuicao,
        fonte: item.fonte,
        url: item.url,
        consulta: { tipo: consulta.tipo, valor: consulta.valor },
      },
    }));
    // Sem "achado-resumo" aqui de propósito: um achado `found` precisa apontar a
    // evidência (URL do processo). O que sobra da página vira aviso em
    // buscarJuridicoDoCaso, com o total informado pela fonte.
    return achados;
  }

  const explica: Record<ResultadoEsaj["estado"], string> = {
    resultados: "a fonte respondeu resultados, mas a lista veio vazia",
    vazio: "a fonte respondeu que não há informação disponível para este parâmetro",
    multiplos: "a fonte respondeu que há processos demais e pediu refinamento do termo — não é ausência de processo",
    bloqueado: "a fonte bloqueou a consulta (captcha/403) — resultado desconhecido, não negativo",
    erro: "a fonte respondeu algo que não foi reconhecido — resultado desconhecido, não negativo",
  };
  return [
    {
      ...base,
      id: randomUUID(),
      status: statusDoEstado(fonte.estado),
      summary: `${fonte.fonte.toUpperCase()} por ${rotuloConsulta}: ${explica[fonte.estado]}`,
      raw: {
        estado: fonte.estado,
        total: fonte.total,
        pagina: fonte.pagina,
        ultimaPagina: fonte.ultimaPagina,
        consulta: { tipo: consulta.tipo, valor: consulta.valor },
      },
    },
  ];
}

export interface BuscarJuridicoOpts {
  /** injetável para teste: usa as fixtures reais capturadas dos tribunais */
  fetchImpl?: typeof fetch;
  ufs?: string[];
  perfis?: unknown;
  agora?: string;
}

export interface ResultadoBuscaJuridica {
  porAlvo: ResultadoAlvo[];
  achados: OsintFinding[];
  avisos: string[];
}

/**
 * Roda a consulta jurídica para os alvos de um caso OSINT e devolve os achados
 * no contrato do Investiga (prontos para `store.addFindings`).
 */
export async function buscarJuridicoDoCaso(caso: OsintCase, opts: BuscarJuridicoOpts = {}): Promise<ResultadoBuscaJuridica> {
  const agora = opts.agora ?? new Date().toISOString();
  const porAlvo: ResultadoAlvo[] = [];
  const achados: OsintFinding[] = [];
  const avisos: string[] = [];

  for (const alvo of caso.targets) {
    const cls = classificarAlvo(alvo);
    if ("motivo" in cls) {
      porAlvo.push({ alvo, tipo: null, estado: "sem-fonte", fontes: [], itens: [], avisos: [cls.motivo] });
      continue;
    }
    const res = await pesquisarTerceiros(cls.tipo, cls.valor, {
      ...(opts.ufs ? { ufs: opts.ufs } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.perfis ? { perfis: opts.perfis as never } : {}),
    });
    const daFonte = res.fontes.flatMap((f) => achadosDaFonte(f, cls, agora, caso.id));
    achados.push(...daFonte);
    const destaques = res.fontes.flatMap((f) => {
      const linhas = f.estado !== "resultados" ? [`${f.fonte.toUpperCase()}: ${f.estado}`] : [];
      if (f.itens.length > MAX_ITENS_POR_FONTE) {
        linhas.push(
          `${f.fonte.toUpperCase()}: ${f.itens.length} processo(s) na página, ${MAX_ITENS_POR_FONTE} gravados` +
            (f.total !== null ? ` (total informado: ${f.total})` : ""),
        );
      }
      return linhas;
    });
    if (destaques.length > 0) avisos.push(...destaques);
    porAlvo.push({
      alvo,
      tipo: cls.tipo,
      estado: res.fontes.some((f) => f.estado === "resultados") ? "resultados" : (res.fontes[0]?.estado ?? "erro"),
      fontes: res.fontes.map((f) => ({ fonte: f.fonte, estado: f.estado, total: f.total, itens: f.itens.length })),
      itens: res.itens.slice(0, MAX_ITENS_POR_FONTE).map((i: ProcessoTercero) => ({
        numeroProcesso: i.numeroProcesso,
        uf: i.uf,
        classe: i.classe,
        assunto: i.assunto,
        nomeParte: i.nomeParte,
        participacao: i.participacao,
        foro: i.foro,
        dataDistribuicao: i.dataDistribuicao,
        fonte: i.fonte,
        url: i.url,
      })),
      avisos: [],
    });
  }

  // confiança pelo motor real do Investiga (mesma fórmula dos outros achados)
  return { porAlvo, achados: annotateConfidence(achados), avisos };
}

export interface EntradaProcessoParaInvestigacao {
  numeroProcesso: string;
  nomeParte: string;
  uf?: string | null;
  participacao?: string | null;
  baseLegal?: string | null;
  finalidade?: string | null;
  titulo?: string | null;
}

export interface CasoAPartirDeProcesso {
  title: string;
  targets: OsintTarget[];
  legalBasis: string;
  purpose: string;
}

/**
 * O caminho de volta: um item de processo (que veio com `nomeParte` da fonte)
 * vira caso OSINT. Sem nome não há alvo — quem chama recebe `null` e responde
 * 422 explicando (nunca cria caso com alvo inventado).
 */
export function casoAPartirDeProcesso(entrada: EntradaProcessoParaInvestigacao): CasoAPartirDeProcesso | null {
  const nome = (entrada.nomeParte ?? "").trim();
  if (nome.length < 3) return null;
  const titulo = (entrada.titulo ?? "").trim() || `Processo ${entrada.numeroProcesso} — ${nome}`;
  return {
    title: titulo.slice(0, 120),
    targets: [
      {
        kind: "name",
        value: nome.slice(0, 320),
        ...(entrada.participacao ? { label: entrada.participacao } : {}),
      },
    ],
    legalBasis:
      (entrada.baseLegal ?? "").trim() ||
      "LGPD art. 7º, §3º e art. 11, II, 'd' — exercício regular de direitos em processo judicial; a parte foi identificada na consulta pública do tribunal",
    purpose:
      (entrada.finalidade ?? "").trim() ||
      `Acompanhar a contraparte do processo ${entrada.numeroProcesso}${entrada.uf ? ` (${entrada.uf.toUpperCase()})` : ""} em fontes públicas, para instruir a defesa`,
  };
}
