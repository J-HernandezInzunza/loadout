// Content digests of an installed tree (architecture.md §4.3, §4.4). `contentHashV1` is the Python
// CLI's `content_hash` (`library.py:191-211`), kept only to recognise what that CLI installed;
// `fileManifest` is what receipts v2 record. Both see the same files: every regular file under the
// path, dot-files and `.git` included, a symlink counted when it points at a file (hashed through
// it), never descended when it points at a directory, skipped when dangling.
import type { Host } from "../host.ts";

/** Relative posix paths of the files `path` holds (itself, by name, when it is a file), and the dir they're relative to. */
async function files(host: Host, path: string): Promise<{ base: string; rels: string[] }> {
  const root = await host.fs.stat(path).catch(() => null);
  if (root === null) return { base: path, rels: [] };
  if (root.kind === "file") {
    const cut = path.lastIndexOf("/");
    return { base: path.slice(0, cut), rels: [path.slice(cut + 1)] };
  }

  const rels: string[] = [];
  const visit = async (dir: string, prefix: string) => {
    for (const e of await host.fs.readDir(dir)) {
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.kind === "dir") await visit(`${dir}/${e.name}`, rel);
      else if (e.kind === "file") rels.push(rel);
      else if ((await host.fs.stat(`${dir}/${e.name}`).catch(() => null))?.kind === "file") rels.push(rel);
    }
  };
  await visit(path, "");
  return { base: path, rels: rels.sort(byCodePoint) };
}

/** Python's str ordering: by code point, where JS's default compares UTF-16 units and misorders astral characters. */
function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** `sha256:<hex>` over `rel \0 bytes \0` for each file in path order; a missing path hashes as empty. */
export async function contentHashV1(host: Host, path: string): Promise<string> {
  const { base, rels } = await files(host, path);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const nul = new Uint8Array([0]);
  for (const rel of rels) parts.push(encoder.encode(rel), nul, await host.fs.readBytes(`${base}/${rel}`), nul);
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return `sha256:${await host.sha256(all)}`;
}

/** Posix relpath → sha256 hex of its bytes, in path order; `{}` for a missing path. */
export async function fileManifest(host: Host, path: string): Promise<Record<string, string>> {
  const { base, rels } = await files(host, path);
  const out: Record<string, string> = {};
  for (const rel of rels) out[rel] = await host.sha256(await host.fs.readBytes(`${base}/${rel}`));
  return out;
}
