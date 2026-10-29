// The app's components and global stylesheet as text, for the guards that read the source the way a reviewer
// would. Through Vite's raw glob, so a new component is picked up with nothing to register.
import appCss from "./app.css?raw";

const SOURCES = import.meta.glob("../**/*.vue", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export { appCss };

/** Every `.vue` file as [path relative to src/, contents]. */
export function components(): [string, string][] {
  return Object.entries(SOURCES).map(([path, source]) => [path.replace("../", ""), source]);
}

/** Style blocks with comments stripped, so prose citing an old value is not a violation. */
export function styles(source: string): string {
  return [...source.matchAll(/<style[^>]*>(.*?)<\/style>/gs)].map(([, block]) => block!.replace(/\/\*.*?\*\//gs, "")).join("\n");
}
