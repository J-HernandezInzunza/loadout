// Wording and colour for catalog rows; decisions about them live in the core (@loadout/core views).

const HUES = [211, 275, 25, 320];

/** A stable colour per catalog, so origin reads at a glance without a legend. */
export function catalogHue(precedence: number): number {
  return HUES[(precedence - 1) % HUES.length]!;
}
