// HostHttp over tauri-plugin-http (architecture.md §2.2, §5.5): the host REST APIs and OAuth endpoints,
// and nothing else (the capability's URL scope). The plugin cancels the Rust request on abort; the wait
// is also raced against the signal so an abort or timeout settles at once, with the signal's reason
// (AbortError, or TimeoutError for the timeout), as Node's fetch does.
import { fetch } from "@tauri-apps/plugin-http";
import type { HostHttp } from "@loadout/core";

export function createTauriHttp(): HostHttp {
  return {
    async request(req) {
      const signals = [...(req.signal ? [req.signal] : []), ...(req.timeoutMs !== undefined ? [AbortSignal.timeout(req.timeoutMs)] : [])];
      const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
      const stopped = new Promise<never>((_, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      // Marks the rejection handled when the request finishes first.
      stopped.catch(() => {});

      const res = await Promise.race([
        fetch(req.url, {
          method: req.method,
          ...(req.headers && { headers: req.headers }),
          ...(req.body !== undefined && { body: req.body }),
          ...(signal && { signal }),
        }),
        stopped,
      ]);
      const body = await Promise.race([res.text(), stopped]);
      return { status: res.status, headers: Object.fromEntries(res.headers), body };
    },
  };
}
