// The sandbox (@loadout/sandbox) for one test: its root is verified and removed when the test finishes.
import { createSandbox as create, type Sandbox } from "@loadout/sandbox";
import { onTestFinished } from "vitest";

export type { Sandbox };

/** Call inside a test or `beforeEach`. */
export const createSandbox = (): Promise<Sandbox> => create(onTestFinished);
