<script setup lang="ts">
import type { Library } from "@loadout/core";
import { open } from "@tauri-apps/plugin-dialog";
import { onMounted, ref } from "vue";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import BusyIndicator from "./BusyIndicator.vue";
import PageHeader from "./PageHeader.vue";
import RegisterCatalog, { type RegisterMode } from "./RegisterCatalog.vue";
import StatusBanner from "./StatusBanner.vue";

type Planned = Awaited<ReturnType<Library["planImport"]>>;
type ImportPlan = Extract<Planned, { ok: true }>["value"];
type ImportRefusal = Extract<Planned, { ok: false }>["error"];
type ImportedCatalog = ImportPlan["config"]["catalogs"][number];

const library = useLibrary();
const activity = useActivityStore();
const catalog = useCatalogStore();

const plan = ref<ImportPlan | null>(null);
/** why there is nothing to import yet: no CLI where it was looked for, or a config it can't take as it stands */
const refusal = ref<ImportRefusal | null>(null);
const importing = ref(false);
const failure = ref<string | null>(null);
const adding = ref<RegisterMode | null>(null);

/** Planning only reads the CLI's files, so it runs on open: the report is what the choice is made on. */
async function planImport(toolDir?: string) {
  const planned = await library.planImport(toolDir);
  if (planned.ok) {
    plan.value = planned.value;
    refusal.value = null;
  } else {
    plan.value = null;
    refusal.value = planned.error;
  }
}

async function chooseFolder() {
  const picked = await open({ directory: true, title: "Which folder holds the Python CLI?" });
  if (typeof picked !== "string") return;
  failure.value = null;
  await planImport(picked);
}

async function runImport() {
  const planned = plan.value;
  if (!planned) return;
  importing.value = true;
  failure.value = null;
  const imported = await activity.withActivity("importing from the Python CLI…", () => library.applyImport(planned));
  importing.value = false;
  if (!imported.ok) {
    failure.value = imported.error.message;
    // The file moved on since it was read: show what importing would take now.
    if (imported.error.code === "STALE_PLAN") await planImport(planned.toolDir);
    return;
  }
  // Imported catalogs aren't cloned yet; launching again clones them and lands on the list.
  await catalog.launch();
}

function describeImported(c: ImportedCatalog): string {
  if (c.kind === "local") return c.writable ? c.path : `${c.path}, read-only`;
  if (!c.writable) return `${c.repo} (${c.branch}), read-only`;
  const how = c.protected ? "changes by pull request" : "changes pushed straight to the branch";
  return `${c.repo} (${c.branch}), ${how}`;
}

onMounted(() => planImport());
</script>

<template>
  <section class="view first-run">
    <PageHeader
      v-if="adding"
      title="Add a catalog"
      back="Set up Loadout"
      @back="adding = null"
    >
      <RegisterCatalog
        :catalogs="[]"
        :start="adding"
        @registered="catalog.launch()"
        @close="adding = null"
      />
    </PageHeader>

    <PageHeader
      v-else
      title="Set up Loadout"
    >
      <p class="first-run__lead">
        Loadout installs skills, agents and prompts from catalogs: <code>library.yaml</code> files in a git repository
        or on this machine. None is registered yet.
      </p>

      <StatusBanner
        v-if="failure"
        kind="error"
        :detail="failure"
      />

      <section
        class="first-run__option card"
        aria-labelledby="first-run-import"
      >
        <h3
          id="first-run-import"
          class="first-run__title"
        >
          Import from the Python CLI
        </h3>
        <template v-if="plan">
          <p class="first-run__line">
            Found <code>{{ plan.configFile }}</code>. Importing registers
            {{ plan.config.catalogs.length === 1 ? "this catalog" : `these ${plan.config.catalogs.length} catalogs, in this order` }}:
          </p>
          <ul class="first-run__list first-run__catalogs">
            <li
              v-for="c in plan.config.catalogs"
              :key="c.id"
            >
              <strong>{{ c.id }}</strong> — {{ describeImported(c) }}
            </li>
          </ul>
          <p
            v-if="Object.keys(plan.config.pins).length"
            class="first-run__line first-run__pins"
          >
            and pins {{ Object.entries(plan.config.pins).map(([name, to]) => `${name} to ${to}`).join(", ") }}.
          </p>
          <template v-if="plan.notImported.length">
            <p class="first-run__line">
              Left behind:
            </p>
            <ul class="first-run__list first-run__left">
              <li
                v-for="line in plan.notImported"
                :key="line"
              >
                {{ line }}
              </li>
            </ul>
          </template>
          <p class="first-run__note">
            The CLI's file is only read, never changed.
          </p>
          <div class="first-run__actions">
            <button
              type="button"
              :disabled="importing"
              @click="runImport"
            >
              Import
            </button>
            <button
              type="button"
              class="ghost"
              :disabled="importing"
              @click="chooseFolder"
            >
              Use another folder…
            </button>
          </div>
          <BusyIndicator
            v-if="importing"
            inline
            label="Importing and cloning the catalogs…"
          />
        </template>
        <template v-else-if="refusal">
          <p class="first-run__line first-run__refusal">
            {{ refusal.message }}
          </p>
          <ul
            v-if="refusal.problems?.length"
            class="first-run__list first-run__problems"
          >
            <li
              v-for="problem in refusal.problems"
              :key="problem"
            >
              {{ problem }}
            </li>
          </ul>
          <div class="first-run__actions">
            <button
              type="button"
              class="ghost"
              @click="chooseFolder"
            >
              Choose the CLI's folder…
            </button>
          </div>
        </template>
      </section>

      <section
        class="first-run__option card"
        aria-labelledby="first-run-add"
      >
        <h3
          id="first-run-add"
          class="first-run__title"
        >
          Add a catalog
        </h3>
        <p class="first-run__line">
          A team's catalog is a git repository you clone; a personal one is a file on this machine that only you write
          to.
        </p>
        <div class="first-run__actions">
          <button
            type="button"
            @click="adding = 'remote'"
          >
            Paste a repository URL…
          </button>
          <button
            type="button"
            class="ghost"
            @click="adding = 'create'"
          >
            Create a personal catalog…
          </button>
        </div>
      </section>
    </PageHeader>
  </section>
</template>

<style scoped>
.first-run__lead {
  margin: 0 0 1rem;
  line-height: 1.5;
  opacity: 0.85;
}
.first-run__option {
  margin-bottom: 1rem;
}
.first-run__title {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.first-run__line {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  line-height: 1.45;
}
.first-run__list {
  margin: 0 0 0.75rem;
  padding-left: 1.2rem;
  font-size: 0.82rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.first-run__note {
  margin: 0 0 0.75rem;
  font-size: 0.78rem;
  opacity: 0.6;
}
.first-run__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.first-run code {
  font-size: 0.85em;
  overflow-wrap: anywhere;
}
</style>
