import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const cloudBuild = env.NETLIFY === "true" || env.VITE_DEPLOYMENT === "cloud";

  if (cloudBuild && env.VITE_AUTH_REQUIRED !== "true") {
    throw new Error(
      "Cloud builds require VITE_AUTH_REQUIRED=true; refusing to build an unprotected finance UI.",
    );
  }

  return {
    plugins: [react()],
    build: {
      emptyOutDir: false,
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api": "http://127.0.0.1:8000",
      },
    },
  };
});
