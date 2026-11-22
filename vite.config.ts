import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  root: "web",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "web/src") } },
  build: { outDir: "../dist", emptyOutDir: true, assetsDir: "app-assets", chunkSizeWarningLimit: 900 },
  server: { port: 5173, proxy: { "/api": "http://localhost:4000", "/healthz": "http://localhost:4000" } },
});
