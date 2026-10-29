// HostProc over the shell plugin's Command (architecture.md §2.2; S1, S2). Only git is in the shell
// scope. The child gets its own process group, so a timeout or an abort kills what git spawned too
// (ssh, remote helpers), as the Node host does. Nothing is ever written to its stdin (S1).
import { Command, type Child } from "@tauri-apps/plugin-shell";
import type { AuditEvent, HostProc, ProcResult } from "@loadout/core";

const SIGKILL = 9;

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

export function createTauriProc(audit: (event: AuditEvent) => void): HostProc {
  let nextProcId = 1;
  return {
    run(program, args, o) {
      const id = nextProcId++;
      const started = performance.now();
      audit({ kind: "proc:start", id, argv: [program, ...args], ...(o.cwd !== undefined && { cwd: o.cwd }) });
      const end = (code: number) => {
        const durationMs = Math.round(performance.now() - started);
        audit({ kind: "proc:end", id, code, durationMs });
        return durationMs;
      };

      return new Promise<ProcResult>((resolve, reject) => {
        if (o.signal?.aborted) {
          end(-1);
          return reject(abortError());
        }
        // env extends the app's environment (the plugin clears it only for env: null).
        const command = Command.create(program, args, {
          ...(o.cwd !== undefined && { cwd: o.cwd }),
          ...(o.env !== undefined && { env: o.env }),
          processGroup: true,
        });
        let stdout = "";
        let stderr = "";
        // The plugin streams line by line, each line keeping its newline.
        command.stdout.on("data", (line: string) => (stdout += line));
        command.stderr.on("data", (line: string) => (stderr += line));

        let child: Child | undefined;
        let killed = false;
        let aborted = false;
        const kill = () => {
          killed = true;
          void child?.kill().catch(() => {});
        };
        const timer = o.timeoutMs !== undefined ? setTimeout(kill, o.timeoutMs) : undefined;
        const onAbort = () => {
          aborted = true;
          kill();
        };
        o.signal?.addEventListener("abort", onAbort, { once: true });
        const settle = () => {
          clearTimeout(timer);
          o.signal?.removeEventListener("abort", onAbort);
        };

        command.on("close", ({ code, signal }: { code: number | null; signal: number | null }) => {
          settle();
          const exit = code ?? (signal === SIGKILL ? 137 : -1);
          const durationMs = end(exit);
          if (aborted) reject(abortError());
          else resolve({ code: exit, stdout, stderr, durationMs });
        });
        command.on("error", (message: string) => {
          settle();
          end(-1);
          reject(new Error(message));
        });
        command.spawn().then(
          (c) => {
            child = c;
            // A timeout or abort that came before the spawn finished.
            if (killed) void c.kill().catch(() => {});
          },
          (e: unknown) => {
            settle();
            end(-1);
            reject(e instanceof Error ? e : new Error(String(e)));
          },
        );
      });
    },
  };
}
