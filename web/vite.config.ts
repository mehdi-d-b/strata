import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Le front parle à la gateway. En dev, on proxifie /api (HTTP) vers elle pour
// éviter les soucis de CORS. Le WebSocket, lui, se connecte directement à la
// gateway (port 3001) côté client — le proxy WS de Vite est peu fiable.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
});
