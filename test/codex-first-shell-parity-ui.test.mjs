// Static pins for the daily-use parity surfaces of the production shell's
// browser side: the Composer codes against the checked-in host contract
// verbatim, invents no option, value or posture, and persists nothing in the
// browser. Behaviour is proven by test/codex-chat-conformance.test.mjs (pure
// modules) and the browser interaction guard; this file pins the source.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

async function shellSources() {
  const [html, script, css, renderer, host, contractText, guard] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/app.css"),
    source("apps/codex-first-shell/chat-renderer.mjs"),
    source("scripts/vh-codex-first-shell.mjs"),
    source("docs/proposals/codex-chat-conformance/daily-use-host-contract.json"),
    source("apps/codex-first-shell/browser-interaction-guard.mjs"),
  ]);
  return { html, script, css, renderer, host, contract: JSON.parse(contractText), guard };
}

// Every `action: "<name>"` the browser dispatches through the host transport,
// plus the names the Composer's dispatch ternary chooses between.
function dispatchedActions(script) {
  const literal = [...script.matchAll(/action: "([a-zA-Z]+)"/g)].map((match) => match[1]);
  const ternary = [...(script.match(/const dispatch = [^;]+;/)?.[0] ?? "").matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]);
  return [...new Set([...literal, ...ternary])].sort();
}

test("every host action the browser dispatches exists in the host and the daily-use ones match the contract", async () => {
  const { script, host, contract } = await shellSources();
  const dispatched = dispatchedActions(script);
  assert.ok(dispatched.length > 20, `dispatched actions: ${dispatched.join(",")}`);
  for (const name of dispatched) assert.match(host, new RegExp(`payload\\.action === "${name}"`), `${name} is a host action`);
  for (const name of ["listModels", "readThread", "startTurn", "steerTurn", "queueTurn", "listQueue", "updateQueued", "deleteQueued", "resumeQueue", "steerQueued", "interruptTurn"]) {
    assert.ok(Object.hasOwn(contract.actions, name), `${name} is in the contract`);
    assert.ok(dispatched.includes(name), `the browser dispatches ${name}`);
  }
  // Experimental seams stay out of the browser as they stay out of the host.
  assert.doesNotMatch(script, /thread\/queue\/|collaborationMode|permissionProfile/);
});

test("model and effort pickers carry no option string in source and code against the host contract verbatim", async () => {
  const { html, script, contract } = await shellSources();
  // In source each picker is disabled with exactly one not-loaded placeholder.
  for (const id of ["modelPicker", "effortPicker"]) {
    const select = html.match(new RegExp(`<select id="${id}"[^>]*>([^]*?)</select>`));
    assert.ok(select, `${id} exists`);
    assert.match(select[0], /^<select id="[a-zA-Z]+" disabled aria-describedby="settingsSource">/);
    assert.equal(select[1], '<option value="">Not loaded</option>', `${id} carries only the not-loaded placeholder`);
  }
  // Options are built from the listModels response alone: the displayName
  // label and the Model.model slug (never the id), efforts from the selected
  // model's supportedReasoningEfforts, defaults marked from the record.
  assert.match(script, /const modelOptions = state\.models\.map\(\(entry\) => \(\{ label: modelOptionLabel\(entry\), value: entry\.model, title: entry\.description \?\? "" \}\)\);/);
  assert.match(script, /\(model\.model\?\.supportedReasoningEfforts \?\? \[\]\)\.map\(\(option\) => \(\{ label: effortOptionLabel\(option, model\.model\), value: option\.reasoningEffort/);
  assert.doesNotMatch(script, /value: entry\.id\b/, "the picker never sends Model.id");
  assert.doesNotMatch(script, /new Option\("/, "no option label is a literal in source");
  for (const literal of ["minimal", "low", "medium", "high", "xhigh", "gpt-", "o3", "o4-mini", "codex-mini"]) {
    assert.doesNotMatch(script + html, new RegExp(`["'\`]${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`, "i"), `no ${literal} option string in source`);
  }
  assert.match(contract.actions.listModels.rules, /send Model\.model back as turnSettings\.model/);
  // The current value is the Thread's settings record; null shows the
  // default without claiming it is set; the overrides travel as settings.
  assert.match(script, /const record = threadSettingsRecord\(state\.activeThreadId\);\s*const overrides = overridesFor\(\);\s*const model = selectedModel\(state\.models, record, overrides\);/);
  assert.match(script, /"Not reported for this Chat yet; showing the runtime default"/);
  assert.match(script, /const settings = steer \? undefined : pendingTurnSettings\(threadId\);/);
  assert.match(script, /\.\.\.\(settings \? \{ settings \} : \{\}\)/);
  assert.match(script, /if \(result\.settings\) rememberSettingsRecord\(threadId, result\.settings\);/);
  assert.match(script, /const refusal = imageRefusal\(nextTurnModel\(\)\);/);
  // thread/settings/updated for any Thread becomes the record; the Turn
  // posture line is claimed only for Turns this session started.
  assert.match(script, /if \(method === "thread\/settings\/updated" \|\| method === "thread\/tokenUsage\/updated"\) \{\s*applyChatEvent\(state, method, params\);/);
  assert.match(script, /function turnPostureMarkup\(turnId\) \{\s*const turn = state\.turnSettings\.get\(turnId\);/);
  assert.match(contract.bootstrap["threads[].settings"], /^null until the runtime reported this Thread's settings/);
  assert.doesNotMatch(html + script, /localStorage|sessionStorage|indexedDB|document\.cookie/i);
});

test("images paste and drop into the Composer as data-URL image inputs, never localImage", async () => {
  const { html, script, contract } = await shellSources();
  assert.match(html, /<input id="attachmentInput" type="file" accept="image\/\*,audio\/\*" multiple hidden>/, "the plus picker stays and takes several files");
  assert.match(script, /\$\("#composerInput"\)\.addEventListener\("paste", async \(event\) => \{\s*const images = imageFilesFrom\(event\.clipboardData\);/);
  assert.match(script, /composerForm\.addEventListener\("drop", async \(event\) => \{[^]*?const images = imageFilesFrom\(event\.dataTransfer\);/);
  assert.match(script, /composerForm\.addEventListener\("dragover"/);
  assert.match(script, /await addAttachmentFiles\(images\);/);
  assert.match(script, /input\.push\(\.\.\.state\.attachments\.map\(\(\{ type, url \}\) => \(\{ type, url \}\)\)\);/, "every attachment travels as its variant with the data URL");
  assert.doesNotMatch(script, /localImage|localAudio/, "a browser File carries no filesystem path");
  assert.match(contract.inputs.never, /localImage and localAudio are never produced/);
  assert.match(script, /if \(file\.size > MAX_ATTACHMENT_BYTES\)/, "the byte bound is applied before a file is read");
});

test("the context indicator reads thread/tokenUsage/updated only and Compact calls compactThread when no Turn is live", async () => {
  const { script, contract } = await shellSources();
  assert.match(script, /const usage = contextUsage\(threadTokenUsage\(state, state\.activeThreadId\)\);/);
  assert.match(script, /const meter = usage\.state === "known" \? `<span class="context-meter" role="img"/, "a meter only when the runtime reported a window");
  assert.match(script, /fill\.style\.width = `\$\{Math\.min\(100, Math\.max\(0, usage\.percent\)\)\}%`;/, "the CSP forbids inline style attributes; the fill is set through the CSSOM");
  assert.match(script, /const result = await action\(\{ action: "compactThread", threadId \}\);/);
  assert.match(script, /error\.code === "turn_live"/, "the host's 409 turn_live refusal is shown as its own message");
  assert.match(script, /compactDisabledReason\(\{ running: state\.running, fixture: state\.fixtureMode, runtimeAlive/);
  assert.match(script, /if \(item\.type === "contextCompaction"\) return `<div class="turn-boundary compacted" data-context-compaction=/, "the contextCompaction item is a boundary row");
  assert.doesNotMatch(script, /thread\/compacted/, "the browser waits for no thread/compacted: the item is the signal");
  assert.match(contract.forwardedNotifications["thread/tokenUsage/updated"], /show no value before the first one and no percentage while modelContextWindow is null/);
  assert.match(contract.actions.compactThread.rules, /409 turn_live/);
});

test("@ and $ mentions are picked from searchFiles and listSkills and sent as text_elements with mention and skill items", async () => {
  const { html, script, renderer, contract } = await shellSources();
  assert.match(html, /<div class="mention-picker" id="mentionPicker" role="listbox" aria-label="Mention suggestions" hidden><\/div>/);
  assert.match(html, /<textarea id="composerInput"[^>]*aria-autocomplete="list" aria-controls="mentionPicker" aria-expanded="false">/);
  // The pickers are fed by the host alone and never invent an entry.
  assert.match(script, /action: "searchFiles", query: trigger\.query, limit: MENTION_RESULT_LIMIT/);
  assert.match(script, /const data = await action\(\{ action: "listSkills" \}\);/);
  assert.match(script, /name: file\.file_name \?\? file\.path\.split\("\/"\)\.pop\(\),\s*path: file\.absolutePath \?\? file\.path,/, "a mention's name and path are searchFiles' file_name and absolutePath");
  assert.match(script, /\{ kind: "skill", name: skill\.name, path: skill\.path,/, "a skill's name and path are listSkills' own");
  assert.match(script, /\.filter\(\(skill\) => skill\.enabled !== false/, "disabled skills are not offered");
  // Keyboard paths: arrows move, Enter/Tab insert, Escape closes in place.
  assert.match(script, /if \(event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"\) \{ event\.preventDefault\(\); moveMentionSelection/);
  assert.match(script, /if \(event\.key === "Escape"\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); closeMentionPicker\(\); return; \}/);
  // Send: one text_elements entry and one item per chip; byte spans from TextEncoder.
  assert.match(script, /const \{ elements, items \} = composeTextElements\(composedText, state\.mentions\);/);
  assert.match(script, /input\.push\(elements\.length \? \{ type: "text", text: composedText, text_elements: elements \} : \{ type: "text", text: composedText \}\);/);
  assert.match(script, /input\.push\(\.\.\.items\);/);
  assert.match(script, /if \(input\.length > INPUT_ITEM_LIMIT\) return notify/);
  assert.match(script, /const INPUT_ITEM_LIMIT = 16;/);
  assert.match(contract.inputs.bound, /^1 to 16 items per Turn/);
  const mentions = await source("apps/codex-first-shell/composer-mentions.mjs");
  assert.match(mentions, /const encoder = new TextEncoder\(\);/);
  assert.match(mentions, /return \{ byteRange: \{ start, end: start \+ byteLength\(placeholder\) \}, placeholder \};/);
  assert.match(contract.inputs.variants.text, /byteRange is a UTF-8 byte span inside text/);
  // Replay: placeholders become chips inside the Markdown; items are not repeated.
  assert.match(renderer, /export function renderUserMessageText\(text, budget = createRenderBudget\(\), \{ currentThreadId = null, textElements = null \} = \{\}\)/);
  assert.match(script, /renderUserMedia\(item\.content, budget, \{ inlineMentions \}\)/);
});
