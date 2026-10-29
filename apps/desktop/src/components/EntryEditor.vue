<script setup lang="ts">
import { entryEdits, requirableRefs, type EntryRecord } from "@loadout/core";
import { storeToRefs } from "pinia";
import { computed, ref } from "vue";
import { describeWrite, useCatalogWrite, type WriteLanding as Landing } from "../catalogWrite.ts";
import { useLibrary } from "../services.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import BusyIndicator from "./BusyIndicator.vue";
import StatusBanner from "./StatusBanner.vue";
import WriteGate from "./WriteGate.vue";
import WriteLanding from "./WriteLanding.vue";

const props = defineProps<{ entry: EntryRecord }>();
const emit = defineEmits<{ close: [] }>();

const library = useLibrary();
const catalog = useCatalogStore();
const { entries } = storeToRefs(catalog);

const description = ref(props.entry.description);
const source = ref(props.entry.source);
const requires = ref([...props.entry.requires]);
const saving = ref(false);
const failure = ref<string | null>(null);
const saved = ref<{ changed: boolean; landing: Landing | null } | null>(null);
const { gate, row: target, run, confirm, decline } = useCatalogWrite(() => props.entry.catalog);

const available = computed(() => requirableRefs(entries.value, props.entry.catalog, `${props.entry.type}:${props.entry.name}`));
/** only the fields that change, so an untouched one keeps whatever the file holds now */
const edits = computed(() => entryEdits(props.entry, { description: description.value, source: source.value, requires: requires.value }));
const emptyField = computed(() => !description.value.trim() || !source.value.trim());
const blockedBecause = computed(() => (emptyField.value ? "An entry needs a description and a source; neither can be left empty." : ""));
/** Cancel throws edits away, Done leaves a page with nothing unsaved: the word says which. */
const dismissLabel = computed(() => (edits.value ? "Cancel" : "Done"));

async function save() {
  const changes = edits.value;
  if (!changes) return;
  saving.value = true;
  failure.value = null;
  saved.value = null;
  const { name, catalog: id, type } = props.entry;
  const result = await run(`updating ${name}…`, (signal) => library.planUpdate({ name, catalog: id, type, ...changes, signal }));
  saving.value = false;
  if (result === null) return;
  if (!result.ok) {
    failure.value = result.error.message;
    return;
  }
  saved.value = { changed: result.value.changed, landing: describeWrite(result.value, result.warnings) };
  await catalog.reload();
}
</script>

<template>
  <section class="editor">
    <StatusBanner
      v-if="failure"
      kind="error"
      :detail="failure"
    />
    <StatusBanner
      v-else-if="saved"
      kind="success"
    >
      <p
        v-if="saved.changed"
        class="editor__saved"
      >
        Updated <strong>{{ entry.name }}</strong> in <strong>{{ entry.catalog }}</strong>.
      </p>
      <WriteLanding
        v-if="saved.landing"
        :landing="saved.landing"
      />
      <p
        v-else
        class="editor__saved"
      >
        No changes — {{ entry.name }} already matched what you asked for.
      </p>
    </StatusBanner>
    <p class="editor__note">
      The name and type cannot be changed here: both decide where the entry lives in the file. Remove it and add it
      again to change either.
    </p>
    <form
      class="editor__form"
      @submit.prevent="save"
    >
      <label class="editor__field">
        <span>Description</span>
        <input
          v-model="description"
          type="text"
          autocomplete="off"
        >
      </label>
      <label class="editor__field">
        <span>Source</span>
        <input
          v-model="source"
          type="text"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
        >
      </label>
      <fieldset
        v-if="available.length"
        class="editor__requires"
      >
        <legend>Requires</legend>
        <div class="editor__requires-list">
          <label
            v-for="option in available"
            :key="option"
            class="editor__check"
          >
            <input
              v-model="requires"
              type="checkbox"
              :value="option"
            >
            <span>{{ option }}</span>
          </label>
        </div>
      </fieldset>
      <p
        v-if="blockedBecause"
        class="editor__blocked"
      >
        {{ blockedBecause }}
      </p>
      <div class="editor__actions">
        <button
          type="submit"
          :disabled="!edits || emptyField || saving"
        >
          Save changes
        </button>
        <button
          type="button"
          class="ghost"
          :disabled="saving"
          @click="emit('close')"
        >
          {{ dismissLabel }}
        </button>
      </div>
      <WriteGate
        v-if="gate && target"
        :gate="gate"
        :catalog="target"
        @confirm="confirm"
        @decline="decline"
      />
      <BusyIndicator
        v-else-if="saving"
        inline
        label="Writing the catalog…"
      />
    </form>
  </section>
</template>

<style scoped>
.editor__note {
  margin: 0 0 0.9rem;
  font-size: 0.75rem;
  line-height: 1.45;
  opacity: 0.65;
}
.editor__form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}
.editor__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.78rem;
  opacity: 0.85;
}
.editor__field input {
  padding: 0.45rem 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--border-control);
  background: transparent;
  color: inherit;
  font-size: 0.85rem;
  font-family: ui-monospace, SFMono-Regular, monospace;
}
/* Not a flex container: WKWebView drops a <legend> whose fieldset is `display: flex`,
   so the group label silently disappears. The list inside carries the layout. */
.editor__requires {
  margin: 0;
  padding: 0.5rem 0.75rem 0.6rem;
  border: 1px solid var(--border-control);
  border-radius: 8px;
}
.editor__requires legend {
  padding: 0 0.3rem;
  font-size: 0.78rem;
  opacity: 0.7;
}
.editor__requires-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 12rem;
  overflow-y: auto;
}
.editor__check {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.8rem;
  opacity: 0.85;
}
.editor__blocked {
  margin: 0;
  font-size: 0.75rem;
  opacity: 0.6;
}
.editor__actions {
  display: flex;
  gap: 0.5rem;
}
.editor__saved {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.4;
}
</style>
