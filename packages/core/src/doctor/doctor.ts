// Doctor (behaviors.md §2.10, the checks tagged mvp, with the rebuild's changes): the environment,
// the config, each remote catalog's clone and reachability, accounts for PR writes, each catalog's
// content, overrides and pins, the install dirs, and managed settings. Findings are typed, with a
// stable check id; a diverged clone carries the re-clone action that fixes it (A4).
import type { Accounts, AccountHost } from "../accounts/accounts.ts";
import { catalogEntries, parseCatalog, sortedProblems } from "../catalog/read.ts";
import { catalogStatus, catalogUrls, cloneDir, refreshCatalogs, sameRepo } from "../catalogs/catalogs.ts";
import type { ClaudeSettings } from "../claudeSettings/settings.ts";
import { managedSettingsFile, managedSkillOverrides } from "../claudeSettings/toggle.ts";
import type { ConfigStore } from "../config/config.ts";
import { findCycles } from "../deps/deps.ts";
import type { GitClient } from "../git/git.ts";
import { createOperation } from "../git/operation.ts";
import type { Host } from "../host.ts";
import { LibraryError, ok, type CatalogRef, type Entry, type Result } from "../model/model.ts";
import type { ReceiptStore } from "../receipts/receipts.ts";
import { loadRegistry } from "../registry/registry.ts";
import { installDirs, scanInstallDirs } from "../scan/scan.ts";
import { parseSource, remoteWeb } from "../source/source.ts";

export interface DoctorCtx {
  host: Host;
  git: GitClient;
  config: ConfigStore;
  receipts: ReceiptStore;
  settings: ClaudeSettings;
  /** absent: no account can be connected, so PR writes always fall back to a link */
  accounts?: Pick<Accounts, "tokenFor" | "whoami">;
  /** for tests; the macOS path otherwise */
  managedSettingsFile?: string;
}

export interface Finding {
  /** stable id: the §2.10 check number, or a name for the rebuild's own checks */
  check: string;
  severity: "error" | "warning";
  catalog: string | null;
  entry: string | null;
  message: string;
  /** A4: what fixes it, when Loadout can */
  /** what fixes it: re-cloning a catalog, or replacing content Loadout didn't install with the catalog's copy (Q8 A) */
  action?: { kind: "reclone"; catalog: string } | { kind: "replace"; name: string; dest: string };
}

export interface DoctorReport {
  status: "ok" | "problems";
  /** active entries checked */
  entries: number;
  errors: Finding[];
  warnings: Finding[];
}

type RemoteRef = Extract<CatalogRef, { kind: "remote" }>;
const TYPES = ["skill", "agent", "prompt"] as const;
const hostNames: Record<string, { account: AccountHost; label: string }> = {
  "github.com": { account: "github", label: "GitHub" },
  "bitbucket.org": { account: "bitbucket", label: "Bitbucket" },
};

export async function doctor(ctx: DoctorCtx, opts: { deep?: boolean; noPull?: boolean } = {}): Promise<Result<DoctorReport>> {
  const { host, git } = ctx;
  const findings: Finding[] = [];
  const add = (check: string, severity: Finding["severity"], catalog: string | null, entry: string | null, message: string, action?: Finding["action"]) =>
    findings.push({ check, severity, catalog, entry, message, ...(action && { action }) });
  const done = (entries: number) => {
    const errors = findings.filter((f) => f.severity === "error");
    return ok<DoctorReport>({ status: findings.length === 0 ? "ok" : "problems", entries, errors, warnings: findings.filter((f) => f.severity === "warning") });
  };

  // ── Environment: git runs, and isn't Apple's shim without the Command Line Tools ──
  try {
    const v = await host.proc.run("git", ["--version"], { timeoutMs: 10_000 });
    if (v.code !== 0) {
      const shim = /xcrun|xcode-select|developer tools/i.test(v.stderr);
      add(shim ? "xcode" : "git", "error", null, null, shim ? "the Xcode Command Line Tools are missing; run `xcode-select --install`" : `git doesn't run: ${v.stderr.trim() || `exit ${v.code}`}`);
    }
  } catch {
    add("git", "error", null, null, "git isn't installed, or isn't on the PATH Loadout sees");
  }

  // ── 3, 4: the config ──
  const configFile = `${host.paths.appData}/config.json`;
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) {
    add("4", "error", null, null, loaded.error.message);
    return done(0);
  }
  if (loaded.value.state === "no-catalogs") {
    add("3", "error", null, null, (await host.fs.exists(configFile)) ? "no catalogs registered" : `no config at ${configFile}; register a catalog to start`);
    return done(0);
  }
  const config = loaded.value.config;
  const remotes = config.catalogs.filter((c): c is RemoteRef => c.kind === "remote");

  // ── 7–10: each remote catalog's clone and repo ──
  for (const ref of remotes) {
    const clone = cloneDir(host, ref.id);
    if (!(await host.fs.exists(clone))) {
      add("7", "warning", ref.id, null, `catalog not yet cloned at ${clone}; it clones on the next refresh`);
    } else {
      const origin = await git.originUrl(clone);
      if (origin === "") add("8", "error", ref.id, null, "catalog clone is missing its 'origin' remote; re-clone it", { kind: "reclone", catalog: ref.id });
      else if (!sameRepo(origin, ref.repo)) add("9", "warning", ref.id, null, `catalog clone remote (${origin}) differs from the catalog's repo (${ref.repo})`);
    }
    if ((await git.lsRemoteHead(await catalogUrls(git, ref), ref.branch)) === null) {
      add("10", "error", ref.id, null, `catalog repo unreachable, or it has no branch '${ref.branch}' (${ref.repo})`);
    }
  }

  // ── 11 (rebuild): a connected account whose token works, per host with a protected catalog ──
  const prHosts = new Map<string, string[]>();
  for (const ref of remotes.filter((r) => r.protected)) {
    const h = remoteWeb(ref.repo)?.[0];
    if (h !== undefined && h in hostNames) prHosts.set(h, [...(prHosts.get(h) ?? []), ref.id]);
  }
  for (const [h, ids] of prHosts) {
    const { account, label } = hostNames[h]!;
    const token = ctx.accounts ? await ctx.accounts.tokenFor(account) : null;
    if (!token?.ok) {
      add("accounts", "warning", null, null, `no ${label} account connected: writes to ${ids.map((i) => `'${i}'`).join(", ")} give a link to open the PR by hand; connect ${label} in Accounts`);
      continue;
    }
    const who = await ctx.accounts!.whoami(account, token.value);
    if (!who.ok) {
      const why = who.error.code === "AUTH_FAILED" ? "its token no longer works; connect it again in Accounts" : `couldn't check it (${who.error.message})`;
      add("accounts", "warning", null, null, `the ${label} account: ${why}`);
    }
  }

  // ── 13: pull every remote, then 14 (RCAT-07): staleness, and A4: diverged clones ──
  const pullErrors = new Map<string, string>();
  if (!opts.noPull) {
    const refreshed = await refreshCatalogs(host, git, config.catalogs);
    for (const w of refreshed.warnings) {
      const id = /^catalog '([^']+)'/.exec(w.message)?.[1] ?? null;
      if (id) pullErrors.set(id, w.message);
      add("13", "warning", id, null, w.message);
    }
  }
  for (const ref of remotes) {
    const status = await catalogStatus(host, git, ref);
    if (status.state !== "cloned") continue;
    if (status.diverged) {
      add("diverged", "error", ref.id, null, `clone has diverged from origin/${ref.branch} (${status.ahead} local commit(s) not on origin); re-clone it to recover`, { kind: "reclone", catalog: ref.id });
    } else if (status.behind === "unknown") {
      add("14", "warning", ref.id, null, `couldn't check whether the clone is behind origin/${ref.branch}`);
    } else if (status.behind > 0) {
      const reason = pullErrors.has(ref.id) ? `pull failed: ${pullErrors.get(ref.id)}` : "catalog was not refreshed";
      add("14", "warning", ref.id, null, `clone is ${status.behind} commit(s) behind origin/${ref.branch} (${reason})`);
    }
  }

  // ── 15: catalogs that couldn't be read (an absent clone is check 7) ──
  const registry = await loadRegistry(host, config);
  for (const c of registry.catalogs()) {
    if (c.skipped === undefined || c.skipped.startsWith("not cloned yet")) continue;
    add("15", "error", c.ref.id, null, c.skipped);
  }

  // ── 16–26: each catalog's content ──
  const op = opts.deep ? await createOperation(host, git) : null;
  try {
    for (const c of registry.active()) {
      const id = c.ref.id;
      const entries = c.entries;
      const parsed = parseCatalog(await host.fs.readText(c.file));
      const data = parsed.ok && typeof parsed.data === "object" && parsed.data !== null ? (parsed.data as Record<string, unknown>) : {};
      const dirs = data.default_dirs;
      if (dirs) {
        const fixed = Object.values(installDirs(host.paths.home)).join(", ");
        add("16", "warning", id, null, `catalog declares default_dirs, which has no effect: Loadout installs to ${fixed}`);
        const legacy = TYPES.map((t) => `${t}s`).filter((s) => {
          const scopes = (dirs as Record<string, unknown>)[s];
          return Array.isArray(scopes) && scopes.some((i) => typeof i === "object" && i !== null && "default" in i);
        });
        if (legacy.length > 0) add("17", "warning", id, null, `default_dirs uses the legacy 'default' scope key (${legacy.join(", ")}) — rename it to 'project' in the catalog`);
      }
      for (const p of catalogEntries(parsed.ok ? parsed.data : null, id).problems) add("entry", "error", id, null, p.message);

      // 18: a name twice in one catalog makes the later ones unreachable.
      const byName = new Map<string, Entry[]>();
      for (const e of entries) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
      for (const [name, group] of byName) if (group.length > 1) add("18", "error", id, name, `duplicate name in ${group.map((g) => g.type).join(", ")}`);

      const known = new Set(entries.map((e) => `${e.type}:${e.name}`));
      for (const e of entries) {
        // 19–21: sources.
        try {
          const src = parseSource(e.source, host.paths.home);
          if (src.kind === "local") {
            if (!(await host.fs.exists(src.path))) add("19", "error", id, e.name, `local source not found: ${e.source}`);
            if (c.ref.kind === "remote") {
              add("20", "warning", id, e.name, `local source ${e.source} won't resolve for teammates pulling this catalog — a remote catalog's sources should be URLs`);
            }
          } else if (op && (await op.heads.head(src)) === null) {
            add("26", "error", id, e.name, `repo or branch unreachable: ${src.org}/${src.repo}@${src.branch}`);
          }
        } catch (ex) {
          if (!(ex instanceof LibraryError)) throw ex;
          add("21", "error", id, e.name, ex.message);
        }
        // 22, 23 (DEP-04): requires resolve within this catalog only.
        for (const r of e.requires) {
          const [t = "", ...rest] = r.split(":");
          if (rest.length === 0 || !(TYPES as readonly string[]).includes(t)) {
            add("22", "error", id, e.name, `malformed requires ref '${r}'`);
            continue;
          }
          const ref = `${t.trim()}:${rest.join(":").trim()}`;
          if (known.has(ref)) continue;
          const elsewhere = registry.active().filter((o) => o.ref.id !== id && o.entries.some((x) => `${x.type}:${x.name}` === ref)).map((o) => o.ref.id);
          add(
            "23",
            "error",
            id,
            e.name,
            elsewhere.length > 0
              ? `dangling dependency '${r}'; it exists in ${elsewhere.join(", ")}, but dependencies resolve within one catalog — add a copy to '${id}'`
              : `dangling dependency '${r}'`,
          );
        }
      }
      // 24 (DEP-05): cycles, per catalog.
      for (const cycle of findCycles(entries)) add("24", "error", id, null, `dependency cycle: ${cycle.join(" -> ")}`);
      // 25 (EDIT-14).
      for (const message of sortedProblems(entries)) add("25", "warning", id, null, message);
    }
  } finally {
    await op?.dispose();
  }

  // ── 27, 28: overrides and pins ──
  const holders = new Map<string, string[]>();
  const all = registry.entries();
  const active = all.ok ? all.value : [];
  for (const e of active) {
    const ids = holders.get(e.name) ?? [];
    if (!ids.includes(e.catalog)) holders.set(e.name, [...ids, e.catalog]);
  }
  for (const [name, ids] of holders) {
    if (ids.length < 2) continue;
    const how = config.pins[name] === ids[0] ? " (pinned)" : "";
    add("27", "warning", null, name, `'${name}' is defined in ${ids.length} catalogs — '${ids[0]}'${how} overrides ${ids.slice(1).join(", ")}`);
  }
  for (const [name, cid] of Object.entries(config.pins).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const ids = holders.get(name) ?? [];
    if (ids.includes(cid)) continue;
    if (ids.length === 0) add("28", "warning", null, name, `'${name}' is pinned to '${cid}', but no catalog defines that name; unpin it to drop the pin`);
    else if (!config.catalogs.some((c) => c.id === cid)) add("28", "warning", null, name, `'${name}' is pinned to '${cid}', which is not registered; it resolves from '${ids[0]}' instead`);
    else add("28", "warning", null, name, `'${name}' is pinned to '${cid}', which does not define it (defined in: ${ids.join(", ")}); it resolves from '${ids[0]}' instead`);
  }

  // ── 29–31 (rebuild): the install dirs ──
  const known = new Set(active.map((e) => `${e.type}:${e.name}`));
  const scan = await scanInstallDirs(host, ctx.receipts, {
    ...(config.imported?.installs !== undefined && { legacyInstalls: config.imported.installs }),
    inCatalog: (type, name) => known.has(`${type}:${name}`),
  });
  if (scan.ok) {
    for (const item of scan.value.items) {
      if (item.state.state === "drifted") {
        const { modified, added, deleted } = item.state.edits;
        const what = [...modified.map((f) => `~${f}`), ...added.map((f) => `+${f}`), ...deleted.map((f) => `-${f}`)].join(" ");
        add("29", "warning", item.state.receipt.catalog.id, item.name, `${item.path} has local edits (${what}); installing or syncing it shows them before overwriting`);
      } else if (item.state.state === "unmanaged" && item.inCatalog && item.state.origin !== "symlink") {
        add("30", "warning", null, item.name, `${item.path} wasn't installed by Loadout (${item.state.origin}); installing '${item.name}' asks before replacing it`, {
          kind: "replace",
          name: item.name,
          dest: item.path,
        });
      }
    }
    for (const r of scan.value.missing) add("31", "warning", r.catalog.id, r.name, `receipt points at ${r.dest}, which no longer exists`);
  } else {
    add("receipts", "error", null, null, scan.error.message);
  }

  // ── arch §4.5 rule 4: managed settings override catalog skills ──
  const managed = await managedSkillOverrides(host, ctx.managedSettingsFile ?? managedSettingsFile);
  for (const [name, value] of managed) {
    if (!active.some((e) => e.name === name && e.type !== "agent")) continue;
    add("managed", "warning", null, name, `your organisation's managed settings set '${name}' to ${value}; turning it on or off in Loadout has no effect`);
  }

  return done(active.length);
}

/** A4: replace a diverged (or origin-less) clone with a fresh one. */
export async function recloneCatalog(ctx: Pick<DoctorCtx, "host" | "git" | "config">, id: string): Promise<Result<void>> {
  const loaded = await ctx.config.loadConfig();
  if (!loaded.ok) return loaded;
  const ref = loaded.value.config.catalogs.find((c) => c.id === id);
  if (!ref || ref.kind !== "remote") return { ok: false, error: { code: "UNKNOWN_CATALOG", message: `no remote catalog '${id}'` }, warnings: [] };
  const clone = cloneDir(ctx.host, id);
  if (await ctx.host.fs.exists(clone)) {
    await ctx.host.fs.remove(clone, { recursive: true });
    ctx.host.audit({ kind: "fs", op: "delete", path: clone });
  }
  const refreshed = await refreshCatalogs(ctx.host, ctx.git, [ref]);
  if (refreshed.ok && refreshed.value[0]!.outcome === "cloned") return ok(undefined);
  return { ok: false, error: { code: "GIT_FAILED", message: refreshed.warnings.map((w) => w.message).join("; ") || `could not clone ${ref.repo}` }, warnings: [] };
}
