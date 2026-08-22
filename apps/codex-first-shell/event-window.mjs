export function eventWindow(events, after, cursor, runtime) {
  const oldestCursor = events[0]?.sequence ?? cursor + 1;
  return {
    events: events.filter((entry) => entry.sequence > after),
    cursor,
    oldestCursor,
    gap: after < oldestCursor - 1,
    runtimeGeneration: runtime.generation,
    runtimeAlive: runtime.alive,
    // alive | restarting | exited | halted, and the halt that ended reuse, so
    // a browser that missed the runtimeExit/runtimeHalted events still lands
    // on the truth.
    runtimeState: runtime.state ?? (runtime.alive ? "alive" : "exited"),
    runtimeHalt: runtime.halt ?? null,
  };
}
