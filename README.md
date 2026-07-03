# Asynthetic

**Verified migration maps for AI coding agents, served over MCP.**

LLMs suffer from temporal drift: training data mixes many versions of a library, so an agent confidently writes v4 syntax into a v5 codebase. Asynthetic is an MCP (Model Context Protocol) server that tells agents **exactly what breaks between two versions of a library and how to fix it** — from hand-curated, source-cited migration maps instead of stale model memory.

> Context7 tells the agent what the current API is. **Asynthetic tells the agent what changed and how to migrate.**

## How it works

Every migration map is hand-curated from authoritative sources only — official migration guides, GitHub releases, and framework blogs — and every map carries:

- ordered breaking changes with **before/after code snippets**
- a `category` per change (`signature-change`, `removal`, `rename`, `behavior-change`, `config-change`, `import-change`, `deprecation`)
- deprecations with replacement symbols and removal timelines
- **`source_urls` citations** and a **`last_verified` date**

Maps are never LLM-generated. A map that would be wrong is worse than no map, so when nothing verified matches a query, the server says so explicitly and instructs the agent **not** to fabricate migration steps.

## Tools

| Tool | Returns |
|---|---|
| `get_migration(package, from_version, to_version, ecosystem?)` | The full migration map for the requested upgrade window |
| `get_breaking_changes(package, version, ecosystem?)` | Breaking changes introduced when upgrading **to** a version |
| `check_compatibility(...)` | Stub — always returns `implemented: false` (planned) |

Version arguments accept concrete versions (`14.2.35`), partial versions (`14`), or SemVer ranges (`^14.2.0`, `~4.3.0`, `15.x`). Resolution is exact-first, then SemVer-aware, and always disclosed in the response via `match_type`, `resolved_via` (`exact_string` / `semver_range` / `major_version`), and a `match_note`.

## Current coverage

| Package | Migration | Breaking changes |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.x → 2.0 | 21 |
| `ai` (Vercel AI SDK) | 4.x → 5.0 | 23 |
| `next` (Next.js) | 14 → 15 | 17 |

Coverage is deliberately narrow and deep: fast-moving AI and JavaScript-ecosystem frameworks, curated for correctness over breadth.

## Quick start

### Hosted server (HTTP)

```sh
claude mcp add --transport http asynthetic https://asynthetic.up.railway.app/mcp
```

Or in any client that takes a JSON MCP config:

```json
{
  "mcpServers": {
    "asynthetic": {
      "url": "https://asynthetic.up.railway.app/mcp"
    }
  }
}
```

### Local (stdio via npm)

```sh
claude mcp add asynthetic -- npx -y asynthetic
```

```json
{
  "mcpServers": {
    "asynthetic": {
      "command": "npx",
      "args": ["-y", "asynthetic"]
    }
  }
}
```

The published package bundles the curated maps, so local stdio mode works offline with no database or configuration.

## HTTP endpoints

When the `PORT` environment variable is set, the server runs as an HTTP service (otherwise it speaks stdio):

| Endpoint | Transport |
|---|---|
| `POST` / `GET` / `DELETE` `/mcp` | **Streamable HTTP** — the current MCP transport; use this from modern clients |
| `GET /sse` + `POST /messages` | Legacy HTTP+SSE — compatibility for older clients (protocol 2024-11-05) |
| `GET /` | Health/info JSON (name, version, active store, endpoints) |

Sessions are managed per client with `Mcp-Session-Id` (Streamable HTTP) or `sessionId` (legacy SSE); each session gets an isolated server instance.

## Response shape

Successful lookups return structured JSON with full verification metadata:

```jsonc
{
  "found": true,
  "match_type": "semver-range",
  "resolved_via": "semver_range",
  "match_note": "Resolved via SemVer range processing: ...",
  "migration": {
    "package": "next",
    "from_version": "14.2.35",
    "to_version": "15.0.0",
    "breaking_changes": [ /* ordered, with before/after code */ ],
    "deprecations": [ /* symbol, replacement, removal timeline */ ],
    "source_urls": ["https://nextjs.org/docs/app/guides/upgrading/version-15"],
    "last_verified": "2026-07-03",
    "status": "draft"
  }
}
```

Missed lookups return `found: false`, an explicit anti-hallucination instruction, and the list of maps that do exist.

## Self-hosting

```sh
git clone https://github.com/asyntheticai/asynthetic.git
cd asynthetic
npm install
npm run build
```

| Variable | Effect |
|---|---|
| *(none)* | Serves the bundled JSON maps from `data/maps/` — zero-config mode |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` | Serves from Postgres (run `schema/schema.sql`, then `npm run seed`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Needed by `npm run seed` only |
| `PORT` | Switches from stdio to the HTTP transports above |
| `MIGRATION_DATA_DIR` | Overrides the local maps directory |

The server never crashes on missing configuration — absent database credentials fall back to the bundled maps with a note on stderr.

## Development

```sh
npm run smoke     # build + 17-check end-to-end suite (stdio, Streamable HTTP, and SSE)
npm run inspect   # build + launch @modelcontextprotocol/inspector against the server
npm run dev       # run from source over stdio
```

### Adding a migration map

1. Curate from **official sources only** (changelogs, GitHub releases, migration guides). Record every URL.
2. Add a JSON file under `data/maps/<ecosystem>/<package>/` following the schema in `src/types/migration-map.ts`. Files are Zod-validated at load and seed time; invalid maps are skipped with a warning, never served.
3. Set `status: "draft"` until snippets are verified against real code, then `"verified"`. Mark superseded maps `"stale"` (excluded from serving) instead of deleting them.
4. `npm run seed` to sync Postgres, if used.

## Project layout

```
schema/schema.sql            Postgres tables (migrations, breaking_changes, deprecations)
src/types/migration-map.ts   TypeScript types + Zod validator for map JSON
src/store/                   Store interface, Supabase + local-file backends, SemVer resolver
src/server.ts                MCP server factory (tool registration)
src/index.ts                 Entry point: stdio or HTTP by environment
data/maps/                   Hand-curated migration maps (source of truth)
scripts/seed.ts              Load data/maps into Supabase
scripts/smoke.ts             End-to-end test suite
```

Built with TypeScript, the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) (v1.x stable line), Zod, Express, and Supabase. Node.js 22+.
