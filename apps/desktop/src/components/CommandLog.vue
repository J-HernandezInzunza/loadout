<script setup lang="ts">
import { storeToRefs } from "pinia";
import { ref } from "vue";
import { useActivityStore, type LoggedCommand } from "../stores/activity.ts";

// The history lives in the store, so it keeps recording while the panel is collapsed, which is most of
// the time; the log is the app's record of every command it ran on the user's behalf.
const activity = useActivityStore();
const { commands, label, cancellable } = storeToRefs(activity);
const open = ref(false);

/** How much of one command shows before it is asked for: verbatim stays one click away. */
const LIMIT = 160;

/** rows shown in full, by command id */
const expanded = ref<Set<number>>(new Set());

function toggle(id: number) {
  const next = new Set(expanded.value);
  if (!next.delete(id)) next.add(id);
  expanded.value = next;
}

const full = (run: LoggedCommand) => run.argv.join(" ");
const isLong = (run: LoggedCommand) => full(run).length > LIMIT;

function shown(run: LoggedCommand): string {
  if (!isLong(run) || expanded.value.has(run.id)) return full(run);
  return `${full(run).slice(0, LIMIT)}…`;
}
</script>

<template>
  <aside
    class="command-log"
    :class="{ 'command-log--open': open }"
  >
    <button
      type="button"
      class="command-log__toggle"
      :aria-expanded="open"
      aria-controls="command-log-list"
      @click="open = !open"
    >
      <span class="command-log__caret">{{ open ? "▾" : "▸" }}</span>
      Commands
      <span class="command-log__count">{{ commands.length }}</span>
    </button>
    <!-- Beside the toggle, not in it, so the button's accessible name stays "Commands". Always rendered:
         a live region added at the moment it has something to say is not announced. -->
    <span class="command-log__right">
      <span
        class="command-log__activity"
        role="status"
        aria-live="polite"
      >{{ label }}</span>
      <button
        v-if="cancellable"
        type="button"
        class="ghost btn-xs"
        @click="activity.cancel()"
      >
        Cancel
      </button>
    </span>

    <ol
      v-show="open"
      id="command-log-list"
      class="command-log__list"
    >
      <li
        v-for="run in commands"
        :key="run.id"
        class="command-log__row"
      >
        <span
          class="command-log__status"
          :class="{
            'command-log__status--running': run.code === null,
            'command-log__status--failed': run.code !== null && run.code !== 0,
          }"
        >
          {{ run.code === null ? "…" : run.code }}
        </span>
        <code class="command-log__argv">{{ shown(run) }}</code>
        <!-- Only where something is hidden, so its presence means there is more to read. -->
        <button
          v-if="isLong(run)"
          type="button"
          class="command-log__more"
          @click="toggle(run.id)"
        >
          {{ expanded.has(run.id) ? "less" : "full" }}
        </button>
        <span
          v-if="run.durationMs !== null"
          class="command-log__time"
        >
          {{ run.durationMs }}ms
        </span>
      </li>
      <li
        v-if="!commands.length"
        class="command-log__empty"
      >
        Nothing has run yet.
      </li>
    </ol>
  </aside>
</template>

<style scoped>
/* The app's last grid row, in the flow rather than fixed, so it is the window's bottom by construction.
   `relative` so the expanded list can hang off it as an overlay instead of resizing the view above. */
.command-log {
  position: relative;
  z-index: 20;
  border-top: 1px solid var(--border-hairline);
  background: var(--surface-page);
}
.command-log__toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  /* A stated height, so the bottom of the app doesn't move with the text: 2.1rem with the hairline. */
  box-sizing: border-box;
  height: calc(2.1rem - 1px);
  padding: 0 1rem;
  border: none;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font-size: 0.78rem;
  font-weight: 500;
  opacity: 0.75;
}
/* Over the toggle's empty right end. */
.command-log__right {
  position: absolute;
  top: 0;
  right: 1rem;
  height: calc(2.1rem - 1px);
  max-width: 50%;
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.command-log__activity {
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.68rem;
  white-space: nowrap;
  text-overflow: ellipsis;
  opacity: 0.6;
  pointer-events: none;
}
.command-log__caret {
  opacity: 0.6;
}
.command-log__count {
  font-variant-numeric: tabular-nums;
  opacity: 0.55;
}
/* Upward, over whatever is on screen, never pushing it; capped so a long history scrolls inside it. */
.command-log__list {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  list-style: none;
  max-height: min(14rem, 60vh);
  overflow-y: auto;
  margin: 0;
  padding: 0.5rem 1rem 0.75rem;
  border-top: 1px solid var(--border-hairline);
  /* Opaque: a translucent panel over the view shows two layers of text. */
  background: var(--surface-page);
}
.command-log__row {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  padding: 0.2rem 0;
  font-size: 0.75rem;
}
.command-log__status {
  min-width: 1.5rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--status-ok-ink);
}
.command-log__status--running {
  color: inherit;
  opacity: 0.5;
}
.command-log__status--failed {
  color: var(--status-danger-ink);
  font-weight: 600;
}
.command-log__argv {
  flex: 1;
  /* Even expanded, one entry scrolls inside its own row rather than pushing the others out. */
  max-height: 9rem;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, monospace;
  overflow-wrap: anywhere;
  opacity: 0.85;
}
.command-log__more {
  flex: none;
  align-self: flex-start;
  padding: 0 0.35rem;
  border: 1px solid var(--border-control);
  border-radius: 0.25rem;
  background: transparent;
  color: inherit;
  font-size: 0.68rem;
  opacity: 0.7;
  cursor: pointer;
}
.command-log__time {
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}
.command-log__empty {
  padding: 0.2rem 0;
  font-size: 0.75rem;
  opacity: 0.5;
}
</style>
