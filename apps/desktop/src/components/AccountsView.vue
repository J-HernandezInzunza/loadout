<script setup lang="ts">
import type { AccountHost } from "@loadout/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { storeToRefs } from "pinia";
import { onMounted } from "vue";
import { HOST_NAMES, useAccountStore } from "../stores/accounts.ts";
import { useViewStore } from "../stores/views.ts";
import PageHeader from "./PageHeader.vue";
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

        <template v-if="pending[on]?.on === 'github'">
          <p class="accounts__line">
            Enter this code on GitHub's page, which opened in your browser:
          </p>
          <p class="accounts__code">
            {{ pending[on].userCode }}
          </p>
          <p class="accounts__note">
            Loadout finishes on its own once you approve there.
          </p>
          <div class="accounts__actions">
            <button
              type="button"
              class="ghost"
              @click="openUrl(pending[on].verificationUri)"
            >
              Open GitHub again
            </button>
            <button
              type="button"
              class="ghost"
              @click="store.cancel(on)"
            >
              Cancel
            </button>
          </div>
        </template>

        <template v-else-if="pending[on]?.on === 'bitbucket'">
          <p class="accounts__line">
            Approve Loadout on Bitbucket's page in your browser; Loadout comes forward when you do.
          </p>
          <div class="accounts__actions">
            <button
              type="button"
              class="ghost"
              @click="openUrl(pending[on].authorizeUrl)"
            >
              Open Bitbucket again
            </button>
            <button
              type="button"
              class="ghost"
              @click="store.cancel(on)"
            >
              Cancel
            </button>
          </div>
        </template>

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
.accounts__code {
  margin: 0 0 0.5rem;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 1.4rem;
  letter-spacing: 0.1em;
  user-select: all;
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
