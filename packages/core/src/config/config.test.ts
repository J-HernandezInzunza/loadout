import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "../../test/sandbox.ts";
import type { Host } from "../host.ts";
import { createConfigStore, type AppConfigV1 } from "./config.ts";

const config: AppConfigV1 = {
  version: 1,
  catalogs: [
    { id: "mine", kind: "local", path: "/Users/you/library.yaml" },
    { id: "team", kind: "remote", repo: "git@bitbucket.org:ws/lib.git", yamlPath: "library.yaml", branch: "main", protected: true, writable: true },
  ],
  pins: { "commit-and-push": "team" },
  settings: {},
  imported: { from: "/Users/you/tool/config.local.yaml", at: "2026-10-28T12:00:00.000Z", configSha256: "ab".repeat(32) },
};

async function setup(wrap: (host: Host) => Host = (h) => h) {
  const sb = await createSandbox();
  const host = wrap(sb.host);
  return { host, file: join(host.paths.appData, "config.json"), store: createConfigStore(host) };
}

describe("config store", () => {
  it("LOCK-01: round-trips a config through an atomic write", async () => {
    const { store, file } = await setup();
    expect(await store.saveConfig(config)).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(config);
    expect(await store.loadConfig()).toEqual({ ok: true, value: { state: "ready", config }, warnings: [] });
  });

  it("reports no catalogs registered when the file is missing or lists none", async () => {
    const { store } = await setup();
    const empty = { version: 1, catalogs: [], pins: {}, settings: {} };
    expect(await store.loadConfig()).toMatchObject({ ok: true, value: { state: "no-catalogs", config: empty } });
    await store.saveConfig(empty as AppConfigV1);
    expect(await store.loadConfig()).toMatchObject({ ok: true, value: { state: "no-catalogs" } });
  });

  it.each([
    ["not JSON", "{"],
    ["a future version", JSON.stringify({ ...config, version: 2 })],
    ["a key Loadout dropped", JSON.stringify({ ...config, settings: { autopush: true } })],
    ["an unknown key", JSON.stringify({ ...config, extra: 1 })],
    ["a catalog with an unknown field", JSON.stringify({ ...config, catalogs: [{ ...config.catalogs[0], gitCommit: true }] })],
  ])("LOCK-01: refuses %s and never overwrites it", async (_, text) => {
    const { store, file } = await setup();
    await writeFile(file, text);
    expect(await store.loadConfig()).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(await store.saveConfig(config)).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("LOCK-01: lands two concurrent saves in the order they were made", async () => {
    const written: string[] = [];
    const { store, file } = await setup((host) => ({
      ...host,
      fs: {
        ...host.fs,
        // The first write is the slow one: without a queue the older config would land last.
        async writeTextAtomic(path, text) {
          if (written.length === 0) await new Promise((r) => setTimeout(r, 30));
          written.push(JSON.parse(text).pins.order);
          return host.fs.writeTextAtomic(path, text);
        },
      },
    }));
    const first = store.saveConfig({ ...config, pins: { order: "first" } });
    const second = store.saveConfig({ ...config, pins: { order: "second" } });
    expect([await first, await second]).toMatchObject([{ ok: true }, { ok: true }]);
    expect(written).toEqual(["first", "second"]);
    expect(JSON.parse(await readFile(file, "utf8")).pins).toEqual({ order: "second" });
  });

  it("keeps no state between two stores", async () => {
    const { host } = await setup();
    await createConfigStore(host).saveConfig(config);
    expect(await createConfigStore(host).loadConfig()).toMatchObject({ ok: true, value: { state: "ready" } });
  });
});
