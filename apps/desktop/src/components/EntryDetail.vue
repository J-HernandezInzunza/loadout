<script setup lang="ts">
import type { EntryDetail } from "@loadout/core";
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";
import { catalogHue, installStatus, SESSION_TIMING } from "../catalog.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore, type EntryStop } from "../stores/views.ts";
import BusyIndicator from "./BusyIndicator.vue";
import InstalledCopies from "./InstalledCopies.vue";
import PageHeader from "./PageHeader.vue";
import StatusBanner from "./StatusBanner.vue";

const props = defineProps<{
  stop: EntryStop;
  /** the title of the page Back returns to */
  back: string;
}>();

const library = useLibrary();
const activity = useActivityStore();
const views = useViewStore();
const catalog = useCatalogStore();
const { catalogs, entries } = storeToRefs(catalog);

const detail = ref<EntryDetail | null>(null);
const loading = ref(false);
const failure = ref<string | null>(null);

/** `quiet` after a write on this page: the page stays up, so the outcome banner on it stays readable. */
async function load(quiet = false) {
  const { name, catalog } = props.stop;
  loading.value = !quiet;
  failure.value = null;
  if (!quiet) detail.value = null;
  const shown = await activity.withActivity(`reading ${name}…`, () => library.show(name, { catalog }));
  loading.value = false;
  if (shown.ok) detail.value = shown.value;
  else failure.value = shown.error.message;
}

// The catalog too: a name has a copy per catalog, and the list opens the one that was clicked.
watch([() => props.stop.name, () => props.stop.catalog], () => load(), { immediate: true });

async function afterWrite() {
  await Promise.all([load(true), catalog.reload()]);
}

const status = computed(() => (detail.value ? installStatus(detail.value.entry) : null));
const hueOf = (id: string) => catalogHue(catalogs.value.find((c) => c.id === id)?.precedence ?? 1);

const sourceLine = computed(() => {
  const source = detail.value?.source;
  if (!source || source.kind === "unknown" || source.kind === "local") return source?.raw ?? "";
  return `${source.kind} · ${source.org}/${source.repo} (${source.branch})`;
});
const sourcePath = computed(() => {
  const source = detail.value?.source;
  return source && source.kind !== "unknown" && source.kind !== "local" ? source.filePath : null;
});

const declared = computed(() => detail.value?.requires.filter((d) => d.direct) ?? []);
const inherited = computed(() => detail.value?.requires.filter((d) => !d.direct) ?? []);
const dependents = computed(() => detail.value?.dependents ?? []);

const choosable = computed(() => (detail.value?.copies.length ?? 0) > 1);
const pinnedTo = computed(() => detail.value?.copies.find((c) => c.pinned)?.catalog ?? "");
/** each copy's source string, from the catalog it sits in */
const sourceOf = (catalog: string) => entries.value.find((e) => e.catalog === catalog && e.name === props.stop.name)?.source ?? "";
/** Where Loadout writes in this milestone: editable, and a file on this machine. */
const editable = (id: string) => catalogs.value.some((c) => c.id === id && c.editable && c.kind === "local");

function brokenBecause(reason: "malformed" | "not_found" | "cycle"): string {
  if (reason === "not_found") return "no catalog defines it";
  if (reason === "malformed") return "not a valid type:name reference";
  return "circular dependency";
}

const handoff = computed(() =>
  detail.value?.entry.installed
    ? "Add another copy or refresh this one, and see what this skill needs before it runs."
    : "Put a copy on this machine, and see what it needs before it runs.",
);
</script>

<template>
  <section class="view">
    <!-- Titled from the stop, so the header is in place before the read returns. -->
    <PageHeader
      :title="stop.name"
      :back="back"
      @back="views.trail.pop()"
    >
      <template #badges>
        <span
          v-if="detail"
          class="entry-detail__type"
        >{{ detail.entry.type }}</span>
        <span
          v-if="detail && catalogs.length > 1"
          class="entry-detail__origin-badge"
          :style="{ '--catalog-hue': hueOf(detail.entry.catalog) }"
        >
          {{ detail.entry.catalog }}
        </span>
        <span
          v-if="status"
          class="entry-detail__status"
          :class="`entry-detail__status--${status.tone}`"
        >
          {{ status.status }}
        </span>
      </template>

      <BusyIndicator
        v-if="loading"
        :label="`Reading ${stop.name}…`"
      />
      <StatusBanner
        v-else-if="failure"
        kind="error"
        :detail="failure"
      />
      <template v-else-if="detail">
        <p class="entry-detail__desc">
          {{ detail.entry.description }}
        </p>
        <p
          v-if="detail.entry.disabled"
          class="entry-detail__timing"
        >
          Switched off, so nothing loads it. {{ SESSION_TIMING }}
        </p>

        <h3 class="entry-detail__section">
          Source
        </h3>
        <div class="card">
          <p class="entry-detail__origin">
            {{ sourceLine }}
          </p>
          <p
            v-if="sourcePath"
            class="entry-detail__path"
          >
            {{ sourcePath }}
          </p>
        </div>

        <!-- What you have before what you could do: the page is most often opened about an installed entry. -->
        <InstalledCopies
          :entry="detail.entry"
          :affected="dependents.filter((d) => d.installed).map((d) => d.name)"
          @changed="afterWrite()"
        />

        <h3 class="entry-detail__section">
          Install and set up
        </h3>
        <div class="card entry-detail__handoff">
          <p class="entry-detail__handoff-lede">
            {{ handoff }}
          </p>
          <button
            type="button"
            @click="views.installFor = detail.name"
          >
            Install and set up
          </button>
        </div>

        <h3 class="entry-detail__section">
          <template v-if="choosable">
            Where this comes from ({{ detail.copies.length }} catalogs)
          </template>
          <template v-else>
            Catalog holding this name
          </template>
        </h3>
        <p
          v-if="choosable"
          class="entry-detail__copies-lead"
        >
          <template v-if="pinnedTo">
            Pinned to <strong>{{ pinnedTo }}</strong>, so its copy installs whatever the catalog order says.
          </template>
          <template v-else>
            Decided by catalog order. Pin one to settle it for this name alone, without reordering the
            registry for everything else.
          </template>
          Copies already on this machine keep the source they came from until you install again.
        </p>
        <ul class="entry-detail__copies">
          <li
            v-for="copy in detail.copies"
            :key="copy.catalog"
            class="entry-detail__copy"
            :class="{ 'entry-detail__copy--wins': copy.wins }"
            :style="{ '--catalog-hue': hueOf(copy.catalog) }"
          >
            <div class="entry-detail__copy-head">
              <span class="entry-detail__origin-chip">{{ copy.catalog }}</span>
              <!-- Pinned and first-by-order look alike from outside and are undone by different things. -->
              <span
                v-if="copy.pinned"
                class="entry-detail__pinned"
              >pinned — this is what installs</span>
              <span
                v-else-if="copy.wins"
                class="entry-detail__wins"
              >first by catalog order — this is what installs</span>
              <span
                v-else
                class="entry-detail__loses"
              >overridden by {{ copy.overriddenBy }}</span>
            </div>
            <p
              v-if="copy.overrides.length"
              class="entry-detail__chain"
            >
              overrides {{ copy.overrides.join(", ") }}
            </p>
            <p class="entry-detail__copy-source">
              {{ sourceOf(copy.catalog) }}
            </p>
            <!-- A pointer, not a form: the edit belongs with the catalog management. -->
            <button
              v-if="editable(copy.catalog)"
              type="button"
              class="ghost btn-sm"
              @click="views.manage = { catalog: copy.catalog, entry: detail.name }"
            >
              Edit this entry in {{ copy.catalog }}
            </button>
          </li>
        </ul>

        <template v-if="declared.length">
          <h3 class="entry-detail__section">
            Requires ({{ declared.length }})
          </h3>
          <ul class="entry-detail__requires">
            <li
              v-for="dep in declared"
              :key="dep.name"
            >
              <button
                type="button"
                class="entry-detail__dep"
                @click="views.trail.push({ name: dep.name, catalog: dep.catalog })"
              >
                <span class="entry-detail__dep-head">
                  <strong>{{ dep.name }}</strong>
                  <span
                    class="entry-detail__dep-state"
                    :class="{ 'entry-detail__dep-state--missing': !dep.installed }"
                  >{{ dep.installed ? "installed" : "not installed" }}</span>
                </span>
                <span class="entry-detail__req-desc">{{ dep.description }}</span>
              </button>
            </li>
          </ul>
        </template>

        <template v-if="inherited.length">
          <h3 class="entry-detail__section">
            Also installed, via those ({{ inherited.length }})
          </h3>
          <ul class="entry-detail__requires">
            <li
              v-for="dep in inherited"
              :key="dep.name"
            >
              <button
                type="button"
                class="entry-detail__dep"
                @click="views.trail.push({ name: dep.name, catalog: dep.catalog })"
              >
                <span class="entry-detail__dep-head">
                  <strong>{{ dep.name }}</strong>
                  <span
                    class="entry-detail__dep-state"
                    :class="{ 'entry-detail__dep-state--missing': !dep.installed }"
                  >{{ dep.installed ? "installed" : "not installed" }}</span>
                </span>
              </button>
            </li>
          </ul>
        </template>

        <template v-if="dependents.length">
          <h3 class="entry-detail__section">
            Required by ({{ dependents.length }})
          </h3>
          <ul class="entry-detail__requires">
            <li
              v-for="user in dependents"
              :key="user.name"
            >
              <button
                type="button"
                class="entry-detail__dep"
                @click="views.trail.push({ name: user.name, catalog: user.catalog })"
              >
                <span class="entry-detail__dep-head">
                  <strong>{{ user.name }}</strong>
                  <span
                    v-if="!user.direct"
                    class="entry-detail__indirect"
                  >via another entry</span>
                  <span
                    class="entry-detail__dep-state"
                    :class="{ 'entry-detail__dep-state--missing': !user.installed }"
                  >{{ user.installed ? "installed" : "not installed" }}</span>
                </span>
                <span class="entry-detail__req-desc">{{ user.description }}</span>
              </button>
            </li>
          </ul>
        </template>

        <template v-if="detail.unresolvedRequires.length">
          <h3 class="entry-detail__section entry-detail__section--broken">
            Unresolved ({{ detail.unresolvedRequires.length }})
          </h3>
          <ul class="entry-detail__requires">
            <li
              v-for="broken in detail.unresolvedRequires"
              :key="broken.ref"
              class="entry-detail__broken"
            >
              <code>{{ broken.ref }}</code>
              <span class="entry-detail__broken-why">{{ brokenBecause(broken.reason) }}</span>
              <p class="entry-detail__req-desc">
                Required by {{ broken.requiredBy }}. This entry will install without it.
              </p>
            </li>
          </ul>
        </template>
      </template>
    </PageHeader>
  </section>
</template>

<style scoped>
.entry-detail__state,
.entry-detail__none {
  opacity: 0.7;
  font-size: 0.88rem;
}
.entry-detail__type {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  opacity: 0.6;
}
.entry-detail__status {
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--status-ok-tint);
  color: var(--status-ok-ink);
}
.entry-detail__status--absent {
  background: var(--surface-sunken);
  color: inherit;
  opacity: 0.75;
}
.entry-detail__status--disabled {
  /* Matches the list's badge: violet reads as neither the green of a loading skill nor
     the grey of one that was never installed. Without this the base rule's green would
     put "disabled" in the colour of a skill that is loading. */
  background: var(--status-disabled-tint);
  color: var(--status-disabled-ink);
}
.entry-detail__status--attention {
  background: var(--status-attention-tint);
  color: var(--status-attention-ink);
}
.entry-detail__status--overridden {
  background: var(--surface-sunken);
  color: inherit;
  opacity: 0.75;
}
.entry-detail__handoff {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.entry-detail__handoff-lede {
  flex: 1;
  min-width: 14rem;
  margin: 0;
  font-size: 0.85rem;
  opacity: 0.8;
}
.entry-detail__desc {
  margin: 0;
  line-height: 1.5;
  opacity: 0.85;
}
.entry-detail__timing {
  margin: 0.6rem 0 0;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  border-left: 3px solid var(--status-disabled-edge);
  background: var(--status-disabled-tint);
  font-size: 0.82rem;
  line-height: 1.5;
}
.entry-detail__section {
  margin: 1.75rem 0 0.5rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.5;
}
.entry-detail__origin,
.entry-detail__path,
.entry-detail__copy-source {
  margin: 0;
  font-size: 0.8rem;
  font-family: ui-monospace, SFMono-Regular, monospace;
  overflow-wrap: anywhere;
  opacity: 0.75;
}
.entry-detail__path {
  opacity: 0.55;
}
.entry-detail__copies,
.entry-detail__requires {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.entry-detail__copy {
  padding: 0.65rem 0.85rem;
  border-radius: 8px;
  border-left: 3px solid var(--catalog-edge);
  background: var(--surface-raised);
  opacity: 0.7;
}
.entry-detail__copy--wins {
  opacity: 1;
}
.entry-detail__copy-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.3rem;
}
.entry-detail__origin-chip {
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  background: var(--catalog-fill);
  color: var(--text-on-accent);
  font-size: 0.7rem;
  font-weight: 600;
}
.entry-detail__origin-chip--muted {
  background: var(--surface-strong);
  color: inherit;
}
.entry-detail__wins {
  font-size: 0.72rem;
  color: var(--status-ok-ink);
  font-weight: 600;
}
/* Tinted rather than just coloured, so a pin reads as something someone chose and a
   precedence win reads as the default it is. */
.entry-detail__origin-badge {
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--catalog-fill);
  color: var(--text-on-accent);
  font-size: 0.7rem;
  font-weight: 600;
}
.entry-detail__pinned {
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--status-ok-ink);
  background: var(--status-ok-tint);
}
.entry-detail__copies-lead {
  margin: -0.4rem 0 0.7rem;
  font-size: 0.78rem;
  line-height: 1.5;
  opacity: 0.7;
}
.entry-detail__loses,
.entry-detail__chain {
  margin: 0 0 0.3rem;
  font-size: 0.72rem;
  opacity: 0.7;
}
.entry-detail__requires li {
  border-radius: 8px;
  background: var(--surface-raised);
  font-size: 0.85rem;
}
.entry-detail__dep {
  display: block;
  width: 100%;
  padding: 0.5rem 0.85rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.entry-detail__dep:hover {
  background: var(--surface-hover);
}
.entry-detail__dep-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.entry-detail__dep-state {
  font-size: 0.7rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: var(--status-ok-tint);
  color: var(--status-ok-ink);
}
.entry-detail__dep-state--missing {
  background: var(--surface-sunken);
  color: inherit;
  opacity: 0.7;
}
.entry-detail__indirect {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  opacity: 0.5;
}
.entry-detail__section--broken {
  color: var(--status-danger-ink);
  opacity: 0.85;
}
.entry-detail__broken {
  padding: 0.5rem 0.85rem;
  border-left: 3px solid var(--status-danger-ink);
}
.entry-detail__broken-why {
  margin-left: 0.5rem;
  font-size: 0.75rem;
  color: var(--status-danger-ink);
}
.entry-detail__req-desc {
  margin: 0.25rem 0 0;
  font-size: 0.78rem;
  opacity: 0.7;
}
</style>
