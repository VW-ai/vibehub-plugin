import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyChatEvent, applyHostEvent, applyTokenUsage, boundedText, canonicalTimeline, itemKey, LIVE_ITEM_LIMIT, rememberQueue, rememberThreadSettings, settingsRecordFromNotification, threadQueue, threadSettings, threadTokenUsage, timelineWindow } from "../apps/codex-first-shell/chat-model.mjs";
import { compactDisabledReason, contextUsage } from "../apps/codex-first-shell/context-usage.mjs";
import { renameThreadRecord, threadTitleFromName } from "../apps/codex-first-shell/thread-name.mjs";
import { describePosture, describeTurnSettings, effortOptionLabel, imageRefusal, modelOptionLabel, pendingOverrides, POSTURE_LABELS, POSTURES, postureOf, selectedEffort, selectedModel } from "../apps/codex-first-shell/composer-settings.mjs";
import { mergeQueueRecord, pausedMessage, QUEUE_PAUSE_MESSAGES, queuedMediaSummary, queuedText, replaceQueuedText } from "../apps/codex-first-shell/composer-queue.mjs";
import { loadThreadDraft, MAX_DRAFT_ATTACHMENTS, MAX_DRAFT_THREADS, saveThreadDraft } from "../apps/codex-first-shell/composer-drafts.mjs";
import { acceptAttachment, attachmentName, imageFilesFrom, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, renderAttachmentChips } from "../apps/codex-first-shell/composer-attachments.mjs";
import { activeTrigger, byteLength, chipsFromItems, composeTextElements, insertPlaceholder, MENTION_TRIGGERS, parseTextElements, placeholderFor, removePlaceholder } from "../apps/codex-first-shell/composer-mentions.mjs";
import { clampComposerHeight, composerBounds, COMPOSER_HEIGHT_FALLBACK } from "../apps/codex-first-shell/composer-sizing.mjs";
import {
  createRenderBudget,
  renderAgentMessage,
  renderGeneratedImage,
  renderMarkdown,
  renderMemoryCitations,
  renderTimelineOmission,
  renderToolContent,
  renderUserMedia,
  renderUserMessageText,
} from "../apps/codex-first-shell/chat-renderer.mjs";
import { eventWindow } from "../apps/codex-first-shell/event-window.mjs";
import { threadLocation } from "../apps/codex-first-shell/thread-location.mjs";
import { answersFromDraft, loadRequestDraft, MAX_REQUEST_DRAFTS, pruneRequestDrafts, saveRequestDraft } from "../apps/codex-first-shell/request-drafts.mjs";
import { composeQuotedMessage, parseQuotedMessage } from "../apps/codex-first-shell/quote-source.mjs";
import { planTimelineReconciliation } from "../apps/codex-first-shell/timeline-reconcile.mjs";
import { requestDescriptor, unsupportedServerRequestResult, validateRequestDecision } from "../apps/codex-first-shell/server-request-registry.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("checked-in protocol census classifies every pinned required event", async () => {
  const [lock, census, fixture] = await Promise.all([
    source("packages/codex-adapter/upstream-lock.json").then(JSON.parse),
    source("docs/proposals/codex-chat-conformance/protocol-event-census.json").then(JSON.parse),
    source("apps/codex-first-shell/chat-fixtures.json").then(JSON.parse),
  ]);
  assert.equal(census.baseline.protocolSchemaSha256, lock.codex.protocolSchemaSha256);
  for (const method of lock.requiredNotifications) assert.ok(census.notifications[method], `missing notification classification: ${method}`);
  for (const method of lock.requiredServerRequests) assert.ok(census.serverRequests[method], `missing server-request classification: ${method}`);
  const delegated = fixture.thread.turns.flatMap((turn) => turn.items).find((item) => item.type === "subAgentActivity");
  assert.ok(["started", "interacted", "interrupted"].includes(delegated.kind));
});

test("Codex Chat reducer shares stable identity across replay, deltas, completion, and interruption", async () => {
  const fixture = JSON.parse(await source("apps/codex-first-shell/chat-conformance-fixtures.json"));
  const model = { liveItems: new Map(), turnErrors: new Map() };
  for (const event of fixture.events) assert.equal(applyChatEvent(model, event.method, event.params), true);
  const timeline = canonicalTimeline(fixture.thread, model);
  assert.equal(timeline.filter((item) => item.id === "agent-shared").length, 1, "durable replay must hide a duplicate live item");
  assert.equal(timeline.find((item) => item.id === "agent-shared").text, "Durable completed answer.");
  assert.equal(timeline.find((item) => item.id === "agent-live").text, "Authoritative completed answer.");
  assert.equal(timeline.find((item) => item.id === "tool-live").progress, "Loading page");
  assert.equal(timeline.find((item) => item.type === "turnPlan").plan[1].status, "inProgress");
  assert.match(timeline.find((item) => item.type === "turnDiff").diff, /\+new/);
  assert.equal(timeline.find((item) => item.id === "files-live").output, "Patch applied");
  assert.equal(timeline.filter((item) => item.id === "boundary-turn-interrupted").length, 1);
  assert.equal(timeline.filter((item) => item.id === "error-turn-live").length, 1);
});

test("completed items replace deltas authoritatively and unknown events remain non-mutating", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  applyChatEvent(model, "item/agentMessage/delta", { turnId: "turn", itemId: "answer", delta: "stale" });
  applyChatEvent(model, "item/completed", { turnId: "turn", item: { id: "answer", type: "agentMessage", text: "settled" } });
  const key = itemKey(undefined, "turn", "answer");
  assert.equal(model.liveItems.get(key).text, "settled");
  assert.equal(model.liveItems.get(key)._live, false);
  const size = model.liveItems.size;
  assert.equal(applyChatEvent(model, "item/future/delta", { turnId: "turn", itemId: "future", delta: "raw" }), false);
  assert.equal(model.liveItems.size, size);
});

test("composite identity isolates colliding item ids across Threads and Turns", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  applyChatEvent(model, "item/agentMessage/delta", { threadId: "thread-a", turnId: "turn-a", itemId: "same", delta: "A" });
  applyChatEvent(model, "item/agentMessage/delta", { threadId: "thread-b", turnId: "turn-b", itemId: "same", delta: "B" });
  assert.equal(model.liveItems.size, 2);
  assert.equal(canonicalTimeline({ id: "thread-a", turns: [] }, model)[0].text, "A");
  assert.equal(canonicalTimeline({ id: "thread-b", turns: [] }, model)[0].text, "B");
  assert.notEqual(itemKey("thread-a", "turn-a", "same"), itemKey("thread-b", "turn-b", "same"));
});

test("execution, tool and delegated identities cannot cross Threads or Turns", () => {
  for (const type of ["commandExecution", "mcpToolCall", "collabAgentToolCall"]) {
    const model = { liveItems: new Map(), turnErrors: new Map() };
    applyChatEvent(model, "item/started", { threadId: "thread-a", turnId: "turn-a", item: { id: "same", type, status: "inProgress" } });
    applyChatEvent(model, "item/started", { threadId: "thread-b", turnId: "turn-b", item: { id: "same", type, status: "inProgress" } });
    assert.equal(canonicalTimeline({ id: "thread-a", turns: [] }, model).length, 1);
    assert.equal(canonicalTimeline({ id: "thread-b", turns: [] }, model).length, 1);
    assert.notEqual(canonicalTimeline({ id: "thread-a", turns: [] }, model)[0]._key, canonicalTimeline({ id: "thread-b", turns: [] }, model)[0]._key);
  }
});

test("authoritative Turn completion retires retry, plan, diff and live execution state", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  applyChatEvent(model, "error", { threadId: "thread", turnId: "turn", error: { message: "retry" }, willRetry: true });
  applyChatEvent(model, "turn/plan/updated", { threadId: "thread", turnId: "turn", plan: [{ step: "Retry", status: "inProgress" }] });
  applyChatEvent(model, "turn/diff/updated", { threadId: "thread", turnId: "turn", diff: "stale" });
  applyChatEvent(model, "item/started", { threadId: "thread", turnId: "turn", item: { id: "command", type: "commandExecution", status: "inProgress" } });
  applyChatEvent(model, "turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
  assert.equal(canonicalTimeline({ id: "thread", turns: [{ id: "turn", status: "completed", items: [] }] }, model).length, 0);
  applyChatEvent(model, "error", { threadId: "thread", turnId: "failed", error: { message: "terminal" }, willRetry: false });
  const failed = canonicalTimeline({ id: "thread", turns: [{ id: "failed", status: "failed", error: { message: "terminal" }, items: [] }] }, model);
  assert.deepEqual(failed.map((item) => item.type), ["turnBoundary"]);
});

test("a runtime exit ends every live claim for the Turn and leaves a boundary until replay settles it", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  applyChatEvent(model, "item/started", { threadId: "thread", turnId: "turn", item: { id: "command", type: "commandExecution", status: "inProgress" } });
  applyChatEvent(model, "item/agentMessage/delta", { threadId: "thread", turnId: "turn", itemId: "answer", delta: "partial" });
  applyChatEvent(model, "turn/plan/updated", { threadId: "thread", turnId: "turn", plan: [{ step: "Plan", status: "inProgress" }] });
  assert.equal(applyChatEvent(model, "runtime/exited", { threadId: "thread", turnId: "turn", generation: 1 }), true);
  // The orphaned Turn replays exactly as the app-server persisted it: still
  // inProgress on a Thread that is no longer active. Nothing streamed survives,
  // the boundary names the exit, and no entry claims to be live.
  const orphaned = canonicalTimeline({ id: "thread", status: { type: "notLoaded" }, turns: [{ id: "turn", status: "inProgress", items: [{ id: "user", type: "userMessage", content: [{ type: "text", text: "keep running" }] }] }] }, model);
  assert.deepEqual(orphaned.map((item) => [item.type, item._live]), [["userMessage", false], ["turnBoundary", false]]);
  assert.equal(orphaned.at(-1).status, "runtimeExited");
  assert.match(orphaned.at(-1).message, /app-server exited \(process generation 1\)/);
  assert.equal(model.liveItems.size, 0);
  assert.equal(model.turnPlans.size, 0);
  // Once replay marks the Turn terminal on its own, the boundary yields to the
  // authoritative record.
  const settled = canonicalTimeline({ id: "thread", status: { type: "idle" }, turns: [{ id: "turn", status: "interrupted", items: [] }] }, model);
  assert.deepEqual(settled.map((item) => item.status), ["interrupted"]);
  // A later Turn of the same Thread is untouched by the old boundary.
  const next = canonicalTimeline({ id: "thread", status: { type: "active" }, turns: [{ id: "turn", status: "interrupted", items: [] }, { id: "turn-2", status: "inProgress", items: [] }] }, model);
  assert.deepEqual(next.map((item) => item._turnId), ["turn"]);
});

test("live reducer memory is bounded before authoritative completion", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  for (let index = 0; index < LIVE_ITEM_LIMIT + 20; index += 1) {
    applyChatEvent(model, "item/started", { threadId: "thread", turnId: "turn", item: { id: `item-${index}`, type: "commandExecution", status: "inProgress" } });
  }
  assert.equal(model.liveItems.size, LIVE_ITEM_LIMIT);
  applyChatEvent(model, "item/agentMessage/delta", { threadId: "thread", turnId: "large", itemId: "answer", delta: "x".repeat(100_000) });
  assert.equal(model.liveItems.get(itemKey("thread", "large", "answer")).text.length, 32_000);
  assert.equal(model.liveItems.get(itemKey("thread", "large", "answer"))._omittedCharacters, 68_000);
  applyChatEvent(model, "item/fileChange/patchUpdated", { threadId: "thread", turnId: "large", itemId: "files", changes: Array.from({ length: 80 }, (_, index) => ({ path: `file-${index}`, diff: "d".repeat(40_000) })) });
  const files = model.liveItems.get(itemKey("thread", "large", "files"));
  assert.equal(files.changes.length, 32);
  assert.equal(files.changes[0].diff.length, 20_000);
});

test("the host-owned follow-up queue mirrors queueChanged, queuedStarted and queuedFailed without inventing state", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  const image = { type: "image", url: "data:image/png;base64,AA==" };
  const full = { threadId: "thread-q", paused: false, pausedReason: null, lastError: null, limit: 20, items: [{ queuedId: "queued-1", queuedAt: "2026-08-22T00:00:00.000Z", settings: { effort: "low" }, starting: false, input: [{ type: "text", text: "A" }, image] }] };
  assert.equal(rememberQueue(model, full), full);
  assert.equal(threadQueue(model, "thread-q"), full);
  assert.equal(threadQueue(model, "elsewhere"), null);
  // The event feed elides media; the mirror keeps the bytes a full read carried.
  const elided = { ...full, items: [{ ...full.items[0], input: [{ type: "text", text: "A" }, { type: "image", elided: true, byteLength: 26 }] }, { queuedId: "queued-2", queuedAt: "2026-08-22T00:00:01.000Z", settings: null, starting: false, input: [{ type: "text", text: "B" }] }] };
  const changed = applyHostEvent(model, "queueChanged", { threadId: "thread-q", queue: elided });
  assert.equal(changed.kind, "queueChanged");
  assert.deepEqual(changed.queue.items.map((item) => item.input), [[{ type: "text", text: "A" }, image], [{ type: "text", text: "B" }]]);
  assert.deepEqual(mergeQueueRecord(null, elided).items[0].input[1], { type: "image", elided: true, byteLength: 26 }, "without a prior full read the elided entry stays elided");
  assert.equal(mergeQueueRecord(full, null), full);
  // queuedStarted names the follow-up that became its own Turn; the item is
  // still in the mirror at that moment so the Turn can be attributed its settings.
  const started = applyHostEvent(model, "queuedStarted", { threadId: "thread-q", queuedId: "queued-1", turnId: "turn-minted" });
  assert.deepEqual([started.kind, started.turnId, started.item?.queuedId, started.item?.settings], ["queuedStarted", "turn-minted", "queued-1", { effort: "low" }]);
  assert.deepEqual(applyHostEvent(model, "queuedFailed", { threadId: "thread-q", queuedId: "queued-1", error: "refused" }), { kind: "queuedFailed", threadId: "thread-q", queuedId: "queued-1", error: "refused" });
  // Records without a Thread, unknown kinds and malformed queues change nothing.
  assert.equal(applyHostEvent(model, "queueChanged", { queue: full }), null);
  assert.equal(applyHostEvent(model, "queueChanged", { threadId: "thread-q", queue: "nope" }), null);
  assert.equal(applyHostEvent(model, "somethingElse", { threadId: "thread-q" }), null);
  assert.equal(threadQueue(model, "thread-q").items.length, 2);
  for (let index = 0; index < 70; index += 1) rememberQueue(model, { ...full, threadId: `thread-${index}` });
  assert.equal(threadQueue(model, "thread-q"), null, "the mirror is bounded");
  // Paused copy comes from the host's pausedReason alone.
  assert.equal(pausedMessage({ paused: true, pausedReason: "interrupted" }), "Queue paused because you interrupted. Nothing is sent until you resume.");
  assert.equal(pausedMessage({ paused: true, pausedReason: "start_failed", lastError: { message: "Unknown thread" } }), "Queue paused because the next follow-up could not start. Unknown thread Nothing is sent until you resume.");
  assert.match(pausedMessage({ paused: true, pausedReason: "later_reason" }), /^Queue paused \(later_reason\)\./);
  assert.equal(pausedMessage({ paused: false }), "");
  assert.deepEqual(Object.keys(QUEUE_PAUSE_MESSAGES), ["interrupted", "turn_failed", "runtime_exited", "start_failed"]);
  // An inline edit replaces the text input only; stale byte ranges never survive it.
  assert.deepEqual(replaceQueuedText([{ type: "text", text: "old", text_elements: [{ byteRange: { start: 0, end: 3 } }] }, { type: "mention", name: "x", path: "/x" }], "new"), [{ type: "text", text: "new" }, { type: "mention", name: "x", path: "/x" }]);
  assert.deepEqual(replaceQueuedText([{ type: "text", text: "new" }], "new @x", [{ byteRange: { start: 4, end: 6 }, placeholder: "@x" }]), [{ type: "text", text: "new @x", text_elements: [{ byteRange: { start: 4, end: 6 }, placeholder: "@x" }] }]);
  assert.deepEqual(replaceQueuedText([image], "   "), [image]);
  assert.deepEqual([queuedText(full.items[0]), queuedMediaSummary(full.items[0]), queuedMediaSummary({ input: [image, image, { type: "skill", name: "s", path: "/s" }] })], ["A", "1 image", "2 images · 1 skill"]);
});

test("Thread settings follow the host record and thread/settings/updated, and the pickers never invent a value", async () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  assert.equal(threadSettings(model, "thread-s"), null, "null until the runtime reported settings");
  // The forwarded notification carries effort (not reasoningEffort) and becomes a record with its source.
  assert.equal(applyChatEvent(model, "thread/settings/updated", { threadId: "thread-s", threadSettings: { model: "fixture-text", effort: "high", approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, cwd: "/x" } }), true);
  const record = threadSettings(model, "thread-s");
  assert.deepEqual([record.model, record.effort, record.approvalPolicy, record.sandboxPolicy.type, record.source], ["fixture-text", "high", "on-request", "workspaceWrite", "thread/settings/updated"]);
  assert.match(record.observedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(applyChatEvent(model, "thread/settings/updated", { threadId: "thread-s" }), false, "a notification without threadSettings changes nothing");
  assert.equal(settingsRecordFromNotification({ threadSettings: {} }), null);
  assert.equal(rememberThreadSettings(model, "", record), false);
  const contract = JSON.parse(await source("docs/proposals/codex-chat-conformance/daily-use-host-contract.json"));
  assert.deepEqual(POSTURES, contract.turnSettings.posture, "the two postures are the host contract's exact turn/start keys");
  assert.deepEqual(POSTURE_LABELS, { askForApproval: "Ask for approval", fullAccess: "Full access" });
  assert.equal(postureOf(record), "askForApproval");
  assert.equal(postureOf({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }), "fullAccess");
  assert.equal(postureOf({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } }), "other");
  assert.equal(postureOf(null), null);
  assert.equal(postureOf({ model: "x" }), null);
  assert.deepEqual([describePosture(null), describePosture(record), describePosture({ approvalPolicy: "untrusted" })], ["not reported yet", "on-request · workspaceWrite", "untrusted · sandbox not reported"]);

  const models = [
    { id: "d", model: "fixture-default", displayName: "Fixture Default", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }], inputModalities: ["text", "image"] },
    { id: "t", model: "fixture-text", displayName: "Fixture Text Only", isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], inputModalities: ["text"] },
  ];
  // Not loaded: no model, whatever the record says.
  assert.deepEqual(selectedModel(null, record, {}), { model: null, slug: "fixture-text", source: "not-loaded" });
  // Loaded, no record: the default is shown as a default, never as set.
  assert.deepEqual(selectedModel(models, null, {}), { model: models[0], slug: "fixture-default", source: "default" });
  assert.deepEqual(selectedEffort(models[0], null, {}, "fixture-default"), { effort: "medium", source: "default" });
  // The record names the current value; the record's effort applies to the record's model only.
  assert.deepEqual(selectedModel(models, record, {}), { model: models[1], slug: "fixture-text", source: "record" });
  assert.deepEqual(selectedEffort(models[1], record, {}, "fixture-text"), { effort: "high", source: "record" });
  assert.deepEqual(selectedEffort(models[0], record, {}, "fixture-default"), { effort: "medium", source: "default" }, "another model takes its own default effort");
  // A record naming an unlisted model is shown as reported, not replaced.
  assert.deepEqual(selectedModel(models, { model: "unlisted" }, {}), { model: null, slug: "unlisted", source: "record" });
  // Overrides win, and only overrides that differ from the record travel.
  assert.deepEqual(selectedModel(models, record, { model: "fixture-default" }), { model: models[0], slug: "fixture-default", source: "override" });
  assert.deepEqual(selectedEffort(models[0], record, { effort: "low" }, "fixture-default"), { effort: "low", source: "override" });
  assert.deepEqual(selectedEffort(models[1], record, { effort: "xhigh" }, "fixture-text"), { effort: "high", source: "record" }, "an override the model does not support is ignored");
  assert.equal(pendingOverrides(record, { model: "fixture-text", effort: "high" }), null, "equal to the record: nothing to send");
  assert.deepEqual(pendingOverrides(record, { model: "fixture-default", effort: "high" }), { model: "fixture-default" });
  assert.deepEqual(pendingOverrides(null, { model: "fixture-default", effort: "low" }), { model: "fixture-default", effort: "low" });
  assert.deepEqual(pendingOverrides(record, POSTURES.fullAccess), { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  assert.equal(pendingOverrides(record, POSTURES.askForApproval), null, "the reported posture already is Ask for approval");
  assert.deepEqual(pendingOverrides({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } }, POSTURES.askForApproval), { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } }, "a posture is one unit");
  assert.equal(pendingOverrides(record, {}), null);
  // Labels mark the defaults; the image refusal names the model and its modalities.
  assert.deepEqual(models.map(modelOptionLabel), ["Fixture Default (default)", "Fixture Text Only"]);
  assert.deepEqual(models[0].supportedReasoningEfforts.map((option) => effortOptionLabel(option, models[0])), ["low", "medium (default)", "high"]);
  assert.equal(imageRefusal(models[0]), null);
  assert.equal(imageRefusal(models[1]), "Fixture Text Only accepts: text");
  assert.equal(imageRefusal({ model: "bare", displayName: "Bare", inputModalities: [] }), "Bare accepts: no reported input modality");
  assert.equal(imageRefusal(null), null, "no model record, no refusal");
  assert.equal(describeTurnSettings({ model: "fixture-text", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }, models), "Fixture Text Only · high · never · dangerFullAccess");
  assert.equal(describeTurnSettings({ model: "unlisted" }, models), "unlisted");
  assert.equal(describeTurnSettings({}, models), null);
});

test("pasted and dropped images attach as bounded data-URL inputs with removable, accessibly named chips", () => {
  const file = (name, type, size = 8) => ({ name, type, size });
  // A paste or drop carries files, or file items as a fallback; only images count.
  assert.deepEqual(imageFilesFrom({ files: [file("a.png", "image/png"), file("notes.txt", "text/plain"), file("b.webp", "image/webp")] }).map((entry) => entry.name), ["a.png", "b.webp"]);
  assert.deepEqual(imageFilesFrom({ files: [], items: [{ kind: "string" }, { kind: "file", getAsFile: () => file("", "image/png") }, { kind: "file", getAsFile: () => null }] }).map((entry) => entry.type), ["image/png"]);
  assert.deepEqual(imageFilesFrom(null), []);
  assert.equal(attachmentName(file("", "image/png"), 2), "Pasted image 3.png");
  assert.equal(attachmentName(file("shot.png", "image/png")), "shot.png");
  assert.equal(attachmentName(file("", "audio/webm")), "Voice recording");
  // Several images travel in one Turn, up to the count bound; every refusal is named.
  let attachments = [];
  for (let index = 0; index < MAX_ATTACHMENTS; index += 1) {
    const accepted = acceptAttachment(attachments, { file: file(`${index}.png`, "image/png"), url: "data:image/png;base64,AA==" });
    assert.equal(accepted.refused, null);
    attachments = accepted.attachments;
  }
  assert.equal(attachments.length, MAX_ATTACHMENTS);
  assert.equal(MAX_DRAFT_ATTACHMENTS, MAX_ATTACHMENTS, "Thread drafts keep the same bound");
  assert.match(acceptAttachment(attachments, { file: file("more.png", "image/png"), url: "data:image/png;base64,AA==" }).refused, /At most 6 attachments/);
  assert.match(acceptAttachment([], { file: file("big.png", "image/png", MAX_ATTACHMENT_BYTES + 1), url: "data:image/png;base64,AA==" }).refused, /big\.png is larger than the 8 MiB attachment limit/);
  assert.match(acceptAttachment([], { file: file("x.png", "image/png"), url: "https://example.com/x.png" }).refused, /data URL/);
  assert.deepEqual(acceptAttachment([], { file: file("clip.webm", "audio/webm"), url: "data:audio/webm;base64,AA==" }).attachments, [{ type: "audio", url: "data:audio/webm;base64,AA==", name: "clip.webm" }]);
  // Chips: a group named for the attachment, a thumbnail for images, a remove button named for the file.
  const chips = renderAttachmentChips([{ type: "image", url: "data:image/png;base64,AA==", name: "shot.png" }, { type: "audio", url: "data:audio/webm;base64,AA==", name: "clip.webm" }]);
  assert.match(chips, /<span class="attachment-chip" role="group" data-attachment-index="0" data-attachment-type="image" aria-label="Attached image shot\.png"><img src="data:image\/png;base64,AA==" alt=""><span>shot\.png<\/span><button type="button" data-remove-attachment="0" aria-label="Remove shot\.png">×<\/button><\/span>/);
  assert.match(chips, /data-attachment-index="1" data-attachment-type="audio" aria-label="Attached audio clip\.webm"><i aria-hidden="true">◉<\/i>/);
  assert.match(renderAttachmentChips([{ type: "image", url: "data:image/png;base64,AA==", name: '<img src=x onerror="1">' }]), /aria-label="Attached image &lt;img src=x onerror=&quot;1&quot;&gt;"/);
  // After send the image variant renders as an image in the user message; several may.
  const rendered = renderUserMedia([{ type: "image", url: "data:image/png;base64,AA==" }, { type: "image", url: "data:image/webp;base64,AA==" }, { type: "text", text: "ignored" }]);
  assert.equal((rendered.match(/<img class="message-image"/g) ?? []).length, 2);
});

test("@ and $ mentions become text_elements whose byte ranges are the UTF-8 spans of their placeholders, plus mention and skill items", () => {
  assert.deepEqual(MENTION_TRIGGERS, { "@": "mention", "$": "skill" });
  // The trigger token is the @ or $ word the caret sits in, at a word start only.
  assert.deepEqual(activeTrigger("see @REA", 8), { kind: "mention", start: 4, end: 8, query: "REA" });
  assert.deepEqual(activeTrigger("$", 1), { kind: "skill", start: 0, end: 1, query: "" });
  assert.equal(activeTrigger("mail@example", 12), null, "an @ inside a word is not a trigger");
  assert.equal(activeTrigger("see @README.md done", 19), null, "the caret has left the token");
  assert.equal(activeTrigger("see @READ", 4), null, "the caret is before the trigger");
  assert.equal(activeTrigger(`@${"x".repeat(81)}`, 82), null, "an over-long query is not a trigger");
  // A pick replaces the token with the placeholder and a space; removal takes it back out.
  assert.deepEqual(insertPlaceholder("see @REA now", activeTrigger("see @REA now", 8), "@README.md"), { text: "see @README.md now", caret: 15 });
  assert.equal(removePlaceholder("see @README.md now", "@README.md"), "see now");
  assert.equal(removePlaceholder("see @README.mdx @README.md", "@README.md"), "see @README.mdx ", "a placeholder never matches inside a longer token");
  assert.equal(removePlaceholder("@a.md one @a.md two", "@a.md", 1), "@a.md one two", "the chip's own occurrence leaves, not the first");
  assert.equal(removePlaceholder("@a.md once", "@a.md", 3), "@a.md once", "a missing ordinal changes nothing");
  assert.deepEqual([placeholderFor("mention", "a.md"), placeholderFor("skill", "review")], ["@a.md", "$review"]);

  // Byte math: each element's byteRange equals the UTF-8 byte span of its
  // placeholder in the text, as Buffer.byteLength measures it; the bytes at
  // the range are the placeholder (the host's own validation).
  const text = "héllo @README.md then $review-change — and @README.md again";
  const chips = [
    { kind: "mention", name: "README.md", path: "/repo/README.md", placeholder: "@README.md" },
    { kind: "skill", name: "review-change", path: "/skills/review-change/SKILL.md", placeholder: "$review-change" },
    { kind: "mention", name: "README.md", path: "/repo/README.md", placeholder: "@README.md" },
    { kind: "mention", name: "gone.md", path: "/repo/gone.md", placeholder: "@gone.md" },
  ];
  const { elements, items } = composeTextElements(text, chips);
  const at = Buffer.byteLength("héllo ", "utf8");
  const dollar = Buffer.byteLength("héllo @README.md then ", "utf8");
  const again = Buffer.byteLength("héllo @README.md then $review-change — and ", "utf8");
  assert.deepEqual(elements, [
    { byteRange: { start: at, end: at + Buffer.byteLength("@README.md", "utf8") }, placeholder: "@README.md" },
    { byteRange: { start: dollar, end: dollar + Buffer.byteLength("$review-change", "utf8") }, placeholder: "$review-change" },
    { byteRange: { start: again, end: again + Buffer.byteLength("@README.md", "utf8") }, placeholder: "@README.md" },
  ]);
  const bytes = Buffer.from(text, "utf8");
  for (const element of elements) {
    assert.equal(Buffer.byteLength(element.placeholder, "utf8"), element.byteRange.end - element.byteRange.start);
    assert.equal(bytes.subarray(element.byteRange.start, element.byteRange.end).toString("utf8"), element.placeholder);
  }
  assert.equal(byteLength(text), bytes.byteLength, "TextEncoder and Buffer agree on the byte length");
  assert.deepEqual(items, [
    { type: "mention", name: "README.md", path: "/repo/README.md" },
    { type: "skill", name: "review-change", path: "/skills/review-change/SKILL.md" },
    { type: "mention", name: "README.md", path: "/repo/README.md" },
  ], "one item per chip still present in the text; a removed placeholder drops its chip");
  assert.deepEqual(composeTextElements("plain", chips), { elements: [], items: [] });

  // Replay parses the same elements back, by byte span, into text and chips;
  // a malformed range is ignored and never hides text.
  assert.deepEqual(parseTextElements(text, elements), [
    { text: "héllo " }, { placeholder: "@README.md", kind: "mention" }, { text: " then " }, { placeholder: "$review-change", kind: "skill" }, { text: " — and " }, { placeholder: "@README.md", kind: "mention" }, { text: " again" },
  ]);
  assert.deepEqual(parseTextElements(text, [{ byteRange: { start: 1, end: 2 } }, { byteRange: { start: 0, end: 999 } }, { byteRange: { start: 5, end: 3 } }, null]), [{ text }]);
  assert.deepEqual(parseTextElements(text, null), [{ text }]);
  assert.deepEqual(chipsFromItems([{ type: "text", text: "x" }, { type: "mention", name: "a.md", path: "/a.md" }, { type: "skill", name: "s", path: "/s" }]), [
    { kind: "mention", name: "a.md", path: "/a.md", placeholder: "@a.md" }, { kind: "skill", name: "s", path: "/s", placeholder: "$s" },
  ]);
  // The replayed user message renders each placeholder as a chip inside the
  // Markdown, so a file name's underscores never become emphasis, and the
  // mention and skill items are not repeated as attachments.
  const html = renderUserMessageText("use @my_file_name.md and $do_it _soon_", createRenderBudget(), { textElements: [{ byteRange: { start: 4, end: 20 }, placeholder: "@my_file_name.md" }, { byteRange: { start: 25, end: 31 }, placeholder: "$do_it" }] });
  assert.equal(html, '<p>use <span class="mention-chip" data-mention-kind="mention" title="File mention">@my_file_name.md</span> and <span class="mention-chip" data-mention-kind="skill" title="Skill mention">$do_it</span> <em>soon</em></p>');
  assert.equal(renderUserMessageText("no elements _here_", createRenderBudget(), { textElements: [] }), "<p>no elements <em>here</em></p>");
  assert.equal(renderUserMedia([{ type: "mention", name: "a.md", path: "/a.md" }, { type: "skill", name: "s", path: "/s" }], createRenderBudget(), { inlineMentions: true }), "");
  assert.match(renderUserMedia([{ type: "mention", name: "a.md", path: "/a.md" }], createRenderBudget()), /@a\.md/, "without text_elements the items still show as chips");
});

test("context use follows thread/tokenUsage/updated alone and the contextCompaction item is the transcript boundary", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  assert.equal(threadTokenUsage(model, "thread-c"), null);
  assert.deepEqual(contextUsage(null), { state: "unknown", totalTokens: null, modelContextWindow: null, percent: null, label: "Context use not reported yet", detail: "The runtime reports token usage inside each Turn; nothing has been reported for this Chat in this session." }, "no value before the first notification");
  const usage = (total, window, turnId = "turn-1") => ({ threadId: "thread-c", turnId, tokenUsage: { total: { totalTokens: total, inputTokens: total - 150, cachedInputTokens: 0, outputTokens: 150, reasoningOutputTokens: 0 }, last: { totalTokens: 1_200 }, modelContextWindow: window } });
  assert.equal(applyChatEvent(model, "thread/tokenUsage/updated", usage(34_000, 272_000)), true);
  const known = contextUsage(threadTokenUsage(model, "thread-c"));
  assert.deepEqual([known.state, known.totalTokens, known.modelContextWindow, known.percent, known.label, known.detail], ["known", 34_000, 272_000, 13, "Context 13% · 34,000 of 272,000 tokens", "Last reported by Turn turn-1."]);
  // A later notification replaces the record; a null window means no percentage.
  assert.equal(applyTokenUsage(model, usage(400, null, "turn-compaction")), true);
  const noWindow = contextUsage(threadTokenUsage(model, "thread-c"));
  assert.deepEqual([noWindow.state, noWindow.totalTokens, noWindow.modelContextWindow, noWindow.percent, noWindow.label], ["no-window", 400, null, null, "Context 400 tokens · window not reported"]);
  assert.equal(threadTokenUsage(model, "thread-c").turnId, "turn-compaction");
  assert.equal(applyTokenUsage(model, { threadId: "thread-c" }), false, "a notification without tokenUsage changes nothing");
  assert.equal(applyTokenUsage(model, { tokenUsage: usage(1, 2).tokenUsage }), false, "a notification without a Thread changes nothing");
  assert.equal(contextUsage({ totalTokens: 10, modelContextWindow: 0 }).state, "no-window", "a zero window is no window");
  assert.equal(contextUsage({ totalTokens: 300_000, modelContextWindow: 272_000 }).percent, 110, "over the window is reported as such, never clamped to a claim");
  for (let index = 0; index < 70; index += 1) applyTokenUsage(model, { ...usage(1, 2), threadId: `thread-${index}` });
  assert.equal(threadTokenUsage(model, "thread-c"), null, "the per-Thread record is bounded");
  assert.equal(compactDisabledReason({ running: false, fixture: false, runtimeAlive: true }), null);
  assert.match(compactDisabledReason({ running: true, fixture: false, runtimeAlive: true }), /running Turn/);
  assert.match(compactDisabledReason({ running: false, fixture: true, runtimeAlive: true }), /Review fixture/);
  assert.match(compactDisabledReason({ running: false, fixture: false, runtimeAlive: false }), /needs the runtime/);
  // The contextCompaction ThreadItem of the compaction Turn is the boundary.
  const thread = { id: "thread-c", turns: [{ id: "turn-1", status: "completed", items: [{ id: "u1", type: "userMessage", content: [{ type: "text", text: "work" }] }] }, { id: "turn-compaction", status: "completed", items: [{ id: "compacted-1", type: "contextCompaction" }] }] };
  const timeline = canonicalTimeline(thread, model);
  const boundary = timeline.find((item) => item.type === "contextCompaction");
  assert.deepEqual([boundary._boundary, boundary._turnId, boundary._live, boundary._turnLive], ["compacted", "turn-compaction", false, false]);
  assert.equal(timeline.filter((item) => item._boundary).length, 1);
  assert.equal(timeline.find((item) => item.id === "u1")._boundary, undefined);
});

test("thread/name/updated renames the Thread record the way the host titles it", () => {
  assert.equal(threadTitleFromName("Named", "preview"), "Named");
  assert.equal(threadTitleFromName(null, "first line\nsecond"), "first line");
  assert.equal(threadTitleFromName("", `${"x".repeat(80)}`), "x".repeat(72), "the preview title is bounded like the host's");
  assert.equal(threadTitleFromName(null, ""), "Untitled chat");
  const thread = { id: "t", name: null, preview: "preview line", title: "preview line", taskLink: null };
  assert.deepEqual(renameThreadRecord(thread, "Renamed"), { ...thread, name: "Renamed", title: "Renamed" });
  assert.deepEqual(renameThreadRecord({ ...thread, name: "Renamed", title: "Renamed" }, null), { ...thread, name: null, title: "preview line" }, "a null threadName clears the name and the title falls back to the preview");
  assert.deepEqual(renameThreadRecord(thread, 42), { ...thread, name: "42", title: "42" });
});

test("Composer text, Quote identity, and attachments are isolated and bounded by Thread", () => {
  const drafts = new Map();
  saveThreadDraft(drafts, "thread-a", { text: "draft A", quote: { threadId: "thread-a", turnId: "turn-a", itemId: "item-a" }, attachments: [{ type: "image", url: "data:image/png;base64,AA==" }] });
  assert.deepEqual(loadThreadDraft(drafts, "thread-b"), { text: "", quote: null, attachments: [], mentions: [] });
  assert.deepEqual(loadThreadDraft(drafts, null), { text: "", quote: null, attachments: [], mentions: [] });
  saveThreadDraft(drafts, "thread-m", { text: "see @a.md", mentions: [{ kind: "mention", name: "a.md", path: "/a.md", placeholder: "@a.md" }] });
  assert.deepEqual(loadThreadDraft(drafts, "thread-m").mentions, [{ kind: "mention", name: "a.md", path: "/a.md", placeholder: "@a.md" }], "mention chips are Thread-owned like the text");
  assert.equal(loadThreadDraft(drafts, "thread-a").quote.threadId, "thread-a");
  for (let index = 0; index < MAX_DRAFT_THREADS + 2; index += 1) saveThreadDraft(drafts, `thread-${index}`, { text: String(index) });
  assert.equal(drafts.size, MAX_DRAFT_THREADS);
  assert.equal(drafts.has("thread-a"), false);
});

test("pure rich renderer escapes Markdown and visibly bounds malformed code", () => {
  const budget = createRenderBudget({ textCharacters: 160, mediaCharacters: 100 });
  const html = renderMarkdown("<script>alert(1)</script>\n\n[good](https://example.com) [bad](javascript:alert(1))\n```js\n" + "x".repeat(400), budget, 120);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /omitted from this mounted view/);
  assert.match(html, /tabindex="0" aria-label="Code block"/);
});

test("escape-first Markdown renders nested lists, nested quotes and line-start fences as structure", () => {
  assert.equal(renderMarkdown("1. one\n   - a\n     - deep\n   - b\n2. two\n\n3. three"), "<ol><li>one<ul><li>a<ul><li>deep</li></ul></li><li>b</li></ul></li><li>two</li><li>three</li></ol>");
  const quote = renderMarkdown("> quoted **line**\n> - item\n> ```\n> code <b>\n> ```\n> > nested");
  assert.match(quote, /^<blockquote><p>quoted <strong>line<\/strong><\/p><ul><li>item<\/li><\/ul><div class="code-block">/);
  assert.match(quote, /<code>code &lt;b&gt;<\/code>/);
  assert.match(quote, /<blockquote><p>nested<\/p><\/blockquote><\/blockquote>$/);
  assert.equal(renderMarkdown("use ```inline``` here\nnext"), "<p>use <code>inline</code> here<br>next</p>");
  assert.equal(renderMarkdown("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(renderMarkdown("# T #\n###### deep\n#nothash\n***\n- - -"), "<h2>T</h2><h4>deep</h4><p>#nothash</p><hr><hr>");
  assert.equal(renderMarkdown("- a\r\n\t- b\r\nend"), "<ul><li>a<ul><li>b</li></ul></li></ul><p>end</p>");
  assert.equal(renderMarkdown("~~~~\ncode\n~~~\nstill\n~~~~\nafter"), '<div class="code-block"><button type="button" data-copy-code="0" aria-label="Copy code block 1">Copy</button><pre tabindex="0" aria-label="Code block"><code>code\n~~~\nstill</code></pre></div><p>after</p>');
});

test("malformed Markdown stays literal, escaped, bounded and linear", () => {
  const unclosed = renderMarkdown("before\n```js\nconst x = 1;\n<script>alert(1)</script>");
  assert.match(unclosed, /^<p>before<\/p><div class="code-block"><span>js<\/span>/);
  assert.match(unclosed, /&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code>/);
  assert.doesNotMatch(unclosed, /<script>/);
  assert.equal(renderMarkdown("**unclosed *and `code **bold** <b>` and a_b_c and *em* and ~~gone~~"), "<p>**unclosed *and <code>code **bold** &lt;b&gt;</code> and a_b_c and <em>em</em> and <del>gone</del></p>");
  const links = renderMarkdown("[a_b](https://e.com/a_b_c?x=1&y=2) [js](javascript:alert(1)) [x](https://e.com/\"onmouseover=\"1)");
  assert.match(links, /<a href="https:\/\/e\.com\/a_b_c\?x=1&amp;y=2" target="_blank" rel="noreferrer noopener">a_b<\/a>/);
  assert.doesNotMatch(links, /href="javascript:/);
  assert.doesNotMatch(links, /[^&]"onmouseover/);
  assert.equal(renderMarkdown("<img src=x onerror=alert(1)>\n<!-- c -->"), "<p>&lt;img src=x onerror=alert(1)&gt;<br>&lt;!-- c --&gt;</p>");
  const bomb = renderMarkdown(`${">".repeat(40)} x`);
  assert.equal((bomb.match(/<blockquote>/g) ?? []).length, 9, "nesting depth is capped and the remainder stays literal");
  assert.match(bomb, /&gt;&gt;[^<]* x<\/p>/);
  const started = performance.now();
  for (const input of ["**a ".repeat(8_000), "*a".repeat(16_000), "`a".repeat(16_000), "[a](https://x".repeat(2_000), "- ".repeat(16_000), "> ".repeat(16_000), "1. ".repeat(10_000)]) {
    const html = renderMarkdown(input);
    assert.doesNotMatch(html, /[\uE000\uE001]/, "inline tokens never leak");
    assert.ok(html.length < 400_000, `bounded output for ${input.slice(0, 8)}…, received ${html.length}`);
  }
  assert.ok(performance.now() - started < 1_000, "adversarial inputs stay linear");
});

test("media, generated images, tool images and unknown rich results have truthful fallbacks", () => {
  const image = "data:image/png;base64,AA==";
  assert.match(renderUserMedia([{ type: "image", url: image }]), /<img/);
  const unsupported = renderUserMedia([{ type: "image", url: "https://example.com/private.png", name: "remote" }]);
  assert.match(unsupported, /image source is not mounted/);
  assert.doesNotMatch(unsupported, /@undefined/);
  assert.match(renderGeneratedImage({ result: { imageUrl: image } }), /Generated image/);
  assert.match(renderGeneratedImage({ status: "completed" }), /not mounted by this local carrier/);
  const tool = renderToolContent([
    { type: "text", text: "tool result" },
    { type: "image", data: "AA==", mimeType: "image/png" },
    { type: "resource", uri: "file:///not-mounted" },
    { type: "inputAudio", audioUrl: "data:audio/wav;base64,AA==" },
  ]);
  assert.match(tool, /tool result/);
  assert.match(tool, /Tool image result/);
  assert.match(tool, /resource tool result remains inspectable/);
  assert.match(tool, /Tool audio result remains available/);
});

test("event-window recovery reports loss and runtime generation truthfully", () => {
  const retained = Array.from({ length: 500 }, (_, index) => ({ sequence: index + 2, kind: "notification", value: {} }));
  const lost = eventWindow(retained, 0, 501, { generation: 4, alive: false });
  assert.equal(lost.oldestCursor, 2);
  assert.equal(lost.gap, true);
  assert.equal(lost.runtimeGeneration, 4);
  assert.equal(lost.runtimeAlive, false);
  assert.equal(eventWindow(retained, 1, 501, { generation: 4, alive: true }).gap, false);
  // The window carries the host's runtime state and halt so a browser that
  // missed runtimeExit or runtimeHalted still lands on the truth.
  assert.deepEqual([lost.runtimeState, lost.runtimeHalt], ["exited", null]);
  const halted = eventWindow(retained, 501, 501, { generation: 2, alive: true, state: "halted", halt: { conditionId: "thread-restart-recovery-unavailable", code: "stop-condition-violated" } });
  assert.deepEqual([halted.runtimeState, halted.runtimeHalt.conditionId, halted.events.length], ["halted", "thread-restart-recovery-unavailable", 0]);
  assert.equal(eventWindow(retained, 501, 501, { generation: 2, alive: false, state: "restarting" }).runtimeState, "restarting");
});

test("server-request registry never mislabels unsupported requests as approvals", () => {
  const command = { method: "item/commandExecution/requestApproval", params: {} };
  assert.equal(requestDescriptor(command).kind, "commandApproval");
  assert.equal(validateRequestDecision(command, "cancel"), true);
  assert.equal(validateRequestDecision(command, "unknown"), false);
  const dynamic = { method: "item/tool/call", params: {} };
  assert.equal(requestDescriptor(dynamic).supported, false);
  assert.deepEqual(unsupportedServerRequestResult(dynamic), {
    success: false,
    contentItems: [{ type: "inputText", text: "This local VibeHub carrier does not execute client-side dynamic tools." }],
  });
  assert.equal(requestDescriptor({ method: "future/request" }).kind, "unsupported");
});

test("citations preserve full accessible Thread identity and enforce aggregate counts", () => {
  const fullThreadId = "0198d957-f8b5-72a0-a268-46de3a15e807";
  const entries = Array.from({ length: 40 }, (_, index) => ({ path: `docs/${index}.md`, lineStart: 1, note: "source" }));
  const html = renderMemoryCitations({ entries, threadIds: [fullThreadId] }, createRenderBudget({ citationCount: 3 }));
  assert.match(html, new RegExp(fullThreadId));
  assert.match(html, /Copy full source Thread id/);
  assert.match(html, /37 citation entries omitted/);
});

test("agent-message renderer carries compound identity through Copy and Quote actions", () => {
  const key = itemKey("thread", "turn", "answer");
  const html = renderAgentMessage({ id: "answer", _key: key, type: "agentMessage", text: "Answer" });
  assert.match(html, new RegExp(`data-item-id="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, new RegExp(`data-copy-message="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, new RegExp(`data-quote-message="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
});

test("one shared render budget bounds aggregate mounted response text", () => {
  const budget = createRenderBudget({ textCharacters: 1_000, mediaCharacters: 100 });
  const html = Array.from({ length: 8 }, (_, index) => renderAgentMessage({ id: String(index), _key: String(index), type: "agentMessage", text: "x".repeat(500) }, budget)).join("");
  assert.equal(budget.textRemaining, 0);
  assert.match(html, /omitted from this mounted view/);
  assert.ok(html.length < 12_000, `mounted HTML should stay bounded, received ${html.length}`);
});

test("timeline and rich output stay bounded without inferring lifecycle", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  const thread = { turns: [{ id: "many", status: "completed", items: Array.from({ length: 300 }, (_, index) => ({ id: `item-${index}`, type: "agentMessage", text: String(index) })) }] };
  const timeline = canonicalTimeline(thread, model, { limit: 240 });
  assert.equal(timeline.length, 240);
  assert.equal(timeline[0].id, "item-60");
  assert.equal(timeline.at(-1)._live, false);
  const bounded = boundedText("x".repeat(20_500));
  assert.equal(bounded.text.length, 20_000);
  assert.equal(bounded.omitted, 500);
  assert.equal(bounded.truncated, true);
});

test("Composer growth has one CSS-owned ceiling shared with the JavaScript clamp", async () => {
  const [css, script, host] = await Promise.all([
    source("apps/codex-first-shell/app.css"),
    source("apps/codex-first-shell/app.js"),
    source("scripts/vh-codex-first-shell.mjs"),
  ]);
  const rule = css.match(/\.composer textarea \{[^}]*min-height: (\d+)px;[^}]*max-height: (\d+)px;/);
  assert.ok(rule, "the textarea rule declares both bounds");
  assert.deepEqual({ min: Number(rule[1]), max: Number(rule[2]) }, { ...COMPOSER_HEIGHT_FALLBACK }, "the script fallback equals the CSS bounds");
  assert.deepEqual(composerBounds({ minHeight: "34px", maxHeight: "190px" }), { min: 34, max: 190 });
  assert.deepEqual(composerBounds({ minHeight: "0px", maxHeight: "none" }), { ...COMPOSER_HEIGHT_FALLBACK });
  assert.deepEqual(composerBounds({ minHeight: "200px", maxHeight: "100px" }), { min: 200, max: 200 }, "an inverted stylesheet never yields max below min");
  assert.equal(clampComposerHeight(900, { min: 34, max: 190 }), 190);
  assert.equal(clampComposerHeight(3, { min: 34, max: 190 }), 34);
  assert.equal(clampComposerHeight(120.5, { min: 34, max: 190 }), 120.5);
  assert.equal(clampComposerHeight(Number.NaN, { min: 34, max: 190 }), 34);
  const autoSize = script.slice(script.indexOf("function autoSizeComposer"), script.indexOf("function captureComposerDraft"));
  assert.match(autoSize, /composerBounds\(getComputedStyle\(textarea\)\)/);
  assert.match(autoSize, /clampComposerHeight\(textarea\.scrollHeight, bounds\)/);
  assert.doesNotMatch(autoSize, /\d{2,}/, "autoSizeComposer carries no numeric ceiling of its own");
  assert.match(host, /\["\/composer-sizing\.mjs", script\("composer-sizing\.mjs"\)\]/);
});

test("thread location follows the visible Thread and preserves token and fixture context", async () => {
  assert.equal(threadLocation("http://127.0.0.1:1/?reviewFrame=narrow#token", "abc"), "http://127.0.0.1:1/?reviewFrame=narrow&thread=abc#token");
  assert.equal(threadLocation("http://127.0.0.1:1/?thread=old&x=1#token", "new"), "http://127.0.0.1:1/?thread=new&x=1#token");
  assert.equal(threadLocation("http://127.0.0.1:1/?thread=old#token", null), "http://127.0.0.1:1/#token");
  assert.equal(threadLocation("http://127.0.0.1:1/#token", null), "http://127.0.0.1:1/#token");
  // The focused Task rides the same query as a second navigation param; it
  // never replaces the Thread param and is dropped off the Workspace route.
  assert.equal(threadLocation("http://127.0.0.1:1/?reviewFrame=narrow#token", "abc", "ticket-focus"), "http://127.0.0.1:1/?reviewFrame=narrow&thread=abc&task=ticket-focus#token");
  assert.equal(threadLocation("http://127.0.0.1:1/?thread=abc&task=ticket-focus#token", "abc"), "http://127.0.0.1:1/?thread=abc#token");
  assert.equal(threadLocation("http://127.0.0.1:1/?task=ticket-old#token", null, "ticket-new"), "http://127.0.0.1:1/?task=ticket-new#token");
  const [script, host] = await Promise.all([source("apps/codex-first-shell/app.js"), source("scripts/vh-codex-first-shell.mjs")]);
  assert.match(script, /function syncThreadLocation\(\) \{\s*if \(state\.fixtureMode\) return;\s*const next = threadLocation\(location\.href, state\.activeThreadId, state\.route === "task" \? state\.activeTicketId : null\);\s*if \(next !== location\.href\) history\.replaceState\(history\.state, "", next\);/);
  const openThreadSource = script.slice(script.indexOf("async function openThread"), script.indexOf("function applyChatNotification"));
  assert.match(openThreadSource, /state\.activeThreadId = threadId;[^]*syncThreadLocation\(\);/);
  for (const name of ["async function newThread", "async function openTask"]) {
    const body = script.slice(script.indexOf(name), script.indexOf("\n}\n", script.indexOf(name)));
    assert.match(body, /syncThreadLocation\(\)/, `${name} keeps the URL on the visible Thread`);
  }
  assert.match(script, /archiveThread[^]*state\.activeThreadId = null;\s*state\.activeThread = null;\s*syncThreadLocation\(\);/);
  assert.match(script, /const requestedThreadId = params\.get\("thread"\);[^]*catch \(error\) \{[^]*syncThreadLocation\(\);[^]*setRoute\("chat"\);/, "a stale deep link lands on Chat instead of bricking the shell");
  assert.match(host, /\["\/thread-location\.mjs", script\("thread-location\.mjs"\)\]/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB/i);
});

test("request-user-input drafts survive route changes and resolve to exact answer ids", async () => {
  const store = new Map();
  saveRequestDraft(store, "req-1", { approach: { choice: "__other__", other: "Custom path", direct: "" }, token: { choice: null, other: "", direct: "secret" } });
  assert.deepEqual(answersFromDraft(loadRequestDraft(store, "req-1")), { answers: { approach: { answers: ["Custom path"] }, token: { answers: ["secret"] } }, invalid: false });
  assert.deepEqual(answersFromDraft({ approach: { choice: "Minimal", other: "ignored", direct: "" } }), { answers: { approach: { answers: ["Minimal"] } }, invalid: false }, "an unselected Other value never leaks into the answer");
  assert.equal(answersFromDraft({ approach: { choice: "__other__", other: "   ", direct: "" } }).invalid, true, "the Other sentinel alone is not an answer");
  assert.equal(answersFromDraft({ approach: { choice: null, other: "", direct: "" } }).invalid, true);
  assert.equal(answersFromDraft({}).invalid, true);
  assert.equal(loadRequestDraft(store, "missing"), null);
  saveRequestDraft(store, "req-1", { approach: { choice: null, other: "", direct: "" } });
  assert.equal(store.has("req-1"), false, "an emptied draft is not retained");
  for (let index = 0; index < MAX_REQUEST_DRAFTS + 3; index += 1) saveRequestDraft(store, `req-${index}`, { q: { choice: "A", other: "", direct: "" } });
  assert.equal(store.size, MAX_REQUEST_DRAFTS);
  pruneRequestDrafts(store, new Set(["req-5"]));
  assert.deepEqual([...store.keys()], ["req-5"], "drafts for requests the host no longer reports are dropped");
  const [script, host] = await Promise.all([source("apps/codex-first-shell/app.js"), source("scripts/vh-codex-first-shell.mjs")]);
  assert.match(script, /document\.addEventListener\("input", \(event\) => \{[^]*rememberRequestDraft\(event\.target\);/);
  assert.match(script, /document\.addEventListener\("change", async \(event\) => \{\s*rememberRequestDraft\(event\.target\);/);
  const renderChatSource = script.slice(script.indexOf("function renderChat("), script.indexOf("function primaryPhase"));
  assert.match(renderChatSource, /surface\.innerHTML = `<div class="chat-view">[^]*restoreRequestDrafts\(surface\);/, "a full Chat render restores every pending request draft");
  assert.match(script.slice(script.indexOf("function renderTaskWorkspace"), script.indexOf("function renderRooms")), /restoreRequestDrafts\(surface\)/);
  assert.match(script.slice(script.indexOf("function patchTimeline"), script.indexOf("function renderChat(")), /restoreRequestDrafts\(next\)/);
  assert.match(script, /function setRoute\(route\) \{\s*captureRequestDrafts\(surface\);/, "a route change snapshots pending request forms before the surface is torn down");
  assert.match(script.slice(script.indexOf("function patchTimeline"), script.indexOf("function renderChat(")), /captureRequestDrafts\(existing\);\s*existing\.replaceWith\(next\);/);
  assert.match(script, /const \{ answers, invalid \} = answersFromDraft\(requestDraftFromForm\(form\)\);/);
  assert.match(script, /state\.requestDrafts\.delete\(requestId\)/);
  assert.equal((script.match(/pruneRequestDrafts\(state\.requestDrafts, state\.knownRequestIds\)/g) ?? []).length, 2, "bootstrap and polling both prune resolved requests");
  assert.match(host, /\["\/request-drafts\.mjs", script\("request-drafts\.mjs"\)\]/);
});

test("quote source identity serializes into the Turn input and renders from replayed Thread history", async () => {
  const quote = { text: "first line\nsecond <b>", threadId: "thread-a", turnId: "turn-1", itemId: "agent-7" };
  const composed = composeQuotedMessage(quote, "my question");
  assert.equal(composed, "> first line\n> second <b>\n> — Quoted from Codex thread thread-a · turn turn-1 · item agent-7\n\nmy question");
  const parsed = parseQuotedMessage(composed);
  assert.deepEqual(parsed, { quoted: "> first line\n> second <b>", source: { threadId: "thread-a", turnId: "turn-1", itemId: "agent-7" }, body: "my question" });
  assert.equal(parseQuotedMessage("plain").source, null);
  assert.equal(parseQuotedMessage("not a quote\n> — Quoted from Codex thread a · turn b · item c").source, null, "a source line must close a leading quote block");
  assert.equal(composeQuotedMessage(null, "  text  "), "text");
  assert.equal(composeQuotedMessage({ text: "x" }, ""), "> x", "a quote without identity still quotes");
  const html = renderUserMessageText(composed, createRenderBudget(), { currentThreadId: "thread-a" });
  assert.equal(html, '<blockquote><p>first line<br>second &lt;b&gt;</p></blockquote><small class="quote-source" data-quote-thread="thread-a" data-quote-turn="turn-1" data-quote-item="agent-7" title="Thread thread-a · Turn turn-1 · Item agent-7" aria-label="Quoted from Thread thread-a · Turn turn-1 · Item agent-7">Quoted from a Codex Turn in this Thread</small><p>my question</p>');
  assert.match(renderUserMessageText(composed, createRenderBudget(), { currentThreadId: "other" }), /in another Thread/);
  const hostile = renderUserMessageText("> — Quoted from Codex thread <img onerror=x> · turn b · item c", createRenderBudget());
  assert.doesNotMatch(hostile, /<img/);
  assert.doesNotMatch(renderUserMessageText(composeQuotedMessage({ ...quote, threadId: '"><script>' }, "x"), createRenderBudget()), /<script>/);
  const [script, host] = await Promise.all([source("apps/codex-first-shell/app.js"), source("scripts/vh-codex-first-shell.mjs")]);
  assert.match(script, /const composedText = composeQuotedMessage\(state\.composerQuote, text\);/);
  assert.equal((script.match(/renderUserMessageText\((?:text|message), budget, \{ currentThreadId: item\._threadId(?:, textElements)? \}\)/g) ?? []).length, 2, "ordinary and Task human messages both render replayed quote identity");
  assert.doesNotMatch(script, /function quotePrefix/);
  assert.match(host, /\["\/quote-source\.mjs", script\("quote-source\.mjs"\)\]/);
  assert.doesNotMatch(script + host, /localStorage|sessionStorage|indexedDB/i);
});

test("selection-preserving reconciliation defers only the entries a live selection touches", async () => {
  const current = [{ key: "a", html: "<a1>" }, { key: "b", html: "<b1>" }, { key: "c", html: "<c1>" }, { key: "req", html: "<r1>" }];
  const next = [{ key: "a", html: "<a1>" }, { key: "b", html: "<b2>" }, { key: "c", html: "<c2>" }, { key: "d", html: "<d1>" }];
  assert.deepEqual(planTimelineReconciliation(current, next, new Set(["b", "req"])), {
    order: ["a", "b", "c", "d"],
    mount: ["d"],
    replace: ["c"],
    keep: ["a"],
    defer: ["b", "req"],
    remove: [],
  }, "a selected changed entry and a selected retired entry both hold their mounted node while everything else streams");
  const released = planTimelineReconciliation(current, next, new Set());
  assert.deepEqual([released.defer, released.replace, released.remove], [[], ["b", "c"], ["req"]], "releasing the selection reconciles every held entry");
  assert.deepEqual(planTimelineReconciliation(current, next, new Set(["a"])).defer, [], "an unchanged selected entry needs no deferral");
  const [script, host, css] = await Promise.all([source("apps/codex-first-shell/app.js"), source("scripts/vh-codex-first-shell.mjs"), source("apps/codex-first-shell/app.css")]);
  const patch = script.slice(script.indexOf("function selectionProtectedKeys"), script.indexOf("function renderChat("));
  assert.match(patch, /range\.intersectsNode\(entry\)/);
  assert.match(patch, /planTimelineReconciliation\(/);
  assert.match(patch, /toggleAttribute\("data-paint-deferred", defer\.has\(key\)\)/);
  assert.match(patch, /state\.paintDeferred = plan\.defer\.length > 0/);
  assert.match(script, /document\.addEventListener\("selectionchange", \(\) => \{[^]*if \(state\.paintDeferred && !transcriptSelectionActive\(\)\) scheduleChatRender\(\);/);
  assert.match(script, /if \(selecting\) surface\.scrollTop = heldScrollTop;/, "an active selection is never scrolled out from under the pointer");
  assert.match(script, /keeps its current text until you release the selection/);
  assert.doesNotMatch(script, /selectionDeferralStartedAt|deferredChatRender|1_200/, "no timer-bounded whole-paint deferral remains");
  assert.match(css, /\[data-paint-deferred\]/);
  assert.match(host, /\["\/timeline-reconcile\.mjs", script\("timeline-reconcile\.mjs"\)\]/);
});

test("mounted timeline discloses its 240-item bound instead of truncating silently", async () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  const thread = { id: "long", turns: [{ id: "many", status: "completed", items: Array.from({ length: 300 }, (_, index) => ({ id: `item-${index}`, type: "agentMessage", text: String(index) })) }] };
  const mounted = timelineWindow(thread, model, { limit: 240 });
  assert.deepEqual([mounted.items.length, mounted.omitted, mounted.total], [240, 60, 300]);
  assert.equal(mounted.items[0].id, "item-60");
  assert.deepEqual(timelineWindow({ id: "short", turns: [] }, model), { items: [], omitted: 0, total: 0 });
  assert.equal(renderTimelineOmission(0), "");
  assert.match(renderTimelineOmission(60), /^<div class="timeline-entry timeline-omission" data-render-key="timeline-omission" role="note">60 earlier items are not mounted in this view\. Durable Thread history remains authoritative\.<\/div>$/);
  const script = await source("apps/codex-first-shell/app.js");
  assert.match(script, /const mounted = timelineWindow\(thread, state, \{ limit: 240 \}\);[^]*renderTimelineOmission\(mounted\.omitted\) \+ renderTimelineItems\(mounted\.items\)/);
});

test("deferred mode, realtime-voice and virtualization checks make no contrary UI claim", async () => {
  const [html, script, host] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("scripts/vh-codex-first-shell.mjs"),
  ]);
  assert.match(html, /<span class="composer-setting" title="Current mode">Agent<\/span>/);
  assert.match(html, /<span class="composer-setting" title="Current runtime">Codex<\/span>/);
  const interactive = [...html.matchAll(/<(?:select|button|input|details)\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(interactive.length > 10);
  // Collaboration mode and realtime stay absent; the model and effort pickers
  // exist and are pinned by test/codex-first-shell-parity-ui.test.mjs.
  for (const tag of interactive) assert.doesNotMatch(tag, /\b(?:mode|realtime)\b/i, `no mode or realtime control: ${tag}`);
  assert.doesNotMatch(script, /realtime/i, "the browser never renders a realtime voice control");
  assert.match(host, /realtimeConversation: false/);
  assert.match(html, /Realtime conversation stays unavailable until the runtime reports support/);
  assert.match(script, /renderTimelineOmission\(mounted\.omitted\)/, "the 240-item mounted bound discloses itself");
});

test("conformance matrix proof entries resolve to existing files, exact tests and guard checks", async () => {
  const matrix = JSON.parse(await source("docs/proposals/codex-chat-conformance/conformance-matrix.json"));
  assert.match(matrix.baseline.proofNotation, /path::name/);
  const cache = new Map();
  const read = async (path) => {
    if (!cache.has(path)) cache.set(path, await source(path).catch(() => null));
    return cache.get(path);
  };
  for (const check of matrix.checks) {
    assert.ok(check.proof.length, `${check.id} records proof`);
    for (const entry of check.proof) {
      const [path, name] = entry.split("::");
      assert.doesNotMatch(path, /codex-first-shell-prototype/, `${check.id} proof points at the production shell, not the retired prototype`);
      const text = await read(path);
      assert.ok(typeof text === "string", `${check.id} proof path exists: ${path}`);
      if (name) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.match(text, new RegExp(`(?:test|check(?:All)?\\(results,)\\s*\\(?\\s*"${escaped}"`), `${check.id}: ${path} declares no test or guard check named "${name}"`);
      }
    }
  }
  for (const id of ["selection-during-stream", "quote-add-to-chat", "markdown-rich-content", "request-user-input", "composer-inputs", "current-thread-url-recovery", "running-composer-steer", "model-mode-pickers"]) {
    const check = matrix.checks.find((entry) => entry.id === id);
    assert.equal(check.after, "pass", `${id} is upgraded`);
    assert.ok(check.proof.some((entry) => entry.startsWith("test/") && entry.includes("::")), `${id} names an exact node test`);
    assert.ok(check.proof.some((entry) => entry.includes("browser-interaction-guard.mjs::")) || id === "markdown-rich-content", `${id} names a real-DOM guard check`);
  }
  for (const id of ["virtualized-production-list", "realtime-voice"]) {
    const check = matrix.checks.find((entry) => entry.id === id);
    assert.equal(check.after, "deferred", `${id} stays deferred`);
    assert.ok(check.proof.some((entry) => entry.includes("::")), `${id} pins that the UI makes no contrary claim`);
  }
  assert.deepEqual(Object.fromEntries(["pass", "partial", "deferred", "fail"].map((state) => [state, matrix.checks.filter((check) => check.after === state).length])), { pass: 28, partial: 0, deferred: 2, fail: 0 });
});

test("current shell exposes the conformance interactions without a second transcript", async () => {
  const [html, script, css, host] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/app.css"),
    source("scripts/vh-codex-first-shell.mjs"),
  ]);
  assert.match(html, /type="module"/);
  assert.match(html, /id="quoteSelection"/);
  assert.match(script, /applyChatEvent/);
  assert.match(script, /canonicalTimeline/);
  assert.match(script, /selectionchange/);
  assert.match(script, /patchTimeline/);
  assert.match(script, /preserveScroll && existingTimeline[^]*patchTimeline\(existingTimeline/);
  assert.match(script, /Quote added to your next message/);
  assert.match(script, /data-request-form/);
  assert.match(script, /data-request-other/);
  assert.match(script, /type=\"\$\{question\.isSecret \? \"password\" : \"text\"\}/);
  assert.match(script, /Cancel & interrupt/);
  assert.match(script, /data\.gap/);
  assert.match(script, /runtimeGeneration/);
  assert.match(script, /Retry as a new Turn/);
  assert.match(script, /state\.running.*composer.*stopTurn/s);
  const requestSurface = script.slice(script.indexOf("function approvalMarkup"), script.indexOf("const groupableActivityTypes"));
  assert.doesNotMatch(requestSurface, /\bprompt\(/);
  assert.match(css, /\.quote-selection/);
  assert.match(css, /\.request-option/);
  assert.match(host, /chat-model\.mjs/);
  assert.doesNotMatch(html + script + host, /localStorage|sessionStorage|indexedDB/i);
});

test("audit corrections wire running steer, fork, Thread drafts, drawer semantics, and bounded media", async () => {
  const [html, script, host, projectsAdapter, lockText, guard] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("scripts/vh-codex-first-shell.mjs"),
    source("packages/codex-adapter/projects.mjs"),
    source("packages/codex-adapter/upstream-lock.json"),
    source("apps/codex-first-shell/browser-interaction-guard.mjs"),
  ]);
  const lock = JSON.parse(lockText);
  assert.ok(lock.requiredRequests.includes("thread/fork"));
  assert.match(host, /payload\.action === "forkThread"[^]*projects\.forkThread/);
  assert.match(projectsAdapter, /thread\/fork/);
  assert.match(host, /payload\.action === "steerTurn"[^]*turn\/steer/);
  assert.match(host, /payload\.action === "archiveThread"[^]*projects\.archiveThread/);
  assert.match(projectsAdapter, /thread\/archive/);
  assert.match(host, /payload\.action === "setThreadName"[^]*thread\/name\/set/);
  // Queue is the default while a Turn streams; steer is the explicit opposite
  // (Alt+Enter) and names the exact live Turn; idle submission starts a Turn.
  assert.match(script, /const steer = state\.running && mode === "opposite";/);
  assert.match(script, /const dispatch = steer \? "steerTurn" : state\.running \? "queueTurn" : "startTurn";/);
  assert.match(script, /\.\.\.\(steer \? \{ expectedTurnId: state\.currentTurnId \} : \{\}\)/);
  assert.match(script, /composerSubmitMode = event\.altKey \? "opposite" : "default";/);
  assert.match(script, /queueing \? "Queue message" : state\.running \? "Steer current turn" : "Send message"/);
  assert.match(script, /action: "interruptTurn"[^]*applyHostEvent\(state, "queueChanged"/, "the interrupt response carries the paused queue");
  assert.match(script, /action: "steerQueued", threadId: queue\.threadId, queuedId: steerQueued\.dataset\.steerQueued, expectedTurnId: state\.currentTurnId/);
  assert.match(script, /action: "resumeQueue", threadId/);
  assert.match(script, /action: "updateQueued", threadId: queue\.threadId, queuedId, input: next/);
  assert.match(script, /action: "deleteQueued", threadId: queue\.threadId/);
  assert.match(script, /action: "listQueue", threadId/);
  assert.doesNotMatch(script, /thread\/queue\//, "the experimental server-side queue stays out of the browser too");
  assert.match(script, /liveTurnId\(fixture\.thread\)/);
  assert.match(script, /dataset\.turnPosture/);
  assert.match(script, /params\.get\("thread"\)/);
  assert.match(script, /saveThreadDraft\(state\.composerDrafts/);
  assert.match(script, /sidebar\.inert = narrow && !open/);
  assert.match(script, /MAX_ATTACHMENT_BYTES/);
  assert.match(script, /MAX_RECORDING_MS/);
  assert.match(html, /id="routeTitle" tabindex="-1"/);
  assert.match(guard, /window\.__VIBEHUB_INTERACTION_GUARD__/);
});
