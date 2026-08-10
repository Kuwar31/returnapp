import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, loadEnv } from "vite";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  // Read the shared root .env so VITE_API_URL lives in one place.
  const env = loadEnv(mode, resolve(process.cwd(), ".."), "VITE_");
  const apiUrl = env.VITE_API_URL ?? "http://localhost:4000";

  return {
    plugins: [reactRouter()],
    define: {
      "import.meta.env.VITE_API_URL": JSON.stringify(apiUrl),
    },
    server: {
      port: 5173,
    },
  };
});
