export function eventWindow(events, after, cursor, runtime) {
  const oldestCursor = events[0]?.sequence ?? cursor + 1;
  return {
    events: events.filter((entry) => entry.sequence > after),
    cursor,
    oldestCursor,
    gap: after < oldestCursor - 1,
    runtimeGeneration: runtime.generation,
    runtimeAlive: runtime.alive,
  };
}
