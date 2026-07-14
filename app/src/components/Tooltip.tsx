import { useEffect, useRef } from "react";

/**
 * Global tooltip, ported 1:1 from v8: any element carrying [data-tip] gets a
 * dark tooltip after a 260ms intent delay; hide is instant; position flips
 * above the anchor when the viewport bottom is near, and clamps horizontally.
 * Document-level delegation (like v8) so every component only has to render
 * data-tip attributes — no per-node wiring, identical timing semantics.
 */
const INTENT_DELAY_MS = 260; // v8 value — frozen
const MAX_WIDTH_GUARD = 286; // v8: tooltip max-width 270 + 16 slack
const EDGE_PAD = 8;
const BOTTOM_GUARD = 90; // v8 flip threshold

export function Tooltip() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const over = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const n = target?.closest?.("[data-tip]") as HTMLElement | null;
      clearTimeout(timer);
      if (!n) {
        tip.classList.remove("on");
        return;
      }
      timer = setTimeout(() => {
        tip.textContent = n.dataset.tip ?? "";
        const r = n.getBoundingClientRect();
        tip.style.left = `${Math.max(EDGE_PAD, Math.min(r.left, window.innerWidth - MAX_WIDTH_GUARD))}px`;
        tip.style.top =
          r.bottom + EDGE_PAD > window.innerHeight - BOTTOM_GUARD
            ? `${r.top - EDGE_PAD - tip.offsetHeight}px`
            : `${r.bottom + EDGE_PAD}px`;
        tip.classList.add("on");
      }, INTENT_DELAY_MS);
    };
    const out = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.("[data-tip]")) {
        clearTimeout(timer);
        tip.classList.remove("on");
      }
    };

    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
    };
  }, []);

  return <div id="tip" ref={ref} />;
}
