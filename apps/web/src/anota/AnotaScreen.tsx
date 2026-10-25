/**
 * AnotA — controle financeiro (refatorado em 25/10/2026).
 *
 * Antes: uma função de ~200 linhas com 12 useState e duas abas. Agora: uma casca
 * com abas e um arquivo por assunto. Sem sanfona, sem seta de expandir — o que
 * importa fica visível, o resto é uma aba.
 */
import { useEffect, useState } from "react";

import type { api, AnotaConta, AnotaResumo, NotaDto } from "../api2";
import { Backup } from "./Backup";
import { Emprestimos } from "./Emprestimos";
import { Lancamentos } from "./Lancamentos";
import { Planejar } from "./Planejar";
import { Relatorio } from "./Relatorio";
import { dataBR, fmt, nomeMes, rotuloTipoConta, ymAtual } from "./ui";

type Api = ReturnType<typeof api>;
interface Props {
  a: Api;
  token: string;
  toast: (m: string) => void;
}
type Aba = "resumo" | "lancamentos" | "planejar" | "relatorio" | "emprestimos" | "notas" | "backup";

const ABAS: Array<{ id: Aba; rotulo: string }> = [
  { id: "resumo", rotulo: "🏠 Resumo" },
  { id: "lancamentos", rotulo: "💸 Lançamentos" },
  { id: "planejar", rotulo: "🎯 Planejar" },
  { id: "relatorio", rotulo: "📈 Relatório" },
  { id: "emprestimos", rotulo: "🤝 Empréstimos" },
  { id: "notas", rotulo: "📝 Notas" },
  { id: "backup", rotulo: "📦 Backup" },
];

export function AnotaScreen({ a, toast }: Props) {
  const [aba, setAba] = useState<Aba>("resumo");
  return (
    <>
      <div className="card">
        <h3>📒 AnotA — controle financeiro</h3>
        <div className="row">
          {ABAS.map((x) => (
            <button key={x.id} className={`chip ${aba === x.id ? "on" : ""}`} onClick={() => setAba(x.id)}>
              {x.rotulo}
            </button>
          ))}
        </div>
      </div>
      {aba === "resumo" && <Resumo a={a} toast={toast} irPara={setAba} />}
      {aba === "lancamentos" && <Lancamentos a={a} toast={toast} />}
      {aba === "planejar" && <Planejar a={a} toast={toast} />}
      {aba === "relatorio" && <Relatorio a={a} toast={toast} />}
      {aba === "emprestimos" && <Emprestimos a={a} toast={toast} />}
      {aba === "notas" && <Notas a={a} toast={toast} />}
      {aba === "backup" && <Backup a={a} toast={toast} />}
    </>
  );
}

function Resumo({ a, toast, irPara }: { a: Api; toast: (m: string) => void; irPara: (x: Aba) => void }) {
  const [ym, setYm] = useState(ymAtual());
  const [dados, setDados] = useState<AnotaResumo | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [nomeConta, setNomeConta] = useState("");
  const [tipoConta, setTipoConta] = useState<AnotaConta["tipo"]>("banco");
  const [saldoInicial, setSaldoInicial] = useState("");

  const carregar = () => {
    a.anotaResumo(ym)
      .then(setDados)
      .catch((e: Error) => setErro(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [ym]);

  if (erro) return <div className="banner bad">{erro}</div>;

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Resumo de {nomeMes(ym)}</h3>
          <input className="input" style={{ maxWidth: 150 }} type="month" value={ym} onChange={(e) => setYm(e.target.value)} />
        </div>
        {!dados && <div className="empty">Carregando…</div>}
        {dados && (
          <>
            <div className="kv">
              <span>Saldo em contas</span>
              <b>{fmt(dados.saldoConsolidadoCents)}</b>
            </div>
            <div className="kv">
              <span>Entrou no mês</span>
              <b style={{ color: "var(--good)" }}>{fmt(dados.resumo.receitasCents)}</b>
            </div>
            <div className="kv">
              <span>Saiu no mês</span>
              <b style={{ color: "var(--bad)" }}>{fmt(dados.resumo.despesasCents)}</b>
            </div>
            <div className="kv">
              <span>Sobrou</span>
              <b>{fmt(dados.resumo.saldoCents)}</b>
            </div>
            {dados.resumo.apagarCents > 0 && (
              <div className="kv">
                <span>Ainda vai sair (pendente)</span>
                <b style={{ color: "var(--warn)" }}>{fmt(dados.resumo.apagarCents)}</b>
              </div>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => irPara("lancamentos")}>+ Lançar</button>
              <button className="btn ghost sm" onClick={() => irPara("relatorio")}>ver relatório</button>
              <button className="btn ghost sm" onClick={() => irPara("backup")}>backup</button>
            </div>
          </>
        )}
      </div>

      {dados && dados.orcamentos.length > 0 && (
        <div className="card">
          <h3>🎯 Orçamento do mês</h3>
          {dados.orcamentos.slice(0, 4).map((o) => (
            <div key={o.categoriaId} style={{ marginBottom: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>{o.categoria}</span>
                <span className="tiny">{fmt(o.gastoCents)} / {fmt(o.limiteCents)}</span>
              </div>
              <div className="bar">
                <i style={{ width: `${Math.min(o.pct, 100)}%`, background: o.estado === "estourou" ? "var(--bad)" : o.estado === "atencao" ? "var(--warn)" : undefined }} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>🏦 Contas</h3>
        {dados?.contas.length === 0 && <div className="empty">Nenhuma conta ainda — cadastre a primeira abaixo.</div>}
        {dados?.contas.map((c) => (
          <div className="list-item" key={c.id}>
            <div>
              <b>{c.nome}</b>
              <div className="tiny">{rotuloTipoConta[c.tipo] ?? c.tipo} · inicial {fmt(c.saldoInicialCents)}</div>
            </div>
            <b>{fmt(c.saldoCents ?? c.saldoInicialCents)}</b>
          </div>
        ))}
        <div className="grid2" style={{ marginTop: 8 }}>
          <div>
            <label>Nova conta</label>
            <input className="input" value={nomeConta} onChange={(e) => setNomeConta(e.target.value)} placeholder="Nubank, carteira…" />
          </div>
          <div>
            <label>Saldo inicial (R$)</label>
            <input className="input" value={saldoInicial} onChange={(e) => setSaldoInicial(e.target.value)} inputMode="decimal" placeholder="0,00" />
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {(["banco", "caixa", "poupanca", "cartao"] as const).map((t) => (
            <button key={t} className={`chip ${tipoConta === t ? "on" : ""}`} onClick={() => setTipoConta(t)}>
              {rotuloTipoConta[t]}
            </button>
          ))}
        </div>
        <button
          className="btn"
          style={{ marginTop: 8 }}
          onClick={async () => {
            if (!nomeConta.trim()) return toast("Dê um nome à conta");
            const cents = saldoInicial.trim() ? Number(saldoInicial.replace(/\./g, "").replace(",", ".")) * 100 : 0;
            await a.anotaContaCriar({ nome: nomeConta.trim(), tipo: tipoConta, saldoInicialCents: Math.round(cents || 0) });
            setNomeConta("");
            setSaldoInicial("");
            toast("Conta criada ✓");
            carregar();
          }}
        >
          Criar conta
        </button>
      </div>
    </>
  );
}

function Notas({ a, toast }: { a: Api; toast: (m: string) => void }) {
  const [notas, setNotas] = useState<NotaDto[]>([]);
  const [titulo, setTitulo] = useState("");
  const [corpo, setCorpo] = useState("");
  const [busca, setBusca] = useState("");

  const carregar = (q?: string) => {
    a.anotaNotas(q).then((r) => setNotas(r.notas)).catch(() => void 0);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => carregar(), []);

  return (
    <>
      <div className="card">
        <h3>📝 Nova nota</h3>
        <input className="input" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Título" />
        <textarea value={corpo} onChange={(e) => setCorpo(e.target.value)} placeholder="Anotação… (entra na busca)" />
        <button
          className="btn"
          style={{ marginTop: 8 }}
          onClick={async () => {
            if (!titulo.trim()) return toast("Título obrigatório");
            await a.anotaNotaCriar({ title: titulo.trim(), body: corpo });
            setTitulo("");
            setCorpo("");
            toast("Nota salva ✓");
            carregar();
          }}
        >
          Salvar nota
        </button>
      </div>

      <div className="card">
        <div className="row">
          <input className="input grow" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar nas notas…" />
          <button className="btn sm ghost" onClick={() => carregar(busca || undefined)}>buscar</button>
        </div>
        {notas.length === 0 && <div className="empty">Sem notas ainda.</div>}
        {notas.map((n) => (
          <div className="list-item" key={n.id}>
            <div>
              <b>{n.title}</b>
              <div className="tiny">{(n.body ?? "").slice(0, 90)}</div>
            </div>
            <div className="row">
              <span className="tiny">{dataBR(n.updatedAt ?? n.createdAt)}</span>
              <button
                className="btn sm bad"
                onClick={async () => {
                  await a.anotaNotaExcluir(n.id);
                  toast("Nota excluída");
                  carregar(busca || undefined);
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
