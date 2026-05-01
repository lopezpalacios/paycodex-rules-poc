import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // Serve from project root so the UI can fetch ../wasm/build/*, ../rules/examples/*,
  // ../.deployments/*, and ../artifacts/contracts/* directly via static URLs.
  root: resolve(__dirname, ".."),
  publicDir: false,
  server: {
    port: 5173,
    open: "/ui/index.html",
    fs: { allow: [resolve(__dirname, "..")] },
  },
  build: {
    outDir: resolve(__dirname, "../dist/ui"),
    rollupOptions: { input: resolve(__dirname, "index.html") },
  },
});
