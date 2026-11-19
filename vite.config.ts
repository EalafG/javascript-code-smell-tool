import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));
const analysisFiles = ["validation/analysis.ts", "validation/research-analysis.ts", "validation/ResearchPanel.tsx", "validation/AnalysisApp.tsx", "validation/bootstrap.worker.ts"];
const analysisSourceHash = createHash("sha256").update(analysisFiles.map((file) => `${file}\n${readFileSync(resolve(rootDirectory, file), "utf8").replace(/\r\n/g, "\n")}`).join("\n")).digest("hex");
let buildRevision = "unavailable";
try { buildRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDirectory, encoding: "utf8" }).trim(); } catch { /* Source archives may not contain Git metadata. */ }

export default defineConfig({
  base: "./",
  define: {
    "import.meta.env.VITE_BUILD_REVISION": JSON.stringify(buildRevision),
    "import.meta.env.VITE_ANALYSIS_SOURCE_SHA256": JSON.stringify(analysisSourceHash),
  },
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["prism-react-renderer"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        detector: resolve(rootDirectory, "index.html"),
        validation: resolve(rootDirectory, "validation/index.html"),
      },
    },
  },
});
