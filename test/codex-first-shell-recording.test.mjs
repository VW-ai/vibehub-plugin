import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createRecordingController,
  formatRecordingClock,
  MAX_RECORDING_MS,
  permissionDeniedCause,
  RECORDING_MIME_TYPE,
  recordingAnnouncement,
  recordingMimeType,
} from "../apps/codex-first-shell/composer-recording.mjs";

// The production Composer's recording controller, driven here on injected
// fakes: the same seams the browser guard stubs (navigator.mediaDevices and
// MediaRecorder) and injectable timers. The one ephemeral live probe in
// packages/codex-adapter/probe-live.mjs is the real-device and real-runtime
// proof; these tests prove the state machine: what attaches, what discards,
// which announcement each exit path makes, and that the MediaStream tracks
// stop on every one of them.

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeout: (fn, ms) => { const id = nextId++; timeouts.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms, next: now + ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
    now: () => now,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const dueTimeout = [...timeouts.entries()].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        const dueInterval = [...intervals.entries()].filter(([, entry]) => entry.next <= target).sort((a, b) => a[1].next - b[1].next)[0];
        const nextAt = Math.min(dueTimeout?.[1].at ?? Infinity, dueInterval?.[1].next ?? Infinity);
        if (nextAt === Infinity) break;
        now = nextAt;
        if (dueTimeout && dueTimeout[1].at === nextAt) {
          timeouts.delete(dueTimeout[0]);
          dueTimeout[1].fn();
        } else {
          dueInterval[1].next += dueInterval[1].ms;
          dueInterval[1].fn();
        }
        await Promise.resolve();
      }
      now = target;
    },
  };
}

class FakeTrack {
  constructor() { this.stopped = 0; }
  stop() { this.stopped += 1; }
}

class FakeStream {
  constructor() { this.tracks = [new FakeTrack(), new FakeTrack()]; }
  getTracks() { return this.tracks; }
  stopped() { return this.tracks.every((track) => track.stopped > 0); }
}

class FakeRecorder {
  static isTypeSupported() { return true; }
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType ?? RECORDING_MIME_TYPE;
    this.state = "inactive";
    this.started = [];
  }
  start(timeslice) { this.state = "recording"; this.started.push(timeslice); }
  stop() {
    if (this.state !== "recording") return;
    this.state = "inactive";
    this.onstop?.();
  }
  emit(bytes) { this.ondataavailable?.({ data: { size: bytes, bytes } }); }
}

function harness({ behavior = "grant", capMs = MAX_RECORDING_MS, maxBytes = 8 * 1024 * 1024, attachResult = true } = {}) {
  const timers = fakeTimers();
  const log = { renders: [], announcements: [], attachments: [], streams: [], recorders: [], getUserMediaCalls: 0 };
  let gate = null;
  const controller = createRecordingController({
    getUserMedia: () => {
      log.getUserMediaCalls += 1;
      if (behavior === "deny") return Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
      if (behavior === "grant-later") return new Promise((resolve) => { gate = () => { const stream = new FakeStream(); log.streams.push(stream); resolve(stream); }; });
      const stream = new FakeStream();
      log.streams.push(stream);
      return Promise.resolve(stream);
    },
    createRecorder: (stream) => { const recorder = new FakeRecorder(stream, { mimeType: recordingMimeType(FakeRecorder) }); log.recorders.push(recorder); return recorder; },
    capMs: () => capMs,
    maxBytes,
    tickMs: 250,
    timers,
    attach: async (payload) => { log.attachments.push(payload); return attachResult; },
    render: (view) => log.renders.push(view),
    announce: (text) => log.announcements.push(text),
  });
  return { controller, timers, log, allow: () => gate?.(), setBehavior: (next) => { behavior = next; } };
}

test("the recording clock counts toward the 90 second cap in m:ss and clamps at it", () => {
  assert.equal(MAX_RECORDING_MS, 90_000);
  assert.equal(formatRecordingClock(0), "0:00 / 1:30");
  assert.equal(formatRecordingClock(7_400), "0:07 / 1:30");
  assert.equal(formatRecordingClock(61_000), "1:01 / 1:30");
  assert.equal(formatRecordingClock(89_999), "1:29 / 1:30");
  assert.equal(formatRecordingClock(200_000), "1:30 / 1:30");
  assert.equal(formatRecordingClock(0, 1_000), "0:00 / 0:01");
});

test("recording copy names every cause and never claims the audio became text", () => {
  assert.match(recordingAnnouncement("start"), /90 second cap/);
  assert.match(recordingAnnouncement("start"), /Cancel or Escape discards/);
  assert.match(recordingAnnouncement("cap"), /auto-stopped at the 90 second cap/);
  assert.match(recordingAnnouncement("size"), /8 MiB attachment bound and was not attached/);
  assert.match(recordingAnnouncement("stop"), /ordinary Codex audio input/);
  assert.match(recordingAnnouncement("cancel"), /Nothing was attached/);
  for (const event of ["start", "stop", "cap", "size", "cancel", "empty", "refused"]) {
    assert.doesNotMatch(recordingAnnouncement(event), /transcri|dictat|listening|speech/i, event);
  }
  assert.throws(() => recordingAnnouncement("bogus"));
  assert.match(permissionDeniedCause({ name: "NotAllowedError" }), /denied[^]*try again/);
  assert.match(permissionDeniedCause({ name: "NotFoundError" }), /No microphone was found/);
  assert.match(permissionDeniedCause({ name: "NotReadableError" }), /could not be read/);
  assert.match(permissionDeniedCause(new Error("weird failure")), /weird failure/);
  assert.equal(recordingMimeType(FakeRecorder), RECORDING_MIME_TYPE);
  assert.equal(recordingMimeType({ isTypeSupported: () => false }), "");
  assert.equal(recordingMimeType(undefined), "");
});

test("recording UI never renders without an active MediaStream, then a plain stop attaches the removable chip", async () => {
  const { controller, timers, log, allow } = harness({ behavior: "grant-later" });
  const started = controller.start();
  assert.equal(controller.status(), "idle");
  assert.ok(log.renders.every((view) => view.status !== "recording"), "no recording view before getUserMedia resolves");
  allow();
  assert.deepEqual(await started, { ok: true });
  assert.equal(controller.status(), "recording");
  assert.equal(controller.activeStream(), log.streams[0]);
  assert.deepEqual(log.recorders[0].started, [1_000]);
  assert.match(log.announcements.at(-1), /Recording locally toward the 90 second cap/);
  await timers.advance(1_100);
  const tick = log.renders.at(-1);
  assert.equal(tick.status, "recording");
  assert.equal(formatRecordingClock(tick.elapsedMs, tick.capMs), "0:01 / 1:30");
  log.recorders[0].emit(2_048);
  const result = await controller.stop();
  assert.deepEqual(result, { attached: true, cause: "stop" });
  assert.equal(log.attachments.length, 1);
  assert.equal(log.attachments[0].mimeType, RECORDING_MIME_TYPE);
  assert.equal(log.attachments[0].bytes, 2_048);
  assert.ok(log.streams[0].stopped(), "every MediaStream track stopped on plain stop");
  assert.equal(controller.status(), "idle");
  assert.match(log.announcements.at(-1), /attached as ordinary Codex audio input/);
});

test("Cancel discards: tracks stop, buffered chunks drop, no chip, and recording again immediately succeeds", async () => {
  const { controller, log } = harness();
  await controller.start();
  log.recorders[0].emit(4_096);
  const cancelled = await controller.cancel();
  assert.deepEqual(cancelled, { attached: false, cause: "cancel" });
  assert.equal(log.attachments.length, 0, "no chip appears on cancel");
  assert.ok(log.streams[0].stopped());
  assert.match(log.announcements.at(-1), /Recording discarded\. Nothing was attached\./);
  assert.equal(controller.status(), "idle");
  assert.deepEqual(await controller.start(), { ok: true }, "immediate re-record after cancel");
  assert.equal(log.getUserMediaCalls, 2);
  await controller.cancel();
});

test("the 90 second cap auto-stops with its cause announced and the bounded recording attached", async () => {
  const { controller, timers, log } = harness();
  await controller.start();
  log.recorders[0].emit(1_024);
  await timers.advance(MAX_RECORDING_MS + 10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.status(), "idle");
  assert.equal(log.attachments.length, 1);
  assert.ok(log.streams[0].stopped());
  assert.match(log.announcements.at(-1), /auto-stopped at the 90 second cap/);
});

test("the size bound auto-stops with its cause announced and nothing attached", async () => {
  const { controller, log } = harness({ maxBytes: 4 * 1024 * 1024 });
  await controller.start();
  log.recorders[0].emit(4 * 1024 * 1024 + 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.status(), "idle");
  assert.equal(log.attachments.length, 0, "an over-bound recording is not attached");
  assert.ok(log.streams[0].stopped());
  assert.match(log.announcements.at(-1), /4 MiB attachment bound and was not attached/);
});

test("a denied prompt is a persistent named state, retry re-prompts, and no stream ever existed", async () => {
  const { controller, log, setBehavior } = harness({ behavior: "deny" });
  const denied = await controller.start();
  assert.equal(denied.ok, false);
  assert.match(denied.denied, /Microphone access was denied[^]*try again/);
  assert.equal(controller.status(), "denied");
  assert.equal(controller.activeStream(), null);
  assert.equal(log.streams.length, 0, "no MediaStream was acquired on denial");
  assert.ok(log.renders.every((view) => view.status !== "recording"), "recording UI never rendered without a stream");
  assert.equal(log.renders.at(-1).status, "denied");
  assert.equal(log.renders.at(-1).deniedCause, denied.denied);
  assert.match(log.announcements.at(-1), /denied/);
  setBehavior("grant");
  assert.deepEqual(await controller.start(), { ok: true }, "retry re-prompts and records");
  assert.equal(log.getUserMediaCalls, 2);
  assert.equal(controller.status(), "recording");
  await controller.cancel();
  const dismissed = harness({ behavior: "deny" });
  await dismissed.controller.start();
  dismissed.controller.dismissDenied();
  assert.equal(dismissed.controller.status(), "idle");
});

test("send finishes the live recording first: the chip attaches and the tracks stop before the Turn is built", async () => {
  const { controller, log } = harness();
  await controller.start();
  log.recorders[0].emit(512);
  const sent = await controller.finishForSend();
  assert.deepEqual(sent, { attached: true, cause: "stop" });
  assert.equal(log.attachments.length, 1);
  assert.ok(log.streams[0].stopped(), "tracks stop on the send path");
});

test("ensureReleased is the idempotent teardown: a live recording is discarded, an idle controller is untouched", async () => {
  const { controller, log } = harness();
  assert.deepEqual(await controller.ensureReleased(), { attached: false, cause: "idle" });
  await controller.start();
  log.recorders[0].emit(256);
  const released = await controller.ensureReleased();
  assert.deepEqual(released, { attached: false, cause: "cancel" });
  assert.equal(log.attachments.length, 0);
  assert.ok(log.streams[0].stopped(), "tracks stop on view teardown");
  assert.deepEqual(await controller.ensureReleased(), { attached: false, cause: "idle" });
  assert.deepEqual(await controller.start(), { ok: true }, "recording after a teardown succeeds");
  await controller.cancel();
});

test("a refused attachment is announced truthfully and an empty recording attaches nothing", async () => {
  const refused = harness({ attachResult: false });
  await refused.controller.start();
  refused.log.recorders[0].emit(128);
  assert.deepEqual(await refused.controller.stop(), { attached: false, cause: "stop" });
  assert.match(refused.log.announcements.at(-1), /attachment was refused; nothing was attached/);
  const empty = harness();
  await empty.controller.start();
  assert.deepEqual(await empty.controller.stop(), { attached: false, cause: "stop" });
  assert.equal(empty.log.attachments.length, 0);
  assert.match(empty.log.announcements.at(-1), /No audio was captured/);
  assert.ok(empty.log.streams[0].stopped());
});

test("recording bytes touch no storage API and no object or blob URL on their way to the data URL", async () => {
  const recording = await readFile(new URL("../apps/codex-first-shell/composer-recording.mjs", import.meta.url), "utf8");
  const script = await readFile(new URL("../apps/codex-first-shell/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(recording + script, /localStorage|sessionStorage|indexedDB|caches\.open|createObjectURL|revokeObjectURL/i);
  assert.doesNotMatch(recording + script, /["'`]blob:/);
  assert.match(script, /fileToDataUrl\(file\)/);
});
