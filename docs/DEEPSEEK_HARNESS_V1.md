# VibeHub for DeepSeek Harness V1

Status: production vertical slice in development, pinned to the exact rc.8
compatibility baseline. This supersedes the rc.7 foundation Spike for new
implementation; the Spike remains historical Evidence.

## Product boundary

VibeHub is an additive DSH Bundle, not a fork and not a replacement shell.
DSH keeps ownership of native Chat, Sessions, models, tools, permissions,
approvals, Skills, settings, workspace selection and responsive application
chrome. VibeHub adds one `Tasks` conversation view backed by the canonical
Git-native Ticket Graph, plus one root-scoped additive `shell.overlay` entry.
The overlay opens the Task Graph as the first working surface even before a
Session exists. Closing it reveals the untouched native DSH application and a
small `Tasks` launcher; every native Session also retains a `Tasks` tab for
returning to its linked Ticket.

The V1 handoff is deliberately exact:

1. The Workbench host creates `contextPackage.agentPayload` for one Ticket.
2. The embedded Workbench sends that object to the trusted loopback DSH parent.
3. The global surface idempotently registers the selected Git path as a native
   DSH Workspace, creates or reuses its blank Session, and opens that Session.
4. DSH records `/vibehub-task <link>` through its registered `command/run` and
   `command/done` lifecycle.
5. The same object, without browser-side reconstruction, is queued into the
   current native DSH Session with `Session.prompt(..., "queue")`.
6. The Agent loads the vendored, byte-identical
   `skills/vibehub-ticket-run/SKILL.md` through a separate official filesystem
   provider with `customSkillDirs` and writes canonical Evidence to Git. This
   provider feeds the catalog merged by DSH's per-session presets; it does not
   revive or overwrite Web's intentionally disabled base provider.
7. Evidence completeness projects `CLOSE_OUT` / `RUNNING · VERIFYING`; a
   separate Agent still owns Outcome adjudication.

The command lifecycle is the durable Ticket–Session link. VibeHub does not add
a second Task database, use Agent Team Task ids, patch DSH's event vocabulary,
or persist identity in browser storage.

## Exact compatibility lock

- Official repository: <https://github.com/deepseek-ai/deepseek-harness>
- Commit: `141eb6fef83422698aef7a981029e843e8161534`
- CLI: `@deepseek-ai/dsh@0.1.0-rc.8` (`next` tag at capture time)
- Runtime: Node `^22.19.0 || >=24.0.0`, pnpm `11.7.0`

Before any DSH-facing change or upgrade, run the source-contract probe against
an exact official checkout:

```sh
npm run probe:dsh -- /absolute/path/to/deepseek-harness
```

The probe covers only imported compatibility seams. Passing it is necessary,
not sufficient; the clean Profile and browser loop remain required.
Host and browser translations for these seams live under
`packages/dsh-adapter`; `packages/dsh-bundle` owns only a one-line re-export,
the installable manifest, Profile composition, and vendored VibeHub files.

## Build and install

Build the standalone Bundle with the current VibeHub runtime and Skills
vendored inside it. This is the normal daily development rebuild; it replaces
only a previously recognized `@vibehub/dsh-vibehub` artifact at the exact
output path and refuses to clean an unrelated directory:

```sh
npm run build:dsh
```

For a packed-install check rather than a source-directory link:

```sh
mkdir -p /tmp/vibehub-dsh-pack
npm pack ./dist/dsh-vibehub --pack-destination /tmp/vibehub-dsh-pack
```

Install it after the official base and Web bundles in an isolated profile:

```sh
DSH_HOME=/tmp/vibehub-dsh-home \
  npx @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile web add \
  /tmp/vibehub-dsh-pack/vibehub-dsh-vibehub-0.1.0.tgz
```

Run that profile from the Git repository whose `.vibehub` graph it should
project:

```sh
DSH_HOME=/tmp/vibehub-dsh-home \
  npx @deepseek-ai/dsh@0.1.0-rc.8 --profile web --port 3080
```

The Bundle starts a separate short-lived read-only Ticket host on loopback and
allows framing only by the exact loopback DSH origins. The bearer stays in the
iframe URL fragment. Repository writes remain exclusively owned by the
VibeHub Skills running through the Agent.

Restart uses the same `dsh --profile web --port 3080` command after stopping
the foreground process with `Ctrl-C`; the registered command projection then
recovers the Task–Session link while runtime presence begins absent and cannot
be fabricated from replay. Remove the Bundle from the isolated Profile with:

```sh
DSH_HOME=/tmp/vibehub-dsh-home \
  npx @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile web remove \
  @vibehub/dsh-vibehub
```

Before upgrading, check the official next version, update
`packages/dsh-adapter/upstream-lock.json` deliberately, and run the source
probe against the exact matching upstream commit before rebuilding:

```sh
npm view @deepseek-ai/dsh dist-tags.next version
npm run probe:dsh -- /absolute/path/to/deepseek-harness
```

Do not treat an available newer package as compatible until the probe, packed
Profile boot, native-Chat handoff, restart recovery, and browser checks pass.

## Runtime truth

The durable Session projection proves linkage, not liveness. A card can show
live `RUNNING` only while the DSH client currently observes that exact Session
running and sends a scoped, expiring runtime fact containing the linked Ticket
and command run id. A terminal or absent observation clears it; a replayed
`command/run` never refreshes `observedAt` or `expiresAt`.

`CLOSE_OUT` is different: it projects `RUNNING · VERIFYING` because the
execution-to-adjudication flow is still open, but it never claims an Agent is
live unless a trusted runtime observation also exists.

The rc.8 Session summary currently exposes active execution and explicit
human-interaction waits (`approval`, `question`, and `plan-review`). V1 maps
those waits to `NEEDS YOU`. It does not invent a waiting-tool stage from a
generic `running` boolean. Native Chat remains the truthful failure and tool
timeline; when a Run ends, the embedded Workbench reloads the canonical Git
projection and clears its expiring live fact. A failed Run with no new
Evidence therefore returns to the canonical actionable phase rather than
becoming a fabricated Git-level deviation.

## Keyless product-loop fixture

`test/fixtures/dsh-vibehub-run` supplies a dependency-free test-only
`llm/stream` waterfall. It replaces ordinary external model calls with a fixed
three-step transcript while leaving the installed DSH Workspace, Session,
Skill catalog and loader, bash tool, sandbox, filesystem, command lifecycle,
and VibeHub Evidence writer real. The transcript loads
`vibehub-ticket-run`, runs the Bundle regression, and invokes the canonical
`ticket evidence` command. Auxiliary Session-title calls pass through and the
fixture is never included in the production Bundle.

## Stop conditions

Stop and replan instead of broadening imports or adding hidden storage if:

- the Bundle cannot install and boot in a clean rc.8 Web Profile;
- `conversation.view`, native `Session.prompt`, registered command lifecycle,
  Session projection or `customSkillDirs` is no longer available;
- exact host-owned handoff cannot reach native Chat without browser re-derivation;
- restart cannot recover the Ticket–Session link from the registered log;
- runtime presence can only be reconstructed by pretending replay is live;
- DSH local persistence would become a competing canonical Task store.
