<script setup lang="ts">
import type { CatalogRow } from "@loadout/core";
import { computed, ref, watch } from "vue";
import { catalogHue, SESSION_TIMING, type Row } from "../catalog.ts";
import { useLibrary } from "../services.ts";
import { useActivityStore } from "../stores/activity.ts";
import { useCatalogStore } from "../stores/catalog.ts";
import { useToastStore } from "../stores/toasts.ts";
import type { EntryStop } from "../stores/views.ts";

const props = defineProps<{
  rows: Row[];
  catalogs: CatalogRow[];
  /** origin is worth the space only once more than one catalog is registered */
  showOrigin: boolean;
}>();

const emit = defineEmits<{
  /** which copy was opened: a row is one catalog's copy, so its name alone is ambiguous */
  select: [stop: EntryStop];
}>();

const library = useLibrary();
const activity = useActivityStore();
const catalog = useCatalogStore();
const toasts = useToastStore();

/** rows whose toggle is in flight, so only those switches go inert */
const toggling = ref(new Set<string>());
/**
 * Flips not yet confirmed, name → on, so the switch moves under the finger rather than after the write
 * and the reload. Intent, not truth: fresh rows replace it, and a refusal drops it so the row snaps back.
 */
const pending = ref(new Map<string, boolean>());

watch(
  () => props.rows,
  () => {
    // Kept while still in flight: the rows also change on every search keystroke.
    for (const name of [...pending.value.keys()]) if (!toggling.value.has(name)) pending.value.delete(name);
  },
);

/**
 * The winning copy of a skill or prompt that is on the machine, whoever put it there; not one set to a
 * value Loadout leaves alone (name-only, user-invocable-only).
 */
function switchable(row: Row): boolean {
  const e = row.entry;
  return e.type !== "agent" && e.installed && e.overriddenBy === null && e.skillOverride === null;
}

function switchedOn(row: Row): boolean {
  return pending.value.get(row.entry.name) ?? !row.entry.disabled;
}

async function flip(row: Row) {
  const name = row.entry.name;
  const on = row.entry.disabled;
  pending.value.set(name, on);
  toggling.value.add(name);
  try {
    const result = await activity.withActivity(`${on ? "enabling" : "disabling"} ${name}…`, () => library.setSkillState([name], on ? "on" : "off"));
    const readOnly = result.ok ? result.value.readOnly[0] : undefined;
    if (!result.ok || readOnly) {
      pending.value.delete(name);
      const detail = result.ok ? `It is set to ${readOnly!.value} elsewhere; Loadout leaves that as it is.` : result.error.message;
      toasts.notify({ kind: "error", message: `Could not switch ${name}.`, detail });
      return;
    }
    // Already in the requested state counts as success.
    toasts.notify({ kind: "success", message: `${name} is switched ${on ? "on" : "off"}. ${SESSION_TIMING}` });
    await catalog.reload();
  } finally {
    toggling.value.delete(name);
  }
}

/** A switched-off card's hover text says when the change lands; the badge has no room for it. */
function statusTitle(row: Row): string | undefined {
  return row.entry.disabled ? `${row.status}\n${SESSION_TIMING}` : undefined;
}

const hueByCatalog = computed(() => new Map(props.catalogs.map((c) => [c.id, catalogHue(c.precedence)])));
</script>

<template>
  <ul class="entry-list">
    <li
      v-for="row in rows"
      :key="`${row.entry.catalog}:${row.entry.type}:${row.entry.name}`"
      class="entry-list__row"
    >
      <div
        class="entry-list__card"
        :class="{ 'entry-list__card--off': row.entry.disabled }"
      >
        <div class="entry-list__item">
          <!-- An empty button stretched over the card rather than one wrapping it, so the card can hold
               controls of its own: a button inside a button swallows one of the two clicks. -->
          <button
            type="button"
            class="entry-list__open"
            :aria-label="`Open ${row.entry.name}`"
            :title="statusTitle(row)"
            @click="emit('select', { name: row.entry.name, catalog: row.entry.catalog })"
          />

          <!-- Its own column, so the type starts at the same x on every row. -->
          <span class="entry-list__type">{{ row.entry.type }}</span>

          <!-- Under the type, on the description's line: a track and a knob, above the open button. -->
          <button
            v-if="switchable(row)"
            type="button"
            role="switch"
            class="entry-list__switch"
            :aria-checked="switchedOn(row)"
            :disabled="toggling.has(row.entry.name)"
            :aria-label="`${row.entry.name} enabled`"
            :title="`${switchedOn(row) ? 'Disable' : 'Enable'} ${row.entry.name}`"
            @click="flip(row)"
          />

          <div class="entry-list__head">
            <span class="entry-list__name">{{ row.entry.name }}</span>
            <span
              v-if="showOrigin"
              class="entry-list__origin"
              :style="{ '--catalog-hue': hueByCatalog.get(row.entry.catalog) ?? 220 }"
            >
              {{ row.entry.catalog }}
            </span>
            <!-- Only where a pin is doing work: with one catalog it would say nothing. -->
            <span
              v-if="row.entry.pinned && showOrigin"
              class="entry-list__pinned"
              title="Pinned: this catalog's copy installs, whatever the catalog order says"
            >
              pinned
            </span>
            <span
              v-if="row.entry.overriddenBy"
              class="entry-list__overridden"
            >
              overridden by {{ row.entry.overriddenBy }}
            </span>
            <span
              v-if="row.overrides.length"
              class="entry-list__overrides"
            >
              overrides {{ row.overrides.join(", ") }}
            </span>
            <span
              v-if="row.entry.skillOverride"
              class="entry-list__visibility"
              :title="`Set to ${row.entry.skillOverride} in Claude Code's settings; Loadout leaves it as it is.`"
            >
              {{ row.entry.skillOverride }}
            </span>
            <!-- Whether this copy is on the machine, apart from the precedence pills, so an overridden
                 copy can say both "overridden by X" and "not installed". -->
            <span
              class="entry-list__status"
              :class="`entry-list__status--${row.tone}`"
            >
              {{ row.status }}
            </span>
          </div>

          <p class="entry-list__desc">
            {{ row.entry.description }}
          </p>
          <p
            v-if="row.entry.requires.length"
            class="entry-list__requires"
          >
            requires: {{ row.entry.requires.join(", ") }}
          </p>
        </div>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.entry-list__card {
  position: relative;
  display: flex;
  align-items: stretch;
  border-radius: 10px;
  transition: background 0.12s ease;
}
/* Dimmed, because the content is on the machine but nothing is loading it. The text is
   dimmed rather than the card: opacity composites a whole subtree, so fading the card
   would fade the switch that undoes the state it is reporting, and the one control the
   row offers would read as unavailable. */
.entry-list__card--off > .entry-list__item {
  border-style: dashed;
}
.entry-list__card--off .entry-list__type,
.entry-list__card--off .entry-list__name,
.entry-list__card--off .entry-list__desc {
  opacity: 0.55;
}
.entry-list__card > .entry-list__item {
  flex: 1;
  min-width: 0;
}
.entry-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.entry-list__item {
  position: relative;
  /* Two columns — the type and its switch, then everything else — and two rows: the
     name's line, then the description's. The column is sized by the label's own
     `min-width` rather than here, so changing the label's font size cannot silently
     stagger the names (see `.entry-list__type`).

     `baseline` rather than the default, because the label and the name are set five
     points apart: aligning their line boxes centres two different amounts of leading and
     leaves the smaller word riding ~2px high. Sharing a baseline is size-independent. */
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.5rem;
  align-items: baseline;
  width: 100%;
  padding: 0.85rem 1rem;
  border-radius: 10px;
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  text-align: left;
  cursor: pointer;
}
.entry-list__item:hover {
  border-color: var(--border-control);
  background: var(--surface-hover);
}
.entry-list__open {
  /* Stretched over the card and invisible: the card is the hit target, the button is
     only what makes it one. Above 0 rather than at it, because the description and
     several pills are dimmed with `opacity`, and an element with opacity below 1 paints
     where a `z-index: 0` positioned element would — at 0 the overlay would sit under
     them, and clicking an entry's own description would miss the button that opens it. */
  position: absolute;
  inset: 0;
  z-index: 1;
  padding: 0;
  border: 0;
  border-radius: inherit;
  background: none;
  cursor: inherit;
}
/* The focus ring belongs on the card, not on the invisible button filling it. */
.entry-list__open:focus-visible {
  outline: 2px solid var(--accent-bright);
  outline-offset: 1px;
}
.entry-list__head {
  grid-column: 2;
  grid-row: 1;
  /* A grid item's automatic minimum is its content, so without this a long unbroken
     name or catalog id widens the column instead of wrapping inside it. */
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.entry-list__name {
  font-weight: 600;
}
.entry-list__type {
  grid-column: 1;
  grid-row: 1;
  /* The column's width lives here, in the label's own em, so it tracks whatever font
     size this rule is set to: the longest type is ~4.5em wide, and a value in `rem` went
     stale the moment the size changed, widening the prompt rows' column and pushing
     their names ~9px right of everyone else's. A type longer than this still widens its
     own row rather than colliding, because the track is `auto`. */
  min-width: 4.75em;
  /* A width decision as much as a type one: small caps run ~20% wider than lower case,
     and the column above is measured in this size, so every step up here is an indent
     taken off the description on all 45 rows. */
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  /* Widens the column rather than breaking across two lines, which would put the second
     half of a long type under the card's first word. */
  white-space: nowrap;
  opacity: 0.7;
}
.entry-list__origin {
  --catalog-hue: 220;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  background: var(--catalog-fill);
  color: var(--text-on-accent);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.entry-list__status {
  /* Pushed to the card's top-right, apart from the precedence pills on the left. */
  margin-left: auto;
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  white-space: nowrap;
}
.entry-list__status--installed {
  background: var(--status-ok-tint);
  color: var(--status-ok-ink);
}
.entry-list__status--absent {
  background: var(--surface-sunken);
  opacity: 0.8;
}
.entry-list__status--disabled {
  /* Violet, so "switched off" reads as neither the green of a loading skill nor the grey
     of one that was never installed. */
  background: var(--status-disabled-tint);
  color: var(--status-disabled-ink);
}
.entry-list__status--attention {
  background: var(--status-attention-tint);
  color: var(--status-attention-ink);
  font-weight: 600;
}
.entry-list__overridden {
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--status-override-tint);
  color: var(--status-attention-ink);
}
.entry-list__pinned {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--status-ok-tint);
  color: var(--status-ok-ink);
}
.entry-list__overrides {
  font-size: 0.7rem;
  opacity: 0.55;
}
.entry-list__desc {
  grid-column: 2;
  grid-row: 2;
  margin: 0.4rem 0 0;
  font-size: 0.88rem;
  line-height: 1.4;
  opacity: 0.85;
}
.entry-list__requires {
  grid-column: 2;
  margin: 0.35rem 0 0;
  font-size: 0.78rem;
  opacity: 0.6;
}
.entry-list__switch {
  /* Above the stretched open button, so pressing the switch does not open the entry. */
  position: relative;
  z-index: 2;
  grid-column: 1;
  grid-row: 2;
  justify-self: start;
  /* Out of the baseline group — a control has no text to sit on a baseline — and nudged
     to centre on the description's first line, which is what row 2 is. */
  align-self: start;
  margin-top: 0.5rem;
  width: 1.9rem;
  height: 1.05rem;
  padding: 0;
  border: 1px solid var(--control-off);
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
  transition:
    background 0.12s ease,
    border-color 0.12s ease;
}
.entry-list__switch::after {
  /* The knob. A pseudo-element because the button has no text to lay out around. */
  content: "";
  position: absolute;
  top: 50%;
  left: 0.1rem;
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
  background: var(--control-off);
  transform: translateY(-50%);
  transition: transform 0.12s ease;
}
.entry-list__switch[aria-checked="true"] {
  background: var(--control-on);
  border-color: var(--control-on);
}
.entry-list__switch[aria-checked="true"]::after {
  background: var(--control-on-knob);
  transform: translate(0.8rem, -50%);
}
.entry-list__switch:hover:not(:disabled) {
  border-color: var(--control-on);
}
.entry-list__switch:disabled {
  /* Only lightly faded: the switch has already moved to where the user put it, and the
     point of moving it early is lost if the new position is hard to read. */
  opacity: 0.7;
  cursor: progress;
}
.entry-list__visibility {
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  border: 1px dashed var(--status-disabled-edge);
  color: var(--status-disabled-ink);
}
</style>
