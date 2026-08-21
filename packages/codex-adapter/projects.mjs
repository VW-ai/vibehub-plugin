const PAGE_LIMIT = 100;
export const PINNED_THREAD_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

async function collectPages(client, method, params = {}) {
  const data = [];
  let cursor = null;
  do {
    const page = await client.request(method, { ...params, cursor, limit: PAGE_LIMIT });
    data.push(...(page.data ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return data;
}

export const CODEX_PROJECT_CAPABILITIES = Object.freeze({
  schemaVersion: 1,
  baseline: {
    package: "@openai/codex",
    version: "0.147.0",
    commit: "be6e8eac029b183056b7e4402879f15d2c85f61b",
  },
  projectObject: "ThreadSection",
  projectIdentity: "server-generated UUIDv7",
  projectMembership: "Thread.section",
  pinnedSectionId: PINNED_THREAD_SECTION_ID,
  recentsQuery: { method: "thread/list", sectionId: null, sortKey: "recency_at" },
  methods: {
    listProjects: "threadSection/list",
    createProject: "threadSection/create",
    renameProject: "threadSection/update",
    deleteProject: "threadSection/delete",
    listChats: "thread/list",
    moveChat: "thread/section/move",
    forkChat: "thread/fork",
    readChat: "thread/read",
    archiveChat: "thread/archive",
    unarchiveChat: "thread/unarchive",
  },
  unsupported: {
    projectDescription: true,
    projectIcon: true,
    projectToVibeHubProjectIdentity: true,
    movingChatChangesCwd: false,
    movingChatMovesVibeHubTask: false,
  },
});

export function publicCodexThread(thread) {
  const section = thread.section ?? null;
  return {
    id: thread.id,
    title: thread.name || thread.preview?.split("\n")[0]?.slice(0, 72) || "Untitled chat",
    preview: thread.preview ?? "",
    cwd: thread.cwd,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.recencyAt ?? null,
    status: thread.status,
    source: thread.source,
    forkedFromId: thread.forkedFromId ?? null,
    project: section ? { id: section.id, name: section.name } : null,
  };
}

export class CodexProjectsAdapter {
  constructor({ client, exposeThread = publicCodexThread } = {}) {
    if (!client?.request) throw new TypeError("client.request is required");
    this.client = client;
    this.exposeThread = exposeThread;
  }

  async listProjects() {
    return collectPages(this.client, "threadSection/list");
  }

  async listThreads({ projectId, archived = false, searchTerm = null, sortKey, sortDirection, sourceKinds = ["cli", "vscode", "appServer"] } = {}) {
    const params = {
      archived,
      searchTerm,
      sourceKinds,
      sortKey: sortKey ?? (projectId === undefined ? "recency_at" : projectId === null ? "recency_at" : "section_position"),
      sortDirection: sortDirection ?? (projectId === undefined || projectId === null ? "desc" : "asc"),
    };
    if (projectId !== undefined) params.sectionId = projectId;
    return (await collectPages(this.client, "thread/list", params)).map(this.exposeThread);
  }

  async snapshot() {
    const sections = await this.listProjects();
    const pinnedSection = sections.find((section) => section.id === PINNED_THREAD_SECTION_ID) ?? null;
    const projectSections = sections.filter((section) => section.id !== PINNED_THREAD_SECTION_ID);
    const [recents, pinned, ...sectionThreads] = await Promise.all([
      this.listThreads({ projectId: null }),
      pinnedSection ? this.listThreads({ projectId: pinnedSection.id }) : Promise.resolve([]),
      ...projectSections.map((section) => this.listThreads({ projectId: section.id })),
    ]);
    const projects = projectSections.map((section, index) => ({
      id: section.id,
      name: section.name,
      threads: sectionThreads[index],
    }));
    return {
      projects,
      pinned,
      recents,
      threads: [...pinned, ...recents, ...projects.flatMap((project) => project.threads)],
      capabilities: CODEX_PROJECT_CAPABILITIES,
    };
  }

  async createProject(name) {
    return this.client.request("threadSection/create", { name: text(name, "name") });
  }

  async renameProject(projectId, name) {
    if (projectId === PINNED_THREAD_SECTION_ID) throw new Error("Pinned is a built-in Codex section and cannot be renamed");
    return this.client.request("threadSection/update", {
      sectionId: text(projectId, "projectId"),
      name: text(name, "name"),
    });
  }

  async deleteProject(projectId) {
    if (projectId === PINNED_THREAD_SECTION_ID) throw new Error("Pinned is a built-in Codex section and cannot be deleted");
    return this.client.request("threadSection/delete", { sectionId: text(projectId, "projectId") });
  }

  async moveThread(threadId, projectId, { beforeThreadId = null } = {}) {
    if (projectId !== null) text(projectId, "projectId");
    return this.client.request("thread/section/move", {
      threadId: text(threadId, "threadId"),
      sectionId: projectId,
      beforeThreadId,
    });
  }

  async forkThread(threadId, { lastTurnId = null, projectId } = {}) {
    const source = await this.client.request("thread/read", {
      threadId: text(threadId, "threadId"),
      includeTurns: false,
    });
    const inheritedProjectId = projectId === undefined ? source.thread.section?.id ?? null : projectId;
    if (inheritedProjectId !== null) text(inheritedProjectId, "projectId");
    const result = await this.client.request("thread/fork", {
      threadId,
      lastTurnId,
      ephemeral: false,
    });
    let placement = { desiredProjectId: inheritedProjectId, applied: true, fallback: null };
    try {
      await this.moveThread(result.thread.id, inheritedProjectId);
    } catch (error) {
      placement = {
        desiredProjectId: inheritedProjectId,
        applied: false,
        fallback: "fork-remains-visible-in-unsectioned-recents",
        error: error.message,
      };
    }
    const refreshed = await this.client.request("thread/read", { threadId: result.thread.id, includeTurns: true });
    return { ...result, thread: refreshed.thread, placement };
  }

  async archiveThread(threadId) {
    return this.client.request("thread/archive", { threadId: text(threadId, "threadId") });
  }

  async unarchiveThread(threadId) {
    return this.client.request("thread/unarchive", { threadId: text(threadId, "threadId") });
  }
}
