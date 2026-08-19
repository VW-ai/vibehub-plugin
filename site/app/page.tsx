"use client";

import Image from "next/image";
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

type TicketMoment = "planning" | "done";
type Brand = "codex" | "claude" | "github";
type WorkbenchLens = "execution" | "contract" | "log";
type WorkbenchState = "READY" | "BLOCKED" | "DONE";
type AttentionState = "UPCOMING" | "COMPLETE";
type WorkbenchContextKind = "DECISION" | "CONSTRAINT" | "CONTRACT" | "REFERENCE";

type WorkbenchTicket = {
  id: string;
  title: string;
  description: string;
  state: WorkbenchState;
  requires: string[];
  room: string;
  x: number;
  y: number;
  acceptance: Array<{ label: string; human?: boolean }>;
  evidence: string[];
  outcome: string;
};

type WorkbenchRoom = {
  id: string;
  label: string;
  boundary: string;
  contexts: Array<{
    kind: WorkbenchContextKind;
    title: string;
    detail: string;
    source: string;
    usedBy: string[];
  }>;
  tickets: string[];
};

const GITHUB = "https://github.com/VW-ai/vibehub-plugin";
const CODEX_INSTALL = "codex plugin marketplace add VW-ai/vibehub-plugin";
const CLAUDE_INSTALL = "/plugin marketplace add VW-ai/vibehub-plugin\n/plugin install vibehub@vibehub\n/reload-plugins";
const EXAMPLE_REQUEST = "Add dark mode to this task app.";
const EXAMPLE_AGENT_MESSAGE = `${EXAMPLE_REQUEST} Start this with VibeHub.`;

const WORKBENCH_FIXTURE: { tickets: WorkbenchTicket[]; rooms: WorkbenchRoom[] } = {
  tickets: [
    {
      id: "VH-201",
      title: "Define theme tokens",
      description: "Establish one semantic palette contract for the task app.",
      state: "DONE",
      requires: [],
      room: "interface",
      x: 5,
      y: 13,
      acceptance: [{ label: "Light and dark tokens share semantic names" }],
      evidence: ["Token contrast assertions", "Theme map source review"],
      outcome: "Theme tokens are proven and available downstream.",
    },
    {
      id: "VH-202",
      title: "Persist preference",
      description: "Store a manual choice without overriding system defaults.",
      state: "DONE",
      requires: [],
      room: "product",
      x: 5,
      y: 61,
      acceptance: [{ label: "Manual preference survives reload" }],
      evidence: ["Storage unit test", "Reload verification"],
      outcome: "Preference persistence is independently accepted.",
    },
    {
      id: "VH-204",
      title: "Persistent dark mode",
      description: "Ship system-aware dark mode with one explicit human palette choice.",
      state: "READY",
      requires: ["VH-201", "VH-202"],
      room: "product",
      x: 39,
      y: 37,
      acceptance: [
        { label: "Follow the operating-system theme" },
        { label: "Apply the user override immediately" },
        { label: "Choose the dark palette", human: true },
        { label: "Avoid an incorrect-theme flash" },
      ],
      evidence: ["Preference unit tests", "Light / dark browser capture", "Reload verification"],
      outcome: "All four conditions were independently accepted.",
    },
    {
      id: "VH-205",
      title: "Ship theme controls",
      description: "Expose the accepted theme behavior in the settings surface.",
      state: "BLOCKED",
      requires: ["VH-204"],
      room: "interface",
      x: 73,
      y: 18,
      acceptance: [{ label: "Control reflects the accepted theme contract" }],
      evidence: [],
      outcome: "Theme controls are ready to execute after the dark-mode Ticket closes.",
    },
    {
      id: "VH-203",
      title: "Refine empty-state copy",
      description: "Independent interface work outside the selected causal cone.",
      state: "READY",
      requires: [],
      room: "interface",
      x: 73,
      y: 64,
      acceptance: [{ label: "Copy is concise and actionable" }],
      evidence: [],
      outcome: "Empty-state copy is ready for execution.",
    },
  ],
  rooms: [
    {
      id: "product",
      label: "Product",
      boundary: "Behavior, intent, and durable user choices.",
      contexts: [
        {
          kind: "DECISION",
          title: "Manual preference wins",
          detail: "A deliberate palette choice overrides the system theme and remains available to later Tickets.",
          source: "Product decision",
          usedBy: ["VH-202", "VH-204"],
        },
        {
          kind: "CONSTRAINT",
          title: "Respect the system by default",
          detail: "Without a manual choice, follow the operating-system theme.",
          source: "Theme constraint",
          usedBy: ["VH-204"],
        },
        {
          kind: "CONTRACT",
          title: "Theme preference contract",
          detail: "Support system, light, and dark; apply immediately and survive reload.",
          source: "Settings contract",
          usedBy: ["VH-202", "VH-204"],
        },
        {
          kind: "REFERENCE",
          title: "Current appearance settings",
          detail: "The existing settings surface is the integration point for the theme control.",
          source: "Repository reference",
          usedBy: ["VH-205"],
        },
      ],
      tickets: ["VH-202", "VH-204"],
    },
    {
      id: "interface",
      label: "Interface",
      boundary: "Visual tokens, controls, and user-facing states.",
      contexts: [
        {
          kind: "DECISION",
          title: "Selection stays neutral",
          detail: "Selection uses outline and elevation instead of borrowing an execution-state color.",
          source: "Interface decision",
          usedBy: ["VH-203", "VH-205"],
        },
        {
          kind: "CONSTRAINT",
          title: "Semantic color only",
          detail: "Green, red, and amber communicate truthful state rather than decoration.",
          source: "Visual constraint",
          usedBy: ["VH-201", "VH-205"],
        },
        {
          kind: "CONTRACT",
          title: "Shared theme tokens",
          detail: "Light and dark palettes expose the same semantic token names.",
          source: "Token contract",
          usedBy: ["VH-201"],
        },
        {
          kind: "REFERENCE",
          title: "Existing control language",
          detail: "Reuse the settings control shape, focus treatment, and 44px narrow target.",
          source: "Interface reference",
          usedBy: ["VH-205"],
        },
      ],
      tickets: ["VH-201", "VH-203", "VH-205"],
    },
  ],
};

const PUBLIC_TICKET_FILE = {
  acceptance: [
    {
      acceptance_id: "follows-system-theme",
      criterion: "Without a manual choice, the app follows the operating-system theme.",
    },
    {
      acceptance_id: "applies-user-override",
      criterion: "A light or dark override applies immediately and survives reload.",
    },
    {
      acceptance_id: "human-chooses-palette",
      authority: "human",
      criterion: "The owner chooses the final dark palette.",
    },
    {
      acceptance_id: "avoids-theme-flash",
      criterion: "The initial render never flashes the incorrect theme.",
    },
  ],
  constraints: [
    "Reuse the existing settings surface and semantic theme tokens.",
    "Keep the final palette choice under human authority.",
  ],
  context: "The task app needs system-aware dark mode. Existing product Context says a deliberate user choice wins over the system default.",
  context_refs: [
    {
      ref: ".vibehub/rooms/product/decision-manual-preference-wins.yaml",
      purpose: "Binding precedence rule for the selected theme.",
    },
    {
      ref: ".vibehub/rooms/product/contract-theme-preference.yaml",
      purpose: "Persistence and immediate-application behavior.",
    },
  ],
  kind: "ticket",
  maturity: "firm",
  outcome: "Ship system-aware dark mode with one explicit human palette choice.",
  provenance_refs: ["conversation:demo-dark-mode-request"],
  relations: [
    {
      type: "depends_on",
      target_ticket_id: "vh-201",
      rationale: "Semantic theme tokens must exist first.",
    },
    {
      type: "depends_on",
      target_ticket_id: "vh-202",
      rationale: "Preference persistence must exist first.",
    },
  ],
  schema_version: 1,
  ticket_id: "vh-204",
};

type SourceFile = {
  label: string;
  path: string;
  kind: "ROOM" | "DECISION" | "CONSTRAINT" | "CONTRACT";
  content: Record<string, unknown>;
};

const ROOM_SOURCE_FILES: SourceFile[] = [
  {
    label: "Room",
    path: ".vibehub/rooms/product/room.yaml",
    kind: "ROOM",
    content: {
      anchors: ["src/theme/", "src/settings/"],
      boundary: "Product behavior, durable user choices, and the contracts that govern them.",
      description: "The durable product knowledge needed by theme and settings work.",
      kind: "room",
      room_id: "product",
      schema_version: 1,
      stale: false,
    },
  },
  {
    label: "Decision",
    path: ".vibehub/rooms/product/decision-manual-preference-wins.yaml",
    kind: "DECISION",
    content: {
      context_id: "decision-manual-preference-wins",
      detail: "A deliberate light or dark choice overrides the system theme until the user returns to system mode.",
      evidence: [{ ref: "conversation:demo-dark-mode-request", note: "The owner explicitly chose manual override behavior." }],
      kind: "context",
      relations: [{ type: "relates_to", target_context_id: "contract-theme-preference" }],
      schema_version: 1,
      source: {
        captured_at: "2026-08-19T18:00:00Z",
        quote: "Let people override the system theme.",
        ref: "conversation:demo-dark-mode-request",
      },
      state: "active",
      summary: "Manual preference wins",
      tags: ["product", "theme", "preference"],
      type: "decision",
    },
  },
  {
    label: "Constraint",
    path: ".vibehub/rooms/product/constraint-system-theme-default.yaml",
    kind: "CONSTRAINT",
    content: {
      context_id: "constraint-system-theme-default",
      detail: "When no manual preference exists, the app must follow the operating-system color scheme.",
      evidence: [{ ref: "ticket:vh-204", note: "The Ticket binds this rule as an acceptance condition." }],
      kind: "context",
      relations: [{ type: "relates_to", target_context_id: "decision-manual-preference-wins" }],
      schema_version: 1,
      source: { captured_at: "2026-08-19T18:03:00Z", ref: "conversation:demo-dark-mode-request" },
      state: "active",
      summary: "Respect the system by default",
      tags: ["constraint", "system-theme", "theme"],
      type: "constraint",
    },
  },
  {
    label: "Contract",
    path: ".vibehub/rooms/product/contract-theme-preference.yaml",
    kind: "CONTRACT",
    content: {
      context_id: "contract-theme-preference",
      detail: "The appearance setting supports system, light, and dark; changes apply immediately and persist across reloads.",
      evidence: [{ ref: "file:src/settings/theme.ts", note: "This module owns the persisted appearance setting." }],
      kind: "context",
      relations: [{ type: "depends_on", target_context_id: "decision-manual-preference-wins" }],
      schema_version: 1,
      source: { captured_at: "2026-08-19T18:05:00Z", ref: "repository:appearance-settings" },
      state: "active",
      summary: "Theme preference contract",
      tags: ["contract", "persistence", "settings", "theme"],
      type: "contract",
    },
  },
];

const WORKBENCH_EDGES = [
  { id: "VH-201:VH-204", from: "VH-201", to: "VH-204", x: 27, y: 26, width: 18, angle: 55 },
  { id: "VH-202:VH-204", from: "VH-202", to: "VH-204", x: 27, y: 69, width: 18, angle: -54 },
  { id: "VH-204:VH-205", from: "VH-204", to: "VH-205", x: 61, y: 49, width: 18, angle: -48 },
];

const SITE_AGENT_BRIEF = `Help me install and use VibeHub in this repository.

VibeHub is a lightweight, Skill-first plugin that turns one concrete development request into a Git-native Ticket cycle a coding Agent can plan, execute, prove, and independently close.

Codex marketplace:
${CODEX_INSTALL}

Claude Code:
${CLAUDE_INSTALL}

After installation, open the repository in a fresh Agent session. Describe one concrete deliverable, then say exactly: "Start this with VibeHub."

Request and existing Context shape one Ticket. Work produces acceptance-linked Evidence. A separate Agent decides the Outcome. Durable learning returns to Context. Checked-in files remain the source of truth; Git owns history, review, rollback, and collaboration.

Source: ${GITHUB}`;

async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Embedded browsers can reject Clipboard. Fall through while the same
      // user gesture is still active.
    }
  }

  const transfer = document.createElement("textarea");
  transfer.value = value;
  transfer.setAttribute("readonly", "");
  transfer.style.position = "fixed";
  transfer.style.opacity = "0";
  transfer.style.pointerEvents = "none";
  document.body.appendChild(transfer);
  transfer.select();
  const copied = document.execCommand("copy");
  transfer.remove();
  if (!copied) throw new Error("Clipboard copy was rejected");
}

function CopyGlyph() {
  return <span className="copy-glyph" aria-hidden="true" />;
}

function ArrowGlyph() {
  return <span className="arrow-glyph" aria-hidden="true">↗</span>;
}

function BrandIcon({ brand }: { brand: Brand }) {
  const source = brand === "codex" ? "/brands/codex.png" : brand === "claude" ? "/brands/claude-code.png" : "/brands/github.svg";
  return <Image className={`brand-symbol brand-symbol-${brand}`} src={source} width={24} height={24} alt="" aria-hidden="true" unoptimized />;
}

function SiteHeader({ copied, onCopy, pastHero }: { copied: string | null; onCopy: (value: string, key: string) => void; pastHero: boolean }) {
  return (
    <header className={`showcase-header ${pastHero ? "is-past-hero" : ""}`}>
      <div className="showcase-header-inner">
        <a className="showcase-brand" href="#top" aria-label="VibeHub home">
          <span className="app-brand"><Image src="/vibehub-mark.svg" width={20} height={21} alt="" priority /></span>
          <strong>VibeHub</strong>
        </a>
        <nav className="showcase-utilities" aria-label="Install and source actions">
          <button type="button" aria-label="Copy Codex installation command" title="Install for Codex" onClick={() => onCopy(CODEX_INSTALL, "codex")}><BrandIcon brand="codex" /><span>{copied === "codex" ? "Copied" : "Codex"}</span></button>
          <button type="button" aria-label="Copy Claude Code installation steps" title="Install for Claude Code" onClick={() => onCopy(CLAUDE_INSTALL, "claude")}><BrandIcon brand="claude" /><span>{copied === "claude" ? "Copied" : "Claude"}</span></button>
          <a href={GITHUB} target="_blank" rel="noreferrer" aria-label="Open VibeHub on GitHub" title="GitHub"><BrandIcon brand="github" /><span>GitHub</span></a>
          <button type="button" className="topbar-copy" aria-label="Copy for Agent" onClick={() => onCopy(SITE_AGENT_BRIEF, "agent")}><CopyGlyph /><span>{copied === "agent" ? "Copied" : "Copy for Agent"}</span></button>
        </nav>
      </div>
    </header>
  );
}

function InstallActions({ copied, onCopy }: { copied: string | null; onCopy: (value: string, key: string) => void }) {
  return (
    <div className="showcase-actions" aria-label="Install and view VibeHub">
      <button type="button" onClick={() => onCopy(CODEX_INSTALL, "codex")}><BrandIcon brand="codex" /><span><b>Install for Codex</b><small>{copied === "codex" ? "Command copied" : "Copy command"}</small></span><CopyGlyph /></button>
      <button type="button" onClick={() => onCopy(CLAUDE_INSTALL, "claude")}><BrandIcon brand="claude" /><span><b>Claude Code</b><small>{copied === "claude" ? "Steps copied" : "Copy install steps"}</small></span><CopyGlyph /></button>
      <a href={GITHUB} target="_blank" rel="noreferrer"><BrandIcon brand="github" /><span><b>GitHub</b><small>Source and docs</small></span><ArrowGlyph /></a>
    </div>
  );
}

function AgentComposer() {
  return (
    <div className="showcase-composer" aria-label={`Example coding-agent message: ${EXAMPLE_AGENT_MESSAGE}`}>
      <p>{EXAMPLE_AGENT_MESSAGE}<span className="composer-caret" aria-hidden="true" /></p>
    </div>
  );
}

function TicketSourceFile() {
  return (
    <article className="source-file-viewer ticket-source-file" aria-label="Schema-valid Ticket source file for VH-204">
      <header>
        <span><small>GENERATED TICKET</small><b>.vibehub/tickets/vh-204.yaml</b></span>
        <strong>ACTUAL SCHEMA</strong>
      </header>
      <pre tabIndex={0}><code>{JSON.stringify(PUBLIC_TICKET_FILE, null, 2)}</code></pre>
      <footer><i aria-hidden="true" /><span><b>This file becomes the selected VH-204 view.</b><small>Outcome, dependencies, bound Context, Acceptance, and human authority stay inspectable.</small></span></footer>
    </article>
  );
}

function RoomSourceBrowser() {
  const [selectedFile, setSelectedFile] = useState(0);
  const file = ROOM_SOURCE_FILES[selectedFile];

  return (
    <div className="room-source-browser" aria-label="Room and Context source files">
      <div className="room-source-tabs" role="tablist" aria-label="Product Room files">
        {ROOM_SOURCE_FILES.map((candidate, index) => (
          <button
            key={candidate.path}
            type="button"
            role="tab"
            aria-selected={selectedFile === index}
            onClick={() => setSelectedFile(index)}
          >
            <small>{candidate.kind}</small>
            <b>{candidate.label}</b>
          </button>
        ))}
      </div>
      <article className="source-file-viewer room-source-file" role="tabpanel">
        <header>
          <span><small>PRODUCT ROOM</small><b>{file.path}</b></span>
          <strong>{file.kind}</strong>
        </header>
        <pre tabIndex={0}><code>{JSON.stringify(file.content, null, 2)}</code></pre>
      </article>
      <div className="context-lifecycle" aria-label="Context lifecycle">
        <span><small>01</small><b>Capture</b><p>A durable choice is made.</p></span>
        <i aria-hidden="true">→</i>
        <span><small>02</small><b>Room</b><p>Context gets a stable home.</p></span>
        <i aria-hidden="true">→</i>
        <span><small>03</small><b>Ticket</b><p><code>context_refs</code> bind only what matters.</p></span>
        <i aria-hidden="true">→</i>
        <span><small>04</small><b>Return</b><p>Accepted learning compounds Context.</p></span>
      </div>
    </div>
  );
}

function Founders() {
  return (
    <section className="showcase-founders" aria-label="VibeHub founders">
      <span>Built by</span>
      <article><Image src="/founders/wayne-wang.jpg" width={32} height={32} alt="Wayne Wang" unoptimized /><div><b>Wayne Wang <small>王宇轩</small></b><nav aria-label="Wayne Wang profile links"><a href="https://wayne-wang-yuxuan.com" target="_blank" rel="noreferrer">Website</a><a href="https://www.linkedin.com/in/wayne-wang-yuxuan" target="_blank" rel="noreferrer">LinkedIn</a></nav></div></article>
      <article><Image src="/founders/victor-zhang.jpg" width={32} height={32} alt="Chenyang Zhang (Victor)" unoptimized /><div><b>Chenyang Zhang <small>Victor</small></b><nav aria-label="Chenyang Zhang profile links"><a href="https://www.victorz.studio" target="_blank" rel="noreferrer">Website</a><a href="https://www.linkedin.com/in/zhang-victor-2032151aa/" target="_blank" rel="noreferrer">LinkedIn</a></nav></div></article>
    </section>
  );
}

function workbenchState(ticket: WorkbenchTicket, moment: TicketMoment): WorkbenchState {
  if (ticket.id === "VH-204") return moment === "done" ? "DONE" : "READY";
  if (ticket.id === "VH-205") return moment === "done" ? "READY" : "BLOCKED";
  return ticket.state;
}

function workbenchAttention(ticket: WorkbenchTicket, moment: TicketMoment): AttentionState | null {
  if (ticket.id !== "VH-204") return null;
  return moment === "done" ? "COMPLETE" : "UPCOMING";
}

function causalCone(ticketId: string) {
  const selected = WORKBENCH_FIXTURE.tickets.find((ticket) => ticket.id === ticketId);
  const related = new Set<string>([ticketId]);
  selected?.requires.forEach((id) => related.add(id));
  WORKBENCH_FIXTURE.tickets.forEach((ticket) => {
    if (ticket.requires.includes(ticketId)) related.add(ticket.id);
  });
  return related;
}

function WorkbenchTicketNode({
  ticket,
  moment,
  selected,
  related,
  onSelect,
}: {
  ticket: WorkbenchTicket;
  moment: TicketMoment;
  selected: boolean;
  related: boolean;
  onSelect: () => void;
}) {
  const state = workbenchState(ticket, moment);
  const attention = workbenchAttention(ticket, moment);
  const unlocks = WORKBENCH_FIXTURE.tickets.filter((candidate) => candidate.requires.includes(ticket.id)).length;
  const evidenceCount = ticket.id === "VH-204" && moment !== "done" ? 0 : ticket.evidence.length;
  const style = { "--ticket-x": `${ticket.x}%`, "--ticket-y": `${ticket.y}%` } as CSSProperties;

  return (
    <button
      type="button"
      className={`workbench-ticket state-${state.toLowerCase()} ${attention ? `attention-${attention.toLowerCase()}` : ""} ${selected ? "is-selected" : related ? "is-related" : "is-dimmed"}`}
      style={style}
      aria-pressed={selected}
      aria-label={`${ticket.id}. ${ticket.title}. ${state}. ${ticket.requires.length} prerequisites, ${unlocks} unlocks.`}
      onClick={onSelect}
    >
      <i className="workbench-ticket-aperture" aria-hidden="true" />
      <span className="workbench-ticket-head">
        <span>{ticket.id}</span>
        {attention ? <b>{attention === "PENDING" ? "NEEDS YOU" : attention}</b> : null}
      </span>
      <strong>{ticket.title}</strong>
      <span className="workbench-ticket-foot"><b>{state}</b><small>{evidenceCount} Evidence</small></span>
    </button>
  );
}

function WorkbenchInspector({
  ticket,
  moment,
  lens,
  onLens,
  onClose,
  onSelectTicket,
}: {
  ticket: WorkbenchTicket;
  moment: TicketMoment;
  lens: WorkbenchLens;
  onLens: (lens: WorkbenchLens) => void;
  onClose: () => void;
  onSelectTicket: (ticketId: string) => void;
}) {
  const state = workbenchState(ticket, moment);
  const attention = workbenchAttention(ticket, moment);
  const dependents = WORKBENCH_FIXTURE.tickets.filter((candidate) => candidate.requires.includes(ticket.id));
  const isCurrent = ticket.id === "VH-204";
  const hasEvidence = !isCurrent || moment === "done";
  const complete = !isCurrent || moment === "done";
  const paletteLabel = "Graphite";
  const boundContext = WORKBENCH_FIXTURE.rooms.find((room) => room.id === ticket.room)?.contexts[0];

  return (
    <aside className="public-inspector" aria-label={`Ticket inspector for ${ticket.id}`}>
      <header>
        <div><span>{ticket.id} · GUIDED FIXTURE</span><h2>{ticket.title}</h2></div>
        <button type="button" aria-label="Close Ticket inspector" onClick={onClose}>×</button>
      </header>
      <nav role="tablist" aria-label="Ticket inspector lenses">
        {(["execution", "contract", "log"] as WorkbenchLens[]).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={lens === item} onClick={() => onLens(item)}>{item[0].toUpperCase() + item.slice(1)}</button>
        ))}
      </nav>
      <div className="public-inspector-body">
        {lens === "execution" ? (
          <section role="tabpanel" aria-label="Execution">
            <div className={`execution-signal state-${state.toLowerCase()}`}><i aria-hidden="true" /><span><b>{state}</b><small>{state === "BLOCKED" ? "Waiting on a direct prerequisite" : state === "DONE" ? "Proven by an independent Outcome" : "Executable from current Git truth"}</small></span></div>
            {attention ? <div className={`attention-signal attention-${attention.toLowerCase()}`}><i aria-hidden="true" /><span><b>Human attention · {attention}</b><small>{attention === "COMPLETE" ? "The human boundary is independently accepted." : "A palette choice will remain with the person."}</small></span></div> : null}
            <div className="inspector-metrics">
              <span><b>{ticket.requires.length}</b><small>Requires</small></span>
              <span><b>{dependents.length}</b><small>Unlocks</small></span>
              <span><b>{hasEvidence ? ticket.evidence.length : 0}</b><small>Evidence</small></span>
            </div>
            <p className="inspector-description">{ticket.description}</p>
            <section className="causal-neighbors" aria-label="Direct causal neighbors">
              <span>DIRECT CAUSAL CONE</span>
              <div>
                {ticket.requires.map((id) => <button type="button" key={id} onClick={() => onSelectTicket(id)}><i aria-hidden="true" />{id}<small>prerequisite</small></button>)}
                {dependents.map((item) => <button type="button" key={item.id} onClick={() => onSelectTicket(item.id)}><i aria-hidden="true" />{item.id}<small>unlock</small></button>)}
                {!ticket.requires.length && !dependents.length ? <p>No direct relations.</p> : null}
              </div>
            </section>
          </section>
        ) : null}

        {lens === "contract" ? (
          <section role="tabpanel" aria-label="Contract">
            <div className="contract-brief"><i aria-hidden="true" /><span><small>EXECUTABLE OUTCOME</small><b>{ticket.description}</b></span><strong>{ticket.acceptance.length} conditions</strong></div>
            <div className="acceptance-rail">
              {ticket.acceptance.map((acceptance, index) => {
                const accepted = complete || (isCurrent && hasEvidence && index < 2);
                return <article key={acceptance.label} className={acceptance.human ? "is-human" : ""}><i aria-hidden="true">{accepted ? "✓" : ""}</i><span><b>{acceptance.label}</b><small>{acceptance.human ? "HUMAN AUTHORITY" : accepted ? "EVIDENCE ATTACHED" : "AGENT AUTHORITY"}</small></span></article>;
              })}
            </div>
            {boundContext ? <div className="bound-context"><span>BOUND CONTEXT · {ticket.room.toUpperCase()} · {boundContext.kind}</span><strong>{boundContext.title}</strong><p>{boundContext.detail}</p></div> : null}
          </section>
        ) : null}

        {lens === "log" ? (
          <section role="tabpanel" aria-label="Log">
            <div className="proof-summary"><b>{complete ? "Outcome recorded" : hasEvidence ? "Evidence is forming" : "No execution proof yet"}</b><span>{complete ? "Independent closeout follows the acceptance-linked trace." : "Successful Outcome remains unavailable until every condition is adjudicated."}</span></div>
            <div className="proof-trace">
              <article className="is-done"><i aria-hidden="true" /><span><b>Ticket planned from Request + Context</b><small>VH-204 · deterministic fixture</small></span></article>
              {isCurrent ? <article className={complete ? "is-done" : "is-attention"}><i aria-hidden="true" /><span><b>{complete ? `${paletteLabel} palette recorded` : "Human palette decision stays with the person"}</b><small>{complete ? "human-origin Evidence" : "human boundary"}</small></span></article> : null}
              {(hasEvidence ? ticket.evidence : []).map((evidence) => <article className="is-done" key={evidence}><i aria-hidden="true" /><span><b>{evidence}</b><small>acceptance-linked Evidence</small></span></article>)}
              <article className={complete ? "is-outcome" : "is-quiet"}><i aria-hidden="true" /><span><b>{complete ? "Successful Outcome" : "Independent Outcome pending"}</b><small>{complete ? ticket.outcome : "not decided yet"}</small></span></article>
            </div>
            {isCurrent && complete ? <div className="returned-context"><span>RETURNED CONTEXT</span><b>{paletteLabel} is the approved dark palette.</b><small>Available to the next Ticket.</small></div> : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function WorkbenchRooms({
  selectedRoom,
  onSelectRoom,
  onSelectTicket,
  onClose,
}: {
  selectedRoom: string;
  onSelectRoom: (room: string) => void;
  onSelectTicket: (ticketId: string) => void;
  onClose: () => void;
}) {
  const room = WORKBENCH_FIXTURE.rooms.find((candidate) => candidate.id === selectedRoom) ?? WORKBENCH_FIXTURE.rooms[0];
  return (
    <aside className="public-rooms" aria-label="Rooms browser">
      <header><strong>Rooms</strong><button type="button" aria-label="Close Rooms" onClick={onClose}>×</button></header>
      <nav aria-label="Canonical Room tree">
        {WORKBENCH_FIXTURE.rooms.map((candidate) => <button type="button" key={candidate.id} aria-current={candidate.id === room.id ? "page" : undefined} onClick={() => onSelectRoom(candidate.id)}><i aria-hidden="true" /><span><b>{candidate.label}</b><small>{candidate.boundary}</small></span><em>FRESH</em></button>)}
      </nav>
      <section>
        <div className="room-title"><span>ROOM · {room.label.toUpperCase()}</span><b>{room.label}</b><p>{room.boundary}</p><small>{room.contexts.length} Context · {room.tickets.length} consuming Tickets</small></div>
        <span className="room-context-label">CONTEXT IN THIS ROOM</span>
        <div className="room-context-list">
          {room.contexts.map((context) => (
            <article key={`${room.id}-${context.kind}-${context.title}`}>
              <header><span className={`context-kind kind-${context.kind.toLowerCase()}`}>{context.kind}</span><small>{context.source}</small></header>
              <b>{context.title}</b>
              <p>{context.detail}</p>
              <footer>
                <span>USED BY</span>
                <div>{context.usedBy.map((ticketId) => <button type="button" key={ticketId} onClick={() => onSelectTicket(ticketId)}>{ticketId}</button>)}</div>
              </footer>
            </article>
          ))}
        </div>
        <span className="room-consuming-label">CONSUMING TICKETS</span>
        <div className="room-consuming-tickets">
          {room.tickets.map((ticketId) => {
            const ticket = WORKBENCH_FIXTURE.tickets.find((candidate) => candidate.id === ticketId);
            return <button type="button" key={ticketId} onClick={() => onSelectTicket(ticketId)}><i aria-hidden="true" /><span><b>{ticketId}</b><small>{ticket?.title}</small></span></button>;
          })}
        </div>
      </section>
    </aside>
  );
}

function TicketView({
  moment,
  initialLens,
  initialRoomsOpen = false,
  initialInspectorOpen = true,
  pannable = false,
}: {
  moment: TicketMoment;
  initialLens?: WorkbenchLens;
  initialRoomsOpen?: boolean;
  initialInspectorOpen?: boolean;
  pannable?: boolean;
}) {
  const [selectedTicketId, setSelectedTicketId] = useState("VH-204");
  const [inspectorOpen, setInspectorOpen] = useState(initialInspectorOpen);
  const [lens, setLens] = useState<WorkbenchLens>(() => initialLens ?? (moment === "done" ? "log" : "execution"));
  const [roomsOpen, setRoomsOpen] = useState(initialRoomsOpen);
  const [selectedRoom, setSelectedRoom] = useState("product");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const selectedTicket = WORKBENCH_FIXTURE.tickets.find((ticket) => ticket.id === selectedTicketId) ?? WORKBENCH_FIXTURE.tickets[2];
  const related = causalCone(selectedTicket.id);
  const counts = WORKBENCH_FIXTURE.tickets.reduce((result, ticket) => {
    result[workbenchState(ticket, moment)] += 1;
    return result;
  }, { READY: 0, BLOCKED: 0, DONE: 0 });

  function selectTicket(ticketId: string) {
    setSelectedTicketId(ticketId);
    setInspectorOpen(true);
    setRoomsOpen(false);
  }

  function beginPan(event: ReactPointerEvent<HTMLElement>) {
    if (!pannable || panRef.current || window.matchMedia("(max-width: 760px)").matches) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, aside, .public-canvas-summary")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y };
    setPanning(true);
  }

  function movePan(event: ReactPointerEvent<HTMLElement>) {
    const drag = panRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const nextX = Math.max(-120, Math.min(120, drag.originX + event.clientX - drag.startX));
    const nextY = Math.max(-86, Math.min(86, drag.originY + event.clientY - drag.startY));
    setPan({ x: nextX, y: nextY });
  }

  function endPan(event: ReactPointerEvent<HTMLElement>) {
    if (panRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    panRef.current = null;
    setPanning(false);
  }

  return (
    <div className={`public-workbench phase-${moment}`} data-moment={moment}>
      <header className="public-workbench-bar">
        <div><i aria-hidden="true">VH</i><span><b>Vibe task app</b><small>demo/dark-mode</small></span></div>
        <div><button type="button" className={roomsOpen ? "is-active" : ""} aria-expanded={roomsOpen} onClick={() => setRoomsOpen((open) => !open)}>Rooms <b>{WORKBENCH_FIXTURE.rooms.length}</b></button><span><i aria-hidden="true" />GUIDED FIXTURE</span></div>
      </header>
      <div className={`public-workbench-shell ${inspectorOpen ? "has-inspector" : ""}`}>
        <section
          className={`public-canvas ${pannable ? "is-pannable" : ""} ${panning ? "is-panning" : ""}`}
          aria-label="Interactive guided Ticket causal graph"
          onPointerDown={beginPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <div className="public-canvas-summary" aria-label="Ticket state summary"><span className="state-done">{counts.DONE} done</span><span className="state-ready">{counts.READY} ready</span>{counts.BLOCKED ? <span className="state-blocked">{counts.BLOCKED} blocked</span> : null}</div>
          <div className="public-canvas-map" style={{ "--canvas-pan-x": `${pan.x}px`, "--canvas-pan-y": `${pan.y}px` } as CSSProperties}>
            {WORKBENCH_EDGES.map((edge) => {
              const edgeRelated = related.has(edge.from) && related.has(edge.to);
              const edgeStyle = { "--edge-x": `${edge.x}%`, "--edge-y": `${edge.y}%`, "--edge-width": `${edge.width}%`, "--edge-angle": `${edge.angle}deg` } as CSSProperties;
              return <span key={edge.id} className={`public-causal-edge ${edgeRelated ? "is-related" : "is-dimmed"}`} style={edgeStyle} aria-hidden="true" />;
            })}
            {WORKBENCH_FIXTURE.tickets.map((ticket) => <WorkbenchTicketNode key={ticket.id} ticket={ticket} moment={moment} selected={ticket.id === selectedTicket.id} related={related.has(ticket.id)} onSelect={() => selectTicket(ticket.id)} />)}
          </div>
          <p className="public-canvas-hint">{pannable ? "Drag empty canvas to move the graph. Select a Ticket to inspect it." : "Select a Ticket to trace its direct causal cone and inspect its contract."}</p>
          {roomsOpen ? <WorkbenchRooms selectedRoom={selectedRoom} onSelectRoom={setSelectedRoom} onSelectTicket={selectTicket} onClose={() => setRoomsOpen(false)} /> : null}
        </section>
        {inspectorOpen ? <WorkbenchInspector ticket={selectedTicket} moment={moment} lens={lens} onLens={setLens} onClose={() => setInspectorOpen(false)} onSelectTicket={selectTicket} /> : null}
      </div>
    </div>
  );
}

export default function Home() {
  const [copied, setCopied] = useState<string | null>(null);
  const [pastHero, setPastHero] = useState(false);
  const heroRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const hero = heroRef.current;
    if (!hero || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setPastHero(!entry.isIntersecting), { rootMargin: "-68px 0px 0px", threshold: 0.05 });
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  async function copy(value: string, key: string) {
    try {
      await writeClipboard(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(`${key}-error`);
      window.setTimeout(() => setCopied(null), 2200);
    }
  }

  return (
    <main className="showcase-site" id="top">
      <a className="skip-link" href="#product-view">Skip to Ticket Graph</a>
      <SiteHeader copied={copied} onCopy={copy} pastHero={pastHero} />

      <section ref={heroRef} className="showcase-hero" aria-labelledby="showcase-title">
        <div className="showcase-hero-copy">
          <span className="showcase-kicker">VIBEHUB FOR CODING AGENTS</span>
          <h1 id="showcase-title">Stop managing chats. Manage the work.</h1>
          <p>Turn every coding request into a Ticket with your context.</p>
          <InstallActions copied={copied} onCopy={copy} />
          <AgentComposer />
        </div>
        <div className="showcase-product" id="product-view">
          <div className="product-caption"><span>THE REAL VIBEHUB VIEW</span><p>One request becomes visible work, with the exact Context needed to do it.</p></div>
          <TicketView moment="planning" pannable />
        </div>
      </section>

      <section className="story-section story-source" id="tickets" aria-labelledby="tickets-title">
        <div className="story-copy">
          <span>TICKETS</span>
          <h2 id="tickets-title">What is a Ticket?</h2>
          <p>A Ticket is an executable contract for an Agent: what to achieve, what it depends on, which Context applies, and how completion will be judged.</p>
          <TicketSourceFile />
        </div>
        <div className="story-workbench"><TicketView moment="planning" initialLens="contract" /></div>
      </section>

      <section className="story-section story-source" id="rooms" aria-labelledby="rooms-title">
        <div className="story-copy">
          <span>ROOMS + CONTEXT</span>
          <h2 id="rooms-title">How is context built up?</h2>
          <p>Rooms are durable product boundaries. Decisions, constraints, and contracts accumulate there; a Ticket references only what it needs, and accepted Outcomes can return new learning.</p>
          <RoomSourceBrowser />
        </div>
        <div className="story-workbench"><TicketView moment="planning" initialRoomsOpen initialInspectorOpen={false} /></div>
      </section>

      <section className="story-section story-proof" id="evidence" aria-labelledby="proof-title">
        <div className="story-copy">
          <span>TRUST</span>
          <h2 id="proof-title">Evidence before Outcome.</h2>
          <p>The graph does not call work complete because the Agent stopped talking. Evidence is attached to Acceptance first; an independent Outcome decides what actually happened and returns durable learning to Context.</p>
          <div className="story-principle"><b>Acceptance</b><i aria-hidden="true">→</i><b>Evidence</b><i aria-hidden="true">→</i><b>Outcome</b><i aria-hidden="true">→</i><b>Context</b></div>
        </div>
        <div className="story-workbench"><TicketView moment="done" initialLens="log" /></div>
      </section>

      <section className="implementation-section" id="git" aria-labelledby="git-title">
        <div className="implementation-copy">
          <span>GIT + GITHUB</span>
          <h2 id="git-title">Your work stays yours.</h2>
          <p>VibeHub keeps Tickets, Context, Evidence, and Outcomes beside your code. Git carries the history; GitHub provides review and collaboration.</p>
        </div>
        <div className="implementation-flow" aria-label="How VibeHub uses the repository, Git, and GitHub">
          <article><span>01</span><b>Repository</b><p>The development record lives beside the code.</p></article>
          <i aria-hidden="true">→</i>
          <article><span>02</span><b>Git</b><p>Every change stays reviewable and reversible.</p></article>
          <i aria-hidden="true">→</i>
          <article><span>03</span><b>GitHub</b><p>People and Agents share the same development history.</p></article>
        </div>
      </section>

      <footer className="showcase-footer"><Founders /><div><strong>Start one real development cycle.</strong><InstallActions copied={copied} onCopy={copy} /></div></footer>

      <span className="copy-status" role="status" aria-live="polite">
        {copied === "agent" ? "VibeHub brief copied for your Agent." : copied === "codex" ? "Codex marketplace command copied." : copied === "claude" ? "Claude Code installation steps copied." : copied?.endsWith("-error") ? "Copy was blocked. Try again." : ""}
      </span>
    </main>
  );
}
