<script setup lang="ts">
import { requiresOf, type EntryRecord, type EntryType, type Library, type LoadoutRecord } from "@loadout/core";
import { storeToRefs } from "pinia";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import ClashLine from "./ClashLine.vue";
import PageHeader from "./PageHeader.vue";
import StatusBanner from "./StatusBanner.vue";
import TypeColumn from "./TypeColumn.vue";
import TypeDot from "./TypeDot.vue";
import UiSelect from "./ui/UiSelect.vue";

type Member = Parameters<Library["planSaveLoadout"]>[0]["members"][number];
type Saved = Extract<Awaited<ReturnType<Library["applySaveLoadout"]>>, { ok: true }>["value"];
type Clash = Extract<Awaited<ReturnType<Library["launchCommand"]>>, { ok: true }>["value"]["clashes"][number];

const props = defineProps<{
  /** the loadout being edited; null for a new one */
  loadout: LoadoutRecord | null;
  /** names already taken, so a new name that clashes is refused as it's typed */
  taken: string[];
}>();
const emit = defineEmits<{ saved: [result: Saved]; cancel: [] }>();

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TYPES: { value: EntryType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "skill", label: "Skills" },
  { value: "agent", label: "Agents" },
  { value: "prompt", label: "Prompts" },
];
const COLUMNS: { type: EntryType; title: string; empty: string }[] = [
  { type: "skill", title: "Skills", empty: "No skills yet." },
  { type: "agent", title: "Agents", empty: "No agents yet." },
  { type: "prompt", title: "Prompts", empty: "No prompts yet." },
];

const library = useLibrary();
const activity = useActivityStore();
const { entries } = storeToRefs(useCatalogStore());

// The parent keys this editor by the loadout it opened, so the prop is fixed for its life.
const editing = props.loadout !== null;
const name = ref(props.loadout?.name ?? "");
const members = ref<Member[]>(props.loadout?.members.map((m) => ({ type: m.type, name: m.name, ...(m.catalog !== undefined && { catalog: m.catalog }) })) ?? []);
const query = ref("");
const type = ref<EntryType | "all">("all");
const saving = ref(false);
const failure = ref<string | null>(null);
const clashes = ref<Clash[]>([]);
const search = useTemplateRef<HTMLInputElement>("search");
/** the catalog picker is open: from the start for a new loadout, which is there to be filled, else when asked */
const picking = ref(!editing);

const key = (m: { type: EntryType; name: string }) => `${m.type}:${m.name}`;
/** Also the catalog it's pinned to: the same name from another catalog is another member. */
const memberKey = (m: Member) => `${key(m)}@${m.catalog ?? ""}`;
const opened = new Set(members.value.map(memberKey));

/** Order is ignored: a member removed and added again lands last but is the same draft. */
const changed = computed(() => {
  const isNamed = !editing && name.value !== "";
  const current = members.value.map(memberKey);
  const sameMembers = current.length === opened.size && current.every((k) => opened.has(k));
  return isNamed || !sameMembers;
});

const nameError = computed(() => {
  if (name.value === "") return null;
  if (!SLUG.test(name.value)) return "Use lowercase letters and digits, with single hyphens between them.";
  const isTaken = !editing && props.taken.includes(name.value);
  if (isTaken) return `A loadout named ${name.value} already exists.`;
  return null;
});
const canSave = computed(() => name.value !== "" && nameError.value === null && !saving.value);

const candidates = computed(() => {
  const q = query.value.trim().toLowerCase();
  const added = new Set(members.value.map(key));
  return entries.value.filter((e) => {
    const isType = type.value === "all" || e.type === type.value;
    const matches = q === "" || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
    return isType && matches && !added.has(key(e));
  });
});

/** The copy a member stands for: the one in the catalog it names, or the first in resolution order. */
function recordOf(m: Member): EntryRecord | undefined {
  return entries.value.find((e) => e.type === m.type && e.name === m.name && (m.catalog === undefined || e.catalog === m.catalog));
}

const rows = computed(() =>
  members.value.map((m) => {
    const record = recordOf(m);
    return { member: m, record, requires: record ? requiresOf(entries.value, record) : [], clash: clashes.value.find((c) => key(c) === key(m)) };
  }),
);

const columns = computed(() => COLUMNS.map((c) => ({ ...c, rows: rows.value.filter((r) => r.member.type === c.type) })));

async function openPicker(t?: EntryType) {
  if (t) type.value = t;
  picking.value = true;
  // The search exists once the picker has rendered.
  await nextTick();
  search.value?.focus();
}

function add(e: EntryRecord) {
  // The copy that wins follows the catalogs' order later, so it names no catalog; any other copy is pinned to its own.
  const wins = e.overriddenBy === null;
  members.value.push({ type: e.type, name: e.name, ...(!wins && { catalog: e.catalog }) });
}

function remove(m: Member) {
  members.value = members.value.filter((x) => key(x) !== key(m));
}


// A later edit can answer before an earlier one, so only the latest request may set the clashes.
let asked = 0;
watch(
  [name, members],
  async () => {
    const mine = ++asked;
    if (!SLUG.test(name.value)) {
      clashes.value = [];
      return;
    }
    const preview = await library.launchCommand(name.value, { members: [...members.value] });
    if (mine !== asked) return;
    clashes.value = preview.ok ? preview.value.clashes : [];
  },
  { deep: true, immediate: true },
);

// The screen asks before Cancel or its Back throws a changed draft away.
defineExpose({ changed });

async function save() {
  failure.value = null;
  saving.value = true;
  const planned = await library.planSaveLoadout({ name: name.value, members: members.value, ...(editing && { replace: true }) });
  if (!planned.ok) {
    saving.value = false;
    failure.value = planned.error.message;
    return;
  }
  const applied = await activity.withActivity(`building ${name.value}…`, (signal) => library.applySaveLoadout(planned.value, { signal }));
  saving.value = false;
  if (!applied.ok) {
    failure.value = applied.error.message;
    return;
  }
  emit("saved", applied.value);
}
</script>

<template>
  <section class="view loadout-editor">
    <!-- Back closes the editor, as Cancel does: the screen asks first when the draft has changed. -->
    <PageHeader
      :title="editing ? `Edit ${name}` : 'New loadout'"
      back="Loadouts"
      @back="emit('cancel')"
    >
      <template #actions>
        <div class="loadout-editor__actions">
          <span
            v-if="changed"
            class="loadout-editor__unsaved"
          >Unsaved changes</span>
          <button
            type="button"
            class="ghost"
            @click="emit('cancel')"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="!canSave"
            @click="save()"
          >
            {{ saving ? "Saving…" : "Save" }}
          </button>
        </div>
      </template>
      <StatusBanner
        v-if="failure"
        kind="error"
        :detail="failure"
      >
        <p>Couldn't save {{ name }}.</p>
      </StatusBanner>

      <!-- Only a new loadout has a name to choose: a saved one keeps its name, which the title shows. -->
      <template v-if="!editing">
        <label
          class="loadout-editor__label"
          for="loadout-name"
        >Name</label>
        <input
          id="loadout-name"
          v-model.trim="name"
          class="loadout-editor__input"
          placeholder="review"
          autocomplete="off"
          spellcheck="false"
          aria-describedby="loadout-name-help"
        >
        <p
          id="loadout-name-help"
          class="loadout-editor__help"
          :class="{ 'loadout-editor__help--error': nameError }"
        >
          <template v-if="nameError">
            {{ nameError }}
          </template>
          <template v-else>
            Lowercase letters, digits and hyphens. It names the loadout's folder, and prefixes a member whose name clashes.
          </template>
        </p>
      </template>

      <h4 class="loadout-editor__section">
        Members · {{ members.length }}
      </h4>
      <div class="loadout-editor__columns">
        <TypeColumn
          v-for="column in columns"
          :key="column.type"
          :type="column.type"
          :title="column.title"
          :count="column.rows.length"
          :empty="column.empty"
        >
          <template #action>
            <button
              type="button"
              class="ghost btn-xs"
              :aria-label="`Add ${column.title.toLowerCase()}`"
              @click="openPicker(column.type)"
            >
              + Add
            </button>
          </template>
          <ul class="loadout-editor__members">
            <li
              v-for="row in column.rows"
              :key="key(row.member)"
              class="loadout-editor__member"
            >
              <div class="loadout-editor__head">
                <span class="loadout-editor__name">{{ row.member.name }}</span>
                <button
                  type="button"
                  class="ghost btn-xs loadout-editor__remove"
                  :aria-label="`Remove ${row.member.name}`"
                  @click="remove(row.member)"
                >
                  ×
                </button>
              </div>
              <span class="loadout-editor__catalog">{{ row.record ? `from ${row.record.catalog}` : "no catalog defines it" }}</span>
              <p
                v-if="row.requires.length"
                class="loadout-editor__adds"
              >
                Adds {{ row.requires.map((r) => r.name).join(", ") }} for it.
              </p>
              <ClashLine
                v-if="row.clash"
                :clash="row.clash"
              />
            </li>
          </ul>
        </TypeColumn>
      </div>

      <section
        v-if="picking"
        class="loadout-editor__picker"
        aria-label="Add from the catalog"
        @keydown.esc="picking = false"
      >
        <div class="loadout-editor__picker-head">
          <h4 class="loadout-editor__section">
            Add from the catalog
          </h4>
          <button
            type="button"
            class="ghost btn-xs"
            @click="picking = false"
          >
            Close
          </button>
        </div>
        <div class="loadout-editor__filters">
          <input
            ref="search"
            v-model="query"
            type="search"
            class="loadout-editor__input"
            aria-label="Search the catalog"
            placeholder="Search skills, agents, prompts…"
            autocomplete="off"
            spellcheck="false"
          >
          <UiSelect
            v-model="type"
            aria-label="Type"
          >
            <option
              v-for="t in TYPES"
              :key="t.value"
              :value="t.value"
            >
              {{ t.label }}
            </option>
          </UiSelect>
        </div>
        <ul class="loadout-editor__candidates">
          <li
            v-for="e in candidates"
            :key="`${e.type}:${e.name}@${e.catalog}`"
            class="loadout-editor__candidate"
          >
            <span class="loadout-editor__name">{{ e.name }}</span>
            <span class="loadout-editor__badge"><TypeDot :type="e.type" />{{ e.type }}</span>
            <span class="loadout-editor__from">{{ e.catalog }}{{ e.overriddenBy ? `, overridden by ${e.overriddenBy}` : "" }}</span>
            <span class="loadout-editor__description">{{ e.description }}</span>
            <button
              type="button"
              class="ghost btn-xs"
              @click="add(e)"
            >
              Add
            </button>
          </li>
          <li
            v-if="!candidates.length"
            class="loadout-editor__help"
          >
            Nothing in the catalog matches.
          </li>
        </ul>
      </section>
      <button
        v-else
        type="button"
        class="ghost btn-sm loadout-editor__open-picker"
        @click="openPicker()"
      >
        Add from the catalog
      </button>
    </PageHeader>
  </section>
</template>

<style scoped>
.loadout-editor__label {
  display: block;
  margin-bottom: 0.3rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.loadout-editor__input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-control);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.85rem;
}
.loadout-editor__help {
  margin: 0.35rem 0 0.75rem;
  font-size: 0.78rem;
  opacity: 0.7;
}
.loadout-editor__help--error {
  color: var(--status-danger-ink);
  opacity: 1;
}
.loadout-editor__picker-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}
.loadout-editor__open-picker {
  margin-top: 0.75rem;
}
.loadout-editor__section {
  margin: 1rem 0 0.5rem;
  font-size: 0.9rem;
}
.loadout-editor__columns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: start;
  gap: 0.6rem;
}
.loadout-editor__members,
.loadout-editor__candidates {
  margin: 0;
  padding: 0;
  list-style: none;
}
.loadout-editor__candidates {
  max-height: 16rem;
  overflow-y: auto;
}
.loadout-editor__member,
.loadout-editor__candidate {
  padding: 0.45rem 0;
  border-bottom: 1px solid var(--border-subtle);
}
.loadout-editor__member:last-child {
  border-bottom: none;
}
.loadout-editor__head,
.loadout-editor__candidate {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}
.loadout-editor__name {
  font-weight: 600;
}
.loadout-editor__member .loadout-editor__name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.loadout-editor__remove {
  border-color: transparent;
}
.loadout-editor__badge {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
}
.loadout-editor__badge,
.loadout-editor__from,
.loadout-editor__catalog {
  font-size: 0.75rem;
  opacity: 0.7;
}
.loadout-editor__description {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 0.8rem;
  opacity: 0.8;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.loadout-editor__head button {
  margin-left: auto;
}
.loadout-editor__adds {
  margin: 0.25rem 0 0;
  font-size: 0.8rem;
}

/* Same text size and height for both: the search takes the room, the select keeps what its longest option needs. */
.loadout-editor__filters {
  display: flex;
  align-items: stretch;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
}
.loadout-editor__filters .loadout-editor__input {
  flex: 1;
  width: auto;
}
.loadout-editor__filters .ui-select {
  flex: none;
}
.loadout-editor__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.loadout-editor__unsaved {
  font-size: 0.8rem;
  color: var(--status-attention-ink);
}
</style>
