#!/usr/bin/env node
import { writeFileSync, realpathSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildUiSnapshot } from "../../../skills/vibehub-core/scripts/vh-ui.mjs";
import { discoverDashboard } from "../../../skills/vibehub-core/scripts/dashboard-data.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(resolve(here, "../../.."));
const discoveryRoot = dirname(repoRoot);
const outPath = join(here, "repo-data.json");

function titleFromId(id) {
  const raw = String(id || "")
    .replace(/^(ticket|goal|epic|context)-/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!raw) return id;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function laneFor(ticket) {
  const action = ticket.capabilities?.nextAction?.summary?.action || "";
  const attention = ticket.capabilities?.attention?.summary?.label || "NONE";
  if (action === "DONE" || ticket.workState?.state === "DONE") return "done";
  if (attention === "PENDING" || action === "NEEDS_HUMAN") return "attention";
  if (action === "WAIT" || ticket.workState?.state === "BLOCKED") return "waiting";
  if (action === "REFINE" || action === "REPLAN" || ticket.workState?.state === "NEEDS_REFINEMENT" || ticket.workState?.state === "NEEDS_REPLAN") {
    return "planned";
  }
  if (action === "CLOSE_OUT" || ticket.workState?.state === "AWAITING_REVIEW") return "ready";
  if (action === "EXECUTE" || ticket.workState?.state === "READY") return "ready";
  return "planned";
}

function remoteUrl(path) {
  try {
    const url = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    return url.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
  } catch {
    return null;
  }
}

function branchName(path) {
  try {
    return execFileSync("git", ["-C", path, "branch", "--show-current"], { encoding: "utf8" }).trim() || "main";
  } catch {
    return "main";
  }
}

function snapshotProject(projectPath) {
  const { graph, state } = buildUiSnapshot(projectPath, { scope: "all" });
  const branch = branchName(projectPath);
  const remote = remoteUrl(projectPath);

  const goals = [];
  for (const entry of graph.hierarchy?.goals || []) {
    const goal = entry.goal;
    goals.push({
      id: goal.goal_id,
      title: goal.title || titleFromId(goal.goal_id),
      outcome: goal.description || (goal.success_criteria || []).join(" "),
      kind: "goal"
    });
  }
  for (const entry of graph.hierarchy?.epics || []) {
    const epic = entry.epic;
    goals.push({
      id: epic.epic_id,
      title: epic.title || titleFromId(epic.epic_id),
      outcome: epic.outcome || "",
      partOf: epic.goal_id,
      kind: "epic"
    });
  }

  const epicGoal = new Map();
  for (const entry of graph.hierarchy?.epics || []) {
    epicGoal.set(entry.epic.epic_id, entry.epic.goal_id);
    for (const ticketId of entry.ticket_ids || []) {
      epicGoal.set(ticketId, entry.epic.goal_id);
    }
  }

  const requiresByTicket = new Map();
  for (const relation of graph.relations || []) {
    const dependent = relation.dependentTicketId || relation.dependent_ticket_id;
    const prerequisite = relation.prerequisiteTicketId || relation.prerequisite_ticket_id;
    if (!dependent || !prerequisite) continue;
    if (!requiresByTicket.has(dependent)) requiresByTicket.set(dependent, []);
    requiresByTicket.get(dependent).push(prerequisite);
  }

  const tickets = (graph.tickets || []).map((ticket) => {
    const id = ticket.ticketId || ticket.ticket_id;
    const goalId = ticket.hierarchy?.goal?.goal_id
      || ticket.goal_id
      || ticket.hierarchy?.epic?.goal_id
      || epicGoal.get(id)
      || epicGoal.get(ticket.epic_id)
      || null;
    const epicId = ticket.hierarchy?.epic?.epic_id || ticket.epic_id || null;
    return {
      id,
      title: ticket.title || titleFromId(id),
      state: laneFor(ticket),
      goal: goalId,
      epic: epicId,
      requires: requiresByTicket.get(id) || ticket.requires || [],
      outcome: ticket.outcome || "",
      branches: [branch],
      acceptance: (ticket.acceptance || []).map((item) => item.criterion || item)
    };
  });

  const roomList = Array.isArray(state.rooms) ? state.rooms : (state.rooms?.rooms || []);
  const depthOf = (room, seen = new Set()) => {
    if (!room?.parent || seen.has(room.room)) return 0;
    seen.add(room.room);
    const parent = roomList.find((item) => item.room === room.parent || item.roomId === room.parent);
    return parent ? depthOf(parent, seen) + 1 : 0;
  };
  const rooms = roomList.map((room) => {
    const raw = room.records || room.contexts || [];
    return {
      room: room.room,
      path: room.path || `.vibehub/rooms/${room.room}`,
      depth: room.depth ?? depthOf(room),
      records: raw.map((ctx) => ({
        id: ctx.context_id || ctx.contextId,
        type: ctx.type || "note",
        title: ctx.title || titleFromId(ctx.context_id || ctx.contextId),
        summary: ctx.summary || "",
        detail: ctx.detail || "",
        state: ctx.state || "active",
        tags: ctx.tags || [],
        relations: (ctx.relations || []).map((rel) => ({
          type: rel.type,
          target: rel.target_context_id || rel.targetContextId || rel.target
        })).filter((rel) => rel.target),
        source: ctx.source ? { ref: ctx.source.ref || ctx.source } : undefined,
        path: ctx.path,
        room: room.room
      }))
    };
  });

  const authorities = rooms
    .flatMap((room) => room.records)
    .filter((record) => record.type === "authority")
    .map((record) => ({
      id: record.id,
      category: "Authority",
      title: record.title,
      summary: record.summary,
      files: record.path,
      approval: "Owner approval for changes",
      path: record.path
    }));

  return {
    id: basename(projectPath),
    checkout: {
      id: branch,
      branch,
      name: basename(projectPath),
      path: projectPath,
      remote
    },
    goals,
    tickets,
    rooms,
    authorities,
    counts: {
      tickets: tickets.length,
      open: tickets.filter((ticket) => ticket.state !== "done").length,
      goals: goals.length,
      contexts: rooms.reduce((sum, room) => sum + room.records.length, 0)
    }
  };
}

const discovered = discoverDashboard([discoveryRoot]);
const preferred = new Map();
for (const project of discovered.projects) {
  const preferredTree = project.worktrees.find((tree) => tree.path === repoRoot && tree.available)
    || project.worktrees.find((tree) => tree.available && tree.hasTickets)
    || project.worktrees.find((tree) => tree.available);
  if (!preferredTree) continue;
  preferred.set(project.id, { project, tree: preferredTree });
}

if (![...preferred.values()].some(({ tree }) => tree.path === repoRoot) && existsSync(join(repoRoot, ".vibehub"))) {
  preferred.set("current", {
    project: { id: "current", name: basename(repoRoot), path: repoRoot, worktrees: [] },
    tree: { path: repoRoot, branch: branchName(repoRoot), available: true, hasTickets: true }
  });
}

const projects = [];
const errors = [];
for (const { project, tree } of preferred.values()) {
  try {
    const snap = snapshotProject(tree.path);
    projects.push({
      ...snap,
      projectId: project.id,
      connectedVia: project.connectedVia || "repository",
      worktrees: (project.worktrees || []).map((item) => ({
        id: item.id,
        path: item.path,
        branch: item.branch,
        available: item.available,
        hasTickets: item.hasTickets
      }))
    });
  } catch (error) {
    errors.push({ path: tree.path, message: error.message || String(error) });
    projects.push({
      projectId: project.id,
      checkout: {
        id: tree.branch || "main",
        branch: tree.branch || branchName(tree.path),
        name: basename(tree.path),
        path: tree.path,
        remote: remoteUrl(tree.path)
      },
      goals: [],
      tickets: [],
      rooms: [],
      authorities: [],
      counts: { tickets: 0, open: 0, goals: 0, contexts: 0 },
      loadError: error.message || String(error),
      connectedVia: project.connectedVia || "repository",
      worktrees: (project.worktrees || []).map((item) => ({
        id: item.id,
        path: item.path,
        branch: item.branch,
        available: item.available,
        hasTickets: item.hasTickets
      }))
    });
  }
}

projects.sort((a, b) => {
  if (a.checkout.path === repoRoot) return -1;
  if (b.checkout.path === repoRoot) return 1;
  return a.checkout.name.localeCompare(b.checkout.name);
});

const active = projects.find((item) => item.checkout.path === repoRoot) || projects[0];
if (!active) {
  console.error("No VibeHub projects discovered under", discoveryRoot);
  process.exit(1);
}

const payload = {
  generatedAt: new Date().toISOString(),
  discoveryRoot,
  activeProjectId: active.projectId,
  projects,
  checkout: active.checkout,
  goals: active.goals,
  tickets: active.tickets,
  rooms: active.rooms,
  authorities: active.authorities,
  counts: active.counts,
  discovery: {
    warnings: discovered.warnings || [],
    errors
  }
};

writeFileSync(outPath, `${JSON.stringify(payload)}\n`);
console.log(`Wrote ${outPath}`);
console.log(`Discovery root ${discoveryRoot}`);
console.log(`${projects.length} projects · active ${active.checkout.name}`);
for (const project of projects) {
  console.log(`- ${project.checkout.name}: ${project.counts.tickets} tickets (${project.counts.open} open) · ${project.counts.goals} goals · ${project.counts.contexts} contexts`);
}
if (errors.length) {
  console.log(`Skipped ${errors.length} checkout(s):`);
  for (const error of errors) console.log(`- ${error.path}: ${error.message}`);
}
