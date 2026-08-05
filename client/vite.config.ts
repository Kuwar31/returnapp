import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  // Read the shared root .env so VITE_API_URL lives in one place.
  const env = loadEnv(mode, resolve(process.cwd(), ".."), "VITE_");

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_API_URL": JSON.stringify(
        env.VITE_API_URL ?? "http://localhost:4000",
      ),
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: env.VITE_API_URL ?? "http://localhost:4000",
          changeOrigin: true,
        },
      },
    },
  };
});
