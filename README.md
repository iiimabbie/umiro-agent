# ümiro V2

Headless agent execution core. Discord is the only official adapter.

- Brand name: `ümiro`
- Technical name: `umiro` (repos, packages, CLI, services, env vars — never `ü`)

## Status

Early execution-kernel scaffold. The development harness connects to an
OpenAI-compatible model endpoint; the Core execution contracts and SQLite
durability boundary are in place, along with the authorized Tool Runtime.

## Layout

```
packages/core             @umiro/core            domain model + runtime contracts
packages/model-openai     @umiro/model-openai     OpenAI-compatible model adapter
packages/storage-sqlite   @umiro/storage-sqlite   durable execution storage
apps/dev-driver           @umiro/dev-driver      development harness (not a product)
apps/gateway                                        future service entrypoint
packages/adapter-discord                            future official product adapter
plugins/*                                           future capability plugins
```

`@umiro/core` must never depend on an adapter, a plugin, or a storage implementation.

## Requirements

Node >= 24, pnpm (via corepack).

```bash
corepack enable pnpm
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

For local model testing, provide `LLM_BASE_URL` and optionally `LLM_API_KEY`,
`LLM_MODEL`, and `LLM_PROTOCOL` in an ignored `.env` file, then run:

```bash
pnpm dev -- --model gemma4:31b "Say hello"
```
