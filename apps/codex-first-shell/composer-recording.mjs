// Honest voice input for the production Composer: record locally with
// getUserMedia and MediaRecorder, review the result as a removable chip, and
// send it as the stable ordinary `audio` Turn input inside one turn/start.
// The recording travels as audio bytes and nothing else: the shell never
// turns it into text, never mimics a text-entry voice flow, and never claims
// more than the capability contract grants. Recording bytes live
// only in memory on their way to one bounded data: URL attachment — never an
// object or blob: URL, never a storage API — and the MediaStream tracks stop
// on every exit path: plain stop, cancel, Escape, the duration cap, the size
// bound, permission denial, send, chip removal and view teardown.

export const MAX_RECORDING_MS = 90_000;
export const RECORDING_TICK_MS = 250;

// The one mimeType the shell asks MediaRecorder for when the browser supports
// it; a browser that cannot produce it records its own default, named
// truthfully on the chip and inside the Turn input's data URL. The lock's
// audio block records which data-URL mime the pinned runtime accepted,
// proven by the one ephemeral audio Turn in probe-live.mjs.
export const RECORDING_MIME_TYPE = "audio/webm;codecs=opus";

export function recordingMimeType(Recorder = globalThis.MediaRecorder) {
  return typeof Recorder?.isTypeSupported === "function" && Recorder.isTypeSupported(RECORDING_MIME_TYPE) ? RECORDING_MIME_TYPE : "";
}

// "0:07 / 1:30": elapsed time counting toward the cap, both as m:ss.
export function formatRecordingClock(elapsedMs, capMs = MAX_RECORDING_MS) {
  const clock = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1_000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  return `${clock(Math.min(elapsedMs, capMs))} / ${clock(capMs)}`;
}

// The persistent inline cause of a getUserMedia rejection, named from the
// DOMException instead of guessed, always ending in the way back (retry
// re-prompts the browser).
export function permissionDeniedCause(error) {
  const name = error?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "Microphone access was denied. Allow microphone use for this site, then select the microphone to try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found on this device. Connect one, then select the microphone to try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "The microphone could not be read; another application may hold it. Free it, then select the microphone to try again.";
  }
  return `The microphone could not be opened (${error?.message ?? String(error ?? "unknown error")}). Select the microphone to try again.`;
}

// Every polite live-region announcement the recording lifecycle makes: the
// start, each auto-stop cause (the duration cap, the size bound), the manual
// stop and the discard. None claims that the audio became text or that
// anything is heard live.
export function recordingAnnouncement(event, { capMs = MAX_RECORDING_MS, maxBytes = 8 * 1024 * 1024 } = {}) {
  const seconds = Math.round(capMs / 1_000);
  const mib = Math.round(maxBytes / (1024 * 1024));
  if (event === "start") return `Recording locally toward the ${seconds} second cap. Stop attaches a reviewable audio chip; Cancel or Escape discards it.`;
  if (event === "stop") return "Recording stopped. Voice recording is attached as ordinary Codex audio input; remove the chip to drop it.";
  if (event === "cap") return `Recording auto-stopped at the ${seconds} second cap. Voice recording is attached as ordinary Codex audio input; remove the chip to drop it.`;
  if (event === "size") return `Recording auto-stopped at the ${mib} MiB attachment bound and was not attached.`;
  if (event === "cancel") return "Recording discarded. Nothing was attached.";
  if (event === "empty") return "Recording stopped. No audio was captured, so nothing was attached.";
  if (event === "refused") return "Recording stopped, but the attachment was refused; nothing was attached.";
  throw new Error(`Unknown recording announcement: ${event}`);
}

// The recording state machine app.js drives. Dependencies are injected so
// the same controller runs on the real capture devices, on the node test
// fakes and on the browser guard's stubbed navigator.mediaDevices; timers are
// injectable for the same reason. Rendering, attaching and announcing stay in
// the caller: this module owns only when they happen and why.
export function createRecordingController({
  getUserMedia,
  createRecorder,
  capMs = () => MAX_RECORDING_MS,
  maxBytes = 8 * 1024 * 1024,
  tickMs = RECORDING_TICK_MS,
  timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis), now: () => Date.now() },
  attach = async () => false,
  render = () => {},
  announce = () => {},
} = {}) {
  let session = null;
  let denied = null;
  let starting = false;

  const status = () => (session ? "recording" : denied ? "denied" : "idle");
  const view = () => ({
    status: status(),
    elapsedMs: session ? timers.now() - session.startedAt : 0,
    capMs: session ? session.capMs : capMs(),
    deniedCause: denied,
  });
  const renderView = () => render(view());

  const stopTracks = (stream) => {
    for (const track of stream?.getTracks?.() ?? []) track.stop();
  };

  // Ends the live recording with its cause. MediaRecorder.stop() fires the
  // final dataavailable then stop; a recorder no longer recording (the fake
  // seams, a track that ended on its own) settles straight away.
  const finish = (cause) => {
    if (!session) return Promise.resolve({ attached: false, cause: "idle" });
    session.cause ??= cause;
    const done = session.done;
    if (session.recorder.state === "recording") {
      try { session.recorder.stop(); } catch { settle(); }
    } else {
      settle();
    }
    return done;
  };

  // The single exit: every path through here stops the MediaStream tracks,
  // clears the timers, releases the chunks and resolves the session promise.
  async function settle() {
    if (!session || session.settling) return;
    session.settling = true;
    const { stream, chunks, bytes, discard, resolve, mimeType, capMs: sessionCapMs } = session;
    const cause = session.cause ?? "stop";
    timers.clearTimeout(session.capTimer);
    timers.clearInterval(session.tickTimer);
    stopTracks(stream);
    session = null;
    renderView();
    if (discard) {
      announce(recordingAnnouncement("cancel"));
      resolve({ attached: false, cause: "cancel" });
      return;
    }
    if (bytes > maxBytes) {
      announce(recordingAnnouncement("size", { maxBytes }));
      resolve({ attached: false, cause: "size" });
      return;
    }
    if (bytes === 0 || chunks.length === 0) {
      announce(recordingAnnouncement("empty"));
      resolve({ attached: false, cause });
      return;
    }
    const attached = await attach({ chunks, mimeType, bytes });
    announce(attached ? recordingAnnouncement(cause === "cap" ? "cap" : "stop", { capMs: sessionCapMs }) : recordingAnnouncement("refused"));
    resolve({ attached: Boolean(attached), cause });
  }

  return {
    status,
    // The active MediaStream, or null: recording UI is rendered from status(),
    // which is "recording" only while this is a live stream.
    activeStream: () => session?.stream ?? null,
    elapsedMs: () => (session ? timers.now() - session.startedAt : 0),
    async start() {
      if (session || starting) return { ok: false, reason: "busy" };
      starting = true;
      denied = null;
      renderView();
      let stream;
      try {
        stream = await getUserMedia();
      } catch (error) {
        starting = false;
        denied = permissionDeniedCause(error);
        renderView();
        announce(denied);
        return { ok: false, denied };
      }
      let recorder;
      try {
        recorder = createRecorder(stream);
      } catch (error) {
        starting = false;
        stopTracks(stream);
        denied = permissionDeniedCause(error);
        renderView();
        announce(denied);
        return { ok: false, denied };
      }
      const cap = capMs();
      let resolve;
      const done = new Promise((settled) => { resolve = settled; });
      session = { stream, recorder, chunks: [], bytes: 0, startedAt: timers.now(), capMs: cap, cause: null, discard: false, settling: false, done, resolve, mimeType: recorder.mimeType || RECORDING_MIME_TYPE };
      recorder.ondataavailable = (event) => {
        if (!session || session.recorder !== recorder || !event.data?.size) return;
        session.bytes += event.data.size;
        if (session.bytes <= maxBytes) session.chunks.push(event.data);
        else finish("size");
      };
      recorder.onstop = () => {
        if (session?.recorder === recorder) settle();
      };
      recorder.start(1_000);
      session.capTimer = timers.setTimeout(() => finish("cap"), cap);
      session.tickTimer = timers.setInterval(renderView, tickMs);
      starting = false;
      renderView();
      announce(recordingAnnouncement("start", { capMs: cap, maxBytes }));
      return { ok: true };
    },
    // Plain stop: attach a removable chip.
    stop: () => finish("stop"),
    // Cancel and Escape: discard — tracks stop, chunks drop, no chip.
    cancel() {
      if (!session) return Promise.resolve({ attached: false, cause: "idle" });
      session.discard = true;
      session.cause = "cancel";
      return finish("cancel");
    },
    // Send while recording: a plain stop whose attachment the send awaits, so
    // the audio travels inside the same ordinary Turn and the tracks are
    // stopped before the request leaves.
    finishForSend: () => finish("stop"),
    // Idempotent release for exits that must never leave live tracks behind
    // (view teardown, audio chip removal): a live recording is discarded.
    ensureReleased() {
      if (!session) return Promise.resolve({ attached: false, cause: "idle" });
      session.discard = true;
      session.cause = "cancel";
      return finish("cancel");
    },
    dismissDenied() {
      if (!denied) return;
      denied = null;
      renderView();
    },
  };
}
