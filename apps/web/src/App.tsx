import { useEffect, useState } from "react";
import { authenticate, api, setSessao, type Sessao } from "./api2";
import { AnotaScreen, ConcursosScreen, EmprestimosScreen, InicioScreen, InvestigaScreen, JuridicoScreen, LicitacoesScreen, PlanosScreen } from "./screens";
import { Icon } from "./Icon";
import "./styles.css";

type Aba = "inicio" | "anota" | "licitacoes" | "concursos" | "juridico" | "emprestimos" | "investiga" | "planos";

const NAV: Array<{ id: Aba; ico: string; label: string }> = [
  { id: "inicio", ico: "home", label: "Início" },
  { id: "anota", ico: "note", label: "AnotA" },
  { id: "licitacoes", ico: "scroll", label: "Licitações" },
  { id: "concursos", ico: "grad", label: "Concursos" },
  { id: "juridico", ico: "scale", label: "Jurídico" },
  { id: "emprestimos", ico: "deal", label: "Empréstimos" },
  { id: "investiga", ico: "search", label: "Investiga" },
  { id: "planos", ico: "star", label: "Planos" },
];

export default function App() {
  const [status, setStatus] = useState<"loading" | "authed" | "error">("loading");
  const [sessao, setS] = useState<Sessao | null>(null);
  const [erro, setErro] = useState("");
  const [aba, setAba] = useState<Aba>("inicio");
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
        <div className="brand">
          Acompanhe.IA
          <small>Finanças · Jurídico · Concursos & Licitações · Empréstimos</small>
        </div>
        {sessao && (
          <div className="xp-pill">
            <b>{sessao.user.firstName}</b>
            <div className="tiny">sessão segura · JWT</div>
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
          {aba === "juridico" && <JuridicoScreen a={a} token={sessao.token} toast={toast} />}
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
      </nav>
    </div>
  );
}
