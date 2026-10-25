/**
 * Aba Planejar — orçamento por categoria, metas e cartões/faturas.
 * Tudo em cartões simples, sem colapsar: o usuário vê o limite, o gasto e
 * quanto sobra em uma linha.
 */
import { useEffect, useState } from "react";

import type { AnotaCategoria, AnotaFatura, AnotaMeta, AnotaOrcamentoStatus, AnotaCartao } from "../api2";
import { centsParaTexto, fmt, nomeMes, textoParaCents, ymAtual } from "./ui";

interface Props {
  a: {
    anotaResumo: (ym: string) => Promise<{ orcamentos: AnotaOrcamentoStatus[]; faturas: AnotaFatura[]; metas: AnotaMeta[] }>;
    anotaCategorias: () => Promise<{ categorias: AnotaCategoria[] }>;
    anotaOrcamentoSalvar: (o: { categoriaId: string; ym: string; limiteCents: number }) => Promise<unknown>;
    anotaCartoes: () => Promise<{ cartoes: AnotaCartao[] }>;
    anotaCartaoCriar: (c: { contaId: string; nome: string; limiteCents: number; fechamentoDia: number; vencimentoDia: number }) => Promise<unknown>;
    anotaContas: () => Promise<{ contas: Array<{ id: string; nome: string }> }>;
    anotaMetas: () => Promise<{ metas: AnotaMeta[] }>;
    anotaMetaCriar: (m: { nome: string; alvoCents: number; guardadoCents?: number }) => Promise<unknown>;
    anotaMetaEditar: (id: string, patch: { guardadoCents?: number }) => Promise<unknown>;
  };
  toast: (m: string) => void;
}

export function Planejar({ a, toast }: Props) {
  const [ym, setYm] = useState(ymAtual());
  const [orcamentos, setOrcamentos] = useState<AnotaOrcamentoStatus[]>([]);
  const [faturas, setFaturas] = useState<AnotaFatura[]>([]);
  const [metas, setMetas] = useState<AnotaMeta[]>([]);
  const [cats, setCats] = useState<AnotaCategoria[]>([]);
  const [contas, setContas] = useState<Array<{ id: string; nome: string }>>([]);
  const [cartoes, setCartoes] = useState<AnotaCartao[]>([]);
  const [catId, setCatId] = useState("");
  const [limite, setLimite] = useState("");
  const [metaNome, setMetaNome] = useState("");
  const [metaAlvo, setMetaAlvo] = useState("");
  const [cartaoNome, setCartaoNome] = useState("");
  const [cartaoLimite, setCartaoLimite] = useState("");
  const [cartaoConta, setCartaoConta] = useState("");
  const [fecha, setFecha] = useState(25);
  const [vence, setVence] = useState(5);
  const [deposito, setDeposito] = useState<Record<string, string>>({});

  const carregar = () => {
    a.anotaResumo(ym).then((r) => {
      setOrcamentos(r.orcamentos);
      setFaturas(r.faturas);
      setMetas(r.metas);
    }).catch((e: Error) => toast(`⚠ ${e.message}`));
    a.anotaCategorias().then((r) => {
      setCats(r.categorias.filter((c) => c.tipo === "despesa"));
      setCatId((atual) => atual || r.categorias.filter((c) => c.tipo === "despesa")[0]?.id || "");
    }).catch(() => void 0);
    a.anotaContas().then((r) => {
      setContas(r.contas);
      setCartaoConta((atual) => atual || r.contas[0]?.id || "");
    }).catch(() => void 0);
    a.anotaCartoes().then((r) => setCartoes(r.cartoes)).catch(() => void 0);
    a.anotaMetas().then((r) => setMetas(r.metas)).catch(() => void 0);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [ym]);

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>🎯 Orçamento por categoria</h3>
          <input className="input" style={{ maxWidth: 150 }} type="month" value={ym} onChange={(e) => setYm(e.target.value)} />
        </div>
        {orcamentos.length === 0 && <div className="empty">Nenhum limite definido para {nomeMes(ym)}.</div>}
        {orcamentos.map((o) => (
          <div key={o.categoriaId} style={{ marginBottom: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>{o.categoria}</b>
              <span className="tiny">
                {fmt(o.gastoCents)} de {fmt(o.limiteCents)} · {o.estado === "ok" ? "no limite" : o.estado === "atencao" ? "atenção" : "estourou"}
              </span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.min(o.pct, 100)}%`, background: o.estado === "estourou" ? "var(--bad)" : o.estado === "atencao" ? "var(--warn)" : undefined }} />
            </div>
            <div className="tiny">{o.restanteCents >= 0 ? `sobram ${fmt(o.restanteCents)}` : `passou ${fmt(-o.restanteCents)}`}</div>
          </div>
        ))}
        <div className="grid2" style={{ marginTop: 8 }}>
          <div>
            <label>Categoria</label>
            <select className="input" value={catId} onChange={(e) => setCatId(e.target.value)}>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>{c.nome}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Limite do mês (R$)</label>
            <input className="input" value={limite} onChange={(e) => setLimite(e.target.value)} inputMode="decimal" placeholder="0,00" />
          </div>
        </div>
        <button
          className="btn"
          style={{ marginTop: 8 }}
          onClick={async () => {
            const cents = textoParaCents(limite);
            if (!catId || !cents) return toast("Escolha a categoria e o limite");
            await a.anotaOrcamentoSalvar({ categoriaId: catId, ym, limiteCents: cents });
            setLimite("");
            toast("Limite salvo ✓");
            carregar();
          }}
        >
          Salvar limite
        </button>
      </div>

      <div className="card">
        <h3>💳 Cartões e faturas</h3>
        {cartoes.length === 0 && <div className="empty">Nenhum cartão cadastrado.</div>}
        {cartoes.map((c) => {
          const f = faturas.find((x) => x.cartaoId === c.id);
          return (
            <div className="list-item" key={c.id}>
              <div>
                <b>{c.nome}</b>
                <div className="tiny">
                  fecha dia {c.fechamentoDia} · vence dia {c.vencimentoDia} · limite {fmt(c.limiteCents)}
                  {f ? ` · fatura ${fmt(f.totalCents)} (${f.itens} itens)` : ""}
                </div>
              </div>
              {f && <span className="chip">{f.abertoCents > 0 ? `aberto ${fmt(f.abertoCents)}` : "fatura fechada"}</span>}
            </div>
          );
        })}
        <div className="grid2" style={{ marginTop: 8 }}>
          <div>
            <label>Nome do cartão</label>
            <input className="input" value={cartaoNome} onChange={(e) => setCartaoNome(e.target.value)} placeholder="Visa Nubank" />
          </div>
          <div>
            <label>Limite (R$)</label>
            <input className="input" value={cartaoLimite} onChange={(e) => setCartaoLimite(e.target.value)} inputMode="decimal" placeholder="0,00" />
          </div>
        </div>
        <div className="grid2">
          <div>
            <label>Conta vinculada</label>
            <select className="input" value={cartaoConta} onChange={(e) => setCartaoConta(e.target.value)}>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>{c.nome}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Fecha / vence (dia)</label>
            <div className="row">
              <input className="input" type="number" min={1} max={28} value={fecha} onChange={(e) => setFecha(Number(e.target.value))} />
              <input className="input" type="number" min={1} max={28} value={vence} onChange={(e) => setVence(Number(e.target.value))} />
            </div>
          </div>
        </div>
        <button
          className="btn"
          style={{ marginTop: 8 }}
          onClick={async () => {
            const cents = textoParaCents(cartaoLimite) ?? 0;
            if (!cartaoNome.trim() || !cartaoConta) return toast("Informe o nome e a conta do cartão");
            await a.anotaCartaoCriar({ contaId: cartaoConta, nome: cartaoNome.trim(), limiteCents: cents, fechamentoDia: fecha, vencimentoDia: vence });
            setCartaoNome("");
            setCartaoLimite("");
            toast("Cartão salvo ✓");
            carregar();
          }}
        >
          Salvar cartão
        </button>
      </div>

      <div className="card">
        <h3>🐷 Metas</h3>
        {metas.length === 0 && <div className="empty">Nenhuma meta ainda. Comece pela reserva de emergência.</div>}
        {metas.map((m) => (
          <div key={m.id} style={{ marginBottom: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>{m.nome}</b>
              <span className="tiny">{fmt(m.guardadoCents)} de {fmt(m.alvoCents)}</span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.min(m.pct ?? 0, 100)}%` }} />
            </div>
            <div className="row" style={{ marginTop: 4 }}>
              <input
                className="input"
                style={{ maxWidth: 110 }}
                placeholder="guardar R$"
                inputMode="decimal"
                value={deposito[m.id] ?? ""}
                onChange={(e) => setDeposito({ ...deposito, [m.id]: e.target.value })}
              />
              <button
                className="btn sm"
                onClick={async () => {
                  const cents = textoParaCents(deposito[m.id] ?? "");
                  if (!cents) return toast("Valor inválido");
                  await a.anotaMetaEditar(m.id, { guardadoCents: m.guardadoCents + cents });
                  setDeposito({ ...deposito, [m.id]: "" });
                  toast("Guardado ✓");
                  carregar();
                }}
              >
                guardar
              </button>
              <span className="tiny">falta {fmt(Math.max(0, m.alvoCents - m.guardadoCents))}</span>
            </div>
          </div>
        ))}
        <div className="grid2" style={{ marginTop: 8 }}>
          <div>
            <label>Nova meta</label>
            <input className="input" value={metaNome} onChange={(e) => setMetaNome(e.target.value)} placeholder="Reserva de emergência" />
          </div>
          <div>
            <label>Alvo (R$)</label>
            <input className="input" value={metaAlvo} onChange={(e) => setMetaAlvo(e.target.value)} inputMode="decimal" placeholder="0,00" />
          </div>
        </div>
        <button
          className="btn"
          style={{ marginTop: 8 }}
          onClick={async () => {
            const cents = textoParaCents(metaAlvo);
            if (!metaNome.trim() || !cents) return toast("Informe nome e valor da meta");
            await a.anotaMetaCriar({ nome: metaNome.trim(), alvoCents: cents, guardadoCents: 0 });
            setMetaNome("");
            setMetaAlvo("");
            toast("Meta criada ✓");
            carregar();
          }}
        >
          Criar meta
        </button>
        <p className="tiny" style={{ marginTop: 8 }}>
          Exemplo de alvo: {centsParaTexto(300000).replace(".", ",")} → R$ 3.000,00 de reserva; guardando R$ 150 por mês dá 20 meses.
        </p>
      </div>
    </>
  );
}
