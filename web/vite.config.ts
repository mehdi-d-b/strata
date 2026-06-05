import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Le front parle à la gateway. En dev, on proxifie /api (HTTP) vers elle pour
// éviter les soucis de CORS. Le WebSocket, lui, se connecte directement à la
// gateway (port 3001) côté client — le proxy WS de Vite est peu fiable.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Alias @ -> src (requis par shadcn/ui).
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
});
