<div align="center">

<img src="assets/umiro-header.png" alt="ümiro" width="700">

**English** · [繁體中文](README.zh-TW.md)

**A self-hosted personal AI agent for Discord, with a durable execution core.**

[![node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)](https://nodejs.org)
[![version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/iiimabbie/umiro-agent/releases/tag/v0.1.0)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

</div>

ümiro runs one agent with one personality across your Discord server. Every conversation, tool call and reply is recorded in SQLite, so the agent survives restarts mid-task, remembers what was said, and can be audited afterwards — while the model endpoint, the data and the permissions stay under your control.

> [!WARNING]
> ümiro can run shell commands and act on connected services. Run it only on machines and Discord servers you trust, and review its permissions before opening it to other people.

## Features

| | |
|---|---|
| **Discord native** | Mentions, replies, DMs, threads and forum posts; slash commands; per-channel trigger policy (ignore / observe / respond) |
| **Durable execution** | Conversation → Turn → Run → Step → Operation in SQLite; crash recovery, approval gates and cancellation per Run |
| **Memory that scales** | Five structured memory files with tiered loading, full-text search over every past turn and tool result, optional semantic recall with embeddings |
| **Permissions** | Owner and member authority levels; every tool declares a capability and a tier; permissions only ever shrink when delegated |
| **Subagents** | Up to two parallel child runs per supervisor, one level deep, with cancel and reply-now; profiles supplied by plugins |
| **Scheduling** | Durable cron jobs and one-shot reminders that execute as ordinary agent Runs |
| **Plugins** | One manifest and runtime for internal plugins and external plugins; install external plugins from GitHub, enable, configure, update, remove |
| **Control panel** | Local web UI: read conversations as chat, manage plugins, schedules, workspace files and configuration |

## Requirements

- Linux with Node.js 24 or newer and pnpm (via Corepack)
- A Discord bot token and your Discord user ID
- An OpenAI-compatible model endpoint (Responses or Chat Completions)

## Quick start

```bash
git clone https://github.com/iiimabbie/umiro-agent.git
cd umiro-agent
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
pnpm umo install
export PATH="$HOME/.umiro/bin:$PATH"
```

No `UMIRO_HOME` setting is needed for a normal installation; these commands install into the current user's `~/.umiro`.

Start the daemon and open the local setup UI:

```bash
umo start
umo web token
umo status
```

`umo start` prints the Web UI URL (`http://127.0.0.1:3210` by default). The gateway stays available in setup mode until the model endpoint, model, Discord token, and owner ID are configured in the UI. Use the token printed by `umo web token` to sign in.

For automated or headless setup, credentials can still be imported before startup:

```bash
cp .env.example .env
$EDITOR .env
umo configure --from-env .env
umo start
```

On first contact the agent walks the owner through a short setup: name, voice, how to address you. The setup protocol removes itself once `SOUL.md` and `OWNER.md` are filled in.

## Configuration

Everything lives under one installation root, `~/.umiro/` by default (`UMIRO_HOME` overrides it).

| Path | Purpose |
|---|---|
| `bin/umo` | Management CLI |
| `app/releases/`, `app/current` | Versioned releases and the active one |
| `config/umiro.json` | Model, Discord, embedding and web UI settings |
| `config/secrets.env` | Tokens and API keys, mode `0600` |
| `workspace/` | The agent's identity and memory — see below |
| `data/umiro.sqlite` | Conversations, runs, search index, embeddings |
| `state/` | Service unit, process state, logs |

### Secrets

```dotenv
DISCORD_TOKEN=
UMIRO_OWNER_DISCORD_ID=
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
```

Set `LLM_BASE_URL` to your OpenAI-compatible endpoint and `LLM_MODEL` to a model that endpoint provides. Both are required by `umo configure`.

### Workspace

The workspace is plain Markdown the agent reads on every run and edits through its tools.

| File | Role |
|---|---|
| `SOUL.md` | Who the agent is: name, voice, values, boundaries |
| `AGENT.md` | How it works: where information belongs, verification, delegation, safety |
| `OWNER.md` | Who it serves and your standing directives |
| `memory/PREFERENCES.md`, `memory/LESSONS.md` | Loaded in full every run |
| `memory/WORKFLOWS.md`, `memory/ONGOING.md`, `memory/FACTS.md` | Only headings are loaded; entries are fetched on demand or recalled by search |
| `skills/<name>/SKILL.md` | Optional skills; enable them in `config/umiro.json` |

### Attachments and downloads

`workspace/attachments/` is the human- and agent-visible file area. Discord uploads are materialized under `attachments/inbox/discord/`, generated images under `attachments/generated/`, and `download_file` results under `attachments/downloads/`. Use `move_file` for managed renames so the SQLite workspace mapping and displayed artifact filename stay synchronized. `web_fetch` only returns bounded text and does not save a file.

`data/artifacts/` contains internal immutable, content-addressed blobs. Do not rename or edit those files manually; workspace copies are independent and safe to edit. The artifact database keeps the blob location, while `artifact_workspace_entries` records the visible workspace path and rename state.

### Discord

```bash
umo discord configure --allowed-guilds <id,...> --allowed-channels <id,...> \
  --ambient-channels <id,...> --ignored-channels <id,...> \
  --respond-to-bots false --queue-mode queue
umo discord status
```

Slash commands in Discord: `/new` starts a fresh conversation in the channel (the current one is archived), `/stop` cancels the active run, `/model` and `/queue` adjust the session.

### Semantic search

Full-text search works out of the box. Embeddings are opt-in:

Set `UMIRO_EMBEDDING_BASE_URL` and `UMIRO_EMBEDDING_API_KEY` in `config/secrets.env` (or use the Embedding section in the control panel). Both are managed as embedding secrets; the URL is required for the OpenAI-compatible provider.

```bash
umo embedding configure --provider gemini --model gemini-embedding-2
umo embedding configure --provider openai-compatible \
  --model nomic-embed-text --base-url http://localhost:11434/v1
umo embedding status
```

## Control panel

```bash
umo web token     # print the access token
umo web status
```

The panel binds to loopback only (`http://127.0.0.1:3210` by default). It shows each channel's current conversation and archived ones as a chat log, plus plugins, schedules, workspace files, configuration, usage and logs.

## Internal / External Plugins

Internal plugins ship with each release and can be disabled but not removed: `context-files`, `memory`, `scheduler`, `subagent`, `host-tools`, `discord-tools`. Without any external plugin, ümiro is a complete agent.

External plugins add capabilities and are installed separately. The official collection lives at [umiro-plugins](https://github.com/iiimabbie/umiro-plugins):

| Plugin | What it adds |
|---|---|
| `people` | Records of the people the agent meets, attached to the prompt when they appear |
| `soul-guardian` | Scheduled integrity checks on `SOUL.md` and `AGENT.md`, with one-click restore |
| `coder` | A subagent profile for coding tasks |
| `google` | Gmail, Calendar, Tasks and Drive tools with OAuth |
| `tool-activity` | A live "what the agent is doing" message in Discord while a run uses tools |
| `daily-report` | Scheduled daily summary |
| `diary` | Reconstructs the agent's first-person daily journal from canonical conversation history |
| `intent-analyzer` | Optional reply-intent and model-visible-tool analysis |

```bash
umo plugin install https://github.com/iiimabbie/umiro-plugins.git --workspace people
umo plugin list
umo plugin enable | disable | update | remove <source>
umo plugin remove <source> [--workspace <name>] --remove-secrets
umo plugin configure <source> --config '{"key":"value"}'
```

Both kinds share the same manifest, permissions, lifecycle and runtime. A plugin declares the capabilities it needs; the host caps them at what the calling principal is allowed to do.

Disabling a plugin unregisters its tools, policies, hooks, jobs, commands, skills, and search projections, and lifecycle-disables its schedules until the plugin is enabled again. Removing a plugin also deletes its owned schedules and search projections. User data produced by the plugin, such as journals and reports, is preserved.

Disabling a plugin always retains its declared secrets, and removing one retains them by default. The control panel's remove modal can explicitly request secret cleanup. The CLI equivalent is `umo plugin remove <source> [--workspace <name>] --remove-secrets`; it removes only secrets declared by the target plugin that are exclusive to it. Core secrets and secrets still declared by any other installed plugin are retained.

### Optional intent analyzer

The official `intent-analyzer` plugin can make one advisory decision per text turn: whether to reply and which registered tools should be visible to the model. Hard Discord ignores are decided first and never call the analyzer. A negative reply decision records an observed message without creating a Run, typing indicator, attachment import or model call; failures and timeouts fall back to the normal trigger policy. Tool visibility is only a model-facing subset: authorization and execution remain in Core, and hidden or hallucinated tools are rejected by the runtime.

The plugin is inert until configured through WebUI or CLI. It supports an OpenAI Chat Completions backend and the Jev TypeSafe backend. Only the current turn's text and model-facing tool definitions are sent; history, memory, secrets, tool results and runtime authorization are not. Jev uses `POST https://api.typesafe.ai/v1/systemone` and the optional `TYPESAFE_API_KEY` secret. See the external plugin repository for configuration details.

## CLI

```text
umo install | upgrade | rollback | uninstall [--purge]
umo start | stop | restart | status
umo configure --from-env <file>
umo discord configure | status
umo embedding configure | disable | status
umo web status | token
umo backup | restore
umo plugin install | list | enable | disable | update | remove | configure
```

## Architecture

```text
apps/cli                  installation and lifecycle CLI
apps/gateway              daemon: composition root, Discord ingress, control panel
packages/core             domain contracts and the execution runtime (no I/O)
packages/adapter-discord  Discord transport
packages/model-openai     OpenAI-compatible model adapter
packages/storage-sqlite   durable state, search and embedding projections
plugins/*                 internal plugins
templates/workspace       first-run workspace files
```

`@umiro/core` knows nothing about Discord, SQLite or any plugin. The gateway wires adapters, storage, model providers and enabled plugin contributions together. Adapters and the composition root are system layers, not plugins.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```
