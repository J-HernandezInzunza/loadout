// The API stub (@loadout/sandbox) for one test: its server closes when the test finishes.
import { createApiStub as create, type ApiStub } from "@loadout/sandbox";
import { onTestFinished } from "vitest";

export type { Api, ApiStub, RecordedRequest, StubPull, StubRepo } from "@loadout/sandbox";

/** Call inside a test or `beforeEach`. */
export const createApiStub = (): Promise<ApiStub> => create(onTestFinished);
