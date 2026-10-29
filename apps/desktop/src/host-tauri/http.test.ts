import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { createTauriHttp } from "./http.ts";

type ClientConfig = { method: string; url: string; headers: [string, string][]; data: number[] | null };

/**
 * plugin-http behind mockIPC. `respond` answers a request, or returns "hang" to leave fetch_send waiting
 * until fetch_cancel, which then fails it as the plugin does. The body is read in one chunk, then the
 * end marker (a trailing 1 byte).
 */
function mockHttp(respond: (req: ClientConfig) => { status: number; headers?: [string, string][]; body?: string } | "hang") {
  const requests: ClientConfig[] = [];
  const cancelled: number[] = [];
  const pending = new Map<number, (e: unknown) => void>();
  const bodies = new Map<number, number[][]>();
  mockIPC((cmd, payload) => {
    const a = payload as { clientConfig?: ClientConfig; rid?: number };
    switch (cmd) {
      case "plugin:http|fetch":
        requests.push(a.clientConfig!);
        return requests.length;
      case "plugin:http|fetch_send": {
        const answer = respond(requests[a.rid! - 1]!);
        if (answer === "hang") return new Promise((_, reject) => pending.set(a.rid!, reject));
        const bytes = Array.from(new TextEncoder().encode(answer.body ?? ""));
        bodies.set(100 + a.rid!, [[...bytes, 0], [1]]);
        return { status: answer.status, statusText: "", url: requests[a.rid! - 1]!.url, headers: answer.headers ?? [], rid: 100 + a.rid! };
      }
      case "plugin:http|fetch_read_body":
        return bodies.get(a.rid!)!.shift()!;
      case "plugin:http|fetch_cancel":
        cancelled.push(a.rid!);
        pending.get(a.rid!)?.("Request cancelled");
        return null;
      case "plugin:http|fetch_cancel_body":
        return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  return { requests, cancelled };
}

afterEach(() => clearMocks());

describe("host-tauri http", () => {
  it("sends method, headers and body through the plugin and returns status, headers and text", async () => {
    const http = mockHttp(() => ({ status: 201, headers: [["content-type", "application/json"]], body: '{"html_url":"https://github.com/o/r/pull/1"}' }));
    const res = await createTauriHttp().request({
      method: "POST",
      url: "https://api.github.com/repos/o/r/pulls",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: '{"title":"x"}',
    });
    expect(res).toEqual({ status: 201, headers: { "content-type": "application/json" }, body: '{"html_url":"https://github.com/o/r/pull/1"}' });
    const sent = http.requests[0]!;
    expect(sent).toMatchObject({ method: "POST", url: "https://api.github.com/repos/o/r/pulls" });
    expect(Object.fromEntries(sent.headers)).toMatchObject({ authorization: "Bearer t" });
    expect(new TextDecoder().decode(new Uint8Array(sent.data!))).toBe('{"title":"x"}');
  });

  it("a timeout cancels the request and rejects with TimeoutError", async () => {
    const http = mockHttp(() => "hang");
    await expect(createTauriHttp().request({ method: "GET", url: "https://api.github.com/user", timeoutMs: 20 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(http.cancelled).toEqual([1]);
  });

  it("an abort cancels the request and rejects with AbortError", async () => {
    const http = mockHttp(() => "hang");
    const controller = new AbortController();
    const pending = createTauriHttp().request({ method: "GET", url: "https://api.bitbucket.org/2.0/user", signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(http.cancelled).toEqual([1]);
  });
});
