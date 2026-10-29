<script setup lang="ts">
// Throwaway: proves the Tauri host end to end until the real screens exist.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onMounted, onUnmounted, ref } from "vue";
import type {
  AccountHost,
  AccountInfo,
  AuditEvent,
  CatalogRow,
  CoreError,
  EntryRecord,
  IssuedSignIn,
  LaunchReport,
  Library,
  PlanItem,
  Result,
  Warning,
} from "@loadout/core";
import type { AuditLog } from "./host-tauri/audit.ts";

const props = defineProps<{ library: Library; log: AuditLog; launched: Promise<Result<LaunchReport>> }>();

const status = ref("launching…");
const warnings = ref<Warning[]>([]);
const catalogs = ref<CatalogRow[]>([]);
const entries = ref<EntryRecord[]>([]);
const accounts = ref<Partial<Record<AccountHost, AccountInfo>>>({});
const hosts: { on: AccountHost; name: string }[] = [
  { on: "github", name: "GitHub" },
  { on: "bitbucket", name: "Bitbucket" },
];
const events = ref<AuditEvent[]>(props.log.events());
const unsubscribe = props.log.subscribe((event) => events.value.push(event));

function valueOr<T>(result: Result<T>, fallback: T): T {
  if (result.ok) return result.value;
  warnings.value.push({ message: `${result.error.code}: ${result.error.message}` });
  return fallback;
}

async function load() {
  const catalogRows = await props.library.catalogs();
  catalogs.value = valueOr(catalogRows, []);
  const records = await props.library.list();
  entries.value = valueOr(records, []);
  await loadAccounts();
}

async function loadAccounts() {
  const connected = await props.library.accounts();
  accounts.value = valueOr(connected, {});
}

async function checkAccount(on: AccountHost, name: string) {
  const checked = await props.library.checkAccount(on);
  if (!checked.ok) return show(failure(`${name} account`, checked.error));
  const scopes = checked.value.scopes?.join(", ") ?? "scopes not reported";
  await show({ title: `${name} account`, lines: [`The token works: ${checked.value.login} (${scopes}).`] });
}

async function disconnect(on: AccountHost, name: string) {
  const done = await props.library.disconnect(on);
  if (!done.ok) return show(failure(`${name} account`, done.error));
  await loadAccounts();
  await show({ title: `${name} account`, lines: [`Disconnected; the token is gone from the Keychain.`] });
}

function signIn(on: AccountHost) {
  if (on === "github") return githubSignIn();
  return act(bitbucketSignIn);
}

/** What an action planned or did; `apply`/`replace` act on the plan, `discard` drops its staged copies. */
interface Panel {
  title: string;
  lines: string[];
  apply?: () => Promise<void>;
  replace?: () => Promise<void>;
  discard?: () => Promise<void>;
}

const panel = ref<Panel | null>(null);
const busy = ref(false);
const editTarget = ref<EntryRecord | null>(null);
const editText = ref("");

async function act(step: () => Promise<void>) {
  busy.value = true;
  try {
    await step();
  } finally {
    busy.value = false;
  }
}

async function show(next: Panel) {
  // A plan nobody applied still holds staged copies or a temp clone.
  await panel.value?.discard?.();
  panel.value = next;
}

function failure(title: string, error: CoreError): Panel {
  return { title, lines: [`${error.code}: ${error.message}`] };
}

/** Runs one of the panel's actions; the plan is spent either way, so there's nothing left to discard. */
async function runPanel(step: "apply" | "replace" | "discard") {
  const current = panel.value;
  panel.value = null;
  await act(async () => {
    await current?.[step]?.();
  });
}

function describeItem(item: PlanItem): string {
  const where = `${item.type} ${item.name} → ${item.dest}: ${item.status}${item.reason ? ` (${item.reason})` : ""}`;
  const consent = item.needsConsent ? ", holds a copy Loadout didn't install" : "";
  if (item.preview.kind === "destination-only") return `${where}${consent}, source unreachable`;
  const p = item.preview;
  const edited = p.editedLocally.length > 0 ? `, you edited ${p.editedLocally.join(", ")}` : "";
  const change = p.newInstall ? "new install" : `+${p.added.length} −${p.removed.length} ~${p.modified.length}${edited}`;
  return `${where}${consent}, ${change}`;
}

async function doctor() {
  const report = await props.library.doctor();
  if (!report.ok) return show(failure("Doctor", report.error));
  const findings = [...report.value.errors, ...report.value.warnings];
  const lines = findings.map((f) => `${f.severity} [${f.check}] ${[f.catalog, f.entry].filter(Boolean).join(" ")}: ${f.message}`);
  await show({ title: `Doctor: ${report.value.status}, ${report.value.entries} entries checked`, lines });
}

async function install(entry: EntryRecord) {
  const plan = await props.library.planInstall({ names: [entry.name], catalog: entry.catalog });
  if (!plan.ok) return show(failure(`Install ${entry.name}`, plan.error));
  const unmanaged = plan.value.items.filter((i) => i.needsConsent).map((i) => i.dest);
  const applyReplacing = (replace: string[]) => async () => {
    const report = await props.library.applyInstall(plan.value, { overwrite: { unmanaged: replace } });
    if (!report.ok) return show(failure(`Install ${entry.name}`, report.error));
    const lines = report.value.installed.map((i) => `installed ${i.type} ${i.name} → ${i.dest}`);
    if (report.value.stopped) lines.push(`stopped at ${report.value.stopped.name}: ${report.value.stopped.reason}`);
    await show({ title: `Installed from ${entry.catalog}`, lines });
    await load();
  };
  await show({
    title: `Install ${entry.name} from ${entry.catalog}`,
    lines: [...plan.warnings.map((w) => `warning: ${w.message}`), ...plan.value.items.map(describeItem)],
    apply: applyReplacing([]),
    ...(unmanaged.length > 0 && { replace: applyReplacing(unmanaged) }),
    discard: async () => {
      await props.library.discardPlan(plan.value);
    },
  });
}

async function sync() {
  const plan = await props.library.planSync();
  if (!plan.ok) return show(failure("Sync", plan.error));
  const { items, upToDate, unmanaged } = plan.value;
  const lines = [
    ...items.map(describeItem),
    `${upToDate.length} up to date`,
    ...unmanaged.map((u) => `left alone (not installed by Loadout): ${u.type} ${u.name} at ${u.dest}`),
  ];
  const apply = async () => {
    const report = await props.library.applySync(plan.value);
    if (!report.ok) return show(failure("Sync", report.error));
    const r = report.value;
    await show({
      title: "Synced",
      lines: [
        ...r.synced.map((s) => `synced ${s.type} ${s.name}`),
        ...r.failed.map((f) => `failed ${f.type} ${f.name}: ${f.reason}`),
        ...r.missing.map((m) => `installed copy gone: ${m.dest}`),
        `${r.upToDate.length} up to date`,
      ],
    });
    await load();
  };
  const discard = async () => {
    await props.library.discardPlan(plan.value);
  };
  await show({ title: `Sync: ${items.length} to update`, lines, ...(items.length > 0 && { apply }), discard });
}

async function editDescription() {
  const entry = editTarget.value;
  if (!entry) return;
  const plan = await props.library.planUpdate({ name: entry.name, catalog: entry.catalog, type: entry.type, setDescription: editText.value });
  if (!plan.ok) return show(failure(`Edit ${entry.name}`, plan.error));
  const mode = plan.value.write.mode;
  const how = { local: "writes the catalog file", direct: "commits and pushes to the catalog's branch", pr: "pushes a branch and opens a pull request (or gives a compare link)" }[mode];
  const apply = async () => {
    const result = await props.library.applyCatalogEdit(plan.value);
    if (!result.ok) return show(failure(`Edit ${entry.name}`, result.error));
    const r = result.value;
    const lines = Object.entries(r).map(([k, v]) => `${k}: ${String(v)}`);
    await show({ title: `Edited ${entry.name} in ${entry.catalog}`, lines: [...result.warnings.map((w) => `warning: ${w.message}`), ...lines] });
    await load();
  };
  await show({
    title: `Set ${entry.name}'s description in ${entry.catalog}`,
    lines: [...plan.warnings.map((w) => `warning: ${w.message}`), `${mode} mode: ${how}`],
    apply,
    discard: async () => {
      await props.library.discardCatalogEdit(plan.value);
    },
  });
}

// Not wrapped in act(): the panel's Discard must stay clickable to cancel while it waits.
async function githubSignIn() {
  const started = await props.library.beginSignIn("github");
  if (!started.ok) return show(failure("GitHub sign-in", started.error));
  if (started.value.on !== "github") return;
  const { userCode, verificationUri } = started.value;
  const controller = new AbortController();
  await show({
    title: "GitHub sign-in",
    lines: [`Enter ${userCode} at ${verificationUri} (opening in your browser).`],
    discard: async () => controller.abort(),
  });
  await openUrl(verificationUri);
  const done = await props.library.completeSignIn(started.value, { signal: controller.signal });
  if (done.ok) {
    const scopes = done.value.scopes.join(", ") || "no scopes";
    await loadAccounts();
    await show({ title: "GitHub sign-in", lines: [`Signed in to GitHub as ${done.value.login} (${scopes}). You can close the browser tab.`] });
  } else if (done.error.code !== "CANCELLED") {
    await show(failure("GitHub sign-in", done.error));
  }
}

// The Bitbucket sign-in waiting for its loadout:// redirect, if one is.
let pendingBitbucket: IssuedSignIn | null = null;

async function bitbucketSignIn() {
  const started = await props.library.beginSignIn("bitbucket");
  if (!started.ok) return show(failure("Bitbucket sign-in", started.error));
  if (started.value.on !== "bitbucket") return;
  const { authorizeUrl } = started.value;
  await show({
    title: "Bitbucket sign-in",
    lines: ["Approve Loadout in your browser; Loadout comes back when you do."],
    discard: async () => {
      pendingBitbucket = null;
    },
  });
  pendingBitbucket = started.value;
  await openUrl(authorizeUrl);
}

async function onRedirect(urls: string[]) {
  const redirectUrl = urls.find((url) => url.startsWith("loadout://oauth/bitbucket"));
  if (redirectUrl === undefined) return;
  // The browser tab stays on Bitbucket's page, so Loadout comes forward to say how it went.
  await getCurrentWindow().setFocus();
  const started = pendingBitbucket;
  pendingBitbucket = null;
  if (started === null) {
    return show({ title: "Bitbucket sign-in", lines: ["A Bitbucket sign-in came back, but none is in progress here; start it again."] });
  }
  const done = await props.library.completeSignIn(started, { redirectUrl });
  if (!done.ok) return show(failure("Bitbucket sign-in", done.error));
  await loadAccounts();
  await show({ title: "Bitbucket sign-in", lines: [`Signed in to Bitbucket as ${done.value.login}. You can close the browser tab.`] });
}

let stopListening: (() => void) | undefined;

function describeEvent(event: AuditEvent): string {
  if (event.kind === "proc:start") return `#${event.id} $ ${event.argv.join(" ")}${event.cwd ? `  (in ${event.cwd})` : ""}`;
  if (event.kind === "proc:end") return `#${event.id} exit ${event.code} in ${event.durationMs} ms`;
  return `${event.op} ${event.path}${event.to ? ` → ${event.to}` : ""}`;
}

function showLaunch(launch: Result<LaunchReport>) {
  if (launch.ok) {
    status.value = launch.value.state === "no-catalogs" ? "no catalogs registered" : "ready";
    warnings.value.push(...launch.warnings);
  } else {
    status.value = `launch failed: ${launch.error.code}: ${launch.error.message}`;
  }
}

// The first-run path: bring in the Python CLI's registry, then launch again to clone its catalogs.
async function importFromCli() {
  status.value = "importing…";
  const plan = await props.library.planImport();
  if (!plan.ok) {
    status.value = `import refused: ${plan.error.message}`;
    return;
  }
  const imported = await props.library.applyImport(plan.value);
  if (!imported.ok) {
    status.value = `import failed: ${imported.error.message}`;
    return;
  }
  warnings.value.push(...imported.value.notImported.map((message) => ({ message: `not imported: ${message}` })));
  status.value = "launching…";
  const launch = await props.library.launch();
  showLaunch(launch);
  await load();
}

onMounted(async () => {
  // Outside Tauri (component tests without IPC) there is no deep-link plugin to listen to.
  onOpenUrl((urls) => void onRedirect(urls)).then(
    (unlisten) => (stopListening = unlisten),
    () => {},
  );
  // Reads serve the clones on disk while launch refreshes them; load again once it's done.
  await load();
  const launch = await props.launched;
  showLaunch(launch);
  await load();
});

onUnmounted(() => {
  unsubscribe();
  stopListening?.();
});
</script>

<template>
  <main class="debug-view">
    <h1 class="debug-view__title">
      Loadout <small class="debug-view__status">{{ status }}</small>
    </h1>
    <button
      v-if="status === 'no catalogs registered'"
      class="debug-view__import"
      @click="importFromCli"
    >
      Import from the Python CLI
    </button>
    <ul
      v-if="warnings.length"
      class="debug-view__warnings"
    >
      <li
        v-for="(warning, i) in warnings"
        :key="i"
      >
        {{ warning.message }}
      </li>
    </ul>

    <h2>Catalogs</h2>
    <table
      class="debug-view__table"
      data-test="catalogs"
    >
      <tr
        v-for="catalog in catalogs"
        :key="catalog.id"
      >
        <td>{{ catalog.precedence }}</td>
        <td>{{ catalog.id }}</td>
        <td>{{ catalog.writeMode }}</td>
        <td>{{ catalog.location }}</td>
        <td>{{ catalog.skipped ?? `${catalog.entries} entries` }}</td>
      </tr>
    </table>

    <h2>Entries</h2>
    <table
      class="debug-view__table"
      data-test="entries"
    >
      <tr
        v-for="entry in entries"
        :key="`${entry.catalog}:${entry.type}:${entry.name}`"
      >
        <td>{{ entry.type }}</td>
        <td>{{ entry.name }}</td>
        <td>{{ entry.catalog }}</td>
        <td>{{ entry.state }}{{ entry.disabled ? " (off)" : "" }}</td>
        <td>{{ entry.overriddenBy ? `overridden by ${entry.overriddenBy}` : "" }}</td>
        <td>
          <button
            v-if="!entry.overriddenBy"
            :disabled="busy"
            data-test="install"
            @click="act(() => install(entry))"
          >
            Install
          </button>
        </td>
      </tr>
    </table>

    <h2>Accounts</h2>
    <table
      class="debug-view__table"
      data-test="accounts"
    >
      <tr
        v-for="host in hosts"
        :key="host.on"
      >
        <td>{{ host.name }}</td>
        <td>{{ accounts[host.on] ? `${accounts[host.on]!.login} (${accounts[host.on]!.scopes.join(", ") || "no scopes"})` : "not connected" }}</td>
        <td>
          <button
            :disabled="busy"
            :data-test="`${host.on}-sign-in`"
            @click="signIn(host.on)"
          >
            Sign in
          </button>
          <button
            v-if="accounts[host.on]"
            :disabled="busy"
            :data-test="`${host.on}-check`"
            @click="act(() => checkAccount(host.on, host.name))"
          >
            Check
          </button>
          <button
            v-if="accounts[host.on]"
            :disabled="busy"
            :data-test="`${host.on}-disconnect`"
            @click="act(() => disconnect(host.on, host.name))"
          >
            Disconnect
          </button>
        </td>
      </tr>
    </table>

    <h2>Actions</h2>
    <p class="debug-view__actions">
      <button
        :disabled="busy"
        data-test="doctor"
        @click="act(doctor)"
      >
        Doctor
      </button>
      <button
        :disabled="busy"
        data-test="sync"
        @click="act(sync)"
      >
        Plan sync
      </button>
    </p>
    <p class="debug-view__actions">
      Set the description of
      <select
        v-model="editTarget"
        data-test="edit-target"
      >
        <option
          v-for="entry in entries"
          :key="`${entry.catalog}:${entry.type}:${entry.name}`"
          :value="entry"
        >
          {{ entry.catalog }}: {{ entry.name }}
        </option>
      </select>
      to
      <input
        v-model="editText"
        data-test="edit-text"
      >
      <button
        :disabled="busy || !editTarget || !editText"
        data-test="edit"
        @click="act(editDescription)"
      >
        Plan edit
      </button>
    </p>

    <section
      v-if="panel"
      class="debug-view__panel"
      data-test="panel"
    >
      <h3>{{ panel.title }}</h3>
      <ul>
        <li
          v-for="(line, i) in panel.lines"
          :key="i"
        >
          {{ line }}
        </li>
      </ul>
      <button
        v-if="panel.apply"
        :disabled="busy"
        data-test="apply"
        @click="runPanel('apply')"
      >
        Apply
      </button>
      <button
        v-if="panel.replace"
        :disabled="busy"
        data-test="replace"
        @click="runPanel('replace')"
      >
        Apply, replacing copies Loadout didn't install
      </button>
      <button
        v-if="panel.discard"
        :disabled="busy"
        data-test="discard"
        @click="runPanel('discard')"
      >
        Discard
      </button>
    </section>

    <h2>Audit log</h2>
    <ol
      class="debug-view__log"
      data-test="audit"
    >
      <li
        v-for="(event, i) in events"
        :key="i"
      >
        {{ describeEvent(event) }}
      </li>
    </ol>
  </main>
</template>

<style scoped>
.debug-view {
  font: 13px/1.4 -apple-system, system-ui, sans-serif;
  padding: 16px;
}

.debug-view__status {
  font-weight: normal;
  opacity: 0.7;
}

.debug-view__warnings {
  color: var(--status-attention-ink);
}

.debug-view__table td {
  padding: 2px 12px 2px 0;
}

.debug-view__actions button {
  margin-right: 8px;
}

.debug-view__panel {
  border: 1px solid var(--border-control);
  padding: 8px 12px;
}

.debug-view__log {
  font-family: ui-monospace, monospace;
  white-space: pre-wrap;
}
</style>
