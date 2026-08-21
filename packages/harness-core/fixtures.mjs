export function createFixtureClient({ prefix }) {
  const calls = [];
  let next = 1;
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "thread/start") return { thread: { id: `${prefix}-thread-${next++}` } };
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      if (method === "thread/fork") return { thread: { id: `${prefix}-thread-${next++}` } };
      if (method === "thread/list") return { data: [], nextCursor: null };
      if (method === "turn/start") return { turn: { id: `${prefix}-turn-${next++}` } };
      if (method === "turn/interrupt") return {};
      throw new Error(`fixture does not implement ${method}`);
    },
    respond(id, result) {
      calls.push({ method: "respond", params: { id, result: structuredClone(result) } });
    },
  };
}
