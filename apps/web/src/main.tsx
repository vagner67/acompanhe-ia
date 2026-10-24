import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { getTelegramWebApp } from "./telegram";

getTelegramWebApp()?.ready();
getTelegramWebApp()?.expand();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
