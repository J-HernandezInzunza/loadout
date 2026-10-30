// Points the tap's cask at a published release (R.05): rewrites its version and sha256 lines and nothing else.
// `node tools/bump-cask.ts <cask.rb> <version> <sha256>`, run by .github/workflows/tap.yml.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A release the tap may carry: never a pre-release (those stop at GitHub, R.07).
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function bumpCask(cask: string, version: string, sha256: string): string {
  if (!RELEASE.test(version)) throw new Error(`not a release version: ${version}`);
  if (!SHA256.test(sha256)) throw new Error(`not a SHA-256: ${sha256}`);
  let bumped = cask;
  for (const [stanza, value] of [["version", version], ["sha256", sha256]] as const) {
    const line = new RegExp(`^  ${stanza} "[^"]*"$`, "gm");
    const found = cask.match(line)?.length ?? 0;
    if (found !== 1) throw new Error(`expected one ${stanza} line in the cask, found ${found}`);
    bumped = bumped.replace(line, `  ${stanza} "${value}"`);
  }
  return bumped;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, version, sha256] = process.argv.slice(2);
  if (!file || !version || !sha256) {
    console.error("usage: node tools/bump-cask.ts <cask.rb> <version> <sha256>");
    process.exit(1);
  }
  writeFileSync(file, bumpCask(readFileSync(file, "utf8"), version, sha256));
}
