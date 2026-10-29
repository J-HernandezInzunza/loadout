// The only system boundary the core sees (architecture.md §2.2). Implemented by
// @loadout/host-node (tests, future agent host) and apps/desktop's host-tauri.

export type FileKind = "file" | "dir" | "symlink";

export interface HostFs {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** temp file in the same directory + rename; never leaves a half-written file */
  writeTextAtomic(path: string, text: string): Promise<void>;
  writeBytes(path: string, data: Uint8Array, opts?: { mode?: number }): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** follows links */
  stat(path: string): Promise<{ kind: FileKind; size: number; mode: number }>;
  lstat(path: string): Promise<{ kind: FileKind; size: number; mode: number }>;
  /** the path with every symlink resolved; rejects { code: "ENOENT" } when missing */
  realPath(path: string): Promise<string>;
  readDir(path: string): Promise<{ name: string; kind: FileKind }[]>;
  mkdirp(path: string): Promise<void>;
  /** rejects { code: "EXDEV" } across volumes */
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** under <appData>/tmp */
  makeTempDir(prefix: string): Promise<string>;
}

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface HostProc {
  run(
    program: "git",
    args: string[],
    opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ProcResult>;
}

/** macOS Keychain in the app (architecture.md §5.5); in memory on the Node host. */
export interface HostSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /** names lowercased */
  headers: Record<string, string>;
  body: string;
}

/** Host REST APIs and OAuth endpoints only. Rejects with AbortError or TimeoutError. */
export interface HostHttp {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface Host {
  fs: HostFs;
  proc: HostProc;
  secrets: HostSecrets;
  http: HostHttp;
  paths: { home: string; appData: string };
  now(): Date;
  /** hex */
  sha256(data: Uint8Array): Promise<string>;
  /** process + destructive-fs log (W17) */
  audit(event: AuditEvent): void;
}

export type AuditEvent =
  | { kind: "proc:start"; id: number; argv: string[]; cwd?: string }
  | { kind: "proc:end"; id: number; code: number; durationMs: number }
  | { kind: "fs"; op: "write" | "delete" | "move" | "copy-tree"; path: string; to?: string };
