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

Public marketplace builds require Node.js 24 and support:

- macOS: arm64 and x64
- Linux: arm64 and x64

Set the marketplace target for your machine:

```bash
TARGET="$(node -p '`${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}`')"
```

### Claude Code

```bash
claude plugin marketplace add "https://github.com/VW-ai/vibehub-plugin.git#marketplace/${TARGET}"
claude plugin install vibehub@vibehub
```

### OpenAI Codex

```bash
codex plugin marketplace add VW-ai/vibehub-plugin --ref "marketplace/${TARGET}"
codex plugin add vibehub@vibehub
```

## Start

Open a new Claude Code session or Codex task in the repository you want to
connect, then ask the host:

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

Source builds support Node.js 20 or newer and pnpm 10.8.1. The full verification
gate builds and tests the CLI, MCP server, skills, real host installations, and
the headless dogfood flow.

See the [release policy](docs/RELEASE.md), [changelog](CHANGELOG.md), and
[published releases](https://github.com/VW-ai/vibehub-plugin/releases).

## 中文

VibeHub 为 Claude Code 和 OpenAI Codex 提供一个本地优先的项目上下文层。
CLI、MCP、hooks 和知识工作流共用本机 SQLite，不需要 API key，也不会在运行
时内置调用 LLM。

安装时使用上面的公开 marketplace 命令。安装完成后，在目标仓库的新会话中
让宿主使用 `$vibehub-setup`；之后可以通过 `$vibehub-query` 查询上下文、
用 `$vibehub-ingest` 保存长期决策，或用 `$vibehub-distill` 梳理已有项目。

公开构建目前支持 Node.js 24，以及 macOS/Linux 的 arm64 和 x64 环境。

## License

[Apache-2.0](LICENSE)
