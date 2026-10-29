<script setup lang="ts">
import { openUrl } from "@tauri-apps/plugin-opener";
import type { WriteLanding } from "../catalogWrite.ts";

defineProps<{ landing: WriteLanding }>();
</script>

<template>
  <p class="landing__line">
    {{ landing.line }}
  </p>
  <p
    v-if="landing.link"
    class="landing__link"
  >
    <button
      type="button"
      class="ghost btn-sm"
      @click="openUrl(landing.link.url)"
    >
      {{ landing.link.label }}
    </button>
    <code>{{ landing.link.url }}</code>
  </p>
  <pre
    v-if="landing.detail"
    class="landing__detail"
  >{{ landing.detail }}</pre>
</template>

<style scoped>
.landing__line {
  margin: 0.3rem 0 0;
}
.landing__link {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.4rem 0 0;
  overflow-wrap: anywhere;
}
.landing__detail {
  margin: 0.4rem 0 0;
  white-space: pre-wrap;
  font-size: 0.75rem;
}
</style>
