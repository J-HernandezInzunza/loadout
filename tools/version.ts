// The app's version lives in apps/desktop/package.json; tauri.conf.json reads it from there. The other
// manifests and both lockfiles carry a copy, which `npm run version:set <version>` keeps in step (R.01).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = ["apps/desktop/package.json", "packages/core/package.json", "packages/host-node/package.json"];
const WORKSPACES = ["apps/desktop", "packages/core", "packages/host-node"];
const CARGO_TOML = "apps/desktop/src-tauri/Cargo.toml";
const CARGO_LOCK = "apps/desktop/src-tauri/Cargo.lock";

/** every file that carries the version; the copy on a test reads and writes these */
export const VERSION_FILES = [...PACKAGES, "package-lock.json", CARGO_TOML, CARGO_LOCK];

// [package]'s own version is the first line that starts with `version =`; dependencies use inline tables.
const TOML_VERSION = /^version = "([^"]*)"$/m;
const LOCK_VERSION = /(\nname = "loadout"\nversion = ")([^"]*)(")/;

/** semver as Cargo and the release tag accept it: 0.1.0, 0.1.0-rc.1 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const readJson = (root: string, file: string) => JSON.parse(read(root, file));
// npm writes its JSON with two spaces and a final newline, so a rewrite only changes the version.
const writeJson = (root: string, file: string, value: unknown) => writeFileSync(join(root, file), JSON.stringify(value, null, 2) + "\n");

/** Each file's copy of the version, keyed like `package-lock.json#packages/core`. */
export function readVersions(root: string): Record<string, string | undefined> {
  const lock = readJson(root, "package-lock.json");
  return {
    ...Object.fromEntries(PACKAGES.map((file) => [file, readJson(root, file).version])),
    ...Object.fromEntries(WORKSPACES.map((ws) => [`package-lock.json#${ws}`, lock.packages[ws]?.version])),
    [CARGO_TOML]: TOML_VERSION.exec(read(root, CARGO_TOML))?.[1],
    [CARGO_LOCK]: LOCK_VERSION.exec(read(root, CARGO_LOCK))?.[2],
  };
}

export function setVersion(root: string, version: string): void {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${version} (expected like 0.1.0 or 0.1.0-rc.1, no leading v)`);
  for (const file of PACKAGES) writeJson(root, file, { ...readJson(root, file), version });
  const lock = readJson(root, "package-lock.json");
  for (const ws of WORKSPACES) lock.packages[ws].version = version;
  writeJson(root, "package-lock.json", lock);
  writeFileSync(join(root, CARGO_TOML), read(root, CARGO_TOML).replace(TOML_VERSION, `version = "${version}"`));
  writeFileSync(join(root, CARGO_LOCK), read(root, CARGO_LOCK).replace(LOCK_VERSION, `$1${version}$3`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version] = process.argv.slice(2);
  if (!version) {
    console.error("usage: npm run version:set <version>");
    process.exit(1);
  }
  setVersion(fileURLToPath(new URL("..", import.meta.url)), version);
  console.log(`version ${version} set in ${VERSION_FILES.join(", ")}`);
}
