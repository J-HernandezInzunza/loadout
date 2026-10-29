import type { CatalogRow, Library, Result, Warning } from "@loadout/core";
import { computed, onUnmounted, ref, toValue, type MaybeRefOrGetter } from "vue";
import { useLibrary } from "./services.ts";
import { useAccountStore } from "./stores/accounts.ts";
import { useActivityStore } from "./stores/activity.ts";
import { useCatalogStore } from "./stores/catalog.ts";

type EditPlan = Extract<Awaited<ReturnType<Library["planAdd"]>>, { ok: true }>["value"];
export type EditResult = Extract<Awaited<ReturnType<Library["applyCatalogEdit"]>>, { ok: true }>["value"];

/** What a write waits on the user for before it lands. */
export interface WriteGate {
  /** direct: pushing with no review needs a yes; account: a PR could open here if the host were connected */
  ask: "direct" | "account" | null;
  /** the catalog changed after the first plan, so this one was made against what is there now */
  replanned: boolean;
}

/**
 * Plans and applies one catalog edit, stopping in between where the catalog's write mode needs the user:
 * a direct push asks first (Q3 A), and a pull request with no account for its host offers to connect one.
 * A plan gone stale is planned again and shown again, never applied blind.
 */
export function useCatalogWrite(catalogId: MaybeRefOrGetter<string>) {
  const library = useLibrary();
  const activity = useActivityStore();
  const catalog = useCatalogStore();
  const accounts = useAccountStore();

  const row = computed<CatalogRow | undefined>(() => catalog.catalogs.find((c) => c.id === toValue(catalogId)));
  const gate = ref<WriteGate | null>(null);
  let decide: ((go: boolean) => void) | null = null;

  async function askFor(): Promise<WriteGate["ask"]> {
    const target = row.value;
    if (target?.writeMode === "direct") return "direct";
    if (target?.writeMode !== "pr" || target.accountHost === null) return null;
    await accounts.load();
    return accounts.accounts[target.accountHost] ? null : "account";
  }

  function waitForUser(next: WriteGate): Promise<boolean> {
    gate.value = next;
    return new Promise((resolve) => (decide = resolve));
  }

  /** Null when the user decided against it; the plan is discarded then. */
  async function run(label: string, plan: (signal: AbortSignal) => Promise<Result<EditPlan>>): Promise<Result<EditResult> | null> {
    let planned = await activity.withActivity(label, plan);
    let replanned = false;
    for (;;) {
      if (!planned.ok) return planned;
      const ask = await askFor();
      if (ask !== null || replanned) {
        const go = await waitForUser({ ask, replanned });
        gate.value = null;
        decide = null;
        if (!go) {
          await library.discardCatalogEdit(planned.value);
          return null;
        }
      }
      const edit = planned.value;
      const applied = await activity.withActivity(label, (signal) => library.applyCatalogEdit(edit, { signal }));
      if (applied.ok || applied.error.code !== "STALE_PLAN") return applied;
      await library.discardCatalogEdit(edit);
      replanned = true;
      planned = await activity.withActivity(label, plan);
    }
  }

  const confirm = () => decide?.(true);
  const decline = () => decide?.(false);

  // Leaving with a question open drops the plan, and with it a PR-mode temp clone.
  onUnmounted(decline);

  return { row, gate, run, confirm, decline };
}

export type CatalogWrite = ReturnType<typeof useCatalogWrite>;

/** What a write to a shared catalog did beyond the file: the pull request, the branch, or the push. */
export interface WriteLanding {
  line: string;
  link: { url: string; label: string } | null;
  /** what went wrong past the edit itself, such as a push or the PR request */
  detail: string | null;
}

/** Null for a local catalog, or an edit that changed nothing: the component's own line says all there is. */
export function describeWrite(result: EditResult, warnings: Warning[]): WriteLanding | null {
  if (result.mode === "local" || !result.changed) return null;
  const detail = warnings.length ? warnings.map((w) => w.message).join("\n") : null;
  // Not `=== "direct"`: the result is an intersection, which only this test narrows to the PR shape below.
  if (result.mode !== "pr") {
    if (result.pushed) return { line: `Committed and pushed to ${result.catalog}'s ${result.branch ?? "branch"}.`, link: null, detail };
    return { line: `Saved in ${result.catalog}'s clone, but not pushed. Doctor can re-clone it if the push keeps failing.`, link: null, detail };
  }
  if (result.method === "api" && result.prUrl) {
    return { line: `Pull request opened from ${result.branch}.`, link: { url: result.prUrl, label: "View the pull request" }, detail };
  }
  return {
    line: `Branch ${result.branch} pushed — the pull request is not open yet, and nobody has been asked to review anything until you open it.`,
    link: result.compareUrl ? { url: result.compareUrl, label: "Open a pull request" } : null,
    detail,
  };
}
