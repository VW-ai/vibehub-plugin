import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function valid(value) {
  return value
    && typeof value.ticketId === "string"
    && typeof value.harnessId === "string"
    && typeof value.conversationId === "string";
}

export function createMemoryAssociationStore(seed = []) {
  const rows = new Map(seed.map((row) => [row.ticketId, structuredClone(row)]));
  return {
    async put(row) {
      if (!valid(row)) throw new Error("Invalid Task-to-conversation association");
      rows.set(row.ticketId, structuredClone(row));
    },
    async get(ticketId) {
      return rows.has(ticketId) ? structuredClone(rows.get(ticketId)) : null;
    },
    async list() {
      return [...rows.values()].map((row) => structuredClone(row)).sort((a, b) => a.ticketId.localeCompare(b.ticketId));
    },
    async close() {},
  };
}

export async function createFileAssociationStore(path) {
  let seed = [];
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.associations) || !parsed.associations.every(valid)) {
      throw new Error("Invalid association store");
    }
    seed = parsed.associations;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const memory = createMemoryAssociationStore(seed);
  const persist = async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.next`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, associations: await memory.list() }, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  };
  return {
    async put(row) {
      await memory.put(row);
      await persist();
    },
    get: memory.get,
    list: memory.list,
    async close() {},
    async remove() {
      await rm(path, { force: true });
      await rm(`${path}.next`, { force: true });
    },
  };
}
