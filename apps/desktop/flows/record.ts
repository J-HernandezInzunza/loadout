// npm run record -- <flow> (M16.12): runs one flow in record mode while the recorder films the app's window,
// then composites it: the window, its corners masked, on a gradient wallpaper with a soft shadow, as H.264
// (S16, S17). Writes apps/desktop/demo/out/<flow>.mp4.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const flows = fileURLToPath(new URL(".", import.meta.url));
const out = join(repo, "apps/desktop/demo/out");
const recorder = join(repo, "apps/desktop/demo/.bin/recorder");
const recorderSource = join(flows, "recorder/recorder.swift");

/** The window in points, and the frame around it, as the app opens (tauri.conf.json). */
const window = { width: 1100, height: 760 };
const canvas = { width: 1600, height: 1000 };

function need(program: string, hint: string): void {
  if (spawnSync("which", [program]).status !== 0) throw new Error(`${program} is needed: ${hint}`);
}

/** Compiled on demand, and again when its source changes. */
function buildRecorder(): void {
  if (existsSync(recorder) && statSync(recorder).mtimeMs > statSync(recorderSource).mtimeMs) return;
  mkdirSync(join(recorder, ".."), { recursive: true });
  const built = spawnSync("swiftc", ["-O", "-parse-as-library", recorderSource, "-o", recorder], { encoding: "utf8" });
  if (built.status !== 0) {
    throw new Error(`the recorder didn't compile, so Swift can't build against the macOS SDK here (reinstalling the Command Line Tools fixes a broken one, S17):\n${built.stderr}`);
  }
}

/** The ProRes capture onto the wallpaper, at the capture's scale, then down to the canvas size. */
function composite(mov: string, mp4: string): void {
  const [w] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width", "-of", "csv=p=0", mov], { encoding: "utf8" }).trim().split(",").map(Number);
  const s = w! / window.width;
  const px = (n: number) => Math.round(n * s);
  const [cw, ch, ww, wh] = [px(canvas.width), px(canvas.height), px(window.width), px(window.height)];
  const [x, y, r, pad] = [px((canvas.width - window.width) / 2), px((canvas.height - window.height) / 2), px(10), px(100)];
  const graph = [
    // A rounded-rectangle mask: whatever showed behind the window's corners goes.
    `color=black:s=${ww}x${wh}:d=1,format=gray,geq=lum='255*lte(pow(X-clip(X\\,${r}\\,${ww - r})\\,2)+pow(Y-clip(Y\\,${r}\\,${wh - r})\\,2)\\,${r * r})',loop=-1:1:0[mask]`,
    `[mask]split[m1][m2]`,
    // The recorder only gets frames when the window changes, so the last state is held on for the closing pause.
    `[0:v]fps=30,tpad=stop_mode=clone:stop_duration=1.5,format=rgba[v]`,
    `[v][m1]alphamerge[win]`,
    `[m2]pad=${ww + 2 * pad}:${wh + 2 * pad}:${pad}:${pad}:color=black,boxblur=${px(22)}:2,lut=y=val*0.38[soft]`,
    `color=black:s=${ww + 2 * pad}x${wh + 2 * pad}:r=30[ink]`,
    `[ink][soft]alphamerge[shadow]`,
    `gradients=s=${cw}x${ch}:c0=0x3b4a8c:c1=0x7a4f9a:c2=0xd07a6b:nb_colors=3:x0=0:y0=0:x1=${cw}:y1=${ch}:speed=0:rate=30[wall]`,
    `[wall][shadow]overlay=x=${x - pad}:y=${y - pad + px(12)}:shortest=1[w1]`,
    `[w1][win]overlay=x=${x}:y=${y}:shortest=1,scale=${canvas.width}:${canvas.height}:flags=lanczos,format=yuv420p[out]`,
  ].join(";");
  const duration = String(Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mov], { encoding: "utf8" }).trim()) + 1.5);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mov, "-filter_complex", graph, "-map", "[out]", "-t", duration, "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", mp4], { stdio: "inherit" });
}

const [name] = process.argv.slice(2);
const available = readdirSync(flows).filter((f) => f.endsWith(".flow.ts")).map((f) => f.replace(".flow.ts", ""));
if (!name || !available.includes(name)) {
  console.error(`usage: npm run record -- <flow>   (one of: ${available.join(", ")})`);
  process.exit(1);
}
need("ffmpeg", "brew install ffmpeg");
buildRecorder();
execFileSync("npm", ["run", "app:build:debug"], { cwd: repo, stdio: "inherit" });
mkdirSync(out, { recursive: true });
const mov = join(out, `${name}.mov`);
rmSync(mov, { force: true });

console.log("\nRecording: turn on Do Not Disturb, since anything drawn over the window is filmed, and leave the mouse alone.\n");
const run = spawnSync("npx", ["vitest", "run", "--config", join(flows, "vitest.config.ts"), `${name}.flow.ts`], {
  cwd: repo,
  stdio: "inherit",
  env: { ...process.env, RECORD: "1", RECORD_OUT: out, RECORD_NAME: name, RECORDER: recorder },
});
if (run.status !== 0) process.exit(run.status ?? 1);

const mp4 = join(out, `${name}.mp4`);
composite(mov, mp4);
rmSync(mov);
console.log(`\nWrote ${mp4} (${(statSync(mp4).size / 1e6).toFixed(1)} MB)`);
