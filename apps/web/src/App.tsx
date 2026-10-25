import { useEffect, useState } from "react";
import { authenticate, api, setSessao, type Sessao } from "./api2";
import { AnotaScreen, ConcursosScreen, EmprestimosScreen, InicioScreen, InvestigaScreen, JuridicoScreen, LicitacoesScreen, PlanosScreen } from "./screens";
import { Icon } from "./Icon";
import { Sheet } from "./juridico/ui";
import "./styles.css";

type Aba = "inicio" | "anota" | "licitacoes" | "concursos" | "juridico" | "emprestimos" | "investiga" | "planos";

/**
 * Navegação: 5 destinos legíveis em 360 px. O resto fica em "Mais" (sheet) —
 * nada foi removido, só agrupado (plano-refatoracao-ui §4).
 */
const NAV: Array<{ id: Aba; ico: string; label: string }> = [
  { id: "inicio", ico: "home", label: "Início" },
  { id: "licitacoes", ico: "scroll", label: "Licitações" },
  { id: "juridico", ico: "scale", label: "Jurídico" },
  { id: "concursos", ico: "grad", label: "Concursos" },
];
const MAIS: Array<{ id: Aba; ico: string; label: string; desc: string }> = [
  { id: "anota", ico: "note", label: "AnotA", desc: "anotações e tarefas" },
  { id: "emprestimos", ico: "deal", label: "Empréstimos", desc: "comparar ofertas" },
  { id: "investiga", ico: "search", label: "Investiga", desc: "dossiês e buscas" },
  { id: "planos", ico: "star", label: "Planos", desc: "assinatura e limites" },
];

export default function App() {
  const [status, setStatus] = useState<"loading" | "authed" | "error">("loading");
  const [sessao, setS] = useState<Sessao | null>(null);
  const [erro, setErro] = useState("");
  const [aba, setAba] = useState<Aba>("inicio");
  const [maisAberto, setMaisAberto] = useState(false);
  const [toastMsg, setToastMsg] = useState("");

  const toast = (m: string) => {
    setToastMsg(m);
    window.setTimeout(() => setToastMsg(""), 3500);
  };

  useEffect(() => {
    authenticate()
      .then((s) => {
        setS(s);
        setSessao(s);
        setStatus("authed");
      })
      .catch((e: Error) => {
        setErro(e.message);
        setStatus("error");
      });
  }, []);

  const a = sessao ? api(sessao.token) : null;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">Acompanhe.IA</div>
        {sessao && (
          <div className="xp-pill">
            <b>{sessao.user.firstName}</b>
          </div>
        )}
      </header>

      {status === "loading" && (
        <>
          <div className="empty">Autenticando…</div>
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </>
      )}
      {status === "error" && (
        <div className="banner bad">
          ⚠ {erro}
        </div>
      )}

      {status === "authed" && a && sessao && (
        <>
          {aba === "inicio" && <InicioScreen a={a} token={sessao.token} toast={toast} />}
          {aba === "anota" && <AnotaScreen a={a} token={sessao.token} toast={toast} />}
          {aba === "licitacoes" && <LicitacoesScreen a={a} token={sessao.token} toast={toast} />}
          {aba === "concursos" && <ConcursosScreen a={a} token={sessao.token} toast={toast} />}
          {aba === "juridico" && <JuridicoScreen a={a} toast={toast} />}
          {aba === "emprestimos" && <EmprestimosScreen a={a} token={sessao.token} toast={toast} />}
          {aba === "investiga" && <InvestigaScreen a={a} token={sessao.token} toast={toast} />}
          {aba === "planos" && <PlanosScreen a={a} token={sessao.token} toast={toast} />}
        </>
      )}

      {toastMsg && <div className="toast">{toastMsg}</div>}

      <nav className="bottom-nav">
        {NAV.map((n) => (
          <button key={n.id} className={aba === n.id ? "on" : ""} onClick={() => setAba(n.id)}>
            <span className="ico"><Icon name={n.ico} /></span>
            {n.label}
          </button>
        ))}
        <button
          className={MAIS.some((m) => m.id === aba) ? "on" : ""}
          onClick={() => setMaisAberto(true)}
          aria-label="mais seções"
        >
          <span className="ico" aria-hidden="true">⋯</span>
          Mais
        </button>
      </nav>

      <Sheet aberto={maisAberto} titulo="Mais" onFechar={() => setMaisAberto(false)}>
        <div className="sheet-lista">
          {MAIS.map((m) => (
            <button
              key={m.id}
              className="sheet-nav"
              onClick={() => {
                setAba(m.id);
                setMaisAberto(false);
              }}
            >
              <span className="ico"><Icon name={m.ico} /></span>
              <span className="grow">
                <b>{m.label}</b>
                <span className="tiny">{m.desc}</span>
              </span>
              <span aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
