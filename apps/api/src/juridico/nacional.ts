/**
 * Busca NACIONAL orquestrada — plano-91-tribunais-nacional.md §4.2.
 *
 * Junta, numa resposta só, tudo o que é realmente alcançável:
 *   • índice próprio (Postgres) — sempre;
 *   • e-SAJ por UF medida — sem captcha;
 *   • DJEN/Comunica (nacional por nome) — se houver egress brasileiro.
 *
 * Regras que não se negociam:
 *   - nenhuma fonte pode derrubar a resposta (timeout + circuit breaker por fonte);
 *   - toda fonte devolve seu ESTADO REAL (ok/vazio/bloqueado/captcha/deriva) com ms;
 *   - dedupe por 20 dígitos e ranking por força do vínculo;
 *   - zero invenção: se nada respondeu, `itens: []` + motivos explícitos.
 */
const soDigitos = (s: string) => s.replace(/\D+/g, "");
import type { PerfilFonte } from "./autoaperfeicoamento.js";
import { consultarEsaj, type ResultadoEsaj } from "./esaj.js";
import { agruparDjenPorProcesso, buscarDjen, janelaPadrao, type DjenOpts, type EstadoDjen } from "./djen.js";
import { UFS_ESAJ_ABERTAS, djenHabilitado, RODAPE_FROTA, type ResumoFrota, resumoFrota } from "./frota.js";
import { detectarConsulta } from "./deteccao.js";

export type EstadoFonteNacional =
  | "ok"
  | "vazio"
  | "refinar" // fonte respondeu "muitos processos, refine a busca" (e-SAJ SP com nome curto)
  | "bloqueado"
  | "captcha"
  | "geo_bloqueado"
  | "timeout"
  | "erro"
  | "pulado"
  | "deriva";

export interface FonteRelatorio {
  fonte: string;
  tipo: "indice" | "esaj" | "djen";
  estado: EstadoFonteNacional;
  itens: number;
  ms: number;
  motivo?: string;
  /** versão do perfil de coleta que foi REALMENTE usada nesta consulta */
  perfilVersao?: number;
}

export interface ItemNacional {
  numeroProcesso: string;
  tribunal: string | null;
  uf: string | null;
  partes: Array<{ nome: string; polo: "A" | "P" | null; encontrada: boolean }>;
  classe: string | null;
  orgao: string | null;
  ultimoMovimento: string | null;
  dataMovimento: string | null;
  dataPublicacao: string | null;
  link: string | null;
  fontes: string[];
  /** 0–1, força do vínculo entre o termo buscado e este processo */
  score: number;
  motivoVinculo: string;
}

export interface ResultadoNacional {
  tipo: "nome" | "cpf" | "cnpj" | "cnj";
  termo: string;
  itens: ItemNacional[];
  fontes: FonteRelatorio[];
  aviso: string | null;
  rodape: string;
  cobertura: ResumoFrota;
  msTotal: number;
}

export interface ConsultarNacionalOpts {
  uf?: string;
  limite?: number;
  /** injetáveis para teste */
  esaj?: (uf: string, tipo: "NMPARTE" | "DOCPARTE", valor: string, pagina: number) => Promise<ResultadoEsaj>;
  djen?: (busca: { nomeParte?: string; numeroProcesso?: string }, opts: DjenOpts) => ReturnType<typeof buscarDjen>;
  djenOpts?: DjenOpts;
  ufs?: string[];
  /** consulta ao índice próprio (já pronta) — injetada pela rota */
  indice?: (termo: string) => Promise<ItemNacional[]>;
  timeoutMs?: number;
  agora?: Date;
  /**
   * Perfis de coleta vigentes (saída do auto-aperfeiçoamento). Aqui eles são
   * APLICADOS: timeout, concorrência, variante de nome e uso de relay.
   * Sem perfil, vale o padrão da casa — nunca quebra a busca.
   */
  perfis?: Record<string, PerfilFonte | undefined>;
}

const PESOS: Record<string, number> = {
  documento_informado: 1,
  numero_informado: 1,
  nome_exato: 0.8,
  nome_parcial: 0.5,
};

/** Variante do termo de nome escolhida pelo auto-aperfeiçoamento (0 exato, 1 sem acento, 2 sobrenome+primeiro). */
export function variarNome(termo: string, variante: 0 | 1 | 2): string {
  if (variante === 0) return termo;
  if (variante === 1) return termo.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const partes = termo.trim().split(/\s+/).filter(Boolean);
  if (partes.length < 2) return termo;
  return `${partes[partes.length - 1]} ${partes[0]}`;
}

/** Pool simples para respeitar a concorrência do perfil sem travar a resposta. */
async function comConcorrencia<T, R>(itens: T[], limite: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const n = Math.max(1, Math.min(limite, itens.length || 1));
  const out: R[] = new Array(itens.length);
  let proximo = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = proximo++;
        if (i >= itens.length) return;
        out[i] = await fn(itens[i]!);
      }
    }),
  );
  return out;
}

const normalizar = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export function classificarVinculo(termo: string, tipo: "nome" | "cpf" | "cnpj" | "cnj", partes: Array<{ nome: string }>): { score: number; motivo: string } {
  if (tipo === "cnj") return { score: 1, motivo: "número do processo informado" };
  if (tipo === "cpf" || tipo === "cnpj") return { score: PESOS["documento_informado"]!, motivo: "documento localizado na fonte" };
  const alvo = normalizar(termo);
  const nomes = partes.map((p) => normalizar(p.nome));
  if (nomes.some((n) => n === alvo)) return { score: PESOS["nome_exato"]!, motivo: "nome completo idêntico" };
  const tokens = alvo.split(" ").filter((t) => t.length > 2);
  const todos = tokens.length > 0 && nomes.some((n) => tokens.every((t) => n.includes(t)));
  if (todos) return { score: PESOS["nome_parcial"]!, motivo: "todos os termos do nome aparecem na parte" };
  // Nenhum token do nome aparece na parte: NÃO é correspondência parcial.
  // Devolver score > 0 aqui faria o processo errado subir na lista (alucinação).
  return { score: 0, motivo: "nenhum vínculo identificado com o termo buscado" };
}

/** Roda com prazo e converte qualquer exceção em estado — nunca propaga erro de fonte. */
async function comPrazo<T>(p: Promise<T>, ms: number): Promise<{ ok: true; valor: T } | { ok: false; motivo: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const valor = await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timeout após ${ms} ms`)), ms);
      }),
    ]);
    return { ok: true, valor };
  } catch (e) {
    return { ok: false, motivo: (e as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function consultarNacional(termo: string, opts: ConsultarNacionalOpts = {}): Promise<ResultadoNacional> {
  const t0 = Date.now();
  const det = detectarConsulta(termo);
  const tipo = det.tipo === "nome" ? "nome" : det.tipo; // cnj | cpf | cnpj | nome
  const limite = Math.min(Math.max(opts.limite ?? 40, 1), 200);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const fontes: FonteRelatorio[] = [];
  const itens = new Map<string, ItemNacional>();

  const guardar = (it: ItemNacional) => {
    const chave = soDigitos(it.numeroProcesso) || it.numeroProcesso;
    const atual = itens.get(chave);
    if (!atual) {
      itens.set(chave, it);
      return;
    }
    // funde: mantém maior score, une partes e fontes, completa campos vazios
    if (it.score > atual.score) {
      atual.score = it.score;
      atual.motivoVinculo = it.motivoVinculo;
    }
    atual.fontes = [...new Set([...atual.fontes, ...it.fontes])];
    atual.classe = atual.classe ?? it.classe;
    atual.orgao = atual.orgao ?? it.orgao;
    atual.ultimoMovimento = atual.ultimoMovimento ?? it.ultimoMovimento;
    atual.dataMovimento = atual.dataMovimento ?? it.dataMovimento;
    atual.dataPublicacao = atual.dataPublicacao ?? it.dataPublicacao;
    atual.link = atual.link ?? it.link;
    for (const p of it.partes) if (!atual.partes.some((x) => x.nome === p.nome)) atual.partes.push(p);
  };

  // ── 1) índice próprio (injetado pela rota; nunca falha a resposta) ──
  if (opts.indice) {
    const r = await comPrazo(opts.indice(termo), Math.min(timeoutMs, 8000));
    if (r.ok) {
      for (const it of r.valor) guardar(it);
      fontes.push({ fonte: "indice", tipo: "indice", estado: r.valor.length ? "ok" : "vazio", itens: r.valor.length, ms: Date.now() - t0 });
    } else {
      fontes.push({ fonte: "indice", tipo: "indice", estado: "erro", itens: 0, ms: Date.now() - t0, motivo: r.motivo });
    }
  }

  // ── 2) fontes por nome/documento ──
  if (tipo !== "cnj") {
    const ufs = (opts.uf && opts.uf !== "todas" ? [opts.uf] : (opts.ufs ?? UFS_ESAJ_ABERTAS)).map((u) => u.toLowerCase());
    const campo = tipo === "nome" ? "NMPARTE" : "DOCPARTE";
    const buscarEsaj = opts.esaj ?? ((uf, t, v, p) => consultarEsaj(uf, t, v, p));

    // ── perfil aplicado ────────────────────────────────────────────────
    const perfisEsaj = ufs.map((uf) => opts.perfis?.[`esaj-${uf}`]);
    const perfil0 = perfisEsaj.find(Boolean);
    const valorConsulta = tipo === "nome" ? variarNome(termo, perfil0?.varianteNome ?? 0) : termo;
    const concorrencia = Math.max(1, Math.min(perfil0?.concorrencia ?? 4, 4));
    const timeoutEsaj = perfil0?.timeoutMs ?? timeoutMs;

    const resultados = await comConcorrencia(ufs, concorrencia, async (uf) => {
        const inicio = Date.now();
        // e-SAJ devolve erro intermitente sob concorrência (medido 25/10: mesma UF
        // alterna vazio/erro em requisições seguidas). Erro transitório merece
        // segunda tentativa com backoff; bloqueio/vazio NÃO se repetem.
        let r = await comPrazo(buscarEsaj(uf, campo, valorConsulta, 1), timeoutEsaj);
        let tentativas = 1;
        const MAX_TENTATIVAS = 3;
        while (r.ok && r.valor.estado === "erro" && tentativas < MAX_TENTATIVAS) {
          await new Promise((res) => setTimeout(res, 300 * 3 ** (tentativas - 1))); // 300ms, 900ms
          tentativas++;
          r = await comPrazo(buscarEsaj(uf, campo, valorConsulta, 1), timeoutEsaj);
        }
        if (!r.ok) {
          const v = opts.perfis?.[`esaj-${uf}`]?.versao;
          return {
            uf, fonte: `esaj-${uf}`, estado: "timeout" as EstadoFonteNacional, itens: 0,
            ms: Date.now() - inicio, motivo: r.motivo, ...(v ? { perfilVersao: v } : {}),
          };
        }
        const res = r.valor;
        // "multiplos" SEM itens não é sucesso: o e-SAJ respondeu "foram encontrados
        // muitos processos, refine sua busca" (medido em SP com nome curto).
        // Declarar isso evita que o usuário leia a tela como "não existe processo".
        const estado: EstadoFonteNacional =
          res.estado === "multiplos" && res.itens.length === 0
            ? "refinar"
            : res.estado === "resultados" || res.estado === "multiplos"
              ? "ok"
            : res.estado === "bloqueado"
              ? "bloqueado"
              : res.estado === "vazio"
                ? "vazio"
                : "erro";
        const motivo =
          res.estado === "erro"
            ? `portal respondeu com erro após ${tentativas} tentativa(s)`
            : estado === "refinar"
              ? "muitos processos com esse termo — refine (nome completo, CPF ou nº)"
              : undefined;
        const versao = opts.perfis?.[`esaj-${uf}`]?.versao;
        return {
          uf,
          fonte: `esaj-${uf}`,
          estado,
          itens: res.itens.length,
          ms: Date.now() - inicio,
          res,
          ...(motivo ? { motivo } : {}),
          ...(versao ? { perfilVersao: versao } : {}),
        };
      });

    for (const r of resultados) {
      if ("res" in r && r.res) {
        for (const it of r.res.itens) {
          const partes = it.nomeParte ? [{ nome: it.nomeParte, polo: null, encontrada: true }] : [];
          const v = classificarVinculo(termo, tipo, partes);
          guardar({
            numeroProcesso: it.numeroProcesso,
            tribunal: `esaj-${it.uf}`,
            uf: it.uf,
            partes,
            classe: it.classe,
            orgao: it.foro,
            ultimoMovimento: null,
            dataMovimento: null,
            dataPublicacao: it.dataDistribuicao,
            link: it.url,
            fontes: [it.fonte],
            score: v.score,
            motivoVinculo: v.motivo,
          });
        }
      }
      fontes.push({
        fonte: r.fonte,
        tipo: "esaj",
        estado: r.estado,
        itens: r.itens,
        ms: r.ms,
        ...(r.motivo ? { motivo: r.motivo } : {}),
        ...(r.perfilVersao ? { perfilVersao: r.perfilVersao } : {}),
      });
    }

    // ── 3) DJEN: única fonte nacional por nome ──
    const chamarDjen = opts.djen ?? ((busca, o) => buscarDjen(busca, o));
    const habilitado = djenHabilitado() || Boolean(opts.djen);
    if (!habilitado) {
      fontes.push({
        fonte: "djen",
        tipo: "djen",
        estado: "pulado",
        itens: 0,
        ms: 0,
        motivo: "sem egress brasileiro (DJEN_RELAY_URL não configurado) — medido: 403 fora do Brasil",
      });
    } else {
      const inicio = Date.now();
      const janela = janelaPadrao(opts.agora ?? new Date(), 60);
      const r = await comPrazo(
        chamarDjen(
          tipo === "nome" ? { nomeParte: termo, ...janela } : { numeroProcesso: termo, ...janela },
          {
            ...(opts.djenOpts ?? {}),
            ...(opts.perfis?.["djen"]?.timeoutMs ? { timeoutMs: opts.perfis["djen"]!.timeoutMs } : {}),
            // perfil pode desligar o relay (ex.: relay pior que o acesso direto)
            ...(opts.perfis?.["djen"] && opts.perfis["djen"]!.usaRelay === false ? { relay: null } : {}),
          },
        ),
        timeoutMs,
      );
      if (!r.ok) {
        fontes.push({ fonte: "djen", tipo: "djen", estado: "timeout", itens: 0, ms: Date.now() - inicio, motivo: r.motivo });
      } else {
        const res = r.valor;
        const estado: EstadoFonteNacional =
          res.estado === "ok" ? "ok" : res.estado === "sem_resultados" ? "vazio" : res.estado === "geo_bloqueado" ? "geo_bloqueado" : res.estado === "rate_limit" ? "bloqueado" : "erro";
        for (const proc of agruparDjenPorProcesso(res.itens)) {
          const partes = proc.partes.map((p) => ({ nome: p.nome, polo: p.polo, encontrada: true }));
          const v = classificarVinculo(termo, tipo, partes);
          guardar({
            numeroProcesso: proc.numeroProcesso,
            tribunal: proc.tribunal,
            uf: null,
            partes,
            classe: proc.classe,
            orgao: proc.orgao,
            ultimoMovimento: null,
            dataMovimento: null,
            dataPublicacao: proc.ultimaPublicacao,
            link: proc.link,
            fontes: ["djen"],
            score: v.score,
            motivoVinculo: v.motivo,
          });
        }
        const versaoDjen = opts.perfis?.["djen"]?.versao;
        fontes.push({
          fonte: "djen",
          tipo: "djen",
          estado,
          itens: res.itens.length,
          ms: Date.now() - inicio,
          ...(res.motivo ? { motivo: res.motivo } : {}),
          ...(versaoDjen ? { perfilVersao: versaoDjen } : {}),
        });
      }
    }
  }

  const lista = [...itens.values()].sort((a, b) => b.score - a.score || (a.numeroProcesso < b.numeroProcesso ? 1 : -1)).slice(0, limite);

  // aviso honesto quando nada veio e alguma fonte está bloqueada
  const bloqueadas = fontes.filter((f) => f.estado === "geo_bloqueado" || f.estado === "bloqueado" || f.estado === "captcha");
  const rotulo = (fonte: string) => (fonte.startsWith("esaj-") ? `e-SAJ ${fonte.slice(5).toUpperCase()}` : fonte.toUpperCase());
  const paraRefinar = fontes.filter((f) => f.estado === "refinar").map((f) => rotulo(f.fonte));
  const aviso =
    lista.length > 0
      ? bloqueadas.length
        ? `Resultados parciais: ${bloqueadas.map((b) => `${b.fonte} (${b.estado})`).join(", ")} não responderam. Nos demais tribunais, consulte o portal oficial.`
        : null
      : bloqueadas.length
        ? `Nenhuma fonte de nome respondeu: ${bloqueadas.map((b) => `${b.fonte} (${b.motivo ?? b.estado})`).join("; ")}.`
        : paraRefinar.length
          ? `Nenhum processo veio, mas ${paraRefinar.join(", ")} ${paraRefinar.length > 1 ? "responderam" : "respondeu"} "muitos processos" — refine a busca (nome completo, CPF ou nº do processo).`
          : "Nenhum processo público encontrado nas fontes consultadas.";

  return {
    tipo,
    termo,
    itens: lista,
    fontes,
    aviso,
    rodape: RODAPE_FROTA,
    cobertura: resumoFrota(),
    msTotal: Date.now() - t0,
  };
}

export type { EstadoDjen };
