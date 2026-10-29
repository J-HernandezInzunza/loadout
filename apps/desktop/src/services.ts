// The two things every store needs from main.ts, provided at the app level so setup stores can inject()
// them and tests can hand in a fake instead.
import type { Library } from "@loadout/core";
import { inject, type InjectionKey } from "vue";
import type { AuditLog } from "./host-tauri/audit.ts";

export const libraryKey: InjectionKey<Library> = Symbol("library");
export const auditLogKey: InjectionKey<AuditLog> = Symbol("auditLog");

function required<T>(key: InjectionKey<T>): T {
  const value = inject(key);
  if (value === undefined) throw new Error(`${String(key.description)} was not provided to the app`);
  return value;
}

export const useLibrary = (): Library => required(libraryKey);
export const useAuditLog = (): AuditLog => required(auditLogKey);
