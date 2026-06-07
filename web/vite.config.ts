import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Le front parle à la gateway. En dev, on proxifie /api (HTTP) et /ws (WebSocket)
// vers elle : ainsi tout est same-origin, le cookie de session part sur le
// handshake WS et la gateway peut authentifier + filtrer le flux par droits.
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
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
});
