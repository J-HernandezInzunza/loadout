<script setup lang="ts">
import { useViewStore } from "../stores/views.ts";
import InstallPreview from "./InstallPreview.vue";
import PageHeader from "./PageHeader.vue";

defineProps<{
  name: string;
  /** the title of the page Back returns to */
  back: string;
}>();

const views = useViewStore();
</script>

<template>
  <section class="view">
    <PageHeader
      title="Install and set up"
      :back="back"
      @back="views.installFor = null"
    >
      <!-- The entry is a badge rather than part of the title, so every back label pointing here is the same. -->
      <template #badges>
        <span class="entry-install__name">{{ name }}</span>
      </template>
      <InstallPreview :name="name" />
    </PageHeader>
  </section>
</template>

<style scoped>
.entry-install__name {
  font-size: 0.85rem;
  font-weight: 600;
  opacity: 0.75;
}
</style>
