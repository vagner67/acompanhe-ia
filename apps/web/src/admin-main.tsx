/** Painel do administrador — ENTRADA SEPARADA (fora do mini-app).
 *  Acessível só por URL (/admin.html) + login RBAC próprio (/v1/admin/auth/login).
 *  NÃO é referenciado pelo app do cliente (nav inferior não tem aba de admin).
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AdminScreen } from "./screens";
import "./styles.css";

function AdminApp() {
  const [toastMsg, setToastMsg] = useState("");
  const toast = (m: string) => {
    setToastMsg(m);
    window.setTimeout(() => setToastMsg(""), 3500);
  };
  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          Acompanhe.IA · Admin
          <small>Painel do administrador — acesso restrito por operador</small>
        </div>
      </header>
      <AdminScreen toast={toast} />
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
