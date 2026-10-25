/**
 * Auto-aperfeiçoamento recursivo das fontes — plano-91-tribunais-nacional.md §5.
 *
 * Laço fechado e AUDITÁVEL (nada de aleatoriedade, nada de "IA mágica"):
 *
 *   medir (canários reais)  →  pontuar (função pura)  →  mutar vizinhos limitados
 *   →  promover só com ganho ≥ ε (histerese)  →  gravar versão  →  (rollback se piorar)
 *   e, em paralelo, detectar DERIVA quando a fonte responde 200 com 0 itens.
 *
 * Tudo determinístico: mesma entrada → mesma decisão. O relógio é injetado.
 */

export interface PerfilFonte {
  fonteId: string;
  /** timeout por requisição (ms) — piso 1.000, teto 30.000 */
  timeoutMs: number;
  /** páginas que varremos por consulta — 1..10 */
  paginas: number;
  /** requisições simultâneas contra a mesma fonte — 1..4 */
  concorrencia: number;
  /** 0 = termo exato, 1 = sem acento, 2 = sobrenome+primeiro nome */
  varianteNome: 0 | 1 | 2;
  usaRelay: boolean;
  versao: number;
}

export interface Metrica {
  fonteId: string;
  coletadaEm: string;
  consultas: number;
  itens: number;
  erros: number;
  captchas: number;
  timeouts: number;
  msP95: number;
  /** resultado do canário: quantos itens vieram do termo de controle */
  canarioItens: number;
  /** melhor recall já observado nesta fonte (normalizador) */
  melhorRecall?: number;
}

export interface Decisao {
  fonteId: string;
  acao: "promover" | "manter" | "rebaixar" | "quarentena" | "reabilitar";
  scoreAtual: number;
  scoreNovo: number;
  motivo: string;
  perfil: PerfilFonte;
  anteriorVersao: number;
}

export const LIMITES = {
  timeoutMin: 1_000,
  timeoutMax: 30_000,
  timeoutPasso: 250,
  paginasMin: 1,
  paginasMax: 10,
  concorrenciaMin: 1,
  concorrenciaMax: 4,
  /** ganho mínimo para promover (histerese): 3% */
  epsilon: 3,
  /** ciclos com canário zerado para declarar deriva */
  driftCiclos: 2,
} as const;

export const PERFIL_PADRAO: Omit<PerfilFonte, "fonteId"> = {
  timeoutMs: 12_000,
  paginas: 3,
  concorrencia: 2,
  varianteNome: 0,
  usaRelay: false,
  versao: 1,
};

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * Pontuação comparável entre fontes (0–140, mais é melhor).
 * aproveitamento é relativo ao melhor recall já visto → uma fonte pequena que responde
 * sempre ganha de uma grande que falha.
 */
export function pontuar(m: Metrica): number {
  const consultas = Math.max(m.consultas, 1);
  const recall = m.itens / consultas;
  const normalizador = Math.max(m.melhorRecall ?? recall, 1);
  const aproveitamento = Math.min(recall / normalizador, 1);
  const confiabilidade = 1 - Math.min((m.erros + m.timeouts) / consultas, 1);
  const penalidadeLentidao = 0.05 * (m.msP95 / 100);
  const penalidadeCaptcha = m.captchas > 0 ? 80 : 0;
  return round2(100 * aproveitamento + 40 * confiabilidade - penalidadeLentidao - penalidadeCaptcha);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Vizinhos determinísticos, na ordem em que serão avaliados. */
export function mutacoes(atual: PerfilFonte): PerfilFonte[] {
  const vizinhos: PerfilFonte[] = [];
  const push = (patch: Partial<PerfilFonte>) => {
    const p: PerfilFonte = { ...atual, ...patch, versao: atual.versao };
    p.timeoutMs = clamp(p.timeoutMs, LIMITES.timeoutMin, LIMITES.timeoutMax);
    p.paginas = clamp(p.paginas, LIMITES.paginasMin, LIMITES.paginasMax);
    p.concorrencia = clamp(p.concorrencia, LIMITES.concorrenciaMin, LIMITES.concorrenciaMax);
    if (p.timeoutMs !== atual.timeoutMs || p.paginas !== atual.paginas || p.concorrencia !== atual.concorrencia || p.varianteNome !== atual.varianteNome || p.usaRelay !== atual.usaRelay) {
      if (!vizinhos.some((v) => JSON.stringify({ ...v, versao: 0 }) === JSON.stringify({ ...p, versao: 0 }))) vizinhos.push(p);
    }
  };
  push({ timeoutMs: atual.timeoutMs + LIMITES.timeoutPasso });
  push({ timeoutMs: atual.timeoutMs - LIMITES.timeoutPasso });
  push({ paginas: atual.paginas + 1 });
  push({ paginas: atual.paginas - 1 });
  push({ concorrencia: atual.concorrencia + 1 });
  push({ concorrencia: atual.concorrencia - 1 });
  const proxVariante = ((atual.varianteNome + 1) % 3) as 0 | 1 | 2;
  push({ varianteNome: proxVariante });
  push({ usaRelay: !atual.usaRelay });
  return vizinhos;
}

/**
 * Decide o próximo perfil a partir das métricas medidas. PURA.
 * `medir(vizinho)` roda o canário com aquele perfil; pode ser assíncrono.
 */
export async function decidir(
  atual: PerfilFonte,
  metricaAtual: Metrica,
  medir: (candidato: PerfilFonte) => Promise<Metrica>,
  opts: { epsilon?: number; maxAvaliacoes?: number } = {},
): Promise<Decisao> {
  const epsilon = opts.epsilon ?? LIMITES.epsilon;
  const scoreAtual = pontuar(metricaAtual);
  const candidatos = mutacoes(atual).slice(0, opts.maxAvaliacoes ?? LIMITES.concorrenciaMax + 4);

  let melhor: { perfil: PerfilFonte; metrica: Metrica; score: number } | null = null;
  let falhasDeMedicao = 0;
  for (const cand of candidatos) {
    let m: Metrica;
    try {
      m = await medir(cand);
    } catch {
      // auto-correção: um vizinho que estoura (DNS, TLS, timeout duro) NÃO pode
      // derrubar o ciclo inteiro — vira candidato com score mínimo.
      falhasDeMedicao++;
      m = { ...metricaAtual, erros: metricaAtual.erros + 1, itens: 0, canarioItens: 0 };
    }
    const s = pontuar(m);
    if (!melhor || s > melhor.score) melhor = { perfil: cand, metrica: m, score: s };
  }

  if (!melhor) {
    return { fonteId: atual.fonteId, acao: "manter", scoreAtual, scoreNovo: scoreAtual, motivo: "sem mutações avaliáveis", perfil: atual, anteriorVersao: atual.versao };
  }

  // captcha dominante → não adianta ajustar parâmetro: rebaixa e registra
  if (melhor.metrica.captchas > 0 && metricaAtual.captchas > 0) {
    return {
      fonteId: atual.fonteId,
      acao: "rebaixar",
      scoreAtual,
      scoreNovo: melhor.score,
      motivo: "fonte exige captcha — parâmetros não resolvem; usar portal oficial",
      perfil: { ...atual, ...{ timeoutMs: Math.min(atual.timeoutMs, LIMITES.timeoutMin * 2) }, versao: atual.versao },
      anteriorVersao: atual.versao,
    };
  }

  if (falhasDeMedicao === candidatos.length) {
    return {
      fonteId: atual.fonteId, acao: "manter", scoreAtual, scoreNovo: scoreAtual,
      motivo: `todas as ${candidatos.length} medições do ciclo falharam — perfil mantido, fonte sinalizada`,
      perfil: atual, anteriorVersao: atual.versao,
    };
  }

  if (melhor.score >= scoreAtual + epsilon) {
    return {
      fonteId: atual.fonteId,
      acao: "promover",
      scoreAtual,
      scoreNovo: melhor.score,
      motivo: `ganho de ${round2(melhor.score - scoreAtual)} pts (ε=${epsilon}) com ${descrever(melhor.perfil, atual)}`,
      perfil: { ...melhor.perfil, versao: atual.versao + 1 },
      anteriorVersao: atual.versao,
    };
  }

  return {
    fonteId: atual.fonteId,
    acao: "manter",
    scoreAtual,
    scoreNovo: melhor.score,
    motivo: `melhor vizinho (${round2(melhor.score)}) não supera o atual (${round2(scoreAtual)}) + ε=${epsilon}`,
    perfil: atual,
    anteriorVersao: atual.versao,
  };
}

function descrever(novo: PerfilFonte, velho: PerfilFonte): string {
  const dif: string[] = [];
  if (novo.timeoutMs !== velho.timeoutMs) dif.push(`timeout ${velho.timeoutMs}→${novo.timeoutMs}ms`);
  if (novo.paginas !== velho.paginas) dif.push(`páginas ${velho.paginas}→${novo.paginas}`);
  if (novo.concorrencia !== velho.concorrencia) dif.push(`concorrência ${velho.concorrencia}→${novo.concorrencia}`);
  if (novo.varianteNome !== velho.varianteNome) dif.push(`varianteNome ${velho.varianteNome}→${novo.varianteNome}`);
  if (novo.usaRelay !== velho.usaRelay) dif.push(`relay ${velho.usaRelay}→${novo.usaRelay}`);
  return dif.join(", ") || "nenhuma diferença";
}

/** Histórico por fonte para detecção de deriva. */
export class DetectorDeriva {
  private historico = new Map<string, Array<{ canarioItens: number; erro: boolean }>>();

  registrar(fonteId: string, canarioItens: number, erro = false): void {
    const h = this.historico.get(fonteId) ?? [];
    h.push({ canarioItens, erro });
    while (h.length > LIMITES.driftCiclos + 2) h.shift();
    this.historico.set(fonteId, h);
  }

  /**
   * Deriva = a fonte já devolveu itens alguma vez e agora devolve 0 sem erro,
   * por `driftCiclos` ciclos seguidos. (200 com HTML novo é o sintoma clássico
   * de quebra de seletor — melhor avisar antes de o usuário notar.)
   */
  deriva(fonteId: string): boolean {
    const h = this.historico.get(fonteId) ?? [];
    if (h.length < LIMITES.driftCiclos + 1) return false;
    const jaTeveItens = h.some((x) => x.canarioItens > 0);
    const ultimos = h.slice(-LIMITES.driftCiclos);
    return jaTeveItens && ultimos.every((x) => x.canarioItens === 0 && !x.erro);
  }

  /** Fonte que nunca devolveu um único item: indisponibilidade, não deriva. */
  nuncaFuncionou(fonteId: string): boolean {
    const h = this.historico.get(fonteId) ?? [];
    return h.length >= LIMITES.driftCiclos && h.every((x) => x.canarioItens === 0);
  }

  /** Registra um lote de métricas e devolve as fontes que entraram em deriva. */
  verificar(metricas: Metrica[]): Array<{ fonteId: string; canarioItens: number }> {
    const emDeriva: Array<{ fonteId: string; canarioItens: number }> = [];
    for (const m of metricas) {
      this.registrar(m.fonteId, m.canarioItens, m.erros > 0);
      if (this.deriva(m.fonteId)) emDeriva.push({ fonteId: m.fonteId, canarioItens: m.canarioItens });
    }
    return emDeriva;
  }

  zerar(fonteId: string): void {
    this.historico.delete(fonteId);
  }
}

export interface PerfilStore {
  obter(fonteId: string): Promise<PerfilFonte | null>;
  salvar(perfil: PerfilFonte, decisao: Decisao): Promise<void>;
  historico(fonteId: string): Promise<PerfilFonte[]>;
}

export class InMemoryPerfilStore implements PerfilStore {
  private perfis = new Map<string, PerfilFonte>();
  private hist = new Map<string, PerfilFonte[]>();

  async obter(fonteId: string): Promise<PerfilFonte | null> {
    return this.perfis.get(fonteId) ?? null;
  }

  async salvar(perfil: PerfilFonte, _decisao: Decisao): Promise<void> {
    this.perfis.set(perfil.fonteId, perfil);
    const h = this.hist.get(perfil.fonteId) ?? [];
    h.push(perfil);
    this.hist.set(perfil.fonteId, h);
  }

  async historico(fonteId: string): Promise<PerfilFonte[]> {
    return [...(this.hist.get(fonteId) ?? [])];
  }

  /** Rollback explícito para uma versão anterior (mantém trilha). */
  async rollback(fonteId: string, versao: number): Promise<PerfilFonte | null> {
    const alvo = (this.hist.get(fonteId) ?? []).find((p) => p.versao === versao);
    if (!alvo) return null;
    this.perfis.set(fonteId, alvo);
    return alvo;
  }
}

/** Perfil vigente ou o padrão da casa (com versão 1). */
export async function perfilVigente(store: PerfilStore, fonteId: string): Promise<PerfilFonte> {
  return (await store.obter(fonteId)) ?? { fonteId, ...PERFIL_PADRAO };
}
