// The Composer growth ceiling has exactly one owner: the `.composer textarea`
// CSS rule. JavaScript reads the computed bounds and clamps scrollHeight inside
// them, so the mounted height can never claim more than CSS paints. The
// fallback only covers a missing stylesheet and is pinned to the CSS by test.
export const COMPOSER_HEIGHT_FALLBACK = Object.freeze({ min: 34, max: 190 });

function pixels(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function composerBounds(style, fallback = COMPOSER_HEIGHT_FALLBACK) {
  const min = pixels(style?.minHeight, fallback.min);
  const max = Math.max(min, pixels(style?.maxHeight, fallback.max));
  return { min, max };
}

export function clampComposerHeight(scrollHeight, bounds = COMPOSER_HEIGHT_FALLBACK) {
  const measured = Number.isFinite(scrollHeight) ? scrollHeight : 0;
  return Math.min(bounds.max, Math.max(bounds.min, measured));
}
