/**
 * Aba “🤝 Empréstimos” do AnotA (união de 25/10).
 *
 * O contrato continua sendo do produto Empréstimo (juros, aceite, dupla
 * confirmação). Aqui ele aparece pelo lado do dinheiro: quanto falta pagar,
 * quantas parcelas já estão lançadas no livro-caixa, o que já foi confirmado.
 *
 * Nada é recalculado na tela: total, parcela e saldo vêm da API, que usa a
 * mesma calculadora do contrato.
 */
import { useEffect, useState } from "react";

import type { AnotaEmprestimosResp } from "../api2";
import { dataBR, fmt } from "./ui";

interface Props {
  a: {
    anotaEmprestimos: () => Promise<AnotaEmprestimosResp>;
    anotaEmprestimoLancar: (matchId: string) => Promise<{ criados: number; jaExistiam: number; totalParcelas: number; totalCents: number }>;
    anotaEmprestimoPagamentoLancar: (matchId: string, paymentId: string) => Promise<{ acao: string; viaParcela: boolean }>;
  };
  toast: (m: string) => void;
}

const ROTULO_STATUS: Record<string, string> = {
  declared: "declarado (aguardando confirmação)",
  confirmed: "confirmado",
  disputed: "contestado",
};

export function Emprestimos({ a, toast }: Props) {
  const [dados, setDados] = useState<AnotaEmprestimosResp | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const carregar = () => {
    a.anotaEmprestimos()
      .then((d) => {
        setDados(d);
        setErro(null);
      })
      .catch((e: Error) => setErro(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, []);

  async function lancar(matchId: string) {
    setOcupado(matchId);
    try {
      const r = await a.anotaEmprestimoLancar(matchId);
      toast(
        r.criados > 0
          ? `${r.criados} parcela(s) lançada(s) · ${fmt(r.totalCents)} no total`
          : `Nada a lançar — as ${r.totalParcelas} parcelas já estavam no AnotA`,
      );
      carregar();
    } catch (e) {
      toast(`⚠ ${(e as Error).message}`);
    } finally {
      setOcupado(null);
    }
  }

  if (erro) return <div className="banner bad">{erro}</div>;
  if (!dados) return <div className="card"><div className="empty">Carregando contratos…</div></div>;

  return (
    <>
      <div className="card">
        <h3>🤝 Empréstimos entre pessoas</h3>
        <p className="tiny">
          Contratos aceitos no módulo de empréstimo. Lançar as parcelas aqui coloca o compromisso no seu
          livro-caixa — e o que a contraparte confirmar como pago vira parcela paga, não linha nova.
        </p>
        <div className="row">
          <span className="chip bad">a pagar {fmt(dados.aPagarCents)}</span>
          <span className="chip ok">a receber {fmt(dados.aReceberCents)}</span>
          <span className="chip">{dados.matchesAceitos} contrato(s) aceito(s) de {dados.matchesTotal} match(es)</span>
        </div>
        {dados.contratos.length === 0 && (
          <div className="empty">
            Nenhum contrato aceito ainda. Quando um match de empréstimo for aceito, ele aparece aqui para
            ser lançado no AnotA.
          </div>
        )}
      </div>

      {dados.contratos.map((c) => {
        const pct = c.parcelasTotal > 0 ? Math.round((c.parcelasLancadas / c.parcelasTotal) * 100) : 0;
        const pagoPct = c.totalCents > 0 ? Math.round((c.pagoCents / c.totalCents) * 100) : 0;
        return (
          <div className="card" key={c.matchId}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>
                {c.papel === "devedor" ? "💸 Devo" : "💰 Recebo"} · {c.motivo}
              </h3>
              <span className="chip">{c.papel}</span>
            </div>

            <div className="kv">
              <span>Principal</span>
              <b>{fmt(c.principalCents)}</b>
            </div>
            <div className="kv">
              <span>Juros ({(c.jurosMesBps / 100).toFixed(2)}% a.m. × {c.meses})</span>
              <b>{fmt(c.jurosCents)}</b>
            </div>
            <div className="kv">
              <span>Total do contrato</span>
              <b>{fmt(c.totalCents)}</b>
            </div>
            <div className="kv">
              <span>Parcela</span>
              <b>{fmt(c.parcelaCents)} · {c.parcelasTotal}×</b>
            </div>
            <div className="kv">
              <span>Em aberto</span>
              <b style={{ color: c.papel === "devedor" ? "var(--bad)" : "var(--good)" }}>{fmt(c.emAbertoCents)}</b>
            </div>
            {c.declaradoCents > 0 && (
              <div className="kv">
                <span>Declarado, aguardando confirmação</span>
                <b style={{ color: "var(--warn)" }}>{fmt(c.declaradoCents)}</b>
              </div>
            )}

            <div className="tiny" style={{ marginTop: 8 }}>
              parcelas lançadas no AnotA: {c.parcelasLancadas}/{c.parcelasTotal} · pago {fmt(c.pagoCents)} ({pagoPct}%)
            </div>
            <div className="bar">
              <i style={{ width: `${pct}%` }} />
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => void lancar(c.matchId)} disabled={ocupado === c.matchId || c.parcelasLancadas === c.parcelasTotal}>
                {ocupado === c.matchId
                  ? "lançando…"
                  : c.parcelasLancadas === c.parcelasTotal
                    ? "parcelas já lançadas ✓"
                    : `Lançar ${c.parcelasTotal - c.parcelasLancadas} parcela(s) no AnotA`}
              </button>
              {c.proximoVencimento && <span className="chip">próx. vencimento {dataBR(c.proximoVencimento)}</span>}
            </div>

            {c.pagamentos.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="tiny">Pagamentos registrados no contrato</div>
                {c.pagamentos.map((p) => (
                  <div className="list-item" key={p.id}>
                    <div>
                      <b>{fmt(p.valorCents)}</b>
                      <div className="tiny">
                        {dataBR(p.declaredAt.slice(0, 10))} · {ROTULO_STATUS[p.status] ?? p.status}
                        {p.noAnotA ? " · já no AnotA" : ""}
                      </div>
                    </div>
                    {p.status === "confirmed" && !p.noAnotA ? (
                      <button
                        className="btn sm ghost"
                        onClick={async () => {
                          try {
                            const r = await a.anotaEmprestimoPagamentoLancar(c.matchId, p.id);
                            toast(r.viaParcela ? "Parcela marcada como paga ✓" : "Pagamento lançado ✓");
                            carregar();
                          } catch (e) {
                            toast(`⚠ ${(e as Error).message}`);
                          }
                        }}
                      >
                        lançar
                      </button>
                    ) : (
                      <span className="tiny">{p.status === "confirmed" ? "✓" : "aguardando"}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
