// The Host browser mode runs the core over (M16.04): each I/O call is a POST to the demo server, which
// answers it from the sandbox. Browser-safe: no Node imports.
import type { AuditEvent, Host, HostFs } from "@loadout/core";
import { decode, encode, fromWire, type BridgeReply, type HostMethod, type Session } from "./protocol.ts";

export type { Session };

/** The sandbox's paths and the API stub's bases; they change with each reset, so read them at page load. */
export async function fetchSession(base: string): Promise<Session> {
  const res = await fetch(`${base}/session`);
  if (!res.ok) throw new Error(`demo session: ${res.status} ${await res.text()}`);
  return (await res.json()) as Session;
}

async function sha256(data: Uint8Array): Promise<string> {
  // A copy, since subtle.digest takes only ArrayBuffer-backed views.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const fsMethods = [
  "readText",
  "readBytes",
  "writeTextAtomic",
  "writeBytes",
  "exists",
  "stat",
  "lstat",
  "realPath",
  "readDir",
  "mkdirp",
  "rename",
  "copyFile",
  "remove",
  "makeTempDir",
] as const satisfies (keyof HostFs)[];

/**
 * `base` is the bridge's URL (`/__demo` on the dev server). `onAudit` receives the browser's own events
 * and, after each call, the git runs the server made for it.
 */
export function createBridgeHost(base: string, paths: Host["paths"], onAudit: (event: AuditEvent) => void = () => {}): Host {
  async function call(method: HostMethod, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    // A dropped request is how the server learns of an abort; fetch rejects with the AbortError itself.
    const res = await fetch(`${base}/host`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, args: encode(args) }),
      ...(signal && { signal }),
    });
    if (!res.ok) throw new Error(`${method}: the demo server answered ${res.status}: ${await res.text()}`);
    const reply = (await res.json()) as BridgeReply;
    for (const event of reply.audit) onAudit(event);
    if (!reply.ok) throw fromWire(reply.error);
    return decode(reply.value);
  }

  const fs = Object.fromEntries(fsMethods.map((m) => [m, (...args: unknown[]) => call(`fs.${m}`, args)])) as unknown as HostFs;
  return {
    fs,
    proc: {
      run: (program, args, opts) => call("proc.run", [program, args, opts], opts.signal) as ReturnType<Host["proc"]["run"]>,
      which: (program) => call("proc.which", [program]) as Promise<string | null>,
    },
    secrets: {
      get: (key) => call("secrets.get", [key]) as Promise<string | null>,
      set: async (key, value) => void (await call("secrets.set", [key, value])),
      delete: async (key) => void (await call("secrets.delete", [key])),
    },
    http: { request: (req) => call("http.request", [req], req.signal) as ReturnType<Host["http"]["request"]> },
    paths,
    now: () => new Date(),
    sha256,
    audit: onAudit,
  };
}
