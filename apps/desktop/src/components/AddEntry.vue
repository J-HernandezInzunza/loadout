<script setup lang="ts">
import { addConsequences, requirableRefs, type EntryType, type Library } from "@loadout/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { storeToRefs } from "pinia";
import { computed, onMounted, ref, useTemplateRef } from "vue";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useViewStore } from "../stores/views.ts";
import BusyIndicator from "./BusyIndicator.vue";
import PageHeader from "./PageHeader.vue";
import StatusBanner from "./StatusBanner.vue";

type Pin = Extract<Awaited<ReturnType<Library["pins"]>>, { ok: true }>["value"][number];
type Suggestion = Extract<Awaited<ReturnType<Library["suggestSource"]>>, { ok: true }>["value"];

const props = defineProps<{ catalogId: string }>();

const library = useLibrary();
const activity = useActivityStore();
const catalog = useCatalogStore();
const { entries, catalogs } = storeToRefs(catalog);
const views = useViewStore();

const TYPES: EntryType[] = ["skill", "agent", "prompt"];

const name = ref("");
const type = ref<EntryType>("skill");
const description = ref("");
const source = ref("");
const requires = ref<string[]>([]);
const submitting = ref(false);
const suggestion = ref<Suggestion | null>(null);
const failure = ref<string | null>(null);
const added = ref<{ name: string; section: string; path: string | null } | null>(null);
const pins = ref<Pin[]>([]);

onMounted(async () => {
  const listed = await library.pins();
  if (listed.ok) pins.value = listed.value;
});

/** the entry the form is about, which can't require itself */
const selfRef = computed(() => (name.value.trim() ? `${type.value}:${name.value.trim()}` : undefined));
const available = computed(() => requirableRefs(entries.value, props.catalogId, selfRef.value));
const consequences = computed(() => addConsequences({ records: entries.value, catalogs: catalogs.value, pins: pins.value }, name.value.trim(), props.catalogId));
const sourceHint = computed(() =>
  type.value === "skill"
    ? "A URL, or a file on this machine. Point at the skill's SKILL.md — the folder holding it is what installs."
    : `A URL, or a file on this machine. Point at the ${type.value} file itself.`,
);
const canSubmit = computed(() => !!name.value.trim() && !!description.value.trim() && !!source.value.trim() && !consequences.value.blocked && !submitting.value);

async function pickSource() {
  const picked = await open({ title: "Which file is this entry?" });
  if (typeof picked !== "string") return;
  source.value = picked;
  await suggestFor(picked);
}

/** A local path gets the browser URL teammates would need, when its repo has one (Q13 b). */
async function suggestFor(path: string) {
  suggestion.value = null;
  const answer = await activity.withActivity("looking up the source URL…", () => library.suggestSource(path));
  if (answer.ok) suggestion.value = answer.value;
}

async function recheckTypedSource() {
  const typed = source.value.trim();
  if (typed.startsWith("/") || typed.startsWith("~")) await suggestFor(typed);
  else suggestion.value = null;
}

function useSuggestion() {
  if (suggestion.value?.url) source.value = suggestion.value.url;
  suggestion.value = null;
}

const header = useTemplateRef<InstanceType<typeof PageHeader>>("header");

/** The outcome banner is at the top of a page the user has scrolled down to submit. */
function scrollToBanner() {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  header.value?.body?.scrollTo?.({ top: 0, behavior: reduced ? "auto" : "smooth" });
}

async function submit() {
  submitting.value = true;
  failure.value = null;
  added.value = null;
  const entry = { name: name.value.trim(), type: type.value, description: description.value.trim(), source: source.value.trim(), requires: requires.value };
  const result = await activity.withActivity(`adding ${entry.name}…`, async (signal) => {
    const planned = await library.planAdd({ entries: [entry], catalog: props.catalogId, signal });
    return planned.ok ? library.applyCatalogEdit(planned.value, { signal }) : planned;
  });
  submitting.value = false;
  if (result.ok) {
    added.value = { name: entry.name, section: `${entry.type}s`, path: result.value.mode === "pr" ? null : result.value.path };
    name.value = "";
    description.value = "";
    source.value = "";
    requires.value = [];
    suggestion.value = null;
    await catalog.reload();
  } else {
    failure.value = result.error.message;
  }
  scrollToBanner();
}

async function reveal(path: string) {
  try {
    await revealItemInDir(path);
  } catch (e) {
    failure.value = `Could not show ${path}: ${e}`;
  }
}
</script>

<template>
  <section class="view">
    <PageHeader
      ref="header"
      :title="`Add an entry to ${catalogId}`"
      :back="catalogId"
      @back="views.addingTo = null"
    >
      <StatusBanner
        v-if="failure"
        kind="error"
        :detail="failure"
      />
      <StatusBanner
        v-else-if="added"
        kind="success"
      >
        <p class="add-entry__added-line">
          Added <strong>{{ added.name }}</strong> to <strong>{{ catalogId }}</strong>, under {{ added.section }}.
        </p>
        <p
          v-if="added.path"
          class="add-entry__added-where"
        >
          <button
            type="button"
            class="ghost btn-sm"
            @click="reveal(added.path)"
          >
            Show in Finder
          </button>
          <code>{{ added.path }}</code>
        </p>
      </StatusBanner>

      <form
        class="add-entry__form"
        @submit.prevent="submit"
      >
        <label class="add-entry__field">
          <span>Name</span>
          <input
            v-model="name"
            type="text"
            placeholder="bug-investigator"
            autofocus
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
          >
          <span
            v-if="consequences.blocked"
            class="add-entry__conflict"
          >
            <strong>{{ catalogId }}</strong> already has an entry called <code>{{ name.trim() }}</code>. Adding it again
            is refused — change the existing entry instead, or pick a different name.
          </span>
          <span
            v-else-if="consequences.overrides.length"
            class="add-entry__consequence"
          >
            <code>{{ name.trim() }}</code> also exists in <strong>{{ consequences.overrides.join(", ") }}</strong>. Your
            copy in {{ catalogId }} takes precedence, so it becomes the one that installs.
          </span>
          <span
            v-else-if="consequences.overriddenBy.length"
            class="add-entry__consequence"
          >
            <code>{{ name.trim() }}</code> also exists in <strong>{{ consequences.overriddenBy.join(", ") }}</strong>, which
            takes precedence. Your copy in {{ catalogId }} would be added but never installed.
          </span>
        </label>

        <label class="add-entry__field">
          <span>Type</span>
          <select v-model="type">
            <option
              v-for="option in TYPES"
              :key="option"
              :value="option"
            >{{ option }}</option>
          </select>
        </label>

        <label class="add-entry__field">
          <span>Description</span>
          <input
            v-model="description"
            type="text"
            placeholder="What it does, in one line, this is what will show in the catalog entry"
            autocomplete="off"
          >
        </label>

        <div class="add-entry__field">
          <label for="add-entry-source">Source</label>
          <span class="add-entry__row">
            <input
              id="add-entry-source"
              v-model="source"
              type="text"
              placeholder="https://github.com/your-team/repo/blob/main/bug-investigator/SKILL.md"
              autocomplete="off"
              autocorrect="off"
              spellcheck="false"
              @change="recheckTypedSource"
            >
            <button
              type="button"
              class="ghost"
              @click="pickSource"
            >Choose file…</button>
          </span>
          <span class="add-entry__hint">{{ sourceHint }}</span>
          <span
            v-if="suggestion?.url"
            class="add-entry__suggestion"
          >
            <span>This file is in a git repo. Teammates would need this URL instead:</span>
            <code>{{ suggestion.url }}</code>
            <span class="add-entry__suggestion-actions">
              <button
                type="button"
                class="btn-sm"
                @click="useSuggestion"
              >Use this URL</button>
              <button
                type="button"
                class="ghost btn-sm"
                @click="suggestion = null"
              >Keep the path</button>
            </span>
          </span>
          <span
            v-else-if="suggestion"
            class="add-entry__hint"
          >
            No shareable URL for this file: {{ suggestion.why }}. That is fine for a catalog only you use.
          </span>
        </div>

        <fieldset
          v-if="available.length"
          class="add-entry__requires"
        >
          <legend>Requires</legend>
          <div class="add-entry__requires-list">
            <label
              v-for="option in available"
              :key="option"
              class="add-entry__check"
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

        <button
          type="submit"
          :disabled="!canSubmit"
        >
          Add to {{ catalogId }}
        </button>
        <BusyIndicator
          v-if="submitting"
          inline
          label="Writing the catalog…"
        />
      </form>
    </PageHeader>
  </section>
</template>

<style scoped>
.add-entry__empty {
  opacity: 0.7;
  line-height: 1.5;
}
.add-entry__form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}
.add-entry__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.78rem;
  opacity: 0.85;
}
.add-entry__field input,
.add-entry__field select {
  padding: 0.45rem 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--border-control);
  background: transparent;
  color: inherit;
  font-size: 0.85rem;
}
.add-entry__field input {
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.add-entry__row {
  display: flex;
  gap: 0.4rem;
}
.add-entry__row input {
  flex: 1;
  min-width: 0;
}
.add-entry__hint {
  font-size: 0.72rem;
  opacity: 0.6;
  line-height: 1.4;
}
.add-entry__conflict,
.add-entry__consequence {
  margin-top: 0.35rem;
  padding: 0.5rem 0.65rem;
  border-radius: 8px;
  font-size: 0.75rem;
  line-height: 1.45;
}
.add-entry__conflict {
  color: var(--status-danger-ink);
  background: var(--status-danger-tint);
}
.add-entry__consequence {
  background: var(--status-override-tint);
}
.add-entry__conflict code,
.add-entry__consequence code {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.95em;
}
.add-entry__suggestion {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.35rem;
  padding: 0.6rem 0.7rem;
  border-radius: 8px;
  background: var(--accent-tint);
  font-size: 0.75rem;
  line-height: 1.4;
  opacity: 1;
}
.add-entry__suggestion code {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.72rem;
  overflow-wrap: anywhere;
  user-select: all;
}
.add-entry__suggestion-actions {
  display: flex;
  gap: 0.5rem;
}
.add-entry__added-line {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.4;
}
.add-entry__added-where {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.6rem 0 0;
  font-size: 0.75rem;
  opacity: 0.75;
}
.add-entry__added-where code {
  font-family: ui-monospace, SFMono-Regular, monospace;
  overflow-wrap: anywhere;
}
.add-entry__added-where button {
  flex: none;
}
.add-entry__check {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.8rem;
  line-height: 1.4;
  opacity: 0.85;
}
/* Deliberately not a flex container: WKWebView drops a <legend> entirely when its
   fieldset is `display: flex`, so the group label silently disappears. The list inside
   carries the layout, which also keeps the label still while the list scrolls. */
.add-entry__requires {
  margin: 0;
  padding: 0.5rem 0.75rem 0.6rem;
  border: 1px solid var(--border-control);
  border-radius: 8px;
}
.add-entry__requires legend {
  padding: 0 0.3rem;
  font-size: 0.78rem;
  opacity: 0.7;
}
.add-entry__requires-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 12rem;
  overflow-y: auto;
}
.add-entry__check code {
  font-size: 0.85em;
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
  background: var(--surface-hover);
}
.add-entry__where {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.75rem;
  opacity: 0.6;
  overflow-wrap: anywhere;
}
</style>
