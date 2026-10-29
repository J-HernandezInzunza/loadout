import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGolden, materializeTree } from "../../test/golden.ts";
import { createSandbox } from "../../test/sandbox.ts";
import { contentHashV1, fileManifest } from "./hash.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("contentHashV1", () => {
  it.each(loadGolden("hash").cases.map((c) => [c.id, c] as const))("matches the CLI's digest: %s", async (_, c) => {
    const { host, root } = await createSandbox();
    const path = await materializeTree(join(root, "tree"), c);
    expect(await contentHashV1(host, path)).toBe(c.contentHash);
  });
});

describe("fileManifest", () => {
  it("maps each file's posix relpath to the sha256 of its bytes, in path order", async () => {
    const { host, root } = await createSandbox();
    const dir = join(root, "skill");
    await mkdir(join(dir, "references", "deep"), { recursive: true });
    await mkdir(join(dir, "empty"));
    await writeFile(join(dir, "SKILL.md"), "s\n");
    await writeFile(join(dir, "references", "deep", "b.md"), "b\n");
    await writeFile(join(dir, ".hidden"), "h\n");
    await symlink("SKILL.md", join(dir, "link.md"));
    await symlink("references", join(dir, "alias"));
    await symlink("nowhere", join(dir, "broken"));

    const manifest = await fileManifest(host, dir);
    expect(Object.keys(manifest)).toEqual([".hidden", "SKILL.md", "link.md", "references/deep/b.md"]);
    expect(manifest).toEqual({
      ".hidden": sha("h\n"),
      "SKILL.md": sha("s\n"),
      "link.md": sha("s\n"),
      "references/deep/b.md": sha("b\n"),
    });
  });

  it("keys a single file by its name, and gives {} for a missing path", async () => {
    const { host, root } = await createSandbox();
    await writeFile(join(root, "review.md"), "r\n");
    expect(await fileManifest(host, join(root, "review.md"))).toEqual({ "review.md": sha("r\n") });
    expect(await fileManifest(host, join(root, "gone"))).toEqual({});
  });
});
