<script setup lang="ts">
import type { EntryDetail, Library } from "@loadout/core";
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";
import { catalogHue } from "../catalog.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import StatusBanner from "./StatusBanner.vue";

type PinPlan = Parameters<Library["applyPin"]>[0];
type Copy = EntryDetail["copies"][number];

const props = defineProps<{ detail: EntryDetail }>();
const emit = defineEmits<{ changed: [] }>();

const library = useLibrary();
const activity = useActivityStore();
const views = useViewStore();
const { catalogs, entries } = storeToRefs(useCatalogStore());

/** the catalog whose pin action is in flight */
const pinning = ref("");
const failure = ref<string | null>(null);
/** asked before either half changes, when pinning would leave an installed copy from elsewhere */
const proposal = ref<PinPlan | null>(null);
/** what a pin meant for the copy already installed, told after the write */
const switched = ref<{ plan: Pick<PinPlan, "catalog" | "switch">; installed: boolean } | null>(null);
const unpinned = ref<string | null>(null);

const name = computed(() => props.detail.name);
const choosable = computed(() => props.detail.copies.length > 1);
const pinnedTo = computed(() => props.detail.copies.find((c) => c.pinned)?.catalog ?? "");
const hueOf = (id: string) => catalogHue(catalogs.value.find((c) => c.id === id)?.precedence ?? 1);
/** each copy's source string, from the catalog it sits in */
const sourceOf = (catalog: string) => entries.value.find((e) => e.catalog === catalog && e.name === name.value)?.source ?? "";
const editable = (id: string) => catalogs.value.some((c) => c.id === id && c.editable);

/**
 * Every copy has a verb, the winner included: pinning it changes nothing today and everything the day the
 * registry is reordered.
 */
function action(copy: Copy): { label: string; busy: string; hint?: string } | null {
  if (copy.pinned) return { label: "Clear pin", busy: "Clearing…" };
  if (!choosable.value) return null;
  if (copy.wins) return { label: "Pin to this", busy: "Pinning…", hint: "Already what installs. Pinning keeps it that way if the catalog order changes." };
  return { label: "Use this one", busy: "Checking…" };
}

function reset() {
  failure.value = null;
  proposal.value = null;
  switched.value = null;
  unpinned.value = null;
}

async function pinTo(catalog: string) {
  reset();
  pinning.value = catalog;
  const planned = await activity.withActivity(`checking what pinning ${name.value} would replace…`, () => library.planPin({ name: name.value, catalog }));
  pinning.value = "";
  if (!planned.ok) {
    failure.value = planned.error.message;
    return;
  }
  // Nothing installed from elsewhere: there is nothing to ask.
  if (planned.value.switch.switchable) proposal.value = planned.value;
  else await apply(planned.value, false);
}

async function apply(plan: PinPlan, switchInstalled: boolean) {
  pinning.value = plan.catalog;
  failure.value = null;
  const label = switchInstalled ? `pinning ${name.value} to ${plan.catalog} and switching the copy over…` : `pinning ${name.value} to ${plan.catalog}…`;
  const result = await activity.withActivity(label, (signal) => library.applyPin(plan, { switchInstalled, signal }));
  pinning.value = "";
  if (!result.ok) {
    failure.value = result.error.message;
    return;
  }
  proposal.value = null;
  if (result.value.switch.switchable) switched.value = { plan: result.value, installed: result.value.installed !== null };
  emit("changed");
}

async function clearPin() {
  reset();
  pinning.value = pinnedTo.value;
  const result = await activity.withActivity(`unpinning ${name.value}…`, () => library.unpin(name.value));
  pinning.value = "";
  if (!result.ok) {
    failure.value = result.error.message;
    return;
  }
  unpinned.value = result.value.resolvesTo
    ? `Unpinned ${name.value}. Catalog order decides it again, so ${result.value.resolvesTo}'s copy is what installs.`
    : `Unpinned ${name.value}.`;
  emit("changed");
}

function run(copy: Copy) {
  if (copy.pinned) void clearPin();
  else void pinTo(copy.catalog);
}

const busy = (copy: Copy) => (copy.pinned ? pinning.value !== "" : pinning.value === copy.catalog);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const dependentNames = (plan: Pick<PinPlan, "switch">) => [...new Set(plan.switch.dependents.map((d) => d.name))].join(", ");

watch(name, reset);
</script>

<template>
  <section class="copy-chooser">
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
        Decided by catalog order. Pin one to settle it for this name alone, without reordering the registry for
        everything else.
      </template>
      Copies already on this machine keep the source they came from until you install again.
    </p>

    <StatusBanner
      v-if="failure"
      kind="error"
      :detail="failure"
    />
    <StatusBanner
      v-if="unpinned"
      kind="success"
    >
      {{ unpinned }}
    </StatusBanner>

    <!-- A question, not a report: the assessment reads the registry and the disk, never the pin. -->
    <div
      v-if="proposal"
      class="entry-detail__propose fade-in"
    >
      <p class="entry-detail__propose-lede">
        Pinning to <strong>{{ proposal.catalog }}</strong> affects {{ proposal.switch.stale.length }} installed
        {{ plural(proposal.switch.stale.length, "copy", "copies") }}:
      </p>
      <ul class="entry-detail__switch-list">
        <li
          v-for="copy in proposal.switch.stale"
          :key="copy.dest"
        >
          <code>{{ copy.dest }}</code> — {{ copy.state }}, from {{ copy.from ?? "an unrecorded source" }}
        </li>
      </ul>
      <p
        v-if="proposal.switch.newDependencies.length"
        class="entry-detail__switch-note"
      >
        Switching also installs {{ proposal.switch.newDependencies.join(", ") }}, which the {{ proposal.catalog }} copy
        requires.
      </p>
      <p
        v-if="proposal.switch.dependents.length"
        class="entry-detail__switch-note"
      >
        Still expected by {{ dependentNames(proposal) }} — each resolves {{ name }} within its own catalog, so after a
        switch what is on disk is no longer the copy it names.
      </p>
      <template v-if="proposal.switch.blockers.length">
        <p class="entry-detail__switch-note">
          These cannot be switched over without a decision:
        </p>
        <ul class="entry-detail__switch-list">
          <li
            v-for="why in proposal.switch.blockers"
            :key="why"
          >
            {{ why }}
          </li>
        </ul>
      </template>
      <div class="entry-detail__propose-actions">
        <button
          v-if="proposal.switch.simple"
          type="button"
          :disabled="!!pinning"
          @click="apply(proposal, true)"
        >
          {{ pinning ? "Switching…" : "Pin and switch the files over" }}
        </button>
        <button
          type="button"
          class="ghost"
          :disabled="!!pinning"
          @click="apply(proposal, false)"
        >
          Pin only, leave the files
        </button>
        <button
          type="button"
          class="ghost"
          :disabled="!!pinning"
          @click="proposal = null"
        >
          Cancel
        </button>
      </div>
    </div>

    <!-- Told after the write, because it describes the machine before the reconcile. -->
    <StatusBanner
      v-if="switched"
      :kind="switched.installed ? 'success' : 'warning'"
    >
      <template v-if="switched.installed">
        <p class="entry-detail__switch-lede">
          Switched {{ switched.plan.switch.stale.length }} {{ plural(switched.plan.switch.stale.length, "copy", "copies") }}
          over to {{ switched.plan.catalog }}, overwriting what was installed.
        </p>
        <ul class="entry-detail__switch-list">
          <li
            v-for="copy in switched.plan.switch.stale"
            :key="copy.dest"
          >
            <code>{{ copy.dest }}</code> — was from {{ copy.from ?? "an unrecorded source" }}
          </li>
        </ul>
        <p
          v-if="switched.plan.switch.newDependencies.length"
          class="entry-detail__switch-note"
        >
          Also installed {{ switched.plan.switch.newDependencies.join(", ") }}, which the {{ switched.plan.catalog }} copy
          requires.
        </p>
      </template>
      <template v-else>
        <p class="entry-detail__switch-lede">
          The pin is saved, but the {{ plural(switched.plan.switch.stale.length, "copy", "copies") }} already installed
          {{ plural(switched.plan.switch.stale.length, "was", "were") }} left alone:
        </p>
        <ul class="entry-detail__switch-list">
          <li
            v-for="why in switched.plan.switch.blockers"
            :key="why"
          >
            {{ why }}
          </li>
        </ul>
        <p class="entry-detail__switch-note">
          Nothing was overwritten. Settle those, then install from this page to switch over.
        </p>
      </template>
      <p
        v-if="switched.plan.switch.dependents.length"
        class="entry-detail__switch-note"
      >
        Still expected by {{ dependentNames(switched.plan) }} — each resolves {{ name }} within its own catalog, so what is
        on disk is no longer the copy it names.
      </p>
    </StatusBanner>

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
          <button
            v-if="action(copy)"
            type="button"
            class="ghost btn-sm entry-detail__choose"
            :disabled="!!pinning"
            :title="action(copy)!.hint"
            @click="run(copy)"
          >
            {{ busy(copy) ? action(copy)!.busy : action(copy)!.label }}
          </button>
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
          class="ghost btn-sm entry-detail__edit"
          @click="views.manage = { catalog: copy.catalog, entry: name }"
        >
          Edit this entry in {{ copy.catalog }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.entry-detail__copy-source {
  margin: 0;
  font-size: 0.8rem;
  font-family: ui-monospace, SFMono-Regular, monospace;
  overflow-wrap: anywhere;
  opacity: 0.75;
}
.entry-detail__copies {
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
.entry-detail__pinned {
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--status-ok-ink);
  background: var(--status-ok-tint);
}
.entry-detail__propose {
  margin: 0 0 0.9rem;
  padding: 0.75rem 0.9rem;
  border-radius: 8px;
  border-left: 3px solid var(--status-attention-ink);
  background: var(--status-attention-tint);
}
.entry-detail__propose-lede {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.45;
}
.entry-detail__propose-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.entry-detail__switch-lede {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.45;
}
.entry-detail__switch-list {
  margin: 0.4rem 0 0;
  padding-left: 1.1rem;
  font-size: 0.78rem;
  line-height: 1.5;
}
.entry-detail__switch-list code {
  font-size: 0.74rem;
  overflow-wrap: anywhere;
}
.entry-detail__switch-note {
  margin: 0.45rem 0 0;
  font-size: 0.78rem;
  line-height: 1.45;
  opacity: 0.85;
}
.entry-detail__copies-lead {
  margin: -0.4rem 0 0.7rem;
  font-size: 0.78rem;
  line-height: 1.5;
  opacity: 0.7;
}
/* Hard right of the head row whatever the label's width, and whatever sits to its left. */
.entry-detail__choose {
  margin-left: auto;
}
.entry-detail__loses,
.entry-detail__chain {
  margin: 0 0 0.3rem;
  font-size: 0.72rem;
  opacity: 0.7;
}
</style>
