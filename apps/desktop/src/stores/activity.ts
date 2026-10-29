import type { AuditEvent } from "@loadout/core";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useAuditLog } from "../services.ts";

/** A command the host ran, with how it ended once it has. */
export interface LoggedCommand {
  id: number;
  argv: string[];
  code: number | null;
  durationMs: number | null;
}

/** git's global options that take a value, which sit before the subcommand */
const VALUED = new Set(["-C", "-c"]);
const PHRASE = 60;

/**
 * An argv as a short phrase for the bar, `git pull`: the full argv has its home in the log. Capped, since a
 * label that needs clipping to be legible is already the wrong label.
 */
export function describeArgv(argv: string[]): string {
  const [program = "", ...args] = argv;
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += VALUED.has(args[i]!) ? 2 : 1;
  const phrase = [program.split("/").pop(), args[i]].filter(Boolean).join(" ");
  return phrase.length > PHRASE ? `${phrase.slice(0, PHRASE)}…` : phrase;
}

/** The running command's phrase wins, being precise; else the newest intent, the more specific one. */
export function activityLabel(runningArgv: string[] | undefined, intents: string[]): string {
  if (runningArgv) return describeArgv(runningArgv);
  return intents.at(-1) ?? "";
}

/**
 * What the app is doing: every command the host has run this session (from the audit log, newest first,
 * never trimmed), and intents, which the UI declares in the click handler so the bar is up in the same frame
 * rather than once the first command lands. Each intent carries an AbortSignal that Cancel fires.
 */
export const useActivityStore = defineStore("activity", () => {
  const log = useAuditLog();
  const commands = ref<LoggedCommand[]>([]);
  const intents = ref(new Map<number, { label: string; controller: AbortController }>());
  let nextIntentId = 1;

  function track(event: AuditEvent) {
    if (event.kind === "proc:start") {
      commands.value.unshift({ id: event.id, argv: event.argv, code: null, durationMs: null });
    } else if (event.kind === "proc:end") {
      const run = commands.value.find((c) => c.id === event.id);
      if (!run) return;
      run.code = event.code;
      run.durationMs = event.durationMs;
    }
  }
  for (const event of log.events()) track(event);
  log.subscribe(track);

  /** Runs `work` under an intent labelled `label`, ended however the work ends. */
  async function withActivity<T>(label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const id = nextIntentId++;
    const controller = new AbortController();
    intents.value.set(id, { label, controller });
    try {
      return await work(controller.signal);
    } finally {
      intents.value.delete(id);
    }
  }

  /** Aborts every operation in flight; each stops between items and kills its running git child. */
  function cancel() {
    for (const { controller } of intents.value.values()) controller.abort();
  }

  const running = computed(() => commands.value.filter((run) => run.code === null));
  const busy = computed(() => intents.value.size > 0 || running.value.length > 0);
  const cancellable = computed(() => intents.value.size > 0);
  const label = computed(() =>
    activityLabel(
      running.value[0]?.argv,
      [...intents.value.values()].map((i) => i.label),
    ),
  );

  return { commands, busy, cancellable, label, withActivity, cancel };
});
