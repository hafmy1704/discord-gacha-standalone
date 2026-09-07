import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const configuredPort = Number(env.PORT);
  const backendPort = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : 3000;
  const backendHost = env.VITE_BACKEND_HOST?.trim() || "127.0.0.1";
  const targetHost = backendHost.includes(":") && !backendHost.startsWith("[")
    ? `[${backendHost}]`
    : backendHost;
  const backendTarget = `http://${targetHost}:${backendPort}`;
  const allowedHosts = (env.VITE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    plugins: [react()],
    server: {
      allowedHosts,
      proxy: {
        "/.proxy": {
          target: backendTarget,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("error", (_error, _request, response) => {
              if (!response.headersSent) {
                response.writeHead(502, {
                  "cache-control": "no-store",
                  "content-type": "application/json; charset=utf-8",
                });
              }
              response.end(JSON.stringify({ error: "backend_unavailable" }));
            });
          },
        },
        "/api": {
          target: backendTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom"],
            phaser: ["phaser"],
            discord: ["@discord/embedded-app-sdk"],
          },
        },
      },
    },
  };
});
