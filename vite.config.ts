import { defineConfig, loadEnv } from "vite";

const app = process.env.APP;

/**
 * Dev: one server for all five apps, at /apps/<name>/. Build: APP=<name> builds
 * one app into dist/<name> for packing.
 * /ws goes to the HUD server, so each app talks to one origin only.
 */
export default defineConfig(({ mode }) => {
  // The server reads PORT from .env (tsx --env-file-if-exists); read the same value here.
  // The "PORT" prefix keeps every other .env value out of the Vite process.
  const serverPort = Number(loadEnv(mode, process.cwd(), "PORT").PORT ?? 8787);
  return app
    ? { root: `apps/${app}`, base: "./", build: { outDir: `../../dist/${app}`, emptyOutDir: true } }
    : {
        server: {
          host: true,
          port: 5173,
          strictPort: true,
          // The HUD server listens on loopback only.
          proxy: { "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true } },
          // The LAN may load the apps and their client code, not context.md, server/ or test/.
          fs: { allow: ["apps", "src"] },
        },
      };
});
