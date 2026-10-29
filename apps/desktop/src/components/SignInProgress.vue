<script setup lang="ts">
import type { AccountHost } from "@loadout/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { computed } from "vue";
import { useAccountStore } from "../stores/accounts.ts";

const props = defineProps<{ on: AccountHost }>();

const accounts = useAccountStore();
const started = computed(() => accounts.pending[props.on]);
</script>

<template>
  <div
    v-if="started"
    class="sign-in"
  >
    <template v-if="started.on === 'github'">
      <p class="sign-in__line">
        Enter this code on GitHub's page, which opened in your browser:
      </p>
      <p class="sign-in__code">
        {{ started.userCode }}
      </p>
      <p class="sign-in__note">
        Loadout finishes on its own once you approve there.
      </p>
    </template>
    <p
      v-else
      class="sign-in__line"
    >
      Approve Loadout on Bitbucket's page in your browser; Loadout comes forward when you do.
    </p>
    <div class="sign-in__actions">
      <button
        type="button"
        class="ghost"
        @click="openUrl(started.on === 'github' ? started.verificationUri : started.authorizeUrl)"
      >
        {{ started.on === "github" ? "Open GitHub again" : "Open Bitbucket again" }}
      </button>
      <button
        type="button"
        class="ghost"
        @click="accounts.cancel(on)"
      >
        Cancel
      </button>
    </div>
  </div>
</template>

<style scoped>
.sign-in__line {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
}
.sign-in__note {
  margin: 0 0 0.75rem;
  font-size: 0.78rem;
  opacity: 0.7;
}
.sign-in__code {
  margin: 0 0 0.5rem;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 1.4rem;
  letter-spacing: 0.1em;
  user-select: all;
}
.sign-in__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
