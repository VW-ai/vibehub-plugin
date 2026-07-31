# VibeHub

> Local-first project context for Claude Code and OpenAI Codex.

[![Release](https://img.shields.io/github/v/release/VW-ai/vibehub-plugin?style=flat-square)](https://github.com/VW-ai/vibehub-plugin/releases/latest)
[![Release workflow](https://img.shields.io/github/actions/workflow/status/VW-ai/vibehub-plugin/release.yml?style=flat-square&label=release)](https://github.com/VW-ai/vibehub-plugin/actions/workflows/release.yml)
[![License](https://img.shields.io/github/license/VW-ai/vibehub-plugin?style=flat-square)](LICENSE)

**[English](#install)** · **[中文](#中文)**

VibeHub gives coding agents one shared context layer across repositories,
worktrees, and sessions. It packages a CLI, MCP server, lifecycle hooks, and
governed knowledge workflows into one plugin for both supported hosts.

Project data stays on your machine in SQLite. The runtime needs no API key and
does not embed an LLM.

## Install

Requires Node.js 20 or newer and GitHub CLI access to this private repository.
No global npm install, platform target, or API key is required.

```bash
gh auth login --hostname github.com
npx -y @vw-ai/vibehub-cli@latest host install
```

The installer detects Claude Code and Codex. Use `--hosts all` to require both.
It downloads and verifies the matching immutable GitHub Release rather than
following a moving branch. By default, it selects the latest published
release; use `--version X.Y.Z` to pin one.

On first use, the plugin downloads its matching signed npm runtime into
`~/.vibehub/runtime/npm/`. Later starts reuse that versioned local cache.
See [installation and update details](docs/INSTALL.md).

## Start

Open a new session in the repository you want to connect. In Claude Code, run:

```text
/vibehub:vibehub-setup
```

In Codex, ask:

```text
Use $vibehub-setup for this repository.
```

In Codex, review and trust the packaged hooks through `/hooks` when prompted.

Once setup is complete:

```text
Use $vibehub-query to retrieve project context.
Use $vibehub-ingest to preserve a durable decision.
Use $vibehub-distill to map an existing repository.
```

## What you get

| Surface | Purpose |
| --- | --- |
| Local runtime | One SQLite context layer shared across repositories and worktrees |
| CLI + MCP | Deterministic reads, writes, validation, and health checks |
| Hooks | Mechanical lifecycle and activity capture from Claude Code and Codex |
| Skills | Explicit workflows for setup, retrieval, knowledge, review, and pull requests |

The packaged workflows are:

| Skill | Use it to |
| --- | --- |
| `$vibehub-setup` | Connect and verify an exact checkout |
| `$vibehub-query` | Retrieve relevant project context |
| `$vibehub-ingest` | Preserve decisions, requirements, and durable knowledge |
| `$vibehub-distill` | Build a governed map of an existing repository |
| `$vibehub-update` | Refresh knowledge after source changes |
| `$vibehub-review` | Validate stored knowledge and evidence |
| `$vibehub-pr` | Prepare semantic checkpoints and pull requests |

## Local data

VibeHub stores machine-level state at:

```text
~/.vibehub/workbench.db
```

Repository identity and exact checkout bindings keep projects and worktrees
separate inside the shared database. JSON and Markdown outputs are exports, not
fallback databases.

## Develop

```bash
git clone https://github.com/VW-ai/vibehub-plugin.git
cd vibehub-plugin
pnpm install --frozen-lockfile
pnpm verify
```

Source builds use pnpm 10.8.1. The full verification
gate builds and tests the CLI, MCP server, skills, real host installations, and
the headless dogfood flow.

See the [release policy](docs/RELEASE.md), [changelog](CHANGELOG.md), and
[published releases](https://github.com/VW-ai/vibehub-plugin/releases).

## 中文

VibeHub 为 Claude Code 和 OpenAI Codex 提供一个本地优先的项目上下文层。
CLI、MCP、hooks 和知识工作流共用本机 SQLite，不需要 API key，也不会在运行
时内置调用 LLM。

安装时先用 GitHub CLI 登录有权访问本私有仓库的账号，再运行上面的一行
installer。安装完成后，在目标仓库的新会话中，Claude Code 使用
`/vibehub:vibehub-setup`，Codex 使用 `$vibehub-setup`；之后可以通过
`$vibehub-query` 查询上下文、用 `$vibehub-ingest` 保存长期决策，或用
`$vibehub-distill` 梳理已有项目。

安装需要 Node.js 20 或更新版本，不需要 `npm -g`，也不用选择系统或 CPU
对应的 branch。首次使用会将与插件同版本的 npm runtime 缓存到本机。

## License

[Apache-2.0](LICENSE)
