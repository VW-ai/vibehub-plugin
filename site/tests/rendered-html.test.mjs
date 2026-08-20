import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("static arrival is one statement plus the real Ticket Graph", async () => {
  const html = await source("dist/client/index.html");

  assert.match(html, /<title>VibeHub — The Git-native development cycle<\/title>/i);
  assert.match(html, /<h1 id="showcase-title">Stop managing chats\. Manage the work\.<\/h1>/);
  assert.match(html, /<p>Turn every coding request into a Ticket with your context\.<\/p>/);
  assert.match(html, /VIBEHUB FOR CODING AGENTS/);
  assert.match(html, /THE REAL VIBEHUB VIEW/);
  assert.match(html, /Interactive guided Ticket causal graph/);
  assert.match(html, /Install for Codex/);
  assert.match(html, /Claude Code/);
  assert.match(html, /Copy for Agent/);
  assert.match(html, /GitHub/);
  assert.doesNotMatch(html, /Start the walkthrough|VibeHub Ticket cycle stages|Continue to Evidence|Choose a palette to continue|Development request|Ask the Agent to change this repository|HOW IT WORKS/);
});

test("installation, Agent handoff, founders, and local assets stay truthful", async () => {
  const page = await source("app/page.tsx");

  assert.match(page, /const CODEX_INSTALL = "codex plugin marketplace add VW-ai\/vibehub-plugin"/);
  assert.match(page, /\/plugin marketplace add VW-ai\/vibehub-plugin/);
  assert.match(page, /function SiteHeader/);
  assert.match(page, /function InstallActions/);
  assert.match(page, /function BrandIcon/);
  assert.match(page, /\/brands\/codex\.png/);
  assert.match(page, /\/brands\/claude-code\.png/);
  assert.match(page, /\/brands\/github\.svg/);
  assert.match(page, /\/founders\/wayne-wang\.jpg/);
  assert.match(page, /\/founders\/victor-zhang\.jpg/);
  assert.match(page, /https:\/\/wayne-wang-yuxuan\.com/);
  assert.match(page, /https:\/\/www\.linkedin\.com\/in\/wayne-wang-yuxuan/);
  assert.match(page, /https:\/\/www\.victorz\.studio/);
  assert.match(page, /https:\/\/www\.linkedin\.com\/in\/zhang-victor-2032151aa\//);
  assert.match(page, /Wayne Wang <small>· 王宇轩<\/small>/);
  assert.match(page, /Victor Zhang <small>· 张辰扬<\/small>/);
  assert.match(page, /alt="Victor Zhang"/);
  assert.match(page, /aria-label="Victor Zhang profile links"/);
  assert.doesNotMatch(page, /Chenyang Zhang|张陈阳|张辰阳/);

  await Promise.all([
    access(new URL("public/brands/codex.png", root)),
    access(new URL("public/brands/claude-code.png", root)),
    access(new URL("public/brands/github.svg", root)),
    access(new URL("public/founders/wayne-wang.jpg", root)),
    access(new URL("public/founders/victor-zhang.jpg", root)),
  ]);
});

test("the page has no walkthrough or parallel lifecycle state machine", async () => {
  const page = await source("app/page.tsx");

  assert.match(page, /type TicketMoment = "planning" \| "done"/);
  assert.doesNotMatch(page, /type Phase|const STAGES|PlaybackStages|PaletteDecision|nextStage|previousStage|furthestStage|setInterval|EVIDENCE_REVEAL_DELAY|OUTCOME_REVEAL_DELAY/);
  assert.doesNotMatch(page, /<textarea|<form|AppPreview|ActivityView|function Workspace|Back<\/button>|Start walkthrough/);
  assert.equal((page.match(/<TicketView moment=/g) ?? []).length, 4);
});

test("one authentic Agent message sits beside the generated real Ticket View", async () => {
  const page = await source("app/page.tsx");

  assert.match(page, /function AgentComposer/);
  assert.match(page, /const EXAMPLE_AGENT_MESSAGE = `\$\{EXAMPLE_REQUEST\} Start this with VibeHub\.`/);
  assert.match(page, /className="composer-caret"/);
  assert.doesNotMatch(page, /function RequestCard|>REQUEST<|In your coding agent|Repository Context attached|<code>Start this with VibeHub\.|aria-hidden="true">↑|className="is-primary"/);
  assert.match(page, /className="showcase-hero"/);
  assert.match(page, /className="showcase-hero-copy"/);
  assert.match(page, /className="showcase-product"/);
  assert.match(page, /<TicketView moment="planning" pannable \/>/);
});

test("the product view remains the faithful typed Ticket Workbench", async () => {
  const page = await source("app/page.tsx");

  assert.match(page, /type WorkbenchLens = "execution" \| "contract" \| "log"/);
  assert.match(page, /const WORKBENCH_FIXTURE/);
  assert.equal((page.match(/id: "VH-20[1-5]"/g) ?? []).length, 5);
  assert.equal((page.match(/const WORKBENCH_FIXTURE/g) ?? []).length, 1);
  assert.match(page, /function causalCone/);
  assert.match(page, /function WorkbenchTicketNode/);
  assert.match(page, /function WorkbenchInspector/);
  assert.match(page, /function WorkbenchRooms/);
  assert.match(page, /pannable/);
  assert.match(page, /Drag empty canvas to move the graph/);
  assert.match(page, /aria-label="Interactive guided Ticket causal graph"/);
  assert.match(page, /aria-label="Ticket inspector lenses"/);
  assert.match(page, /aria-label="Rooms browser"/);
  assert.match(page, /Human attention/);
  assert.match(page, /BOUND CONTEXT/);
  assert.match(page, /Independent Outcome pending/);
  assert.match(page, /RETURNED CONTEXT/);
  assert.equal((page.match(/JSON\.stringify/g) ?? []).length, 2);
  assert.doesNotMatch(page, /fetch\(|XMLHttpRequest|WebSocket|<iframe/i);
});

test("the vertical story explains Tickets, Rooms, Evidence, Outcome, and returned Context", async () => {
  const page = await source("app/page.tsx");

  assert.match(page, /const PUBLIC_TICKET_FILE/);
  assert.match(page, /function TicketSourceFile/);
  assert.match(page, /What is a Ticket\?/);
  assert.match(page, /\.vibehub\/tickets\/vh-204\.yaml/);
  assert.match(page, /ACTUAL SCHEMA/);
  assert.match(page, /context_refs/);
  assert.match(page, /target_ticket_id: "vh-201"/);
  assert.match(page, /target_ticket_id: "vh-202"/);
  assert.match(page, /authority: "human"/);
  assert.match(page, /JSON\.stringify\(PUBLIC_TICKET_FILE, null, 2\)/);
  assert.match(page, /const ROOM_SOURCE_FILES/);
  assert.match(page, /function RoomSourceBrowser/);
  assert.match(page, /How is context built up\?/);
  assert.match(page, /\.vibehub\/rooms\/product\/room\.yaml/);
  assert.match(page, /decision-manual-preference-wins/);
  assert.match(page, /constraint-system-theme-default/);
  assert.match(page, /contract-theme-preference/);
  assert.match(page, /JSON\.stringify\(file\.content, null, 2\)/);
  assert.match(page, /Capture/);
  assert.match(page, /Context gets a stable home/);
  assert.match(page, /context_refs.*bind only what matters/);
  assert.match(page, /Accepted learning compounds Context/);
  assert.match(page, /CONTEXT IN THIS ROOM/);
  assert.match(page, /DECISION/);
  assert.match(page, /CONSTRAINT/);
  assert.match(page, /CONTRACT/);
  assert.match(page, /REFERENCE/);
  assert.match(page, /Manual preference wins/);
  assert.match(page, /Respect the system by default/);
  assert.match(page, /Theme preference contract/);
  assert.match(page, /Current appearance settings/);
  assert.match(page, /USED BY/);
  assert.match(page, /Evidence before Outcome\./);
  assert.match(page, /Your work stays yours\./);
  assert.match(page, /Git carries the history; GitHub provides review and collaboration\./);
  assert.match(page, /How VibeHub uses the repository, Git, and GitHub/);
  assert.match(page, /Acceptance<\/b><i aria-hidden="true">→<\/i><b>Evidence/);
  assert.match(page, /Outcome<\/b><i aria-hidden="true">→<\/i><b>Context/);
  assert.doesNotMatch(page, /function LifecycleDiagram|HOW IT WORKS/);
});

test("the concise showcase remains responsive, accessible, and quiet", async () => {
  const [page, css] = await Promise.all([source("app/page.tsx"), source("app/globals.css")]);

  assert.match(page, /href="#product-view">Skip to Ticket Graph/);
  assert.match(page, /role="status" aria-live="polite"/);
  assert.match(page, /navigator\.clipboard\?\.writeText/);
  assert.match(page, /document\.execCommand\("copy"\)/);
  assert.match(css, /Static Ticket showcase/);
  assert.match(css, /Dark vertical product story/);
  assert.match(css, /--showcase-bg: #0b0d0c/);
  assert.match(css, /grid-template-columns: minmax\(340px, 0\.7fr\) minmax\(0, 1\.3fr\)/);
  assert.match(css, /\.showcase-header \{\s*position: sticky/);
  assert.match(css, /\.source-file-viewer pre \{/);
  assert.match(css, /\.room-source-tabs \{ display: grid; grid-template-columns: repeat\(4/);
  assert.match(css, /\.context-lifecycle \{ display: grid/);
  assert.match(css, /transform: translate3d\(var\(--canvas-pan-x, 0\), var\(--canvas-pan-y, 0\), 0\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.showcase-hero \{ min-height: auto; grid-template-columns: 1fr/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /overflow-x: hidden/);
  assert.doesNotMatch(css, /transition:\s*all/);
});

test("production artifact stays static and Cloudflare-ready", async () => {
  const [packageJson, nextConfig, hosting, layout] = await Promise.all([
    source("package.json"),
    source("next.config.ts"),
    source(".openai/hosting.json"),
    source("app/layout.tsx"),
  ]);

  assert.match(packageJson, /"name": "@vibehub\/site"/);
  assert.doesNotMatch(packageJson, /three|framer-motion|drizzle|tailwind/i);
  assert.match(nextConfig, /output:\s*"export"/);
  assert.match(layout, /NEXT_PUBLIC_SITE_URL/);
  assert.match(layout, /\/og\.png/);
  assert.deepEqual(JSON.parse(hosting), { d1: null, r2: null });

  await Promise.all([
    access(new URL("dist/client/index.html", root)),
    access(new URL("dist/client/index.rsc", root)),
    access(new URL("dist/client/favicon.svg", root)),
    access(new URL("dist/client/og.png", root)),
    access(new URL("dist/client/brands/codex.png", root)),
    access(new URL("dist/client/brands/claude-code.png", root)),
    access(new URL("dist/client/brands/github.svg", root)),
    access(new URL("dist/client/founders/wayne-wang.jpg", root)),
    access(new URL("dist/client/founders/victor-zhang.jpg", root)),
    access(new URL("dist/.openai/hosting.json", root)),
  ]);
});
