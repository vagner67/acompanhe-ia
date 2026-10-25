/** Componentes visuais pequenos da tela jurídica (plano-refatoracao-ui §5). */
import { useEffect, type ReactNode } from "react";

/**
 * Bottom sheet acessível. Substitui o card gigante de diagnóstico: mesmo
 * conteúdo real, fora do caminho de quem só quer buscar. Não é sanfona — é
 * diálogo com foco próprio, Esc e clique no fundo.
 */
export function Sheet({
  aberto,
  titulo,
  onFechar,
  children,
}: {
  aberto: boolean;
  titulo: string;
  onFechar: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!aberto) return;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFechar();
    };
    document.addEventListener("keydown", aoTeclar);
    const overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", aoTeclar);
      document.body.style.overflow = overflowAnterior;
    };
  }, [aberto, onFechar]);

  if (!aberto) return null;
  return (
    <div className="sheet-overlay" onClick={onFechar} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h3>{titulo}</h3>
          <button className="sheet-x" onClick={onFechar} aria-label="fechar">
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Chip({
  children,
  ativo,
  onClick,
  titulo,
}: {
  children: ReactNode;
  ativo?: boolean;
  onClick: () => void;
  titulo?: string;
}) {
  return (
    <button className={`chip${ativo ? " on" : ""}`} onClick={onClick} title={titulo} type="button">
      {children}
    </button>
  );
}

export function SkeletonLista({ linhas = 3 }: { linhas?: number }) {
  return (
    <div className="sk-list" aria-hidden="true">
      {Array.from({ length: linhas }).map((_, i) => (
        <div key={i} className="sk-row">
          <div className="skeleton" style={{ width: "62%" }} />
          <div className="skeleton" style={{ width: "40%", height: 10 }} />
        </div>
      ))}
    </div>
  );
}

/** Selo do grau de certeza do vínculo (0–1). Só aparece quando há score. */
export function ScoreBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const cls = pct >= 90 ? "green" : pct >= 60 ? "amber" : "";
  return (
    <span className={`tag ${cls}`} title="grau de certeza do vínculo entre a consulta e este processo">
      {pct}%
    </span>
  );
}

export function Vazio({ titulo, dica }: { titulo: string; dica?: string }) {
  return (
    <div className="empty">
      <strong style={{ display: "block", marginBottom: 4 }}>{titulo}</strong>
      {dica && <span className="mut">{dica}</span>}
    </div>
  );
}
