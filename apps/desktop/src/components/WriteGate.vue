<script setup lang="ts">
import type { CatalogRow } from "@loadout/core";
import { computed, onMounted, useTemplateRef } from "vue";
import type { WriteGate } from "../catalogWrite.ts";
import { HOST_NAMES, useAccountStore } from "../stores/accounts.ts";
import SignInProgress from "./SignInProgress.vue";
import StatusBanner from "./StatusBanner.vue";

const props = defineProps<{ gate: WriteGate; catalog: CatalogRow }>();
const emit = defineEmits<{ confirm: []; decline: [] }>();

const accounts = useAccountStore();
const host = computed(() => props.catalog.accountHost);
const hostName = computed(() => (host.value ? HOST_NAMES[host.value] : ""));
const account = computed(() => (host.value ? accounts.accounts[host.value] : undefined));
const signingIn = computed(() => (host.value ? accounts.pending[host.value] !== undefined : false));
const signInFailed = computed(() => {
  const outcome = host.value ? accounts.outcomes[host.value] : undefined;
  return outcome && outcome.kind !== "success" ? outcome.message : null;
});

const first = useTemplateRef<HTMLButtonElement>("first");
// The question appears under the form the user just submitted; focus goes to its answer.
onMounted(() => first.value?.focus());

function connect() {
  if (host.value) void accounts.signIn(host.value, { inPlace: true });
}
</script>

<template>
  <div
    class="write-gate card fade-in"
    role="group"
    aria-label="Before this is written"
  >
    <p
      v-if="gate.replanned"
      class="write-gate__replanned"
    >
      {{ catalog.id }} changed after this was planned, so it was planned again against what is there now.
    </p>

    <template v-if="gate.ask === 'direct'">
      <p class="write-gate__question">
        {{ catalog.id }} takes changes straight to its repository: this is committed and pushed to {{ catalog.location }},
        with no pull request and no review.
      </p>
      <div class="write-gate__actions">
        <button
          ref="first"
          type="button"
          @click="emit('confirm')"
        >
          Push it
        </button>
        <button
          type="button"
          class="ghost"
          @click="emit('decline')"
        >
          Don't push
        </button>
      </div>
    </template>

    <template v-else-if="gate.ask === 'account'">
      <p
        v-if="account"
        class="write-gate__question"
      >
        Signed in to {{ hostName }} as {{ account.login }}, so the pull request opens from here.
      </p>
      <SignInProgress
        v-else-if="signingIn && host"
        :on="host"
      />
      <p
        v-else
        class="write-gate__question"
      >
        Connect {{ hostName }} to open the pull request here, or continue and get a link to open it yourself.
      </p>
      <StatusBanner
        v-if="signInFailed && !account"
        kind="error"
      >
        <p>{{ signInFailed }}</p>
      </StatusBanner>
      <div class="write-gate__actions">
        <button
          v-if="account"
          ref="first"
          type="button"
          @click="emit('confirm')"
        >
          Open the pull request
        </button>
        <template v-else>
          <button
            ref="first"
            type="button"
            :disabled="signingIn"
            @click="connect"
          >
            Connect {{ hostName }}
          </button>
          <button
            type="button"
            class="ghost"
            @click="emit('confirm')"
          >
            Continue and get a link
          </button>
        </template>
        <button
          type="button"
          class="ghost"
          @click="emit('decline')"
        >
          Cancel
        </button>
      </div>
    </template>

    <div
      v-else
      class="write-gate__actions"
    >
      <button
        ref="first"
        type="button"
        @click="emit('confirm')"
      >
        Go on
      </button>
      <button
        type="button"
        class="ghost"
        @click="emit('decline')"
      >
        Cancel
      </button>
    </div>
  </div>
</template>

<style scoped>
.write-gate {
  margin-top: 1rem;
}
.write-gate__replanned {
  margin: 0 0 0.6rem;
  font-size: 0.8rem;
  color: var(--status-attention-ink);
}
.write-gate__question {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.write-gate__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.5rem;
}
</style>
