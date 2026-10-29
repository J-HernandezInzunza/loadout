// An in-memory Library for UI tests (architecture.md §6): reads answer from seeded state, nothing touches
// a host. Mutations are REFUSED unless a test overrides them, so each test models only what it exercises.
import type { AccountHost } from "../accounts/accounts.ts";
import type { AccountInfo } from "../config/config.ts";
import { err, ok } from "../model/model.ts";
import type { EntryRecord } from "../registry/registry.ts";
import type { Library } from "./library.ts";
import type { CatalogRow, EntryDetail, PinRecord } from "./schemas.ts";

export * from "./seeds.ts";

export interface FakeState {
  catalogs: CatalogRow[];
  /** every copy, in resolution order, as list() returns them */
  entries: EntryRecord[];
  pins: PinRecord[];
  accounts: Partial<Record<AccountHost, AccountInfo>>;
}

const refused = async () => err({ code: "REFUSED" as const, message: "not modelled by the fake; override it in the test" });

export function createFakeLibrary(seed: Partial<FakeState> = {}, overrides: Partial<Library> = {}): Library & { state: FakeState } {
  const state: FakeState = { catalogs: [], entries: [], pins: [], accounts: {}, ...seed };
  const inCatalog = (catalog?: string) => state.entries.filter((e) => catalog === undefined || e.catalog === catalog);
  // Remote catalogs only, as the real refresh does; the fake never pulls, so each serves its cached copy.
  const refreshed = () => state.catalogs.filter((c) => c.kind === "remote").map((c) => ({ id: c.id, outcome: "cached" as const }));
  const winner = (name: string, catalog?: string) => inCatalog(catalog).find((e) => e.name === name && (catalog !== undefined || e.overriddenBy === null));

  const library: Library = {
    async launch() {
      return ok({ state: state.catalogs.length === 0 ? ("no-catalogs" as const) : ("ready" as const), catalogs: refreshed() });
    },
    async list(o = {}) {
      return ok(inCatalog(o.catalog));
    },
    async search(query, o = {}) {
      const q = query.toLowerCase();
      return ok(inCatalog(o.catalog).filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)));
    },
    async show(name, o = {}) {
      const entry = winner(name, o.catalog);
      if (!entry) return err({ code: "NOT_FOUND", message: `no entry named '${name}'`, query: name, candidates: [] });
      const detail: EntryDetail = {
        name,
        entry,
        copies: state.entries
          .filter((e) => e.name === name)
          .map((e) => ({ catalog: e.catalog, wins: e.overriddenBy === null, subject: e === entry, pinned: e.pinned, overrides: e.overrides, overriddenBy: e.overriddenBy })),
        requires: [],
        unresolvedRequires: [],
        dependents: [],
        installs: entry.receipt ? [entry.receipt] : [],
        source: { raw: entry.source, kind: "unknown", error: "the fake doesn't parse sources" },
      };
      return ok(detail);
    },
    async catalogs() {
      return ok(state.catalogs);
    },
    async pins() {
      return ok(state.pins);
    },
    async scan() {
      return ok({ items: [], missing: [] });
    },
    async refresh() {
      return ok(refreshed());
    },
    async doctor() {
      return ok({ status: "ok" as const, entries: state.entries.length, errors: [], warnings: [] });
    },
    async accounts() {
      return ok(state.accounts);
    },
    planInstall: refused,
    applyInstall: refused,
    uninstall: refused,
    setSkillState: refused,
    planMigrateParked: refused,
    applyMigrateParked: refused,
    planSync: refused,
    applySync: refused,
    discardPlan: refused,
    recloneCatalog: refused,
    planAddCatalog: refused,
    applyAddCatalog: refused,
    initCatalog: refused,
    removeCatalog: refused,
    planImport: refused,
    applyImport: refused,
    connect: refused,
    disconnect: refused,
    checkAccount: refused,
    beginSignIn: refused,
    completeSignIn: refused,
    planAdd: refused,
    planUpdate: refused,
    planRemove: refused,
    applyCatalogEdit: refused,
    discardCatalogEdit: refused,
    planPush: refused,
    applyPush: refused,
    discardPush: refused,
    planPin: refused,
    applyPin: refused,
    unpin: refused,
    suggestSource: refused,
  };
  return { ...library, ...overrides, state };
}
