import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: `pnpm web` (API on WEB_PORT, default 3000) + `pnpm ui:dev` (this server,
// proxying /api so the browser stays same-origin). Prod: `pnpm ui:build` emits
// web/dist, which src/web/static.ts serves from the same process as the API.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${process.env.WEB_PORT ?? "3000"}`,
    },
  },
});
