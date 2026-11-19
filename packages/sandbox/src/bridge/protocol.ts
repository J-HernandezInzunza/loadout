// The wire between browser mode's bridge host and the demo server: one JSON POST per Host call. Runs in
// both, so it imports nothing from Node. Bytes travel as base64; an AbortSignal travels as a marker the
// server swaps for one it aborts when the request is dropped; an error keeps its name and code.
import type { ApiBases, AuditEvent, Host } from "@loadout/core";

/** Every Host call that crosses the wire; `now`, `sha256`, `paths` and `audit` stay in the browser. */
export const hostMethods = [
  "fs.readText",
  "fs.readBytes",
  "fs.writeTextAtomic",
  "fs.writeBytes",
  "fs.exists",
  "fs.stat",
  "fs.lstat",
  "fs.realPath",
  "fs.readDir",
  "fs.mkdirp",
  "fs.rename",
  "fs.copyFile",
  "fs.remove",
  "fs.makeTempDir",
  "proc.run",
  "proc.which",
  "secrets.get",
  "secrets.set",
  "secrets.delete",
  "http.request",
] as const;
export type HostMethod = (typeof hostMethods)[number];

export interface BridgeCall {
  method: HostMethod;
  args: unknown[];
}

export interface WireError {
  name: string;
  message: string;
  code?: string;
}

/** `audit`: the server-side events (git runs) since the last reply, so the browser's log shows them. */
export type BridgeReply = ({ ok: true; value: unknown } | { ok: false; error: WireError }) & { audit: AuditEvent[] };

/** What the browser needs before it can build a Library: the sandbox's paths and the API stub's bases. */
export interface Session {
  paths: Host["paths"];
  apiBases: ApiBases;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // In chunks: fromCharCode takes its arguments on the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A value ready for JSON: bytes as `{ $bytes }`, a signal as `{ $signal: true }`. */
export function encode(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $bytes: toBase64(v) };
  if (v instanceof AbortSignal) return { $signal: true };
  if (Array.isArray(v)) return v.map(encode);
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}

/** The inverse of encode; a signal marker becomes `signal`, which the caller aborts. */
export function decode(v: unknown, signal?: AbortSignal): unknown {
  if (Array.isArray(v)) return v.map((x) => decode(x, signal));
  if (!isPlain(v)) return v;
  if (typeof v.$bytes === "string") return fromBase64(v.$bytes);
  if (v.$signal === true) return signal;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x, signal)]));
}

export function toWire(e: unknown): WireError {
  if (!(e instanceof Error) && !(e instanceof DOMException)) return { name: "Error", message: String(e) };
  const code = (e as { code?: unknown }).code;
  return { name: e.name, message: e.message, ...(typeof code === "string" && { code }) };
}

/** An AbortError or TimeoutError comes back as the DOMException fetch and AbortSignal throw. */
export function fromWire(w: WireError): Error {
  if (w.name === "AbortError" || w.name === "TimeoutError") return new DOMException(w.message, w.name);
  const e = Object.assign(new Error(w.message), w.code === undefined ? {} : { code: w.code });
  e.name = w.name;
  return e;
}
