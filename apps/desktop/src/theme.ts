import { setTheme } from "@tauri-apps/api/app";

export type Appearance = "system" | "light" | "dark";

const KEY = "library.appearance";

/** Toggle order, starting from the default so one full cycle lands back on it. */
export const APPEARANCES: Appearance[] = ["system", "light", "dark"];

export function storedAppearance(): Appearance {
  const stored = localStorage.getItem(KEY);
  return APPEARANCES.find((appearance) => appearance === stored) ?? "system";
}

export function nextAppearance(current: Appearance): Appearance {
  return APPEARANCES[(APPEARANCES.indexOf(current) + 1) % APPEARANCES.length]!;
}

/**
 * Sets the window's native appearance and remembers it for the next launch. Native rather than a page
 * attribute: the WebView reports it as `prefers-color-scheme`, so tokens.css keeps one dark block and the
 * title bar follows along.
 */
export async function applyAppearance(appearance: Appearance): Promise<void> {
  localStorage.setItem(KEY, appearance);
  await setTheme(appearance === "system" ? null : appearance);
}
