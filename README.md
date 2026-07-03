# Asynthetic (MCP Server)

An MCP server that gives AI coding agents **verified migration information for fast-moving libraries**: exactly what breaks between two versions and how to fix it, from hand-curated maps with source citations — instead of hallucinated answers from stale training data.

> Context7 tells the agent what the current API is. **This tells the agent what changed and how to migrate.**

Every map is hand-curated from authoritative sources (official migration guides, GitHub Releases, spec changelogs), cites its `source_urls`, and carries a `last_verified` date. Maps are never LLM-generated.

## Tools

| Tool | What it returns |
|---|---|
| `get_migration(package, from_version, to_version, ecosystem?)` | Full migration map: ordered breaking changes with before/after code, deprecations, citations, `last_verified` |
| `get_breaking_changes(package, version, ecosystem?)` | Breaking changes introduced when upgrading **to** that version |
| `check_compatibility(...)` | Stub — always returns `implemented: false` (planned) |

Version matching is SemVer-aware: exact string match first, then range/major resolution — `^14.2.0 → ^15.0.0` and `1.20.0 → 2.0.0` both find the covering map. Every non-exact match is disclosed via `match_type`, `resolved_via` (`exact_string` / `semver_range` / `major_version`), and a `match_note`. When nothing matches, the response says `found: false`, tells the agent **not** to fabricate migration steps, and lists the maps that do exist.

## Quick start (no database needed)

```sh
npm install
npm run smoke     # builds + runs an end-to-end stdio test
```

With no Supabase env vars set, the server automatically serves the JSON maps in [`data/maps/`](data/maps/) — it never crashes on missing configuration.

## Test interactively with MCP Inspector

```sh
npm run inspect
```

This builds and launches `@modelcontextprotocol/inspector` against `node dist/index.js`. Open the URL it prints (default `http://localhost:6274`), go to **Tools → list**, and try:

- `get_migration` with `package: @modelcontextprotocol/sdk`, `from_version: 1.29.0`, `to_version: 2.0.0-beta.2` → full map, `match_type: "exact"`
- `get_migration` with `from_version: 1.20.0`, `to_version: 2.0.0` → same map with a `match_note` disclosure
- `get_migration` with `package: left-pad` → `found: false` + guidance

## Use from Claude Code / Cursor

```sh
npm run build
```

Claude Code:

```sh
claude mcp add asynthetic -- node "F:/MCP ooracle/dist/index.js"
```

Cursor (`.cursor/mcp.json`) or any client using JSON config:

```json
{
  "mcpServers": {
    "asynthetic": {
      "command": "node",
      "args": ["F:/MCP ooracle/dist/index.js"]
    }
  }
}
```

Add `"env": { "SUPABASE_URL": "...", "SUPABASE_ANON_KEY": "..." }` to serve from Postgres instead of local files.

## Supabase mode

1. Create a Supabase project and run [`schema/schema.sql`](schema/schema.sql) in the SQL editor.
2. Copy `.env.example` to `.env` and fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and (for seeding) `SUPABASE_SERVICE_ROLE_KEY`.
3. Seed the curated maps: `npm run seed`
4. Start the server: `npm start` — stderr logs which store is active.

## Adding a new migration map

1. Curate from **official sources only** (changelog, GitHub Releases, migration guide). Record every URL.
2. Add a JSON file under `data/maps/<ecosystem>/<package>/<from>-to-<to>.json` following the schema in [`src/types/migration-map.ts`](src/types/migration-map.ts) — it is validated on load and at seed time; invalid maps are skipped with a stderr warning, never served.
3. Set `status: "draft"` until the before/after snippets have been verified against real code, then flip to `"verified"`. Mark superseded maps `"stale"` instead of deleting them (stale maps are not served).
4. `npm run seed` to push to Supabase.

## Project layout

```
schema/schema.sql            Postgres tables (migrations, breaking_changes, deprecations)
src/types/migration-map.ts   TypeScript types + Zod validator for map JSON
src/store/                   MigrationStore interface, Supabase + local-file backends
src/index.ts                 MCP server entry point (stdio)
data/maps/                   Hand-curated migration maps (source of truth)
scripts/seed.ts              Load data/maps into Supabase
scripts/smoke.ts             End-to-end stdio smoke test
```

Built on `@modelcontextprotocol/sdk` **v1.x (stable)**, Node 22+, Zod, Supabase.
