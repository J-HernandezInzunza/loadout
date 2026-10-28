// WRITE-12: the commit message, PR title and PR body each kind of catalog edit carries.
import type { CatalogEdit } from "./edit.ts";

export interface EditCopy {
  commit: string;
  title: string;
  body: string;
}

export function editCopy(edit: CatalogEdit): EditCopy {
  if (edit.op === "add") {
    if (edit.entries.length === 1) {
      const e = edit.entries[0]!;
      return {
        commit: `library: added ${e.type} ${e.name}`,
        title: `library: add ${e.type} ${e.name}`,
        body: `Adds \`${e.name}\` (${e.type}) to the catalog.\n\nSource: ${e.source}`,
      };
    }
    const n = edit.entries.length;
    return {
      commit: `library: add ${n} entries (${edit.entries.map((e) => e.name).join(", ")})`,
      title: `library: add ${n} entries`,
      body: edit.entries.map((e) => `- \`${e.name}\` (${e.type}) — ${e.source}`).join("\n"),
    };
  }
  if (edit.op === "remove") {
    return {
      commit: `library: removed ${edit.type} ${edit.name}`,
      title: `library: remove ${edit.type} ${edit.name}`,
      body: `Removes \`${edit.name}\` (${edit.type}) from the catalog.`,
    };
  }
  const line = `library: updated ${edit.type} ${edit.name}`;
  return { commit: line, title: line, body: `Updates \`${edit.name}\` (${edit.type}) in the catalog.` };
}
