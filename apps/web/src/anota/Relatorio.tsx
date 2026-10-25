/**
 * Aba Relatório — mês a mês, com variação das despesas e saldo por conta.
 * É a leitura que responde "para onde foi meu dinheiro".
 */
import { useEffect, useState } from "react";

import type { AnotaConta, AnotaLinhaRelatorio, AnotaResumoCategoria } from "../api2";
import { fmt, nomeMes, rotuloTipoConta, ymAtual } from "./ui";

interface Props {
  a: {
    anotaRelatorio: (ym: string, meses?: number) => Promise<{ meses: string[]; linhas: AnotaLinhaRelatorio[] }>;
    anotaResumo: (ym: string) => Promise<{ resumo: { porCategoria: AnotaResumoCategoria[]; despesasCents: number }; contas: AnotaConta[]; saldoConsolidadoCents: number }>;
  };
  toast: (m: string) => void;
}

export function Relatorio({ a, toast }: Props) {
  const [ym, setYm] = useState(ymAtual());
  const [meses, setMeses] = useState(6);
  const [linhas, setLinhas] = useState<AnotaLinhaRelatorio[]>([]);
  const [cats, setCats] = useState<AnotaResumoCategoria[]>([]);
  const [contas, setContas] = useState<AnotaConta[]>([]);
  const [consolidado, setConsolidado] = useState(0);

  useEffect(() => {
    a.anotaRelatorio(ym, meses).then((r) => setLinhas(r.linhas)).catch((e: Error) => toast(`⚠ ${e.message}`));
    a.anotaResumo(ym)
      .then((r) => {
        setCats(r.resumo.porCategoria.filter((c) => c.tipo === "despesa").slice(0, 8));
        setContas(r.contas);
        setConsolidado(r.saldoConsolidadoCents);
      })
      .catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ym, meses]);

  const maiorDespesa = Math.max(1, ...cats.map((c) => c.totalCents));

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>📈 Mês a mês</h3>
          <div className="row">
            <select className="input" style={{ maxWidth: 110 }} value={meses} onChange={(e) => setMeses(Number(e.target.value))}>
              {[3, 6, 12].map((n) => (
                <option key={n} value={n}>{n} meses</option>
              ))}
            </select>
            <input className="input" style={{ maxWidth: 150 }} type="month" value={ym} onChange={(e) => setYm(e.target.value)} />
          </div>
        </div>
        {linhas.map((l) => (
          <div key={l.ym} style={{ marginBottom: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>{nomeMes(l.ym)}</b>
              <span className="tiny">
                ↑ {fmt(l.receitasCents)} · ↓ {fmt(l.despesasCents)} · saldo {fmt(l.saldoCents)}
                {l.variacaoDespesaPct !== null ? ` · ${l.variacaoDespesaPct > 0 ? "+" : ""}${l.variacaoDespesaPct}% vs mês anterior` : ""}
              </span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.min(100, Math.round((l.despesasCents / Math.max(1, l.receitasCents, l.despesasCents)) * 100))}%` }} />
            </div>
          </div>
        ))}
        {linhas.length === 0 && <div className="empty">Sem dados ainda.</div>}
      </div>

      <div className="card">
        <h3>🔎 Onde mais pesou em {nomeMes(ym)}</h3>
        {cats.length === 0 && <div className="empty">Nenhuma despesa no mês.</div>}
        {cats.map((c) => (
          <div key={c.categoria} style={{ marginBottom: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>{c.categoria}</span>
              <b>{fmt(c.totalCents)}</b>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.round((c.totalCents / maiorDespesa) * 100)}%` }} />
            </div>
            <div className="tiny">{c.count} lançamento{c.count === 1 ? "" : "s"}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>🏦 Contas</h3>
        <div className="kv">
          <span>Saldo consolidado</span>
          <b>{fmt(consolidado)}</b>
        </div>
        {contas.length === 0 && <div className="empty">Cadastre uma conta na aba Início.</div>}
        {contas.map((c) => (
          <div className="kv" key={c.id}>
            <span>
              {rotuloTipoConta[c.tipo] ?? c.tipo} · {c.nome}
            </span>
            <b>{fmt(c.saldoCents ?? c.saldoInicialCents)}</b>
          </div>
        ))}
      </div>
    </>
  );
}
