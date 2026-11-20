// Record mode (M16.12): a flow run by `npm run record` plays at recording pace while the recorder films the app's
// window (S17). The cursor, its click ring and the chapter cards are drawn in the page, in one overlay in the top
// layer, since WebDriver's clicks move no pointer. Outside record mode every function here does nothing.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Browser } from "./app.ts";

export const recording = process.env.RECORD === "1";

interface Display {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The display to record on: RECORD_DISPLAY's, else the sharpest, then the biggest. The window is centred there
 * and brought to the front, since the recorder films whatever is drawn over its region.
 */
async function stage(browser: Browser, invokeFocus: () => Promise<void>): Promise<void> {
  const displays = JSON.parse(execFileSync(process.env.RECORDER!, ["displays"], { encoding: "utf8" })) as Display[];
  const chosen = process.env.RECORD_DISPLAY
    ? displays.find((d) => String(d.id) === process.env.RECORD_DISPLAY)
    : [...displays].sort((a, b) => b.scale - a.scale || b.width * b.height - a.width * a.height)[0];
  if (!chosen) throw new Error(`no display ${process.env.RECORD_DISPLAY ?? ""}: ${displays.map((d) => d.id).join(", ")}`);
  const { width, height } = await browser.getWindowRect();
  await browser.setWindowRect(Math.round(chosen.x + (chosen.width - width) / 2), Math.round(chosen.y + (chosen.height - height) / 2), null, null);
  await invokeFocus();
  await pause(600);
}

/** The overlay: injected once per app, raised above any modal <dialog> before each move. */
function injectOverlay(browser: Browser) {
  return browser.execute(() => {
    const layer = document.createElement("div");
    layer.id = "__record";
    layer.popover = "manual";
    Object.assign(layer.style, { position: "fixed", inset: "0", margin: "0", padding: "0", border: "0", background: "transparent", width: "100vw", height: "100vh", maxWidth: "none", maxHeight: "none", overflow: "visible", pointerEvents: "none" });
    document.body.append(layer);
    layer.showPopover();
    const cursor = document.createElement("div");
    cursor.id = "__record_cursor";
    cursor.innerHTML = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 22 L7.5 17 L11 25.5 L14.5 24 L11 15.8 L18.5 15.8 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, { position: "absolute", left: "0", top: "0", zIndex: "3", transform: `translate(${innerWidth / 2}px, ${innerHeight * 0.6}px)`, transition: "transform 650ms cubic-bezier(.25,.8,.3,1)", filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,.35))" });
    layer.append(cursor);
    const style = document.createElement("style");
    style.textContent = "@keyframes __record_ring{from{transform:translate(-50%,-50%) scale(.3);opacity:.55}to{transform:translate(-50%,-50%) scale(1.6);opacity:0}}";
    document.head.append(style);
  });
}

/** Re-showing the overlay puts it above a dialog opened since, and resets the cursor's transition: reading its style keeps the glide. */
function raise(browser: Browser) {
  return browser.execute(() => {
    const layer = document.getElementById("__record")!;
    layer.hidePopover();
    layer.showPopover();
    void getComputedStyle(document.getElementById("__record_cursor")!).transform;
  });
}

/** What pointAt needs of an element: where it is. */
interface Placed {
  getLocation(): Promise<{ x: number; y: number }>;
  getSize(): Promise<{ width: number; height: number }>;
}

/** Glides the cursor to the element's centre, rings it, and leaves the click to the caller. */
export async function pointAt(browser: Browser, el: Placed & { scrollIntoView(o: ScrollIntoViewOptions): Promise<unknown> }): Promise<void> {
  if (!recording) return;
  // Scrolled smoothly into view first; a click would jump there.
  await el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  await pause(450);
  const { x, y } = await el.getLocation();
  const { width, height } = await el.getSize();
  const cx = x + width / 2;
  const cy = y + height / 2;
  await raise(browser);
  await browser.execute((cx: number, cy: number) => {
    document.getElementById("__record_cursor")!.style.transform = `translate(${cx - 2}px, ${cy - 2}px)`;
  }, cx, cy);
  await pause(750);
  await browser.execute((cx: number, cy: number) => {
    const ring = document.createElement("div");
    Object.assign(ring.style, { position: "absolute", left: `${cx}px`, top: `${cy}px`, width: "34px", height: "34px", borderRadius: "50%", background: "rgba(37,99,235,.45)", zIndex: "2", animation: "__record_ring 450ms ease-out forwards" });
    document.getElementById("__record")!.append(ring);
    setTimeout(() => ring.remove(), 500);
  }, cx, cy);
}

/** After a click: time for the change to settle on screen. */
export const settle = () => (recording ? pause(900) : Promise.resolve());

/** A chapter card with a title and a line, over a blurred page; nothing when not recording. */
export async function chapter(browser: Browser, title: string, line: string): Promise<void> {
  if (!recording) return;
  await raise(browser);
  await browser.execute((title: string, line: string) => {
    const card = document.createElement("div");
    const t = document.createElement("div");
    t.textContent = title;
    t.style.font = "600 28px -apple-system, system-ui";
    const l = document.createElement("div");
    l.textContent = line;
    Object.assign(l.style, { font: "400 16px -apple-system, system-ui", opacity: "0.85", marginTop: "8px" });
    card.append(t, l);
    Object.assign(card.style, { position: "absolute", inset: "0", display: "grid", placeContent: "center", textAlign: "center", color: "#fff", background: "rgba(20,24,40,.55)", backdropFilter: "blur(6px)", zIndex: "1", opacity: "0", transition: "opacity 300ms" });
    document.getElementById("__record")!.append(card);
    requestAnimationFrame(() => (card.style.opacity = "1"));
    setTimeout(() => {
      card.style.opacity = "0";
      setTimeout(() => card.remove(), 350);
    }, 1800);
  }, title, line);
  await pause(2300);
}

/**
 * In record mode, stages the window and starts the recorder on the app's process; the returned stop holds the
 * last state a moment, then stops it. Outside record mode, a stop that does nothing.
 */
export async function startRecording(browser: Browser, appPid: number, invokeFocus: () => Promise<void>): Promise<() => Promise<void>> {
  if (!recording) return async () => {};
  await stage(browser, invokeFocus);
  await injectOverlay(browser);
  const out = join(process.env.RECORD_OUT!, `${process.env.RECORD_NAME}.mov`);
  const recorder: ChildProcess = spawn(process.env.RECORDER!, ["record", String(appPid), out], { stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  recorder.stderr!.on("data", (d: Buffer) => (said += d.toString()));
  await pause(1000);
  if (recorder.exitCode !== null) throw new Error(said.trim() || `the recorder quit (exit ${recorder.exitCode})`);
  await pause(400);
  return async () => {
    await pause(1500);
    const gone = new Promise<boolean>((r) => recorder.once("exit", () => r(true)));
    recorder.kill("SIGINT");
    if (!(await Promise.race([gone, pause(20_000).then(() => false)]))) {
      recorder.kill("SIGKILL");
      throw new Error(`the recorder didn't stop within 20 s: ${said.trim()}`);
    }
    if (!said.includes("wrote")) throw new Error(`the recorder didn't finish: ${said.trim()}`);
  };
}
