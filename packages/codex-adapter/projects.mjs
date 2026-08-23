import { realpathSync } from "node:fs";
import lock from "./upstream-lock.json" with { type: "json" };

const PAGE_LIMIT = 100;
export const PINNED_THREAD_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

// Folder identity is the resolved real path so a symlinked checkout (macOS
// /tmp -> /private/tmp) and the app-server's own realpath agree. A folder that
// no longer exists keeps its recorded string so it still counts as a distinct
// folder instead of silently collapsing into another one.
export function canonicalFolder(path) {
  if (typeof path !== "string" || !path) return null;
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function sectionEligibility({ memberCount, folders }) {
  if (memberCount === 0) return "empty";
  return folders.length === 1 ? "single-folder" : "multi-folder";
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
  // The baseline is the pinned lock itself, so the Project contract cannot
  // name a different Codex than the one the schema probe proved.
  baseline: {
    package: lock.codex.package,
    version: lock.codex.version,
    commit: lock.codex.commit,
  },
  projectObject: "ThreadSection",
  projectIdentity: "server-generated UUIDv7",
  projectMembership: "Thread.section",
  // 0.149.0 added an app-server-owned Thread.projectId with no ClientRequest
  // that assigns it; it is not read as membership.
  notMembership: ["Thread.projectId"],
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
  scope: {
    defaultVisibility: "repository-folder-only",
    folderFilter: { method: "thread/list", param: "cwd", comparison: "realpath-exact" },
    recentsQuery: { method: "thread/list", sectionId: null, cwd: "repository folder" },
    hiddenHistory: "counted, never listed",
    groupVisibility: "a ThreadSection is listed when it has a member in this folder or no members at all",
  },
  binding: {
    act: "explicit single-folder Codex Project import",
    eligibility: "every member Thread, archived included, shares exactly one real folder and that folder is the repository root",
    neverMatchedBy: ["section name", "repository name"],
    record: "provenance only; ThreadSection stays the sole membership authority and is re-read on every bootstrap",
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
  constructor({ client, exposeThread = publicCodexThread, resolveFolder = canonicalFolder } = {}) {
    if (!client?.request) throw new TypeError("client.request is required");
    this.client = client;
    this.exposeThread = exposeThread;
    this.resolveFolder = resolveFolder;
  }

  async listProjects() {
    return collectPages(this.client, "threadSection/list");
  }

  async listThreads({ projectId, archived = false, searchTerm = null, sortKey, sortDirection, sourceKinds = ["cli", "vscode", "appServer"], cwd } = {}) {
    const params = {
      archived,
      searchTerm,
      sourceKinds,
      sortKey: sortKey ?? (projectId === undefined ? "recency_at" : projectId === null ? "recency_at" : "section_position"),
      sortDirection: sortDirection ?? (projectId === undefined || projectId === null ? "desc" : "asc"),
    };
    if (projectId !== undefined) params.sectionId = projectId;
    // The native folder filter: the app-server compares real paths exactly, so
    // the caller passes the resolved repository folder and nothing else.
    if (cwd !== undefined && cwd !== null) params.cwd = text(cwd, "cwd");
    return (await collectPages(this.client, "thread/list", params)).map(this.exposeThread);
  }

  // `cwd` scopes every list to one folder through the native thread/list
  // filter. Threads that live elsewhere are never returned; only their count
  // is, so the shell can say that history exists without listing it.
  async snapshot({ cwd = null } = {}) {
    const scope = cwd === null || cwd === undefined ? null : this.resolveFolder(text(cwd, "cwd"));
    const scoped = scope === null ? {} : { cwd: scope };
    const sections = await this.listProjects();
    const pinnedSection = sections.find((section) => section.id === PINNED_THREAD_SECTION_ID) ?? null;
    const projectSections = sections.filter((section) => section.id !== PINNED_THREAD_SECTION_ID);
    const [recents, pinned, ...sectionThreads] = await Promise.all([
      this.listThreads({ projectId: null, ...scoped }),
      pinnedSection ? this.listThreads({ projectId: pinnedSection.id, ...scoped }) : Promise.resolve([]),
      ...projectSections.map((section) => this.listThreads({ projectId: section.id, ...scoped })),
    ]);
    const everywhere = scope === null ? null : await this.listThreads({});
    const totalBySection = new Map();
    for (const thread of everywhere ?? []) {
      const key = thread.project?.id ?? null;
      totalBySection.set(key, (totalBySection.get(key) ?? 0) + 1);
    }
    const projects = projectSections.map((section, index) => {
      const threads = sectionThreads[index];
      const project = { id: section.id, name: section.name, threads };
      if (scope !== null) {
        project.scopedCount = threads.length;
        project.totalCount = totalBySection.get(section.id) ?? 0;
        project.hiddenElsewhere = Math.max(0, project.totalCount - threads.length);
      }
      return project;
    });
    const scopedCount = pinned.length + recents.length + projects.reduce((sum, project) => sum + project.threads.length, 0);
    return {
      projects,
      pinned,
      recents,
      threads: [...pinned, ...recents, ...projects.flatMap((project) => project.threads)],
      capabilities: CODEX_PROJECT_CAPABILITIES,
      folderScope: scope === null ? null : {
        cwd: scope,
        scopedCount,
        totalCount: everywhere.length,
        hiddenChats: Math.max(0, everywhere.length - scopedCount),
        hiddenGroups: projects.filter((project) => project.scopedCount === 0 && project.totalCount > 0).length,
      },
    };
  }

  // Import eligibility is derived, never declared: a ThreadSection carries no
  // folder of its own, so its folder set is the real paths of every member
  // Thread, archived ones included. Exactly one folder equal to the repository
  // root is the only importable shape; names never take part in the match.
  async importableProjects({ repositoryRoot }) {
    const target = this.resolveFolder(text(repositoryRoot, "repositoryRoot"));
    const sections = (await this.listProjects()).filter((section) => section.id !== PINNED_THREAD_SECTION_ID);
    const projects = await Promise.all(sections.map(async (section) => {
      const [active, archived] = await Promise.all([
        this.listThreads({ projectId: section.id, archived: false }),
        this.listThreads({ projectId: section.id, archived: true }),
      ]);
      const members = [...active, ...archived];
      const folders = [...new Set(members.map((thread) => this.resolveFolder(thread.cwd)).filter(Boolean))].sort();
      const eligibility = sectionEligibility({ memberCount: members.length, folders });
      const matchesRepository = eligibility === "single-folder" && folders[0] === target;
      return {
        id: section.id,
        name: section.name,
        memberCount: members.length,
        archivedCount: archived.length,
        folders,
        eligibility,
        matchesRepository,
        importable: matchesRepository,
        reason: matchesRepository
          ? null
          : eligibility === "empty"
            ? "This Codex Project has no chats, so it has no folder to match."
            : eligibility === "multi-folder"
              ? `This Codex Project spans ${folders.length} folders; only a single-folder Codex Project can be imported.`
              : "This Codex Project's only folder is a different repository.",
      };
    }));
    return {
      repositoryRoot: target,
      projects,
      rule: { eligibility: "single-folder", match: "realpath(folder) === realpath(repositoryRoot)", byName: false },
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
