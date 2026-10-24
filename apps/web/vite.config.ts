import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    // Browser nunca fala com localhost direto (preview): proxya tudo para a API.
    proxy: {
      "/api": "http://localhost:3000",
      "/v1": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: new URL("index.html", import.meta.url).pathname,
        admin: new URL("admin.html", import.meta.url).pathname,
      },
    },
  },
});
