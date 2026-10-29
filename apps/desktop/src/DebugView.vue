<script setup lang="ts">
// Throwaway: proves the Tauri host end to end until the real screens exist.
import { onMounted, onUnmounted, ref } from "vue";
import type { AuditEvent, CatalogRow, EntryRecord, LaunchReport, Library, Result, Warning } from "@loadout/core";
import type { AuditLog } from "./host-tauri/audit.ts";

const props = defineProps<{ library: Library; log: AuditLog; launched: Promise<Result<LaunchReport>> }>();

const status = ref("launching…");
const warnings = ref<Warning[]>([]);
const catalogs = ref<CatalogRow[]>([]);
const entries = ref<EntryRecord[]>([]);
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
}

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
  // Reads serve the clones on disk while launch refreshes them; load again once it's done.
  await load();
  const launch = await props.launched;
  showLaunch(launch);
  await load();
});

onUnmounted(unsubscribe);
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
      </tr>
    </table>

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
  color: #666;
}

.debug-view__warnings {
  color: #a15c00;
}

.debug-view__table td {
  padding: 2px 12px 2px 0;
}

.debug-view__log {
  font-family: ui-monospace, monospace;
  white-space: pre-wrap;
}
</style>
