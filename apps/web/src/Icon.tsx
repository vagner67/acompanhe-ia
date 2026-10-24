/** Ícones Acompanhe.IA — SVG stroke 24px, stroke-width 1.8, cantos redondos
 *  (linguagem de ícone de produto 2026: consistência de grid, sem emoji).
 *  Uso: <Icon name="home" />  · cor herdada via `currentColor`. */

const P: Record<string, string> = {
  home: "M4 11.2 12 4l8 7.2M6.2 9.8V19a1 1 0 0 0 1 1h3.2v-4.6h3.2V20h3.2a1 1 0 0 0 1-1V9.8",
  note: "M7 3.5h7.2L18.5 8v12.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1ZM13.8 3.7V8.3h4.5M8.8 12.4h6.6M8.8 15.9h6.6M8.8 19h4",
  scroll: "M6 4.5h10.5A2.5 2.5 0 0 1 19 7v2.2a2.3 2.3 0 0 0 0 4.6V16a2.5 2.5 0 0 1-2.5 2.5H8A2.5 2.5 0 0 1 5.5 16V7a2.5 2.5 0 0 1 .5-2.5Zm12 8H8M8 20.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  grad: "M3.5 9.2 12 5l8.5 4.2L12 13.4 3.5 9.2ZM6.8 11v4.4c0 1.5 2.3 2.8 5.2 2.8s5.2-1.3 5.2-2.8V11M20.5 9.2v4.8",
  scale: "M12 4.2v15.6M8.2 19.8h7.6M12 6.2l-5.4 1.6 2.2 5.6a2.7 2.7 0 0 1-4.4 0l2.2-5.6M12 6.2l5.4 1.6-2.2 5.6a2.7 2.7 0 0 0 4.4 0l-2.2-5.6M4.2 7.8h2.4M17.4 7.8h2.4",
  deal: "M8.2 12.2 11 15a1.7 1.7 0 0 0 2.4 0l4.6-4.6M3.8 9.2 7.6 5.4a1.8 1.8 0 0 1 1.3-.5h3.2a1.8 1.8 0 0 1 1.3.5l.7.7M20.2 9.2l-3-3M6.6 12.6 5.2 14a1.8 1.8 0 0 0 0 2.6l3.5 3.4a1.8 1.8 0 0 0 2.5 0l.9-.9M17.4 12.6l1.4 1.4a1.8 1.8 0 0 1 0 2.6l-1.8 1.8",
  search: "M10.8 4.6a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 0 0 0-12.4ZM15.4 15.4 20 20M9 10.8h3.6",
  star: "M12 4.4l2.3 4.7 5.2.7-3.8 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1L4.5 9.8l5.2-.7L12 4.4Z",
};

export function Icon({ name, size = 24 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={P[name] ?? P.star} />
    </svg>
  );
}
