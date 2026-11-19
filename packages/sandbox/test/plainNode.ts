// Runs under plain `node` (no Vitest): creates a sandbox, a remote and the API
// stub, uses each once, runs their clean-ups, and prints what the test checks afterwards. It imports
// the three modules, not the index: the index brings in the core, whose syntax Node can't strip.
import { createApiStub } from "../src/apiStub.ts";
import { createGitHarness } from "../src/git.ts";
import { createSandbox } from "../src/sandbox.ts";

const cleanups: (() => Promise<void>)[] = [];
const sandbox = await createSandbox((cleanup) => void cleanups.push(cleanup));
const remote = createGitHarness(sandbox).createRepo("github.com", "acme/skills");
const head = remote.commit({ "README.md": "skills\n" });
const lsRemote = createGitHarness(sandbox).git(["ls-remote", remote.https, "main"]);
const stub = await createApiStub((cleanup) => void cleanups.push(cleanup));
const stubStatus = (await fetch(`${stub.bases.github}/user`)).status;

for (const cleanup of cleanups.reverse()) await cleanup();
console.log(JSON.stringify({ root: sandbox.root, head, lsRemote, stubBase: stub.bases.github, stubStatus }));
