// Builders for the fake's state (fake.ts): each returns a valid default to override with what the test is
// about, and seededState() is a whole machine with every install state, for screens that render them all.
import type { AccountInfo } from "../config/config.ts";
import type { EntryType } from "../model/model.ts";
import type { ReceiptV2 } from "../receipts/receipts.ts";
import type { EntryRecord, InstallState } from "../registry/registry.ts";
import { destFor, type ScanItem } from "../scan/scan.ts";
import type { FakeState } from "./fake.ts";
import type { CatalogRow, LoadoutRecord, PinRecord } from "./schemas.ts";

export const seedHome = "/Users/dev";

/** A writable local catalog at precedence 1. */
export function catalogRow(overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    precedence: 1,
    id: "personal",
    kind: "local",
    location: `${seedHome}/catalog/library.yaml`,
    writeMode: "local",
    accountHost: null,
    writable: true,
    editable: true,
    entries: 0,
    skipped: null,
    ...overrides,
  };
}

/** A not-installed skill in `personal` that wins its name. */
export function entryRecord(overrides: Partial<EntryRecord> = {}): EntryRecord {
  const type = overrides.type ?? "skill";
  const name = overrides.name ?? "a-skill";
  const file = type === "skill" ? `${name}/SKILL.md` : `${name}.md`;
  return {
    type,
    name,
    description: `${name} does a thing`,
    source: `https://github.com/acme/skills/blob/main/${type}s/${file}`,
    requires: [],
    catalog: "personal",
    overrides: [],
    overriddenBy: null,
    pinned: false,
    installed: false,
    state: "not_installed",
    receipt: null,
    locations: [],
    disabled: false,
    skillOverride: null,
    ...overrides,
  };
}

/** The receipt Loadout wrote when it installed `entry` (catalog key = its id). */
export function receipt(entry: Pick<EntryRecord, "type" | "name" | "catalog" | "source">, overrides: Partial<ReceiptV2> = {}): ReceiptV2 {
  const main = entry.type === "skill" ? "SKILL.md" : `${entry.name}.md`;
  return {
    dest: destFor(seedHome, entry.type, entry.name),
    type: entry.type,
    name: entry.name,
    catalog: { id: entry.catalog, key: entry.catalog },
    source: entry.source,
    commit: "1111111111111111111111111111111111111111",
    sourceOid: "2222222222222222222222222222222222222222",
    files: { [main]: "3".repeat(64) },
    installedAt: "2026-10-01T12:00:00Z",
    ...overrides,
  };
}

/**
 * `entry` installed at its destination in `state`, with the fields list() pairs with it: a receipt unless
 * the copy is unmanaged, which Loadout didn't install.
 */
export function installedRecord(state: Exclude<InstallState, "not_installed">, overrides: Partial<EntryRecord> = {}): EntryRecord {
  const base = entryRecord(overrides);
  return {
    ...base,
    installed: true,
    state,
    receipt: state === "unmanaged" ? null : receipt(base),
    locations: [destFor(seedHome, base.type, base.name)],
    ...overrides,
  };
}

/** An unmanaged skill scan() found by hand-copy, on and loadable; prompts and skills carry their switch state. */
export function scanItem(overrides: Partial<ScanItem> = {}): ScanItem {
  const type = overrides.type ?? "skill";
  const name = overrides.name ?? "stray";
  return {
    type,
    name,
    path: destFor(seedHome, type, name),
    state: { state: "unmanaged", origin: "foreign" },
    loadable: true,
    inCatalog: false,
    ...(type !== "agent" && { disabled: false, skillOverride: null }),
    ...overrides,
  };
}

export function pinRecord(overrides: Partial<PinRecord> = {}): PinRecord {
  return { name: "a-skill", catalog: "team", holders: ["personal", "team"], dangling: false, resolvesTo: "team", ...overrides };
}

/** A saved loadout whose members are all built; `name` also sets its two commands. */
export function loadoutRecord(overrides: Partial<LoadoutRecord> = {}): LoadoutRecord {
  const name = overrides.name ?? "review";
  return {
    name,
    run: `loadout run ${name}`,
    command: `claude --add-dir='/Users/dev/Library/Application Support/com.jhernandezinzunza.loadout/loadouts/${name}'`,
    members: [{ type: "skill", name: "lint", resolvesTo: "team", state: "built" }],
    ...overrides,
  };
}

export function accountInfo(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return { login: "dev", scopes: [], connectedAt: "2026-10-01T12:00:00Z", ...overrides };
}

const team = (name: string, type: EntryType = "skill") => ({ type, name, catalog: "team" });

/**
 * Two catalogs (a writable local `personal` over a PR-mode remote `team`) holding a copy in every install
 * state, a skill switched off, a prompt, an agent, a dependency, a name `personal` overrides and a name
 * pinned to `team`; a Bitbucket account is connected.
 */
export function seededState(): FakeState {
  const entries: EntryRecord[] = [
    installedRecord("installed", { name: "notes" }),
    entryRecord({ name: "review", overrides: ["team"] }),
    entryRecord({ name: "deploy", overriddenBy: "team" }),
    installedRecord("installed", { ...team("tidy"), requires: ["skill:lint"] }),
    installedRecord("drifted", { ...team("lint") }),
    installedRecord("stale", { ...team("triage") }),
    installedRecord("unmanaged", { ...team("grill") }),
    installedRecord("installed", { ...team("verbose"), disabled: true }),
    entryRecord({ ...team("review"), overriddenBy: "personal" }),
    entryRecord({ ...team("deploy"), pinned: true, overrides: ["personal"] }),
    installedRecord("installed", { ...team("reviewer", "agent") }),
    entryRecord({ ...team("standup", "prompt") }),
  ];
  const count = (id: string) => entries.filter((e) => e.catalog === id).length;
  return {
    catalogs: [
      catalogRow({ entries: count("personal") }),
      catalogRow({
        precedence: 2,
        id: "team",
        kind: "remote",
        location: "git@bitbucket.org:acme/catalog.git (main, library.yaml)",
        writeMode: "pr",
        accountHost: "bitbucket",
        entries: count("team"),
      }),
    ],
    entries,
    pins: [pinRecord({ name: "deploy" })],
    accounts: { bitbucket: accountInfo({ login: "dev-acme", scopes: ["account", "pullrequest:write"] }) },
    scanned: [
      scanItem({
        name: "find-skills",
        state: { state: "unmanaged", origin: "symlink" },
        link: { target: `${seedHome}/.agents/skills/find-skills`, kind: "dir" },
        attribution: { tool: "npx skills", source: "vercel-labs/skills", installedAt: "2026-09-25T17:35:14.235Z", updatedAt: "2026-09-25T17:35:14.235Z" },
      }),
      scanItem({ name: "grill", inCatalog: true }),
      scanItem({ name: "neo", attribution: { tool: "BrowserOS", source: null, installedAt: null, updatedAt: null }, disabled: true }),
      scanItem({ name: "gone", state: { state: "unmanaged", origin: "symlink" }, link: { target: null, broken: true }, loadable: false }),
      scanItem({ type: "agent", name: "helper", state: { state: "unmanaged", origin: "python-cli" } }),
      scanItem({ type: "prompt", name: "team", path: `${seedHome}/.claude/commands/team` }),
    ],
    loadouts: [],
  };
}
