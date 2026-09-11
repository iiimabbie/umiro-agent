# ümiro

Native, self-hosted Discord agent with a durable execution core, persistent memory, scheduled work, and a composable plugin system.

`ümiro` is the product name. Repositories, packages, CLI commands, services, and environment variables use `umiro`.

## What is included

- Discord message, thread, DM, delivery, identity, and slash-command adapter
- Persistent conversations, Runs, tool evidence, crash recovery, and deduplication in SQLite
- Shared `SOUL.md`, `AGENT.md`, and `MEMORY.md` context for one consistent bot personality
- 隨 release 出貨的內掛：context-files、memory/search、scheduler、subagent、host-tools、discord-tools
- 需另外安裝的外掛：People、Soul Guardian、Coder profile 與其他 domain capabilities
- Permission-aware FTS and optional Gemini semantic search
- Durable cron and one-shot reminders that execute as normal agent Runs
- GitHub plugin installation and lifecycle commands
- Native user daemon with versioned upgrades and rollback

## Requirements

- Linux with Node.js 24 or newer
- pnpm through Corepack
- A Discord bot token and owner Discord user ID
- An OpenAI Responses-compatible model endpoint

## Install from source

```bash
git clone https://github.com/iiimabbie/umiro-V2.git
cd umiro-V2
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
pnpm umiro install
```

Add the installed command to your shell path:

```bash
export PATH="$HOME/.umiro-v2/bin:$PATH"
```

Copy the example secrets file, fill in its values, and install it with owner-only permissions:

```bash
cp .env.example .env
$EDITOR .env
umiro configure --from-env .env
umiro start
umiro status
```

> [!IMPORTANT]
> Do not run V1 and V2 with the same Discord token at the same time. Both processes would consume the same event stream.

## Configuration

The default installation root is `~/.umiro-v2/`. Set `UMIRO_HOME` to use an isolated profile or test installation.

| Path | Purpose |
|---|---|
| `bin/umiro` | Management CLI |
| `app/releases/` | Versioned application bundles |
| `app/current` | Active release |
| `config/umiro.json` | Model and application configuration |
| `config/secrets.env` | Tokens and API credentials (`0600`) |
| `workspace/` | Bot identity, operating guidance, memory, and people files |
| `data/umiro.sqlite` | Durable canonical state and rebuildable projections |
| `state/` | Service unit, process state, and logs |

Required secrets:

```dotenv
DISCORD_TOKEN=
UMIRO_OWNER_DISCORD_ID=
LLM_BASE_URL=http://localhost:8317/v1
LLM_API_KEY=
```

Semantic memory search is opt-in. A new installation uses `"embedding": { "provider": "disabled" }`, so full-text search works without an embedding service. Enable either Gemini or any OpenAI-compatible embedding endpoint explicitly; model names and endpoints are user configuration, and credentials stay in `config/secrets.env`.

```bash
# Gemini; reads the key from GOOGLE_API_KEY by default
umiro embedding configure --provider gemini --model gemini-embedding-2

# A local or hosted OpenAI-compatible endpoint; authentication is optional
umiro embedding configure --provider openai-compatible \
  --model nomic-embed-text --base-url http://localhost:11434/v1

# For an authenticated compatible endpoint, name the environment variable
umiro embedding configure --provider openai-compatible \
  --model custom-embed --base-url https://example.com/v1 \
  --api-key-env UMIRO_EMBEDDING_API_KEY

umiro embedding disable
umiro embedding status
```

## CLI

```text
umiro install
umiro upgrade
umiro rollback
umiro init
umiro configure --from-env .env
umiro embedding configure | disable | status
umiro start | stop | status
umiro plugin install <path-or-github-url> [--workspace package]
umiro plugin list
umiro plugin enable | disable | update | remove <source>
umiro plugin configure <source> --config '{"key":"value"}'
```

GitHub monorepo example:

```bash
umiro plugin install https://github.com/iiimabbie/umiro-plugins.git \
  --workspace daily-report
```

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

The repository is a pnpm workspace. `@umiro/core` is protocol-neutral and does not depend on Discord, SQLite, or individual plugins. The gateway is the composition root that connects adapters, storage, model providers, and enabled plugin contributions.

For Plugin ownership, Core is not a Plugin; 內掛 use the `builtin:<id>` source, are owned by the release, and may be disabled but not removed; 外掛 are installed separately and may be independently updated or removed. Both Plugin kinds use the same manifest, permissions, lifecycle, and runtime. A checkout under `plugins/umiro-plugins` does not change an external Plugin into an 內掛; that directory is an external repository submodule. Adapters and Composition are separate system layers, not Plugin kinds.

```text
apps/cli                  installation and lifecycle CLI
apps/gateway              native daemon composition root
packages/core             domain contracts and execution runtime
packages/adapter-discord  official Discord adapter
packages/model-openai     OpenAI-compatible model adapter
packages/storage-sqlite   durable storage and projections
plugins/*                 內掛（built-in Plugins）隨 release 出貨
templates/workspace       safe first-run workspace files
```
