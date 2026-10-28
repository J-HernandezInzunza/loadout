// A new catalog's text (EDIT-15): the CLI's scaffold, with comments that name Loadout.

export function scaffoldCatalog(id: string): string {
  const name = id.replace(/\s+/g, " ");
  return [
    `# Loadout catalog '${name}'. Edit it in Loadout or by hand; entries live under library.`,
    "#",
    "# No default_dirs here: install locations belong to the app, not the catalog.",
    "library:",
    "  skills: []",
    "  agents: []",
    "  prompts: []",
    "",
  ].join("\n");
}
