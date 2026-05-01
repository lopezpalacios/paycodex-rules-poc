import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "../",
  server: { port: 5173, fs: { allow: [".."] } },
  build: { outDir: "../dist/ui" },
});
