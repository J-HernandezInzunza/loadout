// The audit log the UI shows (architecture.md §2.5): process starts and ends and destructive fs ops, the
// most recent `capacity` of them, in memory. Events carry argv and paths only, never an env value, so
// tokens passed to git through the environment (§5.5) never land here.
import type { AuditEvent } from "@loadout/core";

export interface AuditLog {
  record(event: AuditEvent): void;
  /** oldest first */
  events(): AuditEvent[];
  /** Calls `listener` for each event recorded from now on; returns the unsubscribe. */
  subscribe(listener: (event: AuditEvent) => void): () => void;
}

export function createAuditLog(capacity = 1000): AuditLog {
  const buffer: AuditEvent[] = [];
  const listeners = new Set<(event: AuditEvent) => void>();
  return {
    record(event) {
      buffer.push(event);
      if (buffer.length > capacity) buffer.shift();
      for (const listener of listeners) listener(event);
    },
    events: () => [...buffer],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
