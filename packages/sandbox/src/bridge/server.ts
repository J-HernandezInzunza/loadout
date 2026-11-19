// The demo server behind browser mode (M16.04): a seeded sandbox and API stub, the bridge that answers
// the browser's Host calls from them, and a reset that swaps in a fresh pair. Mounted at /__demo on the
// Vite dev server by demoBridge(); loopback only.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { createApiStub, type ApiStub } from "../apiStub.ts";
import { seedDemo } from "../demo.ts";
import { createSandbox, type Sandbox } from "../sandbox.ts";
import { decode, encode, hostMethods, toWire, type BridgeCall, type BridgeReply, type HostMethod, type Session } from "./protocol.ts";

export interface DemoServer {
  /** connect-style, with `req.url` relative to the mount point */
  middleware(req: IncomingMessage, res: ServerResponse, next: () => void): void;
  /** the current sandbox's root */
  root(): string;
  /** removes the sandbox and closes the stub */
  close(): Promise<void>;
}

interface Run {
  sandbox: Sandbox;
  stub: ApiStub;
  cleanups: (() => Promise<void>)[];
  /** how many of sandbox.audit the browser has been sent */
  delivered: number;
}

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function start(): Promise<Run> {
  const cleanups: Run["cleanups"] = [];
  const defer = (cleanup: () => Promise<void>) => void cleanups.push(cleanup);
  const sandbox = await createSandbox(defer);
  const stub = await createApiStub(defer);
  await seedDemo(sandbox, stub);
  return { sandbox, stub, cleanups, delivered: sandbox.audit.length };
}

/** Runs every clean-up; an escape the sandbox recorded is reported, not thrown, so a reset still goes on. */
async function stop(run: Run): Promise<void> {
  for (const cleanup of run.cleanups.reverse()) {
    try {
      await cleanup();
    } catch (e) {
      console.warn(`[demo] ${(e as Error).message}`);
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8").on("data", (d: string) => (body += d));
    req.on("end", () => resolve(body)).on("error", reject);
  });
}

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

async function answer(run: Run, call: BridgeCall, res: ServerResponse): Promise<void> {
  // The browser dropping the request (its signal aborted) aborts the call here.
  const aborted = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) aborted.abort();
  });
  const [group, name] = call.method.split(".") as [keyof Sandbox["host"], string];
  const target = run.sandbox.host[group] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  let reply: BridgeReply;
  try {
    const value = await target[name]!(...(decode(call.args, aborted.signal) as unknown[]));
    reply = { ok: true, value: encode(value), audit: [] };
  } catch (e) {
    reply = { ok: false, error: toWire(e), audit: [] };
  }
  reply.audit = run.sandbox.audit.slice(run.delivered);
  run.delivered = run.sandbox.audit.length;
  if (!res.destroyed) json(res, 200, reply);
}

export async function createDemoServer(): Promise<DemoServer> {
  let run = await start();

  async function route(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (!loopback.has(req.socket.remoteAddress ?? "")) return json(res, 403, { error: "the demo bridge answers loopback only" });
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/session") {
      const session: Session = { paths: run.sandbox.host.paths, apiBases: run.stub.bases };
      return json(res, 200, session);
    }
    if (req.method === "POST" && path === "/reset") {
      const old = run;
      run = await start();
      await stop(old);
      return res.writeHead(204).end();
    }
    if (req.method === "POST" && path === "/host") {
      const call = JSON.parse(await readBody(req)) as BridgeCall;
      if (!hostMethods.includes(call.method as HostMethod)) return json(res, 400, { error: `not a Host call: ${String(call.method)}` });
      return answer(run, call, res);
    }
    next();
  }

  return {
    middleware(req, res, next) {
      route(req, res, next).catch((e: unknown) => {
        if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      });
    },
    root: () => run.sandbox.root,
    close: () => stop(run),
  };
}

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
      demo = await createDemoServer();
      server.middlewares.use("/__demo", demo.middleware);
    },
    async buildEnd() {
      await demo?.close();
      demo = undefined;
    },
  };
}
