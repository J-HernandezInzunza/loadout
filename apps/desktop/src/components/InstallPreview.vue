<script setup lang="ts">
import { discardsEdits, type Library } from "@loadout/core";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, ref, watch } from "vue";
import { describeDestState, describeInstallAction, summarizeChanges } from "../catalog.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import BusyIndicator from "./BusyIndicator.vue";
import StatusBanner from "./StatusBanner.vue";

type Plan = Parameters<Library["applyInstall"]>[0];
type Report = Extract<Awaited<ReturnType<Library["applyInstall"]>>, { ok: true }>["value"];

const props = defineProps<{ name: string }>();

const library = useLibrary();
const activity = useActivityStore();
const catalog = useCatalogStore();
const { entries } = storeToRefs(catalog);

const plan = ref<Plan | null>(null);
const report = ref<Report | null>(null);
const loading = ref(false);
const installing = ref(false);
const failure = ref<string | null>(null);
const notice = ref<string | null>(null);
const acknowledged = ref(false);

/** "" installs whatever resolves; another catalog installs that copy, once. */
const source = ref("");
/** pin the chosen catalog before installing, so the next sync keeps it */
const remember = ref(false);

/** The catalogs holding the name, in resolution order; a picker only when there is a choice. */
const sources = computed(() => entries.value.filter((e) => e.name === props.name));
const resolving = computed(() => sources.value.find((e) => e.overriddenBy === null)?.catalog ?? "");
const overriding = computed(() => source.value !== "" && source.value !== resolving.value);
const installed = computed(() => sources.value.some((e) => e.installed));

const items = computed(() => plan.value?.items ?? []);
const drifted = computed(() => (plan.value ? discardsEdits(plan.value) : []));
/** content Loadout didn't install sits at a destination; replacing it needs consent this version doesn't ask for */
const unmanaged = computed(() => items.value.filter((i) => i.status === "ready" && i.needsConsent));
const action = computed(() => describeInstallAction(items.value));
const destinationOnly = computed(() => items.value.some((i) => i.preview.kind === "destination-only"));
const canInstall = computed(
  () => !!plan.value && !installing.value && !unmanaged.value.length && items.value.some((i) => i.status === "ready") && (!drifted.value.length || acknowledged.value),
);

async function discard() {
  const issued = plan.value;
  plan.value = null;
  if (issued) await library.discardPlan(issued);
}

async function preview() {
  await discard();
  loading.value = true;
  failure.value = null;
  report.value = null;
  acknowledged.value = false;
  const planned = await activity.withActivity(`checking what installing ${props.name} would change…`, (signal) =>
    library.planInstall({ names: [props.name], ...(overriding.value && { catalog: source.value }), signal }),
  );
  loading.value = false;
  if (planned.ok) plan.value = planned.value;
  else failure.value = planned.error.message;
}

async function install() {
  const issued = plan.value;
  if (!issued) return;
  installing.value = true;
  failure.value = null;
  notice.value = null;
  try {
    // Pinned first, so a refused pin stops the install before any file is written.
    if (remember.value && overriding.value) {
      const pin = await activity.withActivity(`pinning ${props.name} to ${source.value}…`, async () => {
        const planned = await library.planPin({ name: props.name, catalog: source.value });
        return planned.ok ? library.applyPin(planned.value, { switchInstalled: false }) : planned;
      });
      if (!pin.ok) {
        failure.value = pin.error.message;
        return;
      }
      remember.value = false;
    }
    const applied = await activity.withActivity(`installing ${props.name}…`, (signal) => library.applyInstall(issued, { signal }));
    if (!applied.ok && applied.error.code === "STALE_PLAN") {
      notice.value = "Something changed since the preview, so here is a fresh one.";
      await preview();
      return;
    }
    plan.value = null;
    if (!applied.ok) {
      failure.value = applied.error.message;
      return;
    }
    report.value = applied.value;
    await catalog.reload();
  } finally {
    installing.value = false;
  }
}

watch(source, () => {
  void discard();
  report.value = null;
  failure.value = null;
  acknowledged.value = false;
  if (!overriding.value) remember.value = false;
});

onUnmounted(() => void discard());
</script>

<template>
  <section class="install-preview">
    <!-- Titled by state: "Install" over an entry already badged installed contradicts itself. -->
    <h3 class="install-preview__heading">
      {{ installed ? "Refresh the installed copy" : "Install" }}
    </h3>
    <div class="card">
      <StatusBanner
        v-if="failure"
        kind="error"
        :detail="failure"
      />
      <StatusBanner
        v-if="notice"
        kind="warning"
      >
        {{ notice }}
      </StatusBanner>

      <!-- Only when there is a choice: a picker with one option is a setting you are failing to use. -->
      <div
        v-if="sources.length > 1"
        class="install-preview__sources"
      >
        <label class="install-preview__field">
          <span class="install-preview__label">Install from</span>
          <select
            v-model="source"
            class="install-preview__source"
          >
            <option
              v-for="option in sources"
              :key="option.catalog"
              :value="option.overriddenBy === null ? '' : option.catalog"
            >
              {{ option.catalog }}{{ option.overriddenBy === null ? (option.pinned ? " · default, pinned" : " · default") : "" }}
            </option>
          </select>
        </label>
        <label
          v-if="overriding"
          class="install-preview__remember"
        >
          <input
            v-model="remember"
            type="checkbox"
          >
          <span>
            Always use {{ source }} for {{ name }}. Without this the choice applies to this install only, and the next
            refresh goes back to {{ resolving || "whatever the catalog order resolves" }}.
          </span>
        </label>
      </div>

      <p class="install-preview__note">
        An install puts one copy in your Claude directory, where every project on this machine can use it. Loadout
        keeps managing it: it is listed, refreshed by a sync, and removable afterwards.
      </p>

      <button
        type="button"
        class="ghost"
        :disabled="loading"
        @click="preview()"
      >
        {{ plan ? "Re-check" : "Preview install" }}
      </button>
      <BusyIndicator
        v-if="loading"
        inline
        label="Fetching and comparing files…"
      />

      <template v-if="plan">
        <p
          v-if="action.caution"
          class="install-preview__caution"
        >
          {{ action.caution }}
        </p>
        <p
          v-if="drifted.length"
          class="install-preview__warning"
        >
          Installing overwrites local edits that Loadout did not make. The edited copies are marked below; they cannot
          be recovered afterwards.
        </p>
        <p
          v-if="destinationOnly"
          class="install-preview__warning"
        >
          Couldn't fetch the source, so only the destinations are shown, not which files would change.
        </p>
        <p class="install-preview__scope">
          nothing has been written
        </p>
        <ul class="install-preview__plan fade-in">
          <li
            v-for="item in items"
            :key="item.dest"
            class="install-preview__item"
            :class="{ 'install-preview__item--drifted': item.state === 'drifted' }"
          >
            <span class="install-preview__item-head">
              <strong>{{ item.name }}</strong>
              <span
                v-if="item.requiredBy.length"
                class="install-preview__role"
              >dependency</span>
              <span
                class="install-preview__state"
                :class="{ 'install-preview__state--drifted': item.state === 'drifted' }"
              >{{ describeDestState(item.state) }}</span>
            </span>
            <code class="install-preview__dest">{{ item.dest }}</code>
            <p
              v-if="item.status !== 'ready'"
              class="install-preview__warning"
            >
              Can't install: {{ item.reason }}
            </p>
            <p
              v-else-if="item.needsConsent"
              class="install-preview__warning"
            >
              This holds a copy Loadout didn't install, so Loadout leaves it alone. Remove it yourself to install the
              catalog's copy here.
            </p>
            <ul
              v-else-if="item.preview.kind === 'files' && !item.preview.newInstall"
              class="install-preview__files"
            >
              <li
                v-for="file in item.preview.modified"
                :key="`~${file}`"
              >
                ~ {{ file }}<span
                  v-if="item.preview.editedLocally.includes(file)"
                  class="install-preview__edited"
                > · you edited this</span>
              </li>
              <li
                v-for="file in item.preview.added"
                :key="`+${file}`"
              >
                + {{ file }}
              </li>
              <li
                v-for="file in item.preview.removed"
                :key="`-${file}`"
              >
                - {{ file }}
              </li>
            </ul>
          </li>
        </ul>
        <label
          v-if="drifted.length"
          class="install-preview__ack"
        >
          <input
            v-model="acknowledged"
            type="checkbox"
          >
          Overwrite {{ drifted.length }} locally edited {{ drifted.length === 1 ? "copy" : "copies" }}, discarding those
          edits.
        </label>
        <button
          type="button"
          class="install-preview__go"
          :disabled="!canInstall"
          @click="install()"
        >
          {{ action.label }}
        </button>
        <BusyIndicator
          v-if="installing"
          inline
          label="Fetching and writing files…"
        />
      </template>

      <template v-if="report">
        <StatusBanner
          v-if="report.stopped"
          kind="error"
          :detail="report.stopped.reason"
        >
          Stopped at {{ report.stopped.name }}; what installed before it stays installed.
        </StatusBanner>
        <StatusBanner
          v-else-if="report.aborted"
          kind="warning"
        >
          Cancelled; what installed before that stays installed.
        </StatusBanner>
        <p class="install-preview__done fade-in">
          Installed {{ report.installed.length }} {{ report.installed.length === 1 ? "item" : "items" }}.
        </p>
        <ul class="install-preview__plan fade-in">
          <li
            v-for="item in report.installed"
            :key="item.dest"
            class="install-preview__item"
          >
            <span class="install-preview__item-head">
              <strong>{{ item.name }}</strong>
              <span class="install-preview__state">{{ summarizeChanges(item.preview) }}</span>
            </span>
            <code class="install-preview__dest">{{ item.dest }}</code>
            <ul
              v-if="item.preview.kind === 'files' && !item.preview.newInstall"
              class="install-preview__files"
            >
              <li
                v-for="file in item.preview.modified"
                :key="`~${file}`"
              >
                ~ {{ file }}
              </li>
              <li
                v-for="file in item.preview.added"
                :key="`+${file}`"
              >
                + {{ file }}
              </li>
              <li
                v-for="file in item.preview.removed"
                :key="`-${file}`"
              >
                - {{ file }}
              </li>
            </ul>
          </li>
        </ul>
      </template>
    </div>
  </section>
</template>

<style scoped>
.install-preview {
  margin-top: 1.75rem;
}
.install-preview__heading {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.5;
}
.install-preview__caution {
  margin: 0.5rem 0 0;
  font-size: 0.78rem;
  line-height: 1.45;
  opacity: 0.75;
}
.install-preview__warning {
  margin: 0.75rem 0 0;
  padding: 0.65rem 0.85rem;
  border-radius: 8px;
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--status-attention-ink);
  background: var(--status-attention-tint);
}
.install-preview__scope {
  margin: 0.75rem 0 0.5rem;
  font-size: 0.75rem;
  opacity: 0.6;
}
.install-preview__sources {
  margin-bottom: 0.9rem;
}
.install-preview__field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.install-preview__source {
  align-self: flex-start;
  max-width: 100%;
  padding: 0.35rem 0.5rem;
  border-radius: 8px;
  border: 1px solid var(--border-control);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 0.85rem;
}
.install-preview__remember {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  margin-top: 0.55rem;
  font-size: 0.76rem;
  line-height: 1.45;
  opacity: 0.85;
}
.install-preview__note {
  margin: 0 0 0.6rem;
  padding: 0.5rem 0.7rem;
  border-radius: 6px;
  background: var(--surface-hover);
  font-size: 0.78rem;
  line-height: 1.5;
  opacity: 0.85;
}
.install-preview__note code {
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.install-preview__label {
  margin: 0.6rem 0 0.2rem;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.5;
}
.install-preview__plan {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.install-preview__item {
  padding: 0.5rem 0.85rem;
  border-radius: 8px;
  background: var(--surface-raised);
}
.install-preview__item--drifted {
  border-left: 3px solid var(--status-attention-ink);
}
.install-preview__item-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  font-size: 0.85rem;
}
.install-preview__role {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  opacity: 0.55;
}
.install-preview__state {
  font-size: 0.7rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: var(--surface-sunken);
}
.install-preview__state--drifted {
  background: var(--status-attention-tint);
  color: var(--status-attention-ink);
  font-weight: 600;
}
.install-preview__dest {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.78rem;
  opacity: 0.65;
  overflow-wrap: anywhere;
}
.install-preview__files {
  list-style: none;
  margin: 0.35rem 0 0;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.75rem;
  opacity: 0.6;
}
.install-preview__ack {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  margin: 0.75rem 0 0;
  font-size: 0.82rem;
  line-height: 1.4;
}
.install-preview__go {
  margin-top: 0.75rem;
}
.install-preview__done {
  margin: 0.75rem 0 0.5rem;
  font-size: 0.85rem;
  color: var(--status-ok-ink);
  font-weight: 600;
}
.install-preview__edited {
  color: var(--status-attention-ink);
}
</style>
