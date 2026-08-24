#!/usr/bin/env node

// Fork chat interaction review driver (docs/proposals/fork-chat/README.md).
//
// Boots the production shell on the FIXTURE app-server — the same
// no-model-spend boot the interaction guard uses — over a temporary copy of
// the bridge fixture repository, and serves the fork-lineage review surfaces
// behind their ?forkFixture gate:
//
//   npm run review:fork-chat                 # boot and print the review URLs; Ctrl+C to stop
//   npm run review:fork-chat -- --captures   # regenerate docs/proposals/fork-chat/captures/*.png headlessly, then exit
//
// Captures use the guard driver's headless-Chrome approach (CDP over a fresh
// profile; a headless "new" page is a visible document, so focus, selection
// and rendering behave as in a foreground tab). Every variant is captured
// wide (1280x800) and narrow (390x844), Light and Dark, plus a keyboard-focus
// state for each direction and the Bring Back flow's two moments. Nothing
// here talks to a model, writes into this checkout, or changes the runtime:
// the fixture app-server answers every request and the browser fixture gate
// refuses sends.
//
// Exit status is non-zero when a capture cannot be produced.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridgeRepository } from "../test/fixtures/bridge-repository.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const capturesDir = join(root, "docs/proposals/fork-chat/captures");
const options = { captures: false, chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (flag === "--captures") options.captures = true;
  else if (flag === "--chrome") options.chrome = argv[++index];
  else throw new Error(`unknown flag: ${flag}`);
}

// The review variants, one per direction state the proposal shows. The
// query parameter is the entire gate: without it the shell renders none of
// the review surfaces.
// Main directions carry the full wide/narrow × Light/Dark matrix; the chip
// direction's sub-states (source side, missing source) are captured wide in
// both schemes. Keyboard-focus states are captured wide/light, where the
// focus ring reads clearest.
const VARIANTS = [
  { name: "chip", note: "Direction A · fork side: navigable source chip with derived divergence", frames: ["wide", "narrow"] },
  { name: "chip-source", note: "Direction A · source side: the chat's forks listed and openable", frames: ["wide"] },
  { name: "chip-missing", note: "Direction A · honest empty state: source not listed in this folder", frames: ["wide"] },
  { name: "sidebar", note: "Direction B · sidebar fork tree: forks indent under their listed source", frames: ["wide", "narrow"] },
  { name: "bringback", note: "Direction C · Bring Back: fork passage returns to the source composer", frames: ["wide", "narrow"] },
];

const FRAMES = {
  wide: { width: 1280, height: 800, narrow: false, mobile: false },
  narrow: { width: 390, height: 844, narrow: true, mobile: true },
};

// --- The fixture shell boot, exactly the guard driver's no-spend posture ---
async function bootShell() {
  const temp = mkdtempSync(join(tmpdir(), "vibehub-fork-review-"));
  const repo = createBridgeRepository({ prefix: "vibehub-fork-review-repo-" });
  const env = {
    ...process.env,
    CODEX_FIXTURE_VERSION: "0.149.0",
    CODEX_FIXTURE_STATE: join(temp, "codex-state.json"),
    CODEX_FIXTURE_PIDFILE: join(temp, "codex-pids"),
  };
  writeFileSync(env.CODEX_FIXTURE_STATE, `${JSON.stringify({ counter: 1, sections: [], threads: [] })}\n`);
  const codex = join(root, "test/fixtures/codex-app-server-fixture.mjs");
  const shell = spawn(process.execPath, [join(root, "scripts/vh-codex-first-shell.mjs"), "--repo", repo.folder, "--port", "0", "--json", "--codex", codex], { cwd: root, stdio: ["ignore", "pipe", "inherit"], env });
  const close = async () => {
    shell.kill("SIGTERM");
    await once(shell, "exit").catch(() => {});
    rmSync(temp, { recursive: true, force: true });
    rmSync(repo.folder, { recursive: true, force: true });
  };
  const [chunk] = await once(shell.stdout, "data");
  const envelope = JSON.parse(String(chunk));
  if (envelope.runtime.state !== "alive") {
    await close();
    throw new Error(`the shell is ${envelope.runtime.state}: ${envelope.runtime.halt?.detail ?? "no runtime"}`);
  }
  return { url: envelope.url, close };
}

function reviewUrl(shellUrl, variant, frame) {
  const url = new URL(shellUrl);
  url.searchParams.set("forkFixture", variant);
  if (frame?.narrow) url.searchParams.set("reviewFrame", "narrow");
  return url.href;
}

// --- Headless Chrome over CDP, as the guard driver drives it ---------------
async function launchChrome(viewport) {
  const profile = mkdtempSync(join(tmpdir(), "vibehub-fork-review-chrome-"));
  const child = spawn(options.chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--window-size=${viewport.width},${viewport.height}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.once("exit", (code) => reject(new Error(`chrome exited ${code}: ${stderr}`)));
    setTimeout(() => reject(new Error(`chrome did not announce DevTools: ${stderr}`)), 15_000);
  });
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: Boolean(viewport.mobile) }, sessionId);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  const evaluate = async (expression, awaitPromise = false) => (await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, sessionId)).result.value;
  return {
    evaluate,
    emulateScheme: (scheme) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, sessionId),
    navigate: (url) => send("Page.navigate", { url }, sessionId),
    // One real keyboard event, so a scripted focus that follows carries the
    // keyboard-focus heuristic and :focus-visible renders in the capture.
    pressTab: async () => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, sessionId);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, sessionId);
    },
    waitFor: (expression, timeoutMs = 20_000) => evaluate(`(async () => { const deadline = Date.now() + ${timeoutMs}; while (Date.now() < deadline) { try { const value = (${expression}); if (value) return value; } catch {} await new Promise((r) => setTimeout(r, 60)); } return null; })()`, true),
    screenshot: async (path) => {
      const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      writeFileSync(path, Buffer.from(data, "base64"));
    },
    close: () => {
      ws.close();
      child.kill("SIGKILL");
      // Chrome may still hold profile files for a moment after SIGKILL; a
      // leaked temp profile must not abort the capture run.
      try { rmSync(profile, { recursive: true, force: true }); } catch { setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* leaked temp profile */ } }, 500); }
    },
  };
}

const READY = {
  chip: `document.querySelector('#threadLineage .lineage-chip[data-open-lineage]') && document.querySelector('.turn.assistant')`,
  "chip-source": `document.querySelector('#threadLineage .fork-list .fork-row') && document.querySelector('.turn.assistant')`,
  "chip-missing": `document.querySelector('#threadLineage .lineage-chip.is-missing') && document.querySelector('.turn.assistant')`,
  sidebar: `document.querySelector('.thread-row[data-fork-depth]') && document.querySelector('.turn.assistant')`,
  bringback: `document.querySelector('.turn.assistant') && document.querySelector('[data-bring-back]')`,
};

// Select the recommendation sentence of the fork's final assistant message,
// through the same document selection a human's drag produces, so the
// selection sheet opens with the Bring Back action.
const SELECT_PASSAGE = `(() => {
  const article = [...document.querySelectorAll('.turn.assistant')].at(-1);
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  let target = null;
  while (walker.nextNode()) if (walker.currentNode.textContent.includes('Recommendation for the source chat')) { target = walker.currentNode; break; }
  if (!target) return false;
  const range = document.createRange();
  range.setStart(target, 0);
  range.setEnd(target, target.textContent.length);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
})()`;

async function captureVariant(shellUrl, variant, frameName, scheme, failures) {
  const frame = FRAMES[frameName];
  const chrome = await launchChrome(frame);
  const shot = (name) => join(capturesDir, `${name}--${frameName}-${scheme}.png`);
  try {
    await chrome.emulateScheme(scheme);
    await chrome.navigate(reviewUrl(shellUrl, variant.name, frame));
    const ready = await chrome.waitFor(READY[variant.name]);
    if (!ready) throw new Error(`review surface did not mount: ${variant.name}`);
    // The transcript scrolls to its end on open; captures show the heading,
    // so scroll the conversation surface back to the top first.
    await chrome.evaluate(`document.querySelector('#surface').scrollTop = 0`);
    await chrome.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
    await chrome.screenshot(shot(variant.name));
    console.log(`[capture] ${variant.name} ${frameName} ${scheme}`);

    // Keyboard-focus states, wide/light only: one per direction affordance.
    if (frameName === "wide" && scheme === "light") {
      const focusTarget = { chip: ".lineage-chip[data-open-lineage]", "chip-source": ".fork-list .fork-row", sidebar: `.thread-row[data-fork-depth] .thread-button` }[variant.name];
      if (focusTarget) {
        await chrome.pressTab();
        await chrome.evaluate(`document.querySelector('${focusTarget}').focus()`);
        await chrome.evaluate(`new Promise((resolve) => requestAnimationFrame(resolve))`, true);
        await chrome.screenshot(shot(`${variant.name}--keyboard-focus`));
        console.log(`[capture] ${variant.name} keyboard focus ${frameName} ${scheme}`);
      }
    }

    // The Bring Back flow's two moments, wide only: the selection sheet on
    // the fork's passage, then the source Chat's composer holding the quote
    // with the fork's exact identity.
    if (variant.name === "bringback" && frameName === "wide") {
      await chrome.evaluate(`[...document.querySelectorAll('.turn.assistant')].at(-1).scrollIntoView({ block: "center" })`);
      await chrome.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
      const selected = await chrome.evaluate(SELECT_PASSAGE);
      const sheet = selected && await chrome.waitFor(`!document.querySelector('#selectionSheet').hidden && !document.querySelector('[data-bring-back]').hidden`);
      if (!sheet) throw new Error("the selection sheet with Bring back to source did not open");
      await chrome.screenshot(shot("bringback--selection"));
      console.log(`[capture] bringback selection ${frameName} ${scheme}`);
      await chrome.evaluate(`document.querySelector('[data-bring-back]').click()`);
      const landed = await chrome.waitFor(`!document.querySelector('#quoteTray').hidden && document.querySelector('#quoteTray .quote-source')?.textContent.includes('Brought back from fork') && document.querySelector('#activeThreadTitle')?.textContent === 'Harden login retry backoff'`);
      if (!landed) throw new Error("the brought-back quote did not land in the source composer");
      await chrome.screenshot(shot("bringback--landed"));
      console.log(`[capture] bringback landed ${frameName} ${scheme}`);
    }
  } catch (error) {
    failures.push(`${variant.name} ${frameName} ${scheme}: ${error.message}`);
    console.error(`[capture] FAIL ${variant.name} ${frameName} ${scheme}: ${error.message}`);
  } finally {
    chrome.close();
  }
}

const shell = await bootShell();
process.on("SIGINT", async () => { await shell.close(); process.exit(0); });
try {
  if (!options.captures) {
    console.log("Fork chat review surfaces (fixture app-server, no model spend; sends are refused):\n");
    for (const variant of VARIANTS) {
      console.log(`  ${variant.note}`);
      console.log(`    ${reviewUrl(shell.url, variant.name)}\n`);
    }
    console.log("Narrow frame: add reviewFrame=narrow to the query (before the # token) · Theme: the shell's Appearance toggle or the OS scheme.");
    console.log("Ctrl+C stops the shell.");
    await new Promise(() => {});
  }
  if (!existsSync(options.chrome)) throw new Error(`Chrome binary not found: ${options.chrome} (pass --chrome)`);
  mkdirSync(capturesDir, { recursive: true });
  const failures = [];
  for (const variant of VARIANTS) {
    for (const frameName of variant.frames) {
      for (const scheme of ["light", "dark"]) {
        await captureVariant(shell.url, variant, frameName, scheme, failures);
      }
    }
  }
  if (failures.length) {
    console.error(`\n${failures.length} capture(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll captures written to ${capturesDir}`);
  }
} finally {
  await shell.close();
}
