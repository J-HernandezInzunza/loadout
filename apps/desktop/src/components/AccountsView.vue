<script setup lang="ts">
import type { AccountHost } from "@loadout/core";
import { storeToRefs } from "pinia";
import { onMounted } from "vue";
import { HOST_NAMES, useAccountStore } from "../stores/accounts.ts";
import { useViewStore } from "../stores/views.ts";
import PageHeader from "./PageHeader.vue";
import SignInProgress from "./SignInProgress.vue";
import StatusBanner from "./StatusBanner.vue";

const HOSTS: AccountHost[] = ["github", "bitbucket"];

const store = useAccountStore();
const { accounts, pending, outcomes } = storeToRefs(store);
const views = useViewStore();

onMounted(() => store.load());
</script>

<template>
  <section class="view accounts">
    <PageHeader
      title="Accounts"
      back="Loadout"
      @back="views.accounts = false"
    >
      <p class="accounts__lead">
        With an account signed in, a change to a shared catalog on that host opens its pull request from here; without
        one, Loadout gives you a link to open it yourself. Tokens are kept in the macOS Keychain.
      </p>

      <section
        v-for="on in HOSTS"
        :key="on"
        class="accounts__host card"
        :aria-labelledby="`accounts-${on}`"
      >
        <h3
          :id="`accounts-${on}`"
          class="accounts__name"
        >
          {{ HOST_NAMES[on] }}
        </h3>

        <SignInProgress
          v-if="pending[on]"
          :on="on"
        />

        <template v-else-if="accounts[on]">
          <p class="accounts__line accounts__who">
            Signed in as <strong>{{ accounts[on].login }}</strong> since {{ accounts[on].connectedAt.slice(0, 10) }}
          </p>
          <p class="accounts__note accounts__scopes">
            Access: {{ accounts[on].scopes.join(", ") || "no scopes reported" }}
          </p>
          <div class="accounts__actions">
            <button
              type="button"
              class="ghost"
              @click="store.check(on)"
            >
              Check
            </button>
            <button
              type="button"
              class="ghost danger"
              @click="store.disconnect(on)"
            >
              Disconnect
            </button>
          </div>
        </template>

        <template v-else>
          <p class="accounts__line accounts__who">
            Not signed in.
          </p>
          <div class="accounts__actions">
            <button
              type="button"
              :disabled="outcomes[on]?.code === 'SIGN_IN_UNAVAILABLE'"
              @click="store.signIn(on)"
            >
              {{ outcomes[on]?.code === "SIGN_IN_EXPIRED" ? "Get a new code" : `Sign in to ${HOST_NAMES[on]}` }}
            </button>
          </div>
        </template>

        <StatusBanner
          v-if="outcomes[on]"
          :kind="outcomes[on].kind"
          class="accounts__outcome"
        >
          <p>{{ outcomes[on].message }}</p>
        </StatusBanner>
      </section>
    </PageHeader>
  </section>
</template>

<style scoped>
.accounts__lead {
  margin: 0 0 1rem;
  line-height: 1.5;
  opacity: 0.85;
}
.accounts__host {
  margin-bottom: 1rem;
}
.accounts__name {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.accounts__line {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
}
.accounts__note {
  margin: 0 0 0.75rem;
  font-size: 0.78rem;
  opacity: 0.7;
}
.accounts__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.accounts__outcome {
  margin-top: 0.75rem;
}
</style>
