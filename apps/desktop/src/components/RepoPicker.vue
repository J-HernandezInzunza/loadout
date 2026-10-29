<script setup lang="ts">
import { parseRepoLink, type AccountHost, type CatalogRepo, type HostedRepo } from "@loadout/core";
import { computed, onMounted, ref, watch } from "vue";
import { useLibrary } from "../services.ts";
import { HOST_NAMES, useAccountStore } from "../stores/accounts.ts";
import { useActivityStore } from "../stores/activity.ts";
import BusyIndicator from "./BusyIndicator.vue";
import SignInProgress from "./SignInProgress.vue";
import StatusBanner from "./StatusBanner.vue";

/** A repository chosen and checked: what registering it needs. */
export interface RepoPick {
  repo: string;
  name: string;
  branch: string;
  yamlPath: string;
}

const props = defineProps<{ on: AccountHost }>();
/** null until a repository is picked and its catalog file is found */
const pick = defineModel<RepoPick | null>({ required: true });

const library = useLibrary();
const activity = useActivityStore();
const accounts = useAccountStore();

const SHOWN = 50;
const OTHER = "other";

const hostName = computed(() => HOST_NAMES[props.on]);
const account = computed(() => accounts.accounts[props.on]);
const signingIn = computed(() => accounts.pending[props.on] !== undefined);
const signInFailed = computed(() => {
  const outcome = accounts.outcomes[props.on];
  return outcome && outcome.kind !== "success" ? outcome.message : null;
});

const repos = ref<HostedRepo[] | null>(null);
const listFailure = ref<string | null>(null);
const filter = ref("");
/** a listed repository's URL, or OTHER for a pasted link */
const choice = ref("");
const link = ref("");
const branch = ref("");
const checked = ref<CatalogRepo | null>(null);
const checkFailure = ref<string | null>(null);
const checking = ref(false);
/** each check's number, so an answer that arrives after a newer question is dropped */
let asked = 0;

const matching = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return (repos.value ?? []).filter((r) => `${r.org}/${r.name}`.toLowerCase().includes(q));
});
const shown = computed(() => matching.value.slice(0, SHOWN));

const pasted = computed(() => (choice.value === OTHER && link.value.trim() ? parseRepoLink(link.value) : null));
const linkProblem = computed(() => {
  if (choice.value !== OTHER || !link.value.trim()) return null;
  if (!pasted.value) return "That isn't a link to a repository.";
  if (pasted.value.on !== props.on) return `That isn't a ${hostName.value} repository; choose where it lives above.`;
  return null;
});
const target = computed(() => {
  if (choice.value === OTHER) return linkProblem.value || !pasted.value ? null : { repo: pasted.value.repo, org: pasted.value.org, name: pasted.value.name, branch: pasted.value.branch, yamlPath: pasted.value.yamlPath };
  const listed = repos.value?.find((r) => r.repo === choice.value);
  return listed ? { repo: listed.repo, org: listed.org, name: listed.name, branch: undefined, yamlPath: undefined } : null;
});

async function list() {
  listFailure.value = null;
  const listed = await activity.withActivity(`listing your ${hostName.value} repositories…`, (signal) => library.listRepos(props.on, { signal }));
  if (listed.ok) repos.value = listed.value;
  else listFailure.value = listed.error.message;
}

/** Asks the host for the default branch and the catalog file, before anything is cloned. */
async function check(branchAsked?: string) {
  const t = target.value;
  const n = ++asked;
  checked.value = null;
  checkFailure.value = null;
  pick.value = null;
  checking.value = t !== null;
  if (!t) return;
  const request = { on: props.on, org: t.org, name: t.name, ...((branchAsked ?? t.branch) && { branch: branchAsked ?? t.branch }), ...(t.yamlPath && { yamlPath: t.yamlPath }) };
  const answer = await activity.withActivity(`looking for the catalog in ${t.org}/${t.name}…`, (signal) => library.checkCatalogRepo({ ...request, signal }));
  if (n !== asked) return;
  checking.value = false;
  if (!answer.ok) {
    checkFailure.value = answer.error.message;
    return;
  }
  checked.value = answer.value;
  branch.value = answer.value.branch;
  if (answer.value.found) pick.value = { repo: t.repo, name: t.name, branch: answer.value.branch, yamlPath: answer.value.yamlPath };
}

function recheckBranch() {
  const typed = branch.value.trim();
  if (typed && typed !== checked.value?.branch) void check(typed);
}

watch(target, () => void check(), { deep: true });
watch(
  account,
  (connected) => {
    if (connected && repos.value === null) void list();
  },
  { immediate: true },
);
onMounted(() => accounts.load());
</script>

<template>
  <div class="repo-picker">
    <template v-if="!account">
      <SignInProgress
        v-if="signingIn"
        :on="on"
      />
      <template v-else>
        <p class="repo-picker__line">
          Connect {{ hostName }} to pick the repository from the ones you can read. With it connected, Loadout clones
          over https with the account, so this machine needs no SSH key.
        </p>
        <button
          type="button"
          @click="accounts.signIn(on, { inPlace: true })"
        >
          Connect {{ hostName }}
        </button>
      </template>
      <StatusBanner
        v-if="signInFailed"
        kind="error"
      >
        <p>{{ signInFailed }}</p>
      </StatusBanner>
      <p class="repo-picker__hint">
        Or choose <strong>Somewhere else</strong> above to paste a clone URL without connecting.
      </p>
    </template>

    <template v-else>
      <p class="repo-picker__hint">
        Signed in to {{ hostName }} as {{ account.login }}: listing every repository it can read, yours or not.
      </p>
      <StatusBanner
        v-if="listFailure"
        kind="error"
        :detail="listFailure"
      />
      <BusyIndicator
        v-else-if="repos === null"
        inline
        :label="`Listing your ${hostName} repositories…`"
      />
      <template v-else>
        <input
          v-model="filter"
          type="search"
          class="repo-picker__filter"
          aria-label="Filter repositories"
          placeholder="Filter repositories…"
          autocomplete="off"
          spellcheck="false"
        >
        <div
          class="repo-picker__list"
          role="radiogroup"
          aria-label="Repository"
        >
          <label
            v-for="r in shown"
            :key="r.repo"
            class="repo-picker__option"
          >
            <input
              v-model="choice"
              type="radio"
              :value="r.repo"
            >
            <span>{{ r.org }}/{{ r.name }}</span>
            <span
              v-if="r.private"
              class="repo-picker__private"
            >private</span>
          </label>
          <p
            v-if="matching.length > SHOWN"
            class="repo-picker__more"
          >
            {{ matching.length - SHOWN }} more; type to narrow them down.
          </p>
          <p
            v-else-if="!matching.length"
            class="repo-picker__more"
          >
            None of your repositories matches; paste its link below if you can read it.
          </p>
          <label class="repo-picker__option">
            <input
              v-model="choice"
              type="radio"
              :value="OTHER"
            >
            <span>Other: paste a link</span>
          </label>
        </div>
        <label
          v-if="choice === OTHER"
          class="repo-picker__field"
        >
          <span>Link to the repository</span>
          <input
            v-model.lazy="link"
            type="text"
            :placeholder="on === 'github' ? 'https://github.com/acme/agentics' : 'https://bitbucket.org/acme/agentics'"
            autocomplete="off"
            spellcheck="false"
          >
          <span class="repo-picker__hint">The repository's page, a link to its library.yaml, or its clone URL.</span>
          <span
            v-if="linkProblem"
            class="repo-picker__problem"
          >{{ linkProblem }}</span>
        </label>
      </template>

      <BusyIndicator
        v-if="checking"
        inline
        label="Looking for the catalog…"
      />
      <StatusBanner
        v-if="checkFailure"
        kind="error"
        :detail="checkFailure"
      />
      <template v-if="checked">
        <label class="repo-picker__field">
          <span>Branch</span>
          <input
            v-model="branch"
            type="text"
            autocomplete="off"
            spellcheck="false"
            @change="recheckBranch"
          >
          <span class="repo-picker__hint">The repository's default is {{ checked.defaultBranch }}.</span>
        </label>
        <p
          class="repo-picker__found"
          :class="{ 'repo-picker__problem': !checked.found }"
        >
          {{
            checked.found
              ? `Found ${checked.yamlPath} on ${checked.branch}.`
              : `There is no ${checked.yamlPath} on ${checked.branch}, so this isn't a catalog Loadout can read.`
          }}
        </p>
      </template>
    </template>
  </div>
</template>

<style scoped>
.repo-picker {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.repo-picker__line {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
}
.repo-picker__hint {
  font-size: 0.72rem;
  opacity: 0.65;
  margin: 0;
}
.repo-picker__filter,
.repo-picker__field input {
  padding: 0.45rem 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--border-control);
  background: transparent;
  color: inherit;
  font-size: 0.85rem;
}
.repo-picker__list {
  max-height: 14rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.3rem 0.4rem;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
}
.repo-picker__option {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.repo-picker__private {
  font-size: 0.68rem;
  opacity: 0.6;
  font-family: inherit;
}
.repo-picker__more {
  margin: 0.2rem 0;
  font-size: 0.72rem;
  opacity: 0.65;
}
.repo-picker__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.78rem;
}
.repo-picker__found {
  margin: 0;
  font-size: 0.8rem;
}
.repo-picker__problem {
  font-size: 0.78rem;
  color: var(--status-attention-ink);
}
</style>
