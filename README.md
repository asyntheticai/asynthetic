# Asynthetic

**Migration-as-a-Service for AI coding agents.**

## The problem: temporal drift

LLMs are trained on years of mixed-version code. When an agent writes or upgrades code against a fast-moving library, it has no chronological filter — it will confidently produce v4 syntax in a v5 codebase, hallucinate removed APIs, or "fix" an upgrade with a function that no longer exists. Local tooling can't save it: the language server only knows the *installed* version, and dependency bots only bump version numbers without explaining what breaks.

Asynthetic is an MCP (Model Context Protocol) server that closes this gap. Before an agent touches an upgrade, it asks Asynthetic **exactly what breaks between two versions and how to fix it** — and gets back hand-curated, source-cited migration data instead of model memory.

**How this differs from "current API" tools like Context7:** those tell the agent what the latest API looks like. Asynthetic tells the agent what *changed* — the diff between two versions, with before/after code, deprecation timelines, and peer-dependency requirements. The two are complementary; only one of them prevents an agent from breaking your build during an upgrade.

## Design principle: a wrong map is worse than no map

- Every migration map is **hand-curated exclusively from official sources** — migration guides, release notes, and framework blogs. Maps are never LLM-generated.
- Every map carries **`source_urls` citations** and a **`last_verified` date**.
- Every response includes a derived **`verification_level`** confidence signal.
- When no verified data matches a query, the server says so explicitly and instructs the agent **not to fabricate migration steps**. `"unknown"` always means *absence of data*, never a guess.

## Tools

| Tool | What it does |
|---|---|
| `get_migration(package, from_version, to_version, ecosystem?)` | Full migration map for an upgrade window: ordered breaking changes with before/after code, deprecations, peer requirements, citations |
| `get_breaking_changes(package, version, ecosystem?)` | Breaking changes introduced when upgrading **to** a version |
| `list_available_maps(ecosystem?, package?)` | Coverage listing: every map with versions, status, and `last_verified` |
| `check_peer_compatibility(package_a, version_a, package_b, version_b, ecosystem?)` | Static SemVer check of two known package versions against curated peer data — returns `true`, `false`, or `"unknown"` |
| `check_compatibility(...)` | Reserved stub for future *project-aware* analysis; always returns `implemented: false` today |

`check_peer_compatibility` and `check_compatibility` are deliberately separate: the former is a pure, declarative SemVer evaluation between two known versions (no filesystem access, no project inspection); the latter is reserved for analysis that would need project context, and is not implemented.

Version arguments accept concrete versions (`14.2.35`), partial versions (`14`), and SemVer ranges (`^14.2.0`, `~4.3.0`, `15.x`). Resolution is exact-first, then SemVer-aware, always disclosed via `match_type`, `resolved_via`, and `match_note`.

## Current coverage

| Package | Migration | Breaking changes |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.x → 2.0 | 21 |
| `ai` (Vercel AI SDK) | 4.x → 5.0 | 23 |
| `next` (Next.js) | 14 → 15 | 17 |

Deliberately narrow and deep: fast-moving AI and JavaScript-ecosystem frameworks, curated for correctness over breadth. Run `list_available_maps` for the live answer.

## Quick start

### Hosted (HTTP)

```sh
claude mcp add --transport http asynthetic https://asynthetic.up.railway.app/mcp
```

```json
{
  "mcpServers": {
    "asynthetic": { "url": "https://asynthetic.up.railway.app/mcp" }
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
    "asynthetic": { "command": "npx", "args": ["-y", "asynthetic"] }
  }
}
```

The npm package bundles the curated maps — local stdio mode works offline with zero configuration.

### Try it in MCP Inspector

```sh
npm run inspect
```

Then in the Inspector UI:

1. `list_available_maps` with no arguments — see the full catalog.
2. `get_migration` with `package: next`, `from_version: ^14.2.0`, `to_version: ^15.0.0` — a SemVer range resolving to the 14→15 map, disclosed via `resolved_via: "semver_range"`.
3. `check_peer_compatibility` with `package_a: next`, `version_a: 15.0.0`, `package_b: react`, `version_b: 18.2.0` — returns `compatible: false` citing Next.js 15's React 19 requirement.
4. `get_migration` with `package: left-pad` — the `found: false` anti-hallucination response.

## Response shape

```jsonc
{
  "found": true,
  "match_type": "semver-range",
  "resolved_via": "semver_range",          // exact_string | semver_range | major_version
  "match_note": "Resolved via SemVer range processing: ...",
  "source_count": 2,                        // derived from source_urls
  "verification_level": "medium",           // high | medium | low — see below
  "migration": {
    "package": "next",
    "from_version": "14.2.35",
    "to_version": "15.0.0",
    "breaking_changes": [ /* ordered, with before/after code */ ],
    "deprecations": [ /* symbol, replacement, removal timeline */ ],
    "compatible_with": [
      { "package": "react", "version_range": "^19.0.0", "required": true, "note": "App Router minimum. ..." }
    ],
    "source_urls": ["https://nextjs.org/docs/app/guides/upgrading/version-15"],
    "last_verified": "2026-07-03",
    "status": "draft"
  }
}
```

### Verification levels

| Level | Meaning |
|---|---|
| `high` | `status: verified` — snippets checked against real before/after code |
| `medium` | `status: draft` with 2+ independent official sources |
| `low` | `status: draft` with a single source |

Missed lookups return `found: false`, an explicit do-not-fabricate instruction, a short inline coverage list, and a pointer to `list_available_maps`.

## Status & roadmap

**Asynthetic is in public beta and currently free.** The hosted endpoint and the npm package are open to everyone while we validate coverage and repeat usage.

Planned:

- More hand-curated maps (Tailwind 3→4, React 18→19, Zod 3→4, AI SDK 5→6, and the libraries the beta shows demand for)
- Promoting maps from `draft` to `verified` via compile-checked before/after snippets
- Project-aware compatibility analysis (`check_compatibility`)
- Listings in the MCP registries with one-click installs

Further details will be announced.

## Security

What the server actually is and does today:

- **Read-only by construction.** Every tool is a lookup over curated JSON/Postgres data. The server never executes arbitrary code, never fetches URLs at request time, and has no write operations exposed.
- **No access to your project.** In stdio mode it reads only its own bundled data files; it does not read your filesystem, environment, or codebase. In HTTP mode it sees only what your MCP client sends: tool names and arguments (package names and version strings) plus standard HTTP request metadata.
- **Sessions are ephemeral and isolated.** The hosted endpoint manages sessions via `Mcp-Session-Id` (Streamable HTTP) or a `sessionId` query parameter (legacy SSE). Each session gets its own in-memory server instance; sessions hold no user data and vanish on disconnect or restart. There are no accounts and no query persistence in the application itself; the hosting platform's standard request logging applies.
- **Data flows one way.** Responses are static curated content — the server has no mechanism to act on your machine.

Found a security issue? Please open a GitHub issue (or a private security advisory) rather than exploiting it.

## Contributing migration maps

Quality gates are strict because agents act on this data:

1. **Official sources only.** Curate exclusively from the library's own changelog, GitHub releases, migration guides, or spec documents. Record every URL in `source_urls`. Community blog posts may inspire a hunt but are never citable sources.
2. **Schema.** Add a JSON file under `data/maps/<ecosystem>/<package>/` conforming to `src/types/migration-map.ts` (Zod-validated at load and seed time — invalid maps are skipped with a warning, never served). Peer requirements go in `compatible_with`, where each entry has four fields:
   - `package` — the peer package name as published
   - `version_range` — a valid SemVer range, **verbatim from the official source**: if the source pins an exact version, keep the exact pin; do not widen it to `^x.y.z` unless the source itself states a range
   - `required` — `false` for optional peers only needed when that integration is used
   - `note` — expected, not optional in spirit: use it for scoping caveats ("App Router only"), optional-integration context, or to flag that adjacent versions are unconfirmed by the source; `null` only when the requirement is truly unqualified
3. **Status lifecycle.** New maps enter as `"draft"`. They become `"verified"` only after before/after snippets are checked against real code on both versions. Superseded or outdated maps are marked `"stale"` — excluded from serving but kept as the historical record. Never delete a map to retire it.
4. **Validate and test.** `npm run smoke` must pass — it exercises ingestion, all tools, and every transport end to end.
5. **Seeding Postgres** (only if you run the Supabase backend): `npm run seed`.

Do not guess versions, dates, or API names — if a fact isn't in an official source, leave it out and flag it in the PR.

## Self-hosting

```sh
git clone https://github.com/asyntheticai/asynthetic.git
cd asynthetic && npm install && npm run build
```

| Variable | Effect |
|---|---|
| *(none)* | Serves bundled JSON maps — zero-config mode |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` | Serves from Postgres (`schema/schema.sql`, then `npm run seed`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Needed by `npm run seed` only |
| `PORT` | HTTP mode: Streamable HTTP at `/mcp`, legacy SSE at `/sse` + `/messages`, health at `/` |
| `MIGRATION_DATA_DIR` | Overrides the local maps directory |

Missing configuration never crashes the server — it falls back to bundled maps with a stderr note.

## Project layout

```
schema/schema.sql            Postgres tables (migrations, breaking_changes, deprecations)
src/types/migration-map.ts   TypeScript types + Zod validator for map JSON
src/store/                   Store interface, Supabase + local-file backends, SemVer resolver
src/server.ts                MCP server factory (tool registration)
src/index.ts                 Entry point: stdio or HTTP by environment
data/maps/                   Hand-curated migration maps (source of truth)
scripts/seed.ts              Load data/maps into Supabase
scripts/smoke.ts             End-to-end test suite (22 checks, all transports)
```

Built with TypeScript, the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) (v1.x stable), Zod, Express, semver, and Supabase. Node.js 22+.

## License

Asynthetic is source-available under the [Business Source License 1.1](LICENSE). In plain terms: reading, modifying, and self-hosting it for your own use — personal, team, or company-internal — is always permitted. What isn't permitted is offering it (or a substantially similar migration-data service) as a hosted product competing with Asynthetic's own offering. On July 4, 2030 the license automatically converts to Apache 2.0. The [LICENSE](LICENSE) file is authoritative; this paragraph is only a summary.
