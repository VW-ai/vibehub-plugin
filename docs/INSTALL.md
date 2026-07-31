# Install VibeHub

VibeHub ships one platform-neutral plugin for Claude Code and OpenAI Codex.
The plugin is distributed as an immutable GitHub Release artifact; its matching
runtime is installed from npm on first use.

## Requirements

- macOS or Linux
- Node.js 20 or newer
- [GitHub CLI](https://cli.github.com/) authenticated to an account that can
  read `VW-ai/vibehub-plugin`
- Claude Code, OpenAI Codex, or both

Authenticate once:

```bash
gh auth login --hostname github.com
```

The installer delegates private repository access to `gh`. It does not accept,
print, or store a GitHub token.

## Install

Install into every detected host:

```bash
npx -y @vw-ai/vibehub-cli@latest host install
```

Require both Claude Code and Codex:

```bash
npx -y @vw-ai/vibehub-cli@latest host install --hosts all
```

The command resolves the latest published, immutable GitHub Release, verifies
its SHA-256 receipt and manifests, atomically places it at
`~/.vibehub/distribution/marketplace/`, and registers that local marketplace
with each selected host.

Restart the host after installation. Claude Code exposes the setup Skill as
`/vibehub:vibehub-setup`; Codex exposes it as `$vibehub-setup`. On first use
in Codex, use an interactive `codex` CLI and `/hooks` to inspect and trust the
packaged VibeHub hooks. A desktop task may launch and drive that CLI flow when
its terminal and permission policy allow; otherwise, run it manually. The
desktop app does not expose `/hooks`, but it reuses the trust recorded in
Codex's shared local configuration. After trusting the hooks, start a fresh
desktop task in the target repository so a trusted `SessionStart` can run.

## Update or repair

Run the same command again:

```bash
npx -y @vw-ai/vibehub-cli@latest host install
```

Installation is idempotent. A repeated run revalidates the managed
distribution and host caches, repairing damaged content or missing
registration. It also advances to the latest published release when one is
available.

To install a specific released version:

```bash
npx -y @vw-ai/vibehub-cli@latest host install --version VERSION
```

Replace `VERSION` with the published SemVer number to pin.

If a host already has a `vibehub` marketplace registered from the old direct
Git flow, inspect it first, then explicitly migrate it:

```bash
npx -y @vw-ai/vibehub-cli@latest host install --replace-existing
```

The installer never removes project `.vibehub/` files, the VibeHub database, or
the versioned npm runtime cache.

## Release and local verification

Maintainers can verify a built marketplace without GitHub access:

```bash
node packages/cli/dist/main.js host install \
  --source dist/release \
  --hosts all \
  --json
```

`--source` still requires a complete release marketplace with matching Claude,
Codex, plugin, and npm runtime identities. A source checkout is not accepted as
a substitute for a release artifact.
