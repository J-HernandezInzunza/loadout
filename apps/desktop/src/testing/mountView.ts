// Mounts a component the way main.ts runs the app: a fresh Pinia whose stores inject a seeded fake Library
// and an audit log, so a screen test exercises the real stores and only the core is stood in for.
import type { AuditEvent, Library } from "@loadout/core";
import { createFakeLibrary, seededState, type FakeState } from "@loadout/core/testing";
import { mount, type ComponentMountingOptions } from "@vue/test-utils";
import { createPinia } from "pinia";
import type { Component } from "vue";
import { createAuditLog } from "../host-tauri/audit.ts";
import { auditLogKey, libraryKey } from "../services.ts";

export interface MountViewOptions<C> {
  /** defaults to seededState() */
  seed?: Partial<FakeState>;
  /** fake ops the test models, typically mutations */
  library?: Partial<Library>;
  /** already in the log when the component mounts */
  audit?: AuditEvent[];
  props?: ComponentMountingOptions<C>["props"];
}

export function mountView<C extends Component>(component: C, options: MountViewOptions<C> = {}) {
  const library = createFakeLibrary(options.seed ?? seededState(), options.library);
  const log = createAuditLog();
  for (const event of options.audit ?? []) log.record(event);
  const wrapper = mount(component, {
    props: options.props,
    global: { plugins: [createPinia()], provide: { [libraryKey]: library, [auditLogKey]: log } },
  } as ComponentMountingOptions<C>);
  return { wrapper, library, log };
}
