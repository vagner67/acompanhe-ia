/**
 * AnotA — domínio puro (sem rede, sem banco, sem relógio implícito).
 *
 * Tudo aqui é função determinística: entra dado, sai número. É o que permite
 * testar dinheiro sem mock e sem "quase certo" — se a soma das parcelas não
 * fechar o total, o teste falha.
 */
import {
  type CartaoDto,
  type ContaDto,
  type LancamentoDto,
  type OrcamentoDto,
  ehDataValida,
  ehYmValido,
  ymDe,
} from "./tipos.js";

const porDataAsc = (a: LancamentoDto, b: LancamentoDto) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0);

/** Saldo de UMA conta: saldo inicial + receitas pagas − despesas pagas. */
export function saldoConta(conta: ContaDto, lancamentos: readonly LancamentoDto[]): number {
  let saldo = conta.saldoInicialCents;
  for (const l of lancamentos) {
    if (l.contaId !== conta.id) continue;
    if (l.status !== "pago") continue; // pendente ainda não mexeu no bolso
    saldo += l.tipo === "receita" ? l.amountCents : -l.amountCents;
  }
  return saldo;
}

/** Saldo de todas as contas não arquivadas (a "carteira" do usuário). */
export function saldoConsolidado(contas: readonly ContaDto[], lancamentos: readonly LancamentoDto[]): number {
  return contas.filter((c) => !c.arquivada).reduce((s, c) => s + saldoConta(c, lancamentos), 0);
}

export interface ResumoCategoria {
  categoria: string;
  tipo: "despesa" | "receita";
  totalCents: number;
  count: number;
}

export interface ResumoMes {
  ym: string;
  receitasCents: number;
  despesasCents: number;
  /** receitas − despesas (só o que está pago) */
  saldoCents: number;
  /** despesas pendentes do mês (ainda não pagas) */
  apagarCents: number;
  porCategoria: ResumoCategoria[];
}

export function resumoMes(lancamentos: readonly LancamentoDto[], ym: string): ResumoMes {
  if (!ehYmValido(ym)) throw new Error(`mês inválido: ${ym} (use YYYY-MM)`);
  const doMes = lancamentos.filter((l) => ymDe(l.data) === ym);
  const cats = new Map<string, ResumoCategoria>();
  let receitas = 0;
  let despesas = 0;
  let apagar = 0;
  for (const l of doMes) {
    if (l.status === "pago") {
      if (l.tipo === "receita") receitas += l.amountCents;
      else despesas += l.amountCents;
    } else if (l.tipo === "despesa") {
      apagar += l.amountCents;
    }
    const chave = `${l.tipo}:${l.category}`;
    const c = cats.get(chave) ?? { categoria: l.category, tipo: l.tipo, totalCents: 0, count: 0 };
    c.totalCents += l.amountCents;
    c.count += 1;
    cats.set(chave, c);
  }
  return {
    ym,
    receitasCents: receitas,
    despesasCents: despesas,
    saldoCents: receitas - despesas,
    apagarCents: apagar,
    porCategoria: [...cats.values()].sort((a, b) => b.totalCents - a.totalCents),
  };
}

export interface OrcamentoStatus {
  categoriaId: string;
  categoria: string;
  limiteCents: number;
  gastoCents: number;
  restanteCents: number;
  /** 0–100+ (percentual consumido) */
  pct: number;
  estado: "ok" | "atencao" | "estourou";
}

/**
 * Orçamento × realizado. `atencao` a partir de 80% e `estourou` acima de 100% —
 * limites explícitos, não "sensação": é o que a tela pinta.
 */
export function orcamentoVsRealizado(
  orcamentos: readonly OrcamentoDto[],
  lancamentos: readonly LancamentoDto[],
  ym: string,
): OrcamentoStatus[] {
  if (!ehYmValido(ym)) throw new Error(`mês inválido: ${ym} (use YYYY-MM)`);
  return orcamentos
    .filter((o) => o.ym === ym)
    .map((o) => {
      const gastoCents = lancamentos
        .filter((l) => l.tipo === "despesa" && l.categoriaId === o.categoriaId && ymDe(l.data) === ym)
        .reduce((s, l) => s + l.amountCents, 0);
      const restante = o.limiteCents - gastoCents;
      const pct = o.limiteCents === 0 ? (gastoCents > 0 ? 100 : 0) : Math.round((gastoCents / o.limiteCents) * 1000) / 10;
      const estado: OrcamentoStatus["estado"] = gastoCents > o.limiteCents ? "estourou" : pct >= 80 ? "atencao" : "ok";
      const categoria = lancamentos.find((l) => l.categoriaId === o.categoriaId)?.category ?? o.categoriaId;
      return { categoriaId: o.categoriaId, categoria, limiteCents: o.limiteCents, gastoCents, restanteCents: restante, pct, estado };
    })
    .sort((a, b) => b.pct - a.pct);
}

/** Data `YYYY-MM-DD` do dia `dia` dentro do mês `ym` (dia já normalizado 1–28). */
function dataNoMes(ym: string, dia: number): string {
  return `${ym}-${String(Math.min(Math.max(dia, 1), 28)).padStart(2, "0")}`;
}

function ymSeguinte(ym: string): string {
  const [a, m] = ym.split("-").map(Number);
  const ano = m === 12 ? a! + 1 : a!;
  const mes = m === 12 ? 1 : m! + 1;
  return `${ano}-${String(mes).padStart(2, "0")}`;
}

export interface FaturaCartao {
  cartaoId: string;
  nome: string;
  /** mês de referência da fatura (mês do fechamento) */
  ym: string;
  fechaEm: string;
  venceEm: string;
  totalCents: number;
  itens: number;
  limiteCents: number;
  /** limite disponível depois desta fatura */
  disponivelCents: number;
  pagoCents: number;
  abertoCents: number;
}

/**
 * Fatura do cartão para o ciclo que fecha no mês `ym`: entram as despesas da
 * conta do cartão com data do dia 1 até o dia de fechamento. O vencimento é o
 * dia configurado **no mês seguinte** quando ele vem antes do fechamento
 * (cartão que fecha dia 25 e vence dia 5 vence no mês seguinte).
 */
export function faturaCartao(cartao: CartaoDto, lancamentos: readonly LancamentoDto[], ym: string): FaturaCartao {
  if (!ehYmValido(ym)) throw new Error(`mês inválido: ${ym} (use YYYY-MM)`);
  const fechaEm = dataNoMes(ym, cartao.fechamentoDia);
  const venceYm = cartao.vencimentoDia <= cartao.fechamentoDia ? ymSeguinte(ym) : ym;
  const venceEm = dataNoMes(venceYm, cartao.vencimentoDia);
  const itens = lancamentos.filter(
    (l) => l.tipo === "despesa" && l.contaId === cartao.contaId && l.data >= dataNoMes(ym, 1) && l.data <= fechaEm,
  );
  const totalCents = itens.reduce((s, l) => s + l.amountCents, 0);
  const pagoCents = itens.filter((l) => l.status === "pago").reduce((s, l) => s + l.amountCents, 0);
  const abertoCents = totalCents - pagoCents;
  return {
    cartaoId: cartao.id,
    nome: cartao.nome,
    ym,
    fechaEm,
    venceEm,
    totalCents,
    itens: itens.length,
    limiteCents: cartao.limiteCents,
    disponivelCents: cartao.limiteCents - abertoCents,
    pagoCents,
    abertoCents,
  };
}

export interface ParcelaGerada {
  num: number;
  total: number;
  vencimento: string;
  amountCents: number;
}

/**
 * Divide um valor em N parcelas sem perder centavo: `Math.floor` em todas e a
 * sobra vai para a ÚLTIMA parcela. A soma é sempre exatamente `totalCents`.
 */
export function parcelar(totalCents: number, parcelas: number, primeiroVencimento: string): ParcelaGerada[] {
  if (!Number.isInteger(totalCents) || totalCents <= 0) throw new Error("total deve ser inteiro positivo em centavos");
  if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > 48) throw new Error("parcelas deve ser 1..48");
  if (!ehDataValida(primeiroVencimento)) throw new Error(`data inválida: ${primeiroVencimento}`);
  const base = Math.floor(totalCents / parcelas);
  const sobra = totalCents - base * parcelas;
  const [ano, mes, dia] = primeiroVencimento.split("-").map(Number);
  const out: ParcelaGerada[] = [];
  for (let i = 0; i < parcelas; i++) {
    const zeroBased = mes! - 1 + i;
    const y = ano! + Math.floor(zeroBased / 12);
    const m = (zeroBased % 12) + 1;
    const ultimoDiaDoMes = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = Math.min(dia!, ultimoDiaDoMes); // 31/01 → 28/02 não estoura o mês
    const amountCents = i === parcelas - 1 ? base + sobra : base;
    out.push({
      num: i + 1,
      total: parcelas,
      vencimento: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      amountCents,
    });
  }
  return out;
}

export interface OcorrenciaRecorrente {
  competencia: string;
  amountCents: number;
}

/**
 * Ocorrências de um lançamento fixo (mensal) do mês de origem até `ateYm`,
 * inclusive. Serve para projetar contas fixas do ano sem cadastrar 12 linhas.
 */
export function ocorrenciasRecorrentes(
  origem: { data: string; amountCents: number },
  ateYm: string,
  max = 60,
): OcorrenciaRecorrente[] {
  if (!ehYmValido(ateYm)) throw new Error(`mês inválido: ${ateYm} (use YYYY-MM)`);
  if (!ehDataValida(origem.data)) throw new Error(`data inválida: ${origem.data}`);
  const dia = Number(origem.data.slice(8, 10));
  const out: OcorrenciaRecorrente[] = [];
  let ym = ymDe(origem.data);
  while (ym <= ateYm && out.length < max) {
    out.push({ competencia: dataNoMes(ym, dia), amountCents: origem.amountCents });
    ym = ymSeguinte(ym);
  }
  return out;
}

export interface LinhaRelatorio {
  ym: string;
  receitasCents: number;
  despesasCents: number;
  saldoCents: number;
  /** variação percentual das despesas contra o mês anterior (null no primeiro) */
  variacaoDespesaPct: number | null;
}

/** Relatório mês a mês, do mais antigo para o mais recente. */
export function relatorioMensal(lancamentos: readonly LancamentoDto[], meses: readonly string[]): LinhaRelatorio[] {
  const ordenados = [...meses].filter(ehYmValido).sort();
  return ordenados.map((ym, i) => {
    const r = resumoMes(lancamentos, ym);
    const anterior = i > 0 ? resumoMes(lancamentos, ordenados[i - 1]!) : null;
    const variacao =
      anterior && anterior.despesasCents > 0
        ? Math.round(((r.despesasCents - anterior.despesasCents) / anterior.despesasCents) * 1000) / 10
        : null;
    return { ym, receitasCents: r.receitasCents, despesasCents: r.despesasCents, saldoCents: r.saldoCents, variacaoDespesaPct: variacao };
  });
}

/** Últimos N meses terminando em `ym` (inclusive), em ordem cronológica. */
export function ultimosMeses(ym: string, n: number): string[] {
  if (!ehYmValido(ym)) throw new Error(`mês inválido: ${ym} (use YYYY-MM)`);
  const [a, m] = ym.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const zero = m! - 1 - i;
    const y = a! + Math.floor(zero / 12);
    const mm = ((zero % 12) + 12) % 12 + 1;
    out.push(`${y}-${String(mm).padStart(2, "0")}`);
  }
  return out;
}

// ───────────────────────────── CSV ─────────────────────────────

const escCsv = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** Exporta lançamentos em CSV (separador vírgula, UTF-8, cabeçalho em português). */
export function exportarCsv(lancamentos: readonly LancamentoDto[]): string {
  const cab = "tipo,data,vencimento,status,descricao,categoria,valor_reais,valor_cents,conta_id,fit_id";
  const linhas = [...lancamentos].sort(porDataAsc).map((l) =>
    [
      l.tipo,
      l.data,
      l.vencimento ?? "",
      l.status,
      escCsv(l.description),
      escCsv(l.category),
      (l.amountCents / 100).toFixed(2),
      String(l.amountCents),
      l.contaId ?? "",
      l.fitId ?? "",
    ].join(","),
  );
  return [cab, ...linhas].join("\n") + "\n";
}

export interface LinhaImportada {
  linha: number;
  tipo: "despesa" | "receita";
  data: string;
  description: string;
  category: string;
  amountCents: number;
  /**
   * Identificador da linha no extrato, quando o arquivo traz (colunas
   * fitid/fit_id/id/documento). Sem ele, quem importa precisa de uma chave
   * natural — senão reimportar o mesmo CSV duplica tudo.
   */
  fitId: string | null;
}

export interface Importacao {
  linhas: LinhaImportada[];
  erros: Array<{ linha: number; motivo: string }>;
}

/**
 * Converte valor em texto para centavos aceitando os dois formatos que aparecem
 * em extrato brasileiro: `1.234,56` (pt-BR) e `1234.56` (internacional).
 * Sinal negativo = saída.
 */
export function valorParaCents(texto: string): number | null {
  const limpo = texto.replace(/[R$\s]/g, "").replace(/\u00a0/g, "");
  if (!limpo) return null;
  const temVirgula = limpo.includes(",");
  const normalizado = temVirgula ? limpo.replace(/\./g, "").replace(",", ".") : limpo;
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalizado)) return null;
  return Math.round(Number(normalizado) * 100);
}

/** `31/12/2026` ou `2026-12-31` → `2026-12-31`. */
export function dataParaIso(texto: string): string | null {
  const t = texto.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (br) {
    const iso = `${br[3]}-${br[2]}-${br[1]}`;
    return ehDataValida(iso) ? iso : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return ehDataValida(t) ? t : null;
  return null;
}

/**
 * Importa CSV de extrato/lançamento. Aceita `,` ou `;` e cabeçalho com nomes
 * reconhecíveis (`data/date`, `descricao/description/memo`, `valor/amount`,
 * `categoria/category`, `tipo/type`). Sem cabeçalho assume a ordem
 * data,descrição,valor[,categoria]. Linha inválida **não** é inventada: vai
 * para `erros` com o número da linha.
 */
export function importarCsv(texto: string): Importacao {
  const bruto = texto.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const out: Importacao = { linhas: [], erros: [] };
  if (bruto.length === 0) return out;
  const sep = (bruto[0]!.match(/;/g)?.length ?? 0) > (bruto[0]!.match(/,/g)?.length ?? 0) ? ";" : ",";

  const dividir = (linha: string): string[] => {
    const campos: string[] = [];
    let atual = "";
    let dentro = false;
    for (let i = 0; i < linha.length; i++) {
      const ch = linha[i]!;
      if (ch === '"') {
        if (dentro && linha[i + 1] === '"') {
          atual += '"';
          i++;
        } else dentro = !dentro;
      } else if (ch === sep && !dentro) {
        campos.push(atual);
        atual = "";
      } else atual += ch;
    }
    campos.push(atual);
    return campos.map((c) => c.trim());
  };

  const cabecalho = dividir(bruto[0]!).map((c) => c.toLowerCase());
  const idx = {
    data: cabecalho.findIndex((c) => ["data", "date", "dtposted", "competencia"].includes(c)),
    desc: cabecalho.findIndex((c) => ["descricao", "descrição", "description", "memo", "historico", "histórico", "name"].includes(c)),
    valor: cabecalho.findIndex((c) => ["valor", "amount", "trnamt", "valor_reais"].includes(c)),
    cat: cabecalho.findIndex((c) => ["categoria", "category"].includes(c)),
    tipo: cabecalho.findIndex((c) => ["tipo", "type"].includes(c)),
    fitid: cabecalho.findIndex((c) => ["fitid", "fit_id", "id", "documento", "identificador"].includes(c)),
  };
  const temCabecalho = idx.data >= 0 && idx.valor >= 0;

  const inicio = temCabecalho ? 1 : 0;
  for (let i = inicio; i < bruto.length; i++) {
    const numLinha = i + 1;
    const campos = dividir(bruto[i]!);
    const dataTxt = temCabecalho ? campos[idx.data!] : campos[0];
    const descTxt = temCabecalho ? (idx.desc >= 0 ? campos[idx.desc] : "") : campos[1];
    const valorTxt = temCabecalho ? campos[idx.valor!] : campos[2];
    const catTxt = temCabecalho && idx.cat >= 0 ? campos[idx.cat] : "";
    const tipoTxt = temCabecalho && idx.tipo >= 0 ? campos[idx.tipo]?.toLowerCase() : "";
    const fitIdTxt = temCabecalho && idx.fitid >= 0 ? (campos[idx.fitid] ?? "") : "";

    if (!dataTxt || !valorTxt) {
      out.erros.push({ linha: numLinha, motivo: "sem data ou sem valor" });
      continue;
    }
    const data = dataParaIso(dataTxt);
    if (!data) {
      out.erros.push({ linha: numLinha, motivo: `data inválida: "${dataTxt}"` });
      continue;
    }
    const cents = valorParaCents(valorTxt);
    if (cents === null || cents === 0) {
      out.erros.push({ linha: numLinha, motivo: `valor inválido: "${valorTxt}"` });
      continue;
    }
    const tipo: "despesa" | "receita" =
      tipoTxt === "receita" || tipoTxt === "credit" || tipoTxt === "credito" || tipoTxt === "crédito"
        ? "receita"
        : tipoTxt === "despesa" || tipoTxt === "debit" || tipoTxt === "débito" || tipoTxt === "debito"
          ? "despesa"
          : cents > 0
            ? "receita"
            : "despesa";
    out.linhas.push({
      linha: numLinha,
      tipo,
      data,
      description: (descTxt || "lançamento importado").slice(0, 300),
      category: (catTxt || "outros").slice(0, 40),
      amountCents: Math.abs(cents),
      fitId: fitIdTxt ? fitIdTxt.slice(0, 120) : null,
    });
  }
  return out;
}

// ───────────────────────────── OFX ─────────────────────────────

export interface TransacaoOfx {
  fitId: string;
  data: string;
  /** valor com sinal: negativo = saída (como vem no arquivo) */
  valorCents: number;
  descricao: string;
  trnType: string | null;
}

export interface OfxLido {
  transacoes: TransacaoOfx[];
  /** repetidas dentro do próprio arquivo (FITID é a chave) */
  duplicadasNoArquivo: number;
  formato: "sgml" | "xml";
}

/**
 * Lê OFX 1.x (SGML, tags internas sem fechamento) e 2.x (XML). O que importa:
 * `<STMTTRN>` por transação, `<DTPOSTED>` `YYYYMMDD`, `<TRNAMT>` com sinal e
 * ponto decimal, `<FITID>` como chave de deduplicação e `<NAME>`/`<MEMO>` como
 * descrição. Tag ausente não vira dado inventado: a transação é descartada.
 */
export function parseOfx(texto: string): OfxLido {
  // OFX 2.x começa com declaração XML/PI (`<?xml`, `<?OFX`) e fecha tudo; 1.x é
  // SGML: os containers fecham (`</STMTTRN>`) mas os VALORES não (`<TRNAMT>-1.00`).
  const formato: OfxLido["formato"] = /<\?xml/i.test(texto) || /<\?OFX/i.test(texto) ? "xml" : "sgml";
  const blocos = [...texto.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi)].map((m) => m[1] ?? "");
  const vistos = new Set<string>();
  let duplicadas = 0;
  const transacoes: TransacaoOfx[] = [];
  for (const bloco of blocos) {
    const pegar = (tag: string): string | null => {
      const m = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, "i").exec(bloco);
      return m ? m[1]!.trim() : null;
    };
    const fitId = pegar("FITID");
    const dt = pegar("DTPOSTED");
    const valor = pegar("TRNAMT");
    if (!fitId || !dt || !valor) continue; // sem chave/data/valor não há transação honesta
    const iso = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
    if (!ehDataValida(iso)) continue;
    const cents = valorParaCents(valor);
    if (cents === null) continue;
    if (vistos.has(fitId)) {
      duplicadas++;
      continue;
    }
    vistos.add(fitId);
    const nome = pegar("NAME");
    const memo = pegar("MEMO");
    transacoes.push({
      fitId,
      data: iso,
      valorCents: cents,
      descricao: (nome ?? memo ?? "lançamento OFX").slice(0, 300),
      trnType: pegar("TRNTYPE"),
    });
  }
  return { transacoes, duplicadasNoArquivo: duplicadas, formato };
}
