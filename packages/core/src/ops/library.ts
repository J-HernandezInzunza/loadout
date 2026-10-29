// The core's facade (architecture.md §2.3): one instance per host, no state shared between
// instances. Reads load config, catalogs and the install dirs each call and never touch the network,
// except list({ checkRemote }) (UPD-06) and refresh().
import type { z } from "zod";
import { createAccounts, type AccountHost, type TokenSet } from "../accounts/accounts.ts";
import { defaultApiBases, type ApiBases } from "../accounts/apiBases.ts";
import { checkCatalogRepo, listRepos, type CatalogRepo, type HostedRepo } from "../git/repos.ts";
import {
  beginBitbucketSignIn,
  beginGitHubSignIn,
  completeBitbucketSignIn,
  completeGitHubSignIn,
  type BitbucketSignIn,
  type GitHubSignIn,
} from "../accounts/signIn.ts";
import { refreshCatalogs, type CatalogRefresh } from "../catalogs/catalogs.ts";
import {
  applyAddCatalog,
  initCatalog,
  planAddCatalog,
  removeCatalog,
  type AddCatalogPlan,
  type AddCatalogRequest,
  type RemoveCatalogReport,
} from "../catalogs/register.ts";
import { applyMigrateParked, planMigrateParked, type MigrateReport, type ParkedSkill } from "../claudeSettings/migrate.ts";
import { createClaudeSettings } from "../claudeSettings/settings.ts";
import { setSkillState, type ToggleReport } from "../claudeSettings/toggle.ts";
import { createConfigStore, type AccountInfo, type LoadedConfig } from "../config/config.ts";
import { applyImport, planImport, type ImportErr, type ImportPlan, type ImportReport } from "../config/import.ts";
import { dependents, lookup, resolveDeps } from "../deps/deps.ts";
import { doctor, recloneCatalog, type DoctorReport } from "../doctor/doctor.ts";
import { createGitClient, type GitClient } from "../git/git.ts";
import { createOperation, sweepTemp } from "../git/operation.ts";
import type { Host } from "../host.ts";
import { applyInstall, type ApplyOpts, type ApplyReport } from "../install/apply.ts";
import { discardPlan, planInstall, type InstallPlan } from "../install/plan.ts";
import { applySync, planSync, type SyncPlan, type SyncReport } from "../install/sync.ts";
import { uninstall, type UninstallItem } from "../install/uninstall.ts";
import { err, LibraryError, ok, type CatalogRef, type Entry, type Result, type Warning } from "../model/model.ts";
import { createReceiptStore, type ReceiptV2 } from "../receipts/receipts.ts";
import { loadRegistry, type EntryRecord, type Registry, type ResolveErr } from "../registry/registry.ts";
import { destFor, destState, readLegacyInstalls, scanInstallDirs, type ScanReport } from "../scan/scan.ts";
import { accountHostOf, cloneUrls, parseSource } from "../source/source.ts";
import { isStale } from "../update/update.ts";
import { applyAdd, planAdd, type AddPlan, type AddRequest } from "../write/add.ts";
import type { WriteResult } from "../write/edit.ts";
import { applyPin, planPin, unpin, type PinPlan, type PinResult } from "../write/pin.ts";
import { applyPush, discardPush, planPush, type PushPlan, type PushRequest, type PushResult } from "../write/push.ts";
import { applyRemove, planRemove, type RemovePlan, type RemoveRequest } from "../write/remove.ts";
import { suggestSource, type SourceSuggestion } from "../write/suggest.ts";
import { writeTarget, type WriteTargetErr } from "../write/target.ts";
import { applyUpdate, planUpdate, type UpdatePlan, type UpdateRequest } from "../write/update.ts";
import { discardWrite } from "../write/write.ts";
import type { CatalogRow, EntryDetail, PinRecord } from "./schemas.ts";

/** A plan as the facade hands it out (architecture.md §8.3): readable, but only a Library makes one, and it comes back unedited. */
export type Issued<P, B extends string> = P & z.$brand<B>;
export type IssuedInstallPlan = Issued<InstallPlan, "InstallPlan">;
export type IssuedSyncPlan = Issued<SyncPlan, "SyncPlan">;
export type IssuedMigratePlan = Issued<{ items: ParkedSkill[] }, "MigratePlan">;
export type IssuedAddCatalogPlan = Issued<AddCatalogPlan, "AddCatalogPlan">;
export type IssuedImportPlan = Issued<ImportPlan, "ImportPlan">;
export type IssuedPushPlan = Issued<PushPlan, "PushPlan">;
export type IssuedPinPlan = Issued<PinPlan, "PinPlan">;
/** A sign-in in progress: GitHub's code to enter, or Bitbucket's page to open; hand it back to completeSignIn. */
export type IssuedSignIn = Issued<GitHubSignIn | BitbucketSignIn, "SignIn">;

/** An add, update or remove, carrying its op so one apply serves all three (architecture.md §2.3). */
export type CatalogEditPlan = ({ op: "add" } & AddPlan) | ({ op: "update" } & UpdatePlan) | ({ op: "remove" } & RemovePlan);
export type IssuedCatalogEditPlan = Issued<CatalogEditPlan, "CatalogEditPlan">;
export type CatalogEditResult = WriteResult &
  (
    | { op: "add"; added: AddPlan["added"] }
    | { op: "update"; name: string }
    | { op: "remove"; removed: RemovePlan["removed"]; dependents: string[]; deleted: string[] }
  );

export interface LaunchReport {
  /** "no-catalogs": nothing registered yet, so the app offers to import or add one */
  state: LoadedConfig["state"];
  catalogs: CatalogRefresh[];
}

export interface Library {
  /**
   * At app start (architecture.md §2.5): clear what killed operations left in tmp, then clone or pull
   * every remote catalog; a catalog that can't be refreshed is a warning (A3). Reads made before it
   * finishes serve the clones on disk (W14).
   */
  launch(opts?: { signal?: AbortSignal }): Promise<Result<LaunchReport>>;
  /** Every copy of every entry, in resolution order; `checkRemote` asks each installed remote source whether it moved (UPD-06). */
  list(opts?: { catalog?: string; checkRemote?: boolean }): Promise<Result<EntryRecord[]>>;
  /** W18: the list filtered by name or description, case-insensitively, as RES-04's candidates are. */
  search(query: string, opts?: { catalog?: string }): Promise<Result<EntryRecord[]>>;
  show(name: string, opts?: { catalog?: string }): Promise<Result<EntryDetail, ResolveErr>>;
  catalogs(): Promise<Result<CatalogRow[]>>;
  /** What the install dirs hold, managed or not (architecture.md §4.4). */
  scan(): Promise<Result<ScanReport>>;
  /** Clone or fast-forward every remote catalog (RCAT-03); per-catalog failures are warnings. */
  refresh(): Promise<Result<CatalogRefresh[]>>;

  /** Resolves every name, fetches each item with its dependencies and previews each destination; the plan holds the staged copies. */
  planInstall(req: { names: string[]; catalog?: string; signal?: AbortSignal }): Promise<Result<IssuedInstallPlan, ResolveErr>>;
  /** STALE_PLAN when a destination moved since the plan; REFUSED for unmanaged content not consented to by path. */
  applyInstall(plan: IssuedInstallPlan, opts?: ApplyOpts): Promise<Result<ApplyReport>>;
  uninstall(req: { names: string[]; forcePaths?: string[] }): Promise<Result<{ items: UninstallItem[] }, ResolveErr>>;
  /** Through Claude Code's skillOverrides (architecture.md §4.5); agents are refused. */
  setSkillState(names: string[], state: "on" | "off"): Promise<Result<ToggleReport, ResolveErr>>;
  /** The copies the Python CLI parked in skills-disabled (§4.5 rule 7). */
  planMigrateParked(): Promise<Result<IssuedMigratePlan>>;
  applyMigrateParked(plan: IssuedMigratePlan): Promise<Result<MigrateReport>>;
  planSync(req?: { catalog?: string; force?: boolean; signal?: AbortSignal }): Promise<Result<IssuedSyncPlan>>;
  applySync(plan: IssuedSyncPlan, opts?: { signal?: AbortSignal }): Promise<Result<SyncReport>>;
  /** Removes the staged copies of a plan that won't be applied; apply removes them itself. */
  discardPlan(plan: IssuedInstallPlan | IssuedSyncPlan): Promise<Result<void>>;

  /** §3.6's list: every pin by name, and whether it is dangling (RES-11: its catalog doesn't hold the name, so it is inert). */
  pins(): Promise<Result<PinRecord[]>>;
  doctor(opts?: { deep?: boolean; noPull?: boolean }): Promise<Result<DoctorReport>>;
  /** A4: replace a diverged clone with a fresh one. */
  recloneCatalog(id: string): Promise<Result<void>>;
  /** Clones or reads the catalog to prove it works before anything is saved. */
  planAddCatalog(req: AddCatalogRequest & { signal?: AbortSignal }): Promise<Result<IssuedAddCatalogPlan>>;
  /** The registry after the add, highest precedence first. */
  applyAddCatalog(plan: IssuedAddCatalogPlan): Promise<Result<CatalogRef[]>>;
  initCatalog(req: { path: string; id?: string; position?: "first" | "last" }): Promise<Result<{ created: string; catalogs: CatalogRef[] }>>;
  removeCatalog(req: { id: string; purgeClone?: boolean; purgeInstalls?: boolean }): Promise<Result<RemoveCatalogReport>>;
  /** The Python CLI's config.local.yaml, found through ~/.claude/skills/library unless `toolDir` is given. */
  planImport(toolDir?: string): Promise<Result<IssuedImportPlan, ImportErr>>;
  applyImport(plan: IssuedImportPlan): Promise<Result<ImportReport>>;
  accounts(): Promise<Result<Partial<Record<AccountHost, AccountInfo>>>>;
  /** What a sign-in flow ends with: validates the token, then keeps it in Host.secrets. */
  connect(on: AccountHost, tokens: TokenSet): Promise<Result<AccountInfo>>;
  disconnect(on: AccountHost): Promise<Result<void>>;
  /** Whether the connected account's token still works (refreshing Bitbucket's first): the login and scopes it answers for. */
  checkAccount(on: AccountHost): Promise<Result<{ login: string; scopes: string[] | null }>>;
  /** Starts a browser sign-in (S12); SIGN_IN_UNAVAILABLE when the build lacks the host's OAuth client. */
  beginSignIn(on: AccountHost): Promise<Result<IssuedSignIn>>;
  /**
   * Finishes in the browser's wake, then connects the account: GitHub by polling until the user decides,
   * Bitbucket from `redirectUrl`, the loadout:// link its consent page sent. SIGN_IN_DENIED,
   * SIGN_IN_EXPIRED or CANCELLED otherwise.
   */
  completeSignIn(started: IssuedSignIn, opts?: { signal?: AbortSignal; redirectUrl?: string }): Promise<Result<AccountInfo>>;
  /** Every repository the host's connected account can read, owned or not, to pick a shared catalog from. */
  listRepos(on: AccountHost, opts?: { signal?: AbortSignal }): Promise<Result<HostedRepo[]>>;
  /** A repo's default branch and whether its catalog file is there, before planAddCatalog clones it. */
  checkCatalogRepo(req: { on: AccountHost; org: string; name: string; branch?: string; yamlPath?: string; signal?: AbortSignal }): Promise<Result<CatalogRepo>>;

  /** One entry or a batch, landing as one write in the target catalog's write mode. */
  planAdd(req: AddRequest & { signal?: AbortSignal }): Promise<Result<IssuedCatalogEditPlan, WriteTargetErr>>;
  planUpdate(req: UpdateRequest & { signal?: AbortSignal }): Promise<Result<IssuedCatalogEditPlan, WriteTargetErr>>;
  planRemove(req: RemoveRequest & { signal?: AbortSignal }): Promise<Result<IssuedCatalogEditPlan, WriteTargetErr>>;
  applyCatalogEdit(plan: IssuedCatalogEditPlan, opts?: { signal?: AbortSignal }): Promise<Result<CatalogEditResult>>;
  /** Removes a PR-mode plan's temp clone; other modes hold nothing. */
  discardCatalogEdit(plan: IssuedCatalogEditPlan): Promise<Result<void>>;
  /** Sends an installed copy's edits back to its source (behaviors.md §3.16). */
  planPush(req: PushRequest & { signal?: AbortSignal }): Promise<Result<IssuedPushPlan, ResolveErr>>;
  applyPush(plan: IssuedPushPlan, opts?: { message?: string; signal?: AbortSignal }): Promise<Result<PushResult>>;
  discardPush(plan: IssuedPushPlan): Promise<Result<void>>;
  /** RES-13 refusals, and the switch assessment for what is installed (RES-15). */
  planPin(req: { name: string; catalog: string }): Promise<Result<IssuedPinPlan>>;
  applyPin(plan: IssuedPinPlan, opts: { switchInstalled: boolean; signal?: AbortSignal }): Promise<Result<PinResult>>;
  unpin(name: string): Promise<Result<{ name: string; was: string; resolvesTo: string | null }>>;
  /** WRITE-05's hint: the browser URL of a local file in a GitHub or Bitbucket repo. */
  suggestSource(path: string): Promise<Result<SourceSuggestion>>;
}

export interface LibraryOptions {
  git?: GitClient;
  /** CLAUDE_CONFIG_DIR, as the app's login-shell probe found it */
  claudeConfigDir?: string;
  /** tests only: the API stub's bases (architecture.md §6) */
  apiBases?: ApiBases;
  /** tests only: macOS's managed-settings.json otherwise */
  managedSettingsFile?: string;
  /** the Bitbucket OAuth consumer, injected into release builds */
  bitbucketClient?: { id: string; secret: string };
  /** the GitHub OAuth app's client ID (device flow needs no secret) */
  githubClientId?: string;
}

const ref = (e: Entry) => ({ type: e.type, name: e.name, catalog: e.catalog, description: e.description });

const partialOverride = (value: string | undefined): EntryRecord["skillOverride"] => (value === "name-only" || value === "user-invocable-only" ? value : null);

function shownSource(raw: string, home: string): EntryDetail["source"] {
  try {
    const src = parseSource(raw, home);
    return src.kind === "local" ? { raw, kind: "local", path: src.path } : { raw, ...src, cloneUrls: cloneUrls(src) };
  } catch (e) {
    if (!(e instanceof LibraryError)) throw e;
    return { raw, kind: "unknown", error: e.message };
  }
}

/** Everything a read needs about installs, loaded once per call. */
interface InstallView {
  byDest: Map<string, ReceiptV2>;
  receipts: ReceiptV2[];
  legacy: Map<string, string>;
  overrides: Map<string, string>;
  warnings: Warning[];
}

/** Tags a successful result's value with its op. */
function withOp<O extends string, T extends object>(op: O, r: Result<T>): Result<T & { op: O }> {
  return r.ok ? { ...r, value: { ...r.value, op } } : r;
}

export function createLibrary(host: Host, opts: LibraryOptions = {}): Library {
  const store = createConfigStore(host);
  const receiptStore = createReceiptStore(host);
  const settings = createClaudeSettings(host, opts.claudeConfigDir === undefined ? {} : { configDir: opts.claudeConfigDir });
  const git = opts.git ?? createGitClient(host);
  const apiBases = opts.apiBases ?? defaultApiBases;
  const accounts = createAccounts(host, store, { apiBases, ...(opts.bitbucketClient && { bitbucketClient: opts.bitbucketClient }) });
  // Everything an op needs, built once per instance (architecture.md §8.7).
  const ctx = {
    host,
    git,
    config: store,
    receipts: receiptStore,
    settings,
    accounts,
    apiBases,
    ...(opts.managedSettingsFile !== undefined && { managedSettingsFile: opts.managedSettingsFile }),
    ...(opts.githubClientId !== undefined && { githubClientId: opts.githubClientId }),
    ...(opts.bitbucketClient !== undefined && { bitbucketClient: opts.bitbucketClient }),
  };
  const home = host.paths.home;

  const loadAll = async (): Promise<Result<{ reg: Registry; view: InstallView; installs: string | undefined }>> => {
    const loaded = await store.loadConfig();
    if (!loaded.ok) return loaded;
    const reg = await loadRegistry(host, loaded.value.config);
    const receipts = await receiptStore.all();
    if (!receipts.ok) return receipts;
    const overrides = await settings.readSkillOverrides();
    const installs = loaded.value.config.imported?.installs;
    const view: InstallView = {
      byDest: new Map(receipts.value.map((r) => [r.dest, r])),
      receipts: receipts.value,
      legacy: await readLegacyInstalls(host, installs),
      overrides: overrides.ok ? overrides.value : new Map(),
      warnings: [...receipts.warnings, ...(overrides.ok ? [] : [{ message: `on/off state unknown: ${overrides.error.message}` }])],
    };
    return ok({ reg, view, installs });
  };

  /** The destination's real install fields for `entry`, whichever copy it is. */
  const installFields = async (entry: Entry, view: InstallView) => {
    const dest = destFor(home, entry.type, entry.name);
    const state = await destState(host, dest, view.byDest.get(dest) ?? null, view.legacy);
    return {
      installed: state.state !== "absent",
      state: state.state === "absent" ? ("not_installed" as const) : state.state,
      receipt: "receipt" in state ? state.receipt : null,
      locations: state.state === "absent" ? [] : [dest],
      disabled: entry.type !== "agent" && view.overrides.get(entry.name) === "off",
      skillOverride: entry.type === "agent" ? null : partialOverride(view.overrides.get(entry.name)),
    };
  };

  /** RES-07: only the winning copy of a name carries its install; the others keep the registry's not-installed record. */
  const records = async (reg: Registry, view: InstallView, catalog?: string): Promise<EntryRecord[]> => {
    const all = reg.records().filter((e) => catalog === undefined || e.catalog === catalog);
    return Promise.all(all.map(async (e) => (e.overriddenBy === null ? { ...e, ...(await installFields(e, view)) } : e)));
  };

  const listed = async (catalog?: string) => {
    const all = await loadAll();
    if (!all.ok) return all;
    const { reg, view } = all.value;
    const scope = reg.searchScope(catalog);
    if (!scope.ok) return scope;
    return ok({ reg, view, records: await records(reg, view, catalog) }, [...scope.warnings, ...view.warnings]);
  };

  return {
    async launch(o = {}) {
      await sweepTemp(host);
      const loaded = await store.loadConfig();
      if (!loaded.ok) return loaded;
      const refreshed = await refreshCatalogs(host, git, loaded.value.config.catalogs, o);
      if (!refreshed.ok) return refreshed;
      return ok({ state: loaded.value.state, catalogs: refreshed.value }, refreshed.warnings);
    },

    async list(o = {}) {
      const found = await listed(o.catalog);
      if (!found.ok) return found;
      const list = found.value.records;
      if (o.checkRemote) {
        const op = await createOperation(host, git);
        try {
          for (const r of list) {
            if (r.state === "installed" && r.receipt && (await isStale({ host, op, receipts: receiptStore }, r, r.receipt))) r.state = "stale";
          }
        } finally {
          await op.dispose();
        }
      }
      return ok(list, found.warnings);
    },

    async search(query, o = {}) {
      const found = await listed(o.catalog);
      if (!found.ok) return found;
      const q = query.toLowerCase();
      const matches = found.value.records.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
      return ok(matches, found.warnings);
    },

    async show(name, o = {}) {
      const all = await loadAll();
      if (!all.ok) return all;
      const { reg, view } = all.value;
      const resolved = reg.resolve(name, o.catalog);
      if (!resolved.ok) return resolved;
      const subject = resolved.value;
      const own = reg.entriesOf(subject.catalog);
      const deps = resolveDeps(own, subject);
      const record = reg.records().find((e) => e.catalog === subject.catalog && e.type === subject.type && e.name === subject.name)!;
      const declared = new Set(subject.requires.map((r) => lookup(own, r)));
      // What sits at the related entry's destination, whichever catalog's copy put it there: that is what
      // satisfies a dependency at run time.
      const related = async (e: Entry, direct: boolean) => {
        const { installed, state } = await installFields(e, view);
        return { ...ref(e), direct, installed, state };
      };
      return ok(
        {
          name,
          // RES-08: the subject's install fields as if it won, even when another copy does.
          entry: { ...record, ...(await installFields(subject, view)) },
          copies: reg.copies(name, subject.catalog),
          requires: await Promise.all(deps.order.filter((e) => e !== subject).map((e) => related(e, declared.has(e)))),
          unresolvedRequires: deps.unresolved,
          dependents: await Promise.all(dependents(own, subject).map(({ entry: e, direct }) => related(e, direct))),
          installs: view.receipts.filter((r) => r.name === subject.name && r.type === subject.type),
          source: shownSource(subject.source, home),
        },
        [...resolved.warnings, ...deps.warnings, ...view.warnings],
      );
    },

    async catalogs() {
      const loaded = await store.loadConfig();
      if (!loaded.ok) return loaded;
      const reg = await loadRegistry(host, loaded.value.config);
      return ok(
        reg.catalogs().map((c, i) => ({
          precedence: i + 1,
          id: c.ref.id,
          kind: c.ref.kind,
          location: c.ref.kind === "remote" ? `${c.ref.repo} (${c.ref.branch}, ${c.ref.yamlPath})` : c.file,
          writeMode: c.ref.kind === "local" ? "local" : c.ref.protected ? "pr" : "direct",
          accountHost: c.ref.kind === "remote" ? accountHostOf(c.ref.repo) : null,
          writable: c.ref.writable !== false,
          editable: writeTarget(reg, { op: "add", catalog: c.ref.id }).ok,
          entries: c.skipped === undefined ? c.entries.length : null,
          skipped: c.skipped ?? null,
        })),
      );
    },

    async scan() {
      const all = await loadAll();
      if (!all.ok) return all;
      const { reg, installs } = all.value;
      const entries = reg.entries();
      const known = new Set((entries.ok ? entries.value : []).map((e) => `${e.type}:${e.name}`));
      return scanInstallDirs(host, receiptStore, {
        ...(installs !== undefined && { legacyInstalls: installs }),
        inCatalog: (type, name) => known.has(`${type}:${name}`),
      });
    },

    async refresh() {
      const loaded = await store.loadConfig();
      if (!loaded.ok) return loaded;
      return refreshCatalogs(host, git, loaded.value.config.catalogs);
    },

    async planInstall(req) {
      return (await planInstall(ctx, req, req)) as Result<IssuedInstallPlan, ResolveErr>;
    },

    async applyInstall(plan, o = {}) {
      return applyInstall(ctx, plan, o);
    },

    async uninstall(req) {
      return uninstall(ctx, req);
    },

    async setSkillState(names, state) {
      return setSkillState(ctx, names, state);
    },

    async planMigrateParked() {
      return (await planMigrateParked(host)) as Result<IssuedMigratePlan>;
    },

    async applyMigrateParked(plan) {
      return applyMigrateParked(ctx, plan);
    },

    async planSync(req = {}) {
      return (await planSync(ctx, req, req)) as Result<IssuedSyncPlan>;
    },

    async applySync(plan, o = {}) {
      return applySync(ctx, plan, o);
    },

    async discardPlan(plan) {
      await discardPlan(host, plan);
      return ok(undefined);
    },

    async pins() {
      const loaded = await store.loadConfig();
      if (!loaded.ok) return loaded;
      const reg = await loadRegistry(host, loaded.value.config);
      const active = reg.active().map((c) => c.ref.id);
      const pins = Object.entries(loaded.value.config.pins).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return ok(
        pins.map(([name, catalog]) => {
          const holders = active.filter((id) => reg.entriesOf(id).some((e) => e.name === name));
          const resolved = reg.resolve(name);
          return { name, catalog, holders, dangling: !holders.includes(catalog), resolvesTo: resolved.ok ? resolved.value.catalog : null };
        }),
      );
    },

    async doctor(o = {}) {
      return doctor(ctx, o);
    },

    async recloneCatalog(id) {
      return recloneCatalog(ctx, id);
    },

    async planAddCatalog(req) {
      return (await planAddCatalog(ctx, req, req)) as Result<IssuedAddCatalogPlan>;
    },

    async applyAddCatalog(plan) {
      return applyAddCatalog(ctx, plan);
    },

    async initCatalog(req) {
      return initCatalog(ctx, req);
    },

    async removeCatalog(req) {
      return removeCatalog(ctx, req);
    },

    async planImport(toolDir) {
      return (await planImport(host, toolDir)) as Result<IssuedImportPlan, ImportErr>;
    },

    async applyImport(plan) {
      return applyImport(host, store, plan);
    },

    async accounts() {
      return accounts.accounts();
    },

    async connect(on, tokens) {
      return accounts.connect(on, tokens);
    },

    async disconnect(on) {
      return accounts.disconnect(on);
    },

    async checkAccount(on) {
      const token = await accounts.tokenFor(on);
      if (!token.ok) return token;
      return accounts.whoami(on, token.value);
    },

    async listRepos(on, o = {}) {
      return listRepos({ host, accounts, apiBases }, on, o);
    },

    async checkCatalogRepo(req) {
      return checkCatalogRepo({ host, accounts, apiBases }, req);
    },

    async beginSignIn(on) {
      const started = on === "github" ? await beginGitHubSignIn(ctx) : beginBitbucketSignIn(ctx);
      return started as Result<IssuedSignIn>;
    },

    async completeSignIn(started, o = {}) {
      if (started.on === "github") return completeGitHubSignIn(ctx, started, o);
      if (o.redirectUrl === undefined) return err({ code: "REFUSED", message: "A Bitbucket sign-in completes with the loadout:// redirect it received" });
      return completeBitbucketSignIn(ctx, started, o.redirectUrl);
    },

    async planAdd(req) {
      return withOp("add", await planAdd(ctx, req, req)) as Result<IssuedCatalogEditPlan, WriteTargetErr>;
    },

    async planUpdate(req) {
      return withOp("update", await planUpdate(ctx, req, req)) as Result<IssuedCatalogEditPlan, WriteTargetErr>;
    },

    async planRemove(req) {
      return withOp("remove", await planRemove(ctx, req, req)) as Result<IssuedCatalogEditPlan, WriteTargetErr>;
    },

    async applyCatalogEdit(plan, o = {}) {
      if (plan.op === "add") return withOp("add", await applyAdd(ctx, plan, o));
      if (plan.op === "update") return withOp("update", await applyUpdate(ctx, plan, o));
      return withOp("remove", await applyRemove(ctx, plan, o));
    },

    async discardCatalogEdit(plan) {
      await discardWrite(plan.write);
      return ok(undefined);
    },

    async planPush(req) {
      return (await planPush(ctx, req, req)) as Result<IssuedPushPlan, ResolveErr>;
    },

    async applyPush(plan, o = {}) {
      return applyPush(ctx, plan, o);
    },

    async discardPush(plan) {
      await discardPush(plan);
      return ok(undefined);
    },

    async planPin(req) {
      return (await planPin(ctx, req)) as Result<IssuedPinPlan>;
    },

    async applyPin(plan, o) {
      return applyPin(ctx, plan, o);
    },

    async unpin(name) {
      return unpin(ctx, name);
    },

    async suggestSource(path) {
      return ok(await suggestSource(host, git, path));
    },
  };
}
