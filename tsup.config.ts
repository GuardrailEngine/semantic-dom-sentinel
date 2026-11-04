import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs", "iife"],
  globalName: "SemanticDomSentinel",
  target: "es2022",
  dts: true,
  clean: true,
  outDir: "dist",
});
