// The Vite plugin for browser mode (M16.04). The dev server's config loads this file with Node's own
// TypeScript support, which can't run the core's syntax, so it imports only types and Vite; the demo
// server itself is loaded through Vite's module runner, which transforms the workspace packages.
import { isRunnableDevEnvironment, type Plugin } from "vite";
import type * as Sandbox from "../index.ts";
import type { DemoServer } from "./server.ts";

/**
 * Serves the bridge at /__demo on the dev server, bound to loopback; the sandbox is removed when the
 * server closes. Add it to the config in browser mode only.
 */
export function demoBridge(): Plugin {
  let demo: DemoServer | undefined;
  return {
    name: "loadout-demo-bridge",
    apply: "serve",
    config: () => ({ server: { host: "127.0.0.1" } }),
    async configureServer(server) {
      const ssr = server.environments.ssr;
      if (!ssr || !isRunnableDevEnvironment(ssr)) throw new Error("the demo bridge needs Vite's runnable ssr environment");
      const { createDemoServer } = await ssr.runner.import<typeof Sandbox>("@loadout/sandbox");
      demo = await createDemoServer();
      server.middlewares.use("/__demo", demo.middleware);
      // Vite closes the server (and so buildEnd) on SIGTERM, but Ctrl-C would exit without it.
      process.once("SIGINT", () => void server.close().finally(() => process.exit(130)));
    },
    async buildEnd() {
      await demo?.close();
      demo = undefined;
    },
  };
}
