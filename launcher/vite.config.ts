import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port fixe attendu par tauri.conf.json (devUrl). strictPort : on échoue plutôt
// que de glisser sur un autre port que Tauri ne connaîtrait pas.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
