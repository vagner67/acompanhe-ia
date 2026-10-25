/**
 * Aba Lançamentos — onde o dinheiro entra e sai.
 * Um formulário curto, a lista do mês com edição inline (marcar pago/pendente,
 * mudar valor) e importação de extrato CSV/OFX.
 */
import { useEffect, useMemo, useState } from "react";

import type { AnotaCategoria, AnotaConta, AnotaLancamento } from "../api2";
import { centsParaTexto, dataBR, fmt, hoje, textoParaCents, ymAtual } from "./ui";

interface Props {
  a: {
    anotaLancamentos: (f: { ym?: string; tipo?: "despesa" | "receita"; q?: string }) => Promise<{ lancamentos: AnotaLancamento[] }>;
    anotaContas: () => Promise<{ contas: AnotaConta[] }>;
    anotaCategorias: () => Promise<{ categorias: AnotaCategoria[] }>;
    anotaLancamentoCriar: (l: {
      tipo: "despesa" | "receita";
      amountCents: number;
      description: string;
      category: string;
      categoriaId?: string | null;
      contaId?: string | null;
      data: string;
      status?: "pago" | "pendente";
      parcelas?: number;
      repeticoes?: number;
    }) => Promise<unknown>;
    anotaLancamentoEditar: (id: string, patch: { amountCents?: number; status?: "pago" | "pendente"; description?: string }) => Promise<unknown>;
    anotaLancamentoExcluir: (id: string) => Promise<unknown>;
    anotaImportar: (f: { formato: "csv" | "ofx"; conteudo: string; contaId?: string }) => Promise<{ importados: number; ignorados: number; erros: Array<{ linha: number; motivo: string }> }>;
    anotaExportCsv: () => Promise<string>;
  };
  toast: (m: string) => void;
}

export function Lancamentos({ a, toast }: Props) {
  const [ym, setYm] = useState(ymAtual());
  const [tipo, setTipo] = useState<"despesa" | "receita">("despesa");
  const [lista, setLista] = useState<AnotaLancamento[]>([]);
  const [contas, setContas] = useState<AnotaConta[]>([]);
  const [cats, setCats] = useState<AnotaCategoria[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  const [desc, setDesc] = useState("");
  const [valor, setValor] = useState("");
  const [data, setData] = useState(hoje());
  const [catId, setCatId] = useState<string>("");
  const [contaId, setContaId] = useState<string>("");
  const [status, setStatus] = useState<"pago" | "pendente">("pago");
  const [parcelas, setParcelas] = useState(1);
  const [repeticoes, setRepeticoes] = useState(1);
  const [editando, setEditando] = useState<string | null>(null);
  const [novoValor, setNovoValor] = useState("");

  const carregar = () => {
    a.anotaLancamentos({ ym })
      .then((r) => setLista(r.lancamentos))
      .catch((e: Error) => setErro(e.message));
    a.anotaContas().then((r) => setContas(r.contas)).catch(() => void 0);
    a.anotaCategorias().then((r) => setCats(r.categorias)).catch(() => void 0);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [ym]);

  const catsDoTipo = useMemo(() => cats.filter((c) => c.tipo === tipo), [cats, tipo]);
  useEffect(() => {
    if (catsDoTipo.length > 0 && !catsDoTipo.some((c) => c.id === catId)) setCatId(catsDoTipo[0]!.id);
  }, [catsDoTipo, catId]);

  const total = useMemo(() => {
    const desp = lista.filter((l) => l.tipo === "despesa").reduce((s, l) => s + l.amountCents, 0);
    const rec = lista.filter((l) => l.tipo === "receita").reduce((s, l) => s + l.amountCents, 0);
    return { desp, rec };
  }, [lista]);

  async function salvar() {
    const cents = textoParaCents(valor);
    if (!desc.trim() || !cents) return toast("Preencha descrição e valor");
    const cat = catsDoTipo.find((c) => c.id === catId);
    try {
      await a.anotaLancamentoCriar({
        tipo,
        amountCents: cents,
        description: desc.trim(),
        category: cat?.nome ?? "outros",
        categoriaId: catId || null,
        contaId: contaId || null,
        data,
        status,
        parcelas,
        repeticoes,
      });
      setDesc("");
      setValor("");
      setParcelas(1);
      setRepeticoes(1);
      toast(parcelas > 1 ? `Compra em ${parcelas}x lançada ✓` : repeticoes > 1 ? `${repeticoes} meses lançados ✓` : "Lançamento salvo ✓");
      carregar();
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
    }
  }

  async function importar(arquivo: File) {
    const texto = await arquivo.text();
    const formato = arquivo.name.toLowerCase().endsWith(".ofx") || texto.includes("<OFX>") ? "ofx" : "csv";
    try {
      const r = await a.anotaImportar({ formato, conteudo: texto, ...(contaId ? { contaId } : {}) });
      toast(`${r.importados} importados${r.ignorados ? `, ${r.ignorados} ignorados` : ""}${r.erros.length ? ` · ${r.erros.length} linha(s) com erro` : ""}`);
      carregar();
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
    }
  }

  async function baixarCsv() {
    const csv = await a.anotaExportCsv();
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const el = document.createElement("a");
    el.href = url;
    el.download = `anota-${ym}.csv`;
    el.click();
    toast("CSV exportado ✓");
  }

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>💸 Lançar</h3>
          <div className="row">
            <button className={`chip ${tipo === "despesa" ? "on" : ""}`} onClick={() => setTipo("despesa")}>despesa</button>
            <button className={`chip ${tipo === "receita" ? "on" : ""}`} onClick={() => setTipo("receita")}>receita</button>
          </div>
        </div>
        <div className="grid2">
          <div>
            <label>Descrição</label>
            <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={tipo === "despesa" ? "Mercado do mês" : "Salário"} />
          </div>
          <div>
            <label>Valor (R$)</label>
            <input className="input" value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" placeholder="0,00" />
          </div>
        </div>
        <div className="grid2">
          <div>
            <label>Data</label>
            <input className="input" type="date" value={data} onChange={(e) => setData(e.target.value)} />
          </div>
          <div>
            <label>Categoria</label>
            <select className="input" value={catId} onChange={(e) => setCatId(e.target.value)}>
              {catsDoTipo.map((c) => (
                <option key={c.id} value={c.id}>{c.nome}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid2">
          <div>
            <label>Conta</label>
            <select className="input" value={contaId} onChange={(e) => setContaId(e.target.value)}>
              <option value="">sem conta</option>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>{c.nome}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Situação</label>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value as "pago" | "pendente")}>
              <option value="pago">pago / recebido</option>
              <option value="pendente">pendente</option>
            </select>
          </div>
        </div>
        {tipo === "despesa" && (
          <div className="grid2">
            <div>
              <label>Parcelas</label>
              <select className="input" value={parcelas} onChange={(e) => setParcelas(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6, 10, 12, 18, 24].map((n) => (
                  <option key={n} value={n}>{n === 1 ? "à vista" : `${n}x`}</option>
                ))}
              </select>
            </div>
            <div>
              <label>Repetir por (meses)</label>
              <select className="input" value={repeticoes} onChange={(e) => setRepeticoes(Number(e.target.value))}>
                {[1, 2, 3, 6, 12].map((n) => (
                  <option key={n} value={n}>{n === 1 ? "só este mês" : `${n} meses`}</option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={salvar}>Lançar</button>
          <label className="btn ghost sm" style={{ margin: 0, cursor: "pointer" }}>
            📥 Importar extrato
            <input type="file" accept=".csv,.ofx,text/csv" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && importar(e.target.files[0])} />
          </label>
          <button className="btn ghost sm" onClick={baixarCsv}>⬇ CSV</button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Lançamentos</h3>
          <input className="input" style={{ maxWidth: 150 }} type="month" value={ym} onChange={(e) => setYm(e.target.value)} />
        </div>
        <div className="row">
          <span className="chip bad">↓ {fmt(total.desp)}</span>
          <span className="chip ok">↑ {fmt(total.rec)}</span>
          <span className="chip">saldo {fmt(total.rec - total.desp)}</span>
        </div>
        {erro && <div className="banner bad">{erro}</div>}
        {lista.length === 0 && <div className="empty">Nada lançado neste mês.</div>}
        {lista.map((l) => (
          <div className="list-item" key={l.id}>
            <div>
              <b>{l.description}</b>
              <div className="tiny">
                {dataBR(l.data)} · {l.category}
                {l.parcelasTotal ? ` · ${l.parcelaNum}/${l.parcelasTotal}` : ""}
                {l.origem !== "manual" ? ` · importado (${l.origem.toUpperCase()})` : ""}
                {l.status === "pendente" ? " · pendente" : ""}
              </div>
            </div>
            <div className="row">
              <b style={{ color: l.tipo === "despesa" ? "var(--bad)" : "var(--good)" }}>
                {l.tipo === "despesa" ? "−" : "+"} {fmt(l.amountCents)}
              </b>
              {editando === l.id ? (
                <>
                  <input className="input" style={{ width: 90 }} value={novoValor} onChange={(e) => setNovoValor(e.target.value)} inputMode="decimal" />
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const cents = textoParaCents(novoValor);
                      if (!cents) return toast("Valor inválido");
                      await a.anotaLancamentoEditar(l.id, { amountCents: cents });
                      setEditando(null);
                      toast("Corrigido ✓");
                      carregar();
                    }}
                  >
                    ok
                  </button>
                </>
              ) : (
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    setEditando(l.id);
                    setNovoValor(centsParaTexto(l.amountCents));
                  }}
                >
                  ✎
                </button>
              )}
              <button
                className="btn sm ghost"
                onClick={async () => {
                  await a.anotaLancamentoEditar(l.id, { status: l.status === "pago" ? "pendente" : "pago" });
                  carregar();
                }}
                title="alternar pago/pendente"
              >
                {l.status === "pago" ? "✓" : "⏳"}
              </button>
              <button
                className="btn sm bad"
                onClick={async () => {
                  await a.anotaLancamentoExcluir(l.id);
                  toast("Excluído");
                  carregar();
                }}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
