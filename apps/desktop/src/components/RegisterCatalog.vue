<script setup lang="ts">
import type { CatalogRow } from "@loadout/core";
import { open } from "@tauri-apps/plugin-dialog";
import { computed, ref, watch } from "vue";
import { ordinal } from "../catalog.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import BusyIndicator from "./BusyIndicator.vue";
import StatusBanner from "./StatusBanner.vue";

export type RegisterMode = "existing" | "create" | "remote";

const props = defineProps<{
  catalogs: CatalogRow[];
  start: RegisterMode;
}>();
const emit = defineEmits<{ registered: []; close: [] }>();

const library = useLibrary();
const activity = useActivityStore();

const mode = ref<RegisterMode>(props.start);
const id = ref(props.start === "create" && !props.catalogs.some((c) => c.id === "personal") ? "personal" : "");
const path = ref("");
const repo = ref("");
const branch = ref("");
/** registered first, so its copies win a name collision */
const wins = ref(true);
const protectedRemote = ref(true);
const directPushAck = ref(false);
const submitting = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const done = ref<{ id: string; created: boolean; entries: number; location: string; precedence: number; registered: number; displaced: string | null } | null>(null);

const isRemote = computed(() => mode.value === "remote");
const needsDirectPushAck = computed(() => isRemote.value && !protectedRemote.value);
const takenId = computed(() => props.catalogs.some((c) => c.id === id.value.trim()));
const filled = computed(() => !!id.value.trim() && (isRemote.value ? !!repo.value.trim() && !!branch.value.trim() : !!path.value));
const canSubmit = computed(() => filled.value && !takenId.value && !submitting.value && (!needsDirectPushAck.value || directPushAck.value));
/** create refused because the file is there: registering it is the way forward */
const fileExists = computed(() => mode.value === "create" && failure.value?.code === "DUPLICATE");

watch(protectedRemote, (on) => {
  if (on) directPushAck.value = false;
});
watch(mode, () => {
  path.value = "";
  failure.value = null;
});

const modeHint = computed(() => {
  if (mode.value === "existing") return "Point at a library.yaml already on this machine — usually in a repo you already have cloned.";
  if (mode.value === "create") return "Scaffold an empty library.yaml in a folder you choose, then register it.";
  return "Clone a git repository this machine doesn't have yet — how you add a team's shared catalog.";
});

const precedenceLine = computed(() => {
  if (!done.value) return "";
  const { precedence, registered } = done.value;
  if (registered <= 1) return "the only catalog registered — nothing else for it to collide with.";
  if (precedence === 1) return `checked first of ${registered} catalogs — its copies win if another catalog defines the same name.`;
  return `checked ${ordinal(precedence)} of ${registered} catalogs — a catalog checked earlier wins on a name collision.`;
});

/** The picker matches what the field asks for: the file itself for an existing catalog, a folder for a new one. */
async function pickPath() {
  const picked =
    mode.value === "create"
      ? await open({ directory: true, title: "Which folder should the new catalog live in?" })
      : await open({ title: "Which library.yaml?", filters: [{ name: "Catalog", extensions: ["yaml", "yml"] }] });
  if (typeof picked === "string") path.value = picked;
}

async function submit() {
  submitting.value = true;
  failure.value = null;
  const name = id.value.trim();
  const position = wins.value ? ("first" as const) : ("last" as const);
  const top = wins.value ? (props.catalogs.find((c) => c.precedence === 1)?.id ?? null) : null;
  const result = await activity.withActivity(`registering ${name}…`, async (signal) => {
    if (mode.value === "create") {
      const created = await library.initCatalog({ path: path.value, id: name, position });
      return created.ok ? { ...created, value: { catalogs: created.value.catalogs, created: true, location: created.value.created, entries: 0 } } : created;
    }
    const request = isRemote.value
      ? { kind: "remote" as const, id: name, repo: repo.value.trim(), branch: branch.value.trim(), protected: protectedRemote.value, position, signal }
      : { kind: "local" as const, id: name, path: path.value, position, signal };
    const planned = await library.planAddCatalog(request);
    if (!planned.ok) return planned;
    const applied = await library.applyAddCatalog(planned.value);
    return applied.ok ? { ...applied, value: { catalogs: applied.value, created: false, location: planned.value.file, entries: planned.value.entries } } : applied;
  });
  submitting.value = false;
  if (!result.ok) {
    failure.value = result.error;
    return;
  }
  const { catalogs, created, location, entries } = result.value;
  done.value = { id: name, created, entries, location, precedence: catalogs.findIndex((c) => c.id === name) + 1, registered: catalogs.length, displaced: top };
  emit("registered");
}

function registerAnother() {
  done.value = null;
  id.value = "";
  path.value = "";
  repo.value = "";
  branch.value = "";
  directPushAck.value = false;
}
</script>

<template>
  <section class="register card">
    <!-- A success collapses to the outcome, so the form can't re-validate against what it just registered. -->
    <template v-if="done">
      <StatusBanner kind="success">
        <p class="register__done">
          {{ done.created ? "Created and registered" : "Registered" }} <strong>{{ done.id }}</strong> — {{ done.entries }}
          {{ done.entries === 1 ? "entry" : "entries" }}, {{ precedenceLine }}
        </p>
        <p
          v-if="done.displaced && done.displaced !== done.id"
          class="register__done-displaced"
        >
          This also moved {{ done.displaced }} down to precedence 2.
        </p>
        <p class="register__done-detail">
          {{ done.location }}
        </p>
      </StatusBanner>
      <div class="register__actions">
        <button
          type="button"
          @click="registerAnother"
        >
          Register another…
        </button>
        <button
          type="button"
          class="ghost"
          @click="emit('close')"
        >
          Done
        </button>
      </div>
    </template>

    <template v-else>
      <StatusBanner
        v-if="failure"
        kind="error"
        :detail="failure.message"
      />
      <div
        v-if="fileExists"
        class="register__recover"
      >
        <p class="register__recover-line">
          Creating one will not overwrite what is there. Registering it instead takes the catalog as it stands, with the
          entries it already holds.
        </p>
        <button
          type="button"
          class="ghost btn-sm"
          @click="mode = 'existing'"
        >
          Register the one that's there
        </button>
      </div>

      <div
        class="register__modes"
        role="radiogroup"
        aria-label="How to add the catalog"
      >
        <label><input
          v-model="mode"
          type="radio"
          value="existing"
        > Register an existing catalog</label>
        <label><input
          v-model="mode"
          type="radio"
          value="create"
        > Create a new empty one</label>
        <label><input
          v-model="mode"
          type="radio"
          value="remote"
        > Add a shared repository</label>
      </div>
      <p class="register__hint register__mode-hint">
        {{ modeHint }}
      </p>

      <form
        class="register__form"
        @submit.prevent="submit"
      >
        <label class="register__field">
          <span>Id — how you refer to this catalog</span>
          <input
            v-model="id"
            type="text"
            placeholder="work"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
          >
          <span
            v-if="takenId"
            class="register__conflict"
          >
            <code>{{ id.trim() }}</code> is already registered. Ids have to be unique.
          </span>
        </label>

        <div
          v-if="!isRemote"
          class="register__field"
        >
          <span>{{ mode === "create" ? "Where to create it" : "Where it is" }}</span>
          <div class="register__row">
            <code
              v-if="path"
              class="register__path"
            >{{ path }}</code>
            <button
              type="button"
              :class="{ ghost: !!path }"
              @click="pickPath"
            >
              {{ path ? "Change…" : mode === "create" ? "Choose folder…" : "Choose library.yaml…" }}
            </button>
          </div>
          <span class="register__hint">
            <template v-if="mode === 'create'">
              A <code>library.yaml</code> is written in this folder, with empty skill, agent and prompt sections. One
              that already exists is never overwritten.
            </template>
            <template v-else>
              The catalog's <code>library.yaml</code>.
            </template>
          </span>
        </div>

        <template v-else>
          <label class="register__field">
            <span>Clone URL</span>
            <input
              v-model="repo"
              type="text"
              placeholder="git@github.com:acme/agentics.git"
              autocomplete="off"
              autocorrect="off"
              spellcheck="false"
            >
          </label>
          <label class="register__field">
            <span>Branch</span>
            <input
              v-model="branch"
              type="text"
              placeholder="main"
              autocomplete="off"
              autocorrect="off"
              spellcheck="false"
            >
            <span class="register__hint">
              The repository's own default branch may not be called <code>main</code> — check before typing it.
            </span>
          </label>
          <label class="register__check">
            <input
              v-model="protectedRemote"
              type="checkbox"
            >
            <span>
              Changes to this catalog go through a pull request. Leave this on for anything your team shares; turning it
              off means a write commits straight to {{ branch || "the branch" }}, with no review.
            </span>
          </label>
          <label
            v-if="needsDirectPushAck"
            class="register__check register__check--warn"
          >
            <input
              v-model="directPushAck"
              type="checkbox"
            >
            <span>
              I understand: with the box above unchecked, edits to this catalog push directly to
              {{ branch || "the branch" }} — no pull request, no review step. This has to be checked to register with
              direct pushes on.
            </span>
          </label>
          <span class="register__hint">Registering clones the repository, so this one needs the network.</span>
        </template>

        <label class="register__check">
          <input
            v-model="wins"
            type="checkbox"
          >
          <span>
            When another catalog defines the same name, use this catalog's copy. That is usually right for a catalog of
            your own and wrong for one you are only reading.
          </span>
        </label>
        <div class="register__actions">
          <button
            type="submit"
            :disabled="!canSubmit"
          >
            {{ mode === "create" ? "Create and register" : "Register" }}
          </button>
        </div>
        <BusyIndicator
          v-if="submitting"
          inline
          label="Checking the catalog is usable…"
        />
      </form>
    </template>
  </section>
</template>

<style scoped>
.register {
  margin-bottom: 1rem;
}
.register__recover {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin: -0.5rem 0 1.1rem;
}
.register__recover-line {
  flex: 1;
  min-width: 14rem;
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.45;
  opacity: 0.85;
}
.register__modes {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.9rem;
  font-size: 0.8rem;
}
.register__modes label {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.register__mode-hint {
  margin: -0.5rem 0 0.9rem;
}
.register__form {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
.register__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.78rem;
  opacity: 0.85;
}
.register__field input[type="text"] {
  padding: 0.45rem 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--border-control);
  background: transparent;
  color: inherit;
  font-size: 0.85rem;
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.register__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.register__path {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.register__hint {
  font-size: 0.72rem;
  line-height: 1.45;
  opacity: 0.6;
}
.register__check {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  font-size: 0.76rem;
  line-height: 1.45;
  opacity: 0.85;
}
.register__check--warn {
  padding: 0.5rem 0.6rem;
  border-radius: 6px;
  color: var(--status-attention-ink);
  background: var(--status-attention-tint);
}
.register__conflict {
  margin-top: 0.3rem;
  padding: 0.45rem 0.6rem;
  border-radius: 6px;
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--status-danger-ink);
  background: var(--status-danger-tint);
}
.register__actions {
  display: flex;
  gap: 0.5rem;
}
.register__done {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.4;
}
.register__done-detail {
  margin: 0.35rem 0 0;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.75rem;
  opacity: 0.75;
  overflow-wrap: anywhere;
}
.register__done-displaced {
  margin: 0.35rem 0 0;
  font-size: 0.78rem;
  line-height: 1.45;
  opacity: 0.8;
}
</style>
