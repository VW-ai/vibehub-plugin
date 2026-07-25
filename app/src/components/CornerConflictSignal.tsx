import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { AdjudicationAction, ConflictCardSnapshot } from "@vibehub/core/contracts";
import type { InterventionReceiptNote } from "../receipt-note-derive";
import { ConflictCard } from "./ConflictCard";
import { ReceiptOutcome } from "./ReceiptOutcome";

type Point = { x: number; y: number };
type Size = { width: number; height: number };
type SignalPhase = "compact" | "expanded" | "receipt";

const EDGE_INSET = 8;
const KEYBOARD_STEP = 16;
const DRAG_THRESHOLD = 4;
const POSITION_KEY = "vibehub-workbench.corner-conflict-signal-position";

export function parseCornerPosition(value: string | null): Point | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<Point>;
    return Number.isFinite(parsed.x) && Number.isFinite(parsed.y)
      ? { x: Number(parsed.x), y: Number(parsed.y) }
      : null;
  } catch {
    return null;
  }
}

function loadCornerPosition(): Point | null {
  try {
    return parseCornerPosition(window.sessionStorage.getItem(POSITION_KEY));
  } catch {
    return null;
  }
}

export function clampCornerPosition(
  point: Point,
  bounds: Size,
  surface: Size,
): Point {
  return {
    x: Math.min(Math.max(EDGE_INSET, point.x), Math.max(EDGE_INSET, bounds.width - surface.width - EDGE_INSET)),
    y: Math.min(Math.max(EDGE_INSET, point.y), Math.max(EDGE_INSET, bounds.height - surface.height - EDGE_INSET)),
  };
}

function MoveIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
    <circle cx="4" cy="4" r="1" /><circle cx="10" cy="4" r="1" />
    <circle cx="4" cy="10" r="1" /><circle cx="10" cy="10" r="1" />
  </svg>;
}

function CloseIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M3.22 3.22a.75.75 0 0 1 1.06 0L8 6.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L9.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 0 1 0-1.06Z" />
  </svg>;
}

export interface CornerConflictSignalProps {
  snapshot: ConflictCardSnapshot;
  onDismiss: () => void;
  onOpenTask: (task: ConflictCardSnapshot["tasks"][number]) => void;
  onApply: (action: AdjudicationAction) => Promise<InterventionReceiptNote | string>;
}

export function CornerConflictSignal({
  snapshot,
  onDismiss,
  onOpenTask,
  onApply,
}: CornerConflictSignalProps) {
  const [phase, setPhase] = useState<SignalPhase>("compact");
  const [receipt, setReceipt] = useState<InterventionReceiptNote | null>(null);
  const [position, setPosition] = useState<Point | null>(loadCornerPosition);
  const phaseRef = useRef<SignalPhase>("compact");
  const layerRef = useRef<HTMLDivElement>(null);
  const compactRef = useRef<HTMLElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const receiptCloseRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    start: Point;
    origin: Point;
    moved: boolean;
  } | null>(null);
  phaseRef.current = phase;

  const currentPosition = (): Point | null => {
    const layer = layerRef.current?.getBoundingClientRect();
    const compact = compactRef.current?.getBoundingClientRect();
    if (!layer || !compact) return null;
    return { x: compact.left - layer.left, y: compact.top - layer.top };
  };

  const clamp = (next: Point): Point => {
    const layer = layerRef.current?.getBoundingClientRect();
    const compact = compactRef.current?.getBoundingClientRect();
    if (!layer || !compact) return next;
    return clampCornerPosition(next, layer, compact);
  };

  useLayoutEffect(() => {
    if (phase !== "compact" || position === null) return;
    const layer = layerRef.current;
    const compact = compactRef.current;
    if (!layer || !compact) return;
    const reclamp = () => setPosition((value) => {
      if (!value) return value;
      const next = clamp(value);
      return next.x === value.x && next.y === value.y ? value : next;
    });
    reclamp();
    if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(reclamp);
    observer.observe(layer);
    observer.observe(compact);
    return () => observer.disconnect();
  }, [phase, position]);

  useEffect(() => {
    if (!position) return;
    try {
      window.sessionStorage.setItem(POSITION_KEY, JSON.stringify(position));
    } catch {
      // Position remains component-local in hardened browser contexts.
    }
  }, [position]);

  useEffect(() => {
    const focus = () => {
      if (phase === "compact") expandRef.current?.focus();
      else if (phase === "receipt") receiptCloseRef.current?.focus();
      else layerRef.current?.querySelector<HTMLButtonElement>("[data-corner-collapse]")?.focus();
    };
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    if (phase === "expanded") return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (phase === "receipt") setPhase("compact");
      else onDismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onDismiss, phase]);

  const beginDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const origin = currentPosition();
    if (!origin) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin,
      moved: false,
    };
  };

  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.start.x;
    const dy = event.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    setPosition(clamp({ x: drag.origin.x + dx, y: drag.origin.y + dy }));
  };

  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  const moveByKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const delta = event.key === "ArrowLeft" ? { x: -KEYBOARD_STEP, y: 0 }
      : event.key === "ArrowRight" ? { x: KEYBOARD_STEP, y: 0 }
        : event.key === "ArrowUp" ? { x: 0, y: -KEYBOARD_STEP }
          : event.key === "ArrowDown" ? { x: 0, y: KEYBOARD_STEP }
            : null;
    if (!delta) return;
    event.preventDefault();
    const origin = position ?? currentPosition();
    if (origin) setPosition(clamp({ x: origin.x + delta.x, y: origin.y + delta.y }));
  };

  const compactStyle = position
    ? ({ left: `${position.x}px`, top: `${position.y}px`, right: "auto", bottom: "auto" } satisfies CSSProperties)
    : undefined;

  return <div className="corner-signal-layer" ref={layerRef}>
    {phase === "compact" && <aside
      className="corner-signal compact"
      ref={compactRef}
      style={compactStyle}
      role="region"
      aria-label="Conflict signal"
    >
      <span className="sr-only" role="status" aria-live="polite">Conflict signal available: work may be intersecting.</span>
      <div className="corner-signal-title">
        <button
          type="button"
          className="corner-drag"
          aria-label="Move conflict signal"
          aria-describedby="corner-drag-instructions"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={moveByKeyboard}
        ><MoveIcon /></button>
        <button
          type="button"
          className="corner-expand"
          ref={expandRef}
          aria-label="Expand conflict details"
          aria-expanded="false"
          onClick={() => setPhase("expanded")}
        >
          <span className="pill clash">CONFLICT</span>
          <span><b>Work may be intersecting</b><small>{snapshot.crumb.resourceName}</small></span>
        </button>
        <button type="button" className="corner-dismiss" aria-label="Dismiss conflict signal" onClick={onDismiss}>
          <CloseIcon />
        </button>
      </div>
      <p>{snapshot.tasks[0].title} <span aria-hidden="true">×</span> {snapshot.tasks[1].title}</p>
      <span id="corner-drag-instructions" className="sr-only">Drag with the pointer or use arrow keys to move this signal within the canvas.</span>
    </aside>}

    {phase === "expanded" && <div className="corner-signal expanded">
      <ConflictCard
        snapshot={snapshot}
        onClose={onDismiss}
        onCollapse={() => setPhase("compact")}
        onReceipt={(note) => {
          if (phaseRef.current !== "expanded") return;
          setReceipt(note);
          setPhase("receipt");
        }}
        onOpenTask={onOpenTask}
        onApply={onApply}
      />
    </div>}

    {phase === "receipt" && receipt && <section
      className="corner-signal receipt"
      role="region"
      aria-label="Conflict intervention receipt"
    >
      <span className="sr-only" role="status" aria-live="polite">Conflict intervention receipt is available.</span>
      <header>
        <button type="button" className="corner-receipt-title" onClick={() => setPhase("compact")}>
          <span className="pill alive">RECEIPT</span>
          <b>Intervention recorded</b>
        </button>
        <button type="button" className="corner-dismiss" aria-label="Dismiss conflict signal" onClick={onDismiss}>
          <CloseIcon />
        </button>
      </header>
      <p><ReceiptOutcome note={receipt} /></p>
      <button type="button" className="corner-receipt-close" ref={receiptCloseRef} onClick={onDismiss}>Close</button>
    </section>}
  </div>;
}
