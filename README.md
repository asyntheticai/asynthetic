# Asynthetic

**Ground truth for AI coding agents.**

Your agent's knowledge froze on a date. Asynthetic tells it exactly what changed — every breaking change between library versions, cited and tested.

```sh
claude mcp add --transport http asynthetic https://asynthetic.up.railway.app/mcp
```

```jsonc
// agent asks: get_migration("ai", "^4.0.0", "^5.0.0")
{
  "found": true,
  "verification_level": "medium",
  "migration": {
    "breaking_changes": [
      {
        "title": "maxTokens renamed to maxOutputTokens",
        "before_code": "generateText({ model, maxTokens: 1024, prompt })",
        "after_code":  "generateText({ model, maxOutputTokens: 1024, prompt })",
        "source_url": "https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0"
      }
      // …22 more, every one cited
    ]
  }
}
```

---

## Models improve every month. Their knowledge still ends on a date.

Every coding agent ships with a knowledge freeze date. The libraries it writes against don't.

So agents do what the training data taught them: they write `maxTokens` into AI SDK 5 (removed), synchronous `params` into Next.js 15 (now a Promise), `LangChainAdapter` imports from a package that no longer exports them. The code looks right. The agent is confident. The build breaks — or worse, it doesn't, and the bug ships.

Tools that fetch current documentation tell agents what the API looks like *today*. That's half the problem. An upgrade needs the **diff**: what changed, what replaced it, and what silently behaves differently. No amount of "current docs" contains that.

Asynthetic is that missing half. Ask it about an upgrade, and it returns a hand-curated migration map: ordered breaking changes with before/after code, deprecation timelines, peer-version requirements, and a citation for every claim. Retrieval, never generation — the same question gets the same verified answer every time.

## Before / after

**Without Asynthetic** — the agent "upgrades" your AI SDK app from memory: keeps `result.usage` for billing (now silently counts only the final step), leaves `temperature` unset (v5 removed the implicit `0` — output turns nondeterministic), renames nothing because v4 syntax *was* correct when the model trained.

**With Asynthetic** — one tool call returns all 23 breaking changes for that exact version window, including the three above, each with the fix and the official source. The agent applies facts. You review a diff instead of debugging a regression.

That's the product: the difference between an agent that remembers and an agent that knows.

## What a map gives your agent

| | |
|---|---|
| **Migration Maps** | Hand-curated upgrade intelligence per version window: 40 breaking changes across 2 live maps (`next` 14→15, `ai` 4→5) |
| **Citations** | Every map cites official sources and carries a `last_verified` date. Maps are never LLM-generated. |
| **Verification Levels** | Every response self-reports confidence: `high` (empirically tested on real builds), `medium`, `low` — derived, never self-declared |
| **Field Notes** | Where reality diverges from docs, maps say so — e.g. Turbopack doesn't actually enforce the `@next/font` removal that Webpack does; Next 15's React 19 "requirement" isn't build-enforced. Found by running the upgrades, not reading about them. |
| **SemVer Resolution** | Ask with ranges (`^14.2.0 → ^15.0.0`); resolution method is always disclosed |
| **Peer Checks** | Static compatibility answers (`next@15` + `react@18.2` → `false`, with the cited reason) |
| **Honest Misses** | No data means `found: false` and an explicit instruction not to guess — never a plausible fabrication |

The `next` 14→15 map is Asynthetic's first `verification_level: high`: every entry tested against real builds on 14.2.35 and 15.5.20, across Turbopack and Webpack, dev and production.

## Install

**Hosted** (nothing to install):

```sh
claude mcp add --transport http asynthetic https://asynthetic.up.railway.app/mcp
```

**Local** (offline, bundled data):

```sh
claude mcp add asynthetic -- npx -y asynthetic
```

Any MCP client works — Cursor, Claude Code, Windsurf, or your own agent:

```json
{ "mcpServers": { "asynthetic": { "url": "https://asynthetic.up.railway.app/mcp" } } }
```

Then upgrade something. The agent calls `get_migration` before it edits.

## Tools

| Tool | Answers |
|---|---|
| `get_migration(package, from, to)` | "What breaks between these versions, and how do I fix each one?" |
| `get_breaking_changes(package, version)` | "What does this version break?" |
| `check_peer_compatibility(a, va, b, vb)` | "Do these two versions work together?" — `true` / `false` / `unknown`, cited |
| `list_available_maps()` | "What does Asynthetic know?" |

Full response shape, transports (Streamable HTTP + stdio + legacy SSE), and self-hosting: see [docs below](#self-hosting).

## Why trust it

Asynthetic's founding rule: **a wrong map is worse than no map.** Everything follows from that.

- Curated exclusively from official changelogs, migration guides, and releases — with the URL attached to every entry.
- `verified` status is earned empirically, not editorially: real projects, both bundlers, dev and production, on pinned versions. The process regularly finds things the docs get wrong — those findings ship in the maps.
- Confidence is machine-readable (`verification_level`, `source_count`, pre-release warnings), so agents can weigh answers instead of trusting blindly.
- Unknown is a first-class answer. The server tells agents when it doesn't know and instructs them not to invent.

Narrow and deep, on purpose: fast-moving AI and JavaScript frameworks first, correctness over coverage always.

## Self-hosting

```sh
git clone https://github.com/asyntheticai/asynthetic.git
cd asynthetic && npm install && npm run build && npm start
```

Zero-config serves the bundled maps over stdio. Set `PORT` for HTTP mode (`/mcp`, legacy `/sse`, health at `/`). Set `SUPABASE_URL` + `SUPABASE_ANON_KEY` to serve from Postgres (`schema/schema.sql`, then `npm run seed`). Missing config never crashes — it falls back and says so on stderr.

```
data/maps/          the maps (source of truth, JSON, Zod-validated)
src/server.ts       MCP tools
src/store/          Postgres + local backends, SemVer resolver
scripts/smoke.ts    23-check end-to-end suite across every transport
```

## Contributing a map

1. **Official sources only.** Changelogs, release notes, migration guides. Record every URL. Blog posts can start a hunt; they can't finish one.
2. Follow the schema in `src/types/migration-map.ts` — validation rejects anything malformed before it can ever be served.
3. New maps enter as `draft`. `verified` is earned by testing snippets on real builds of the pinned versions. Retired maps become `stale` — excluded from serving, kept as record.
4. `npm run smoke` must pass. Don't guess versions or API names: if it's not in an official source, flag it in the PR instead.

## Status

Free public beta — hosted endpoint and npm package open to everyone. Next: more maps (Tailwind 3→4, React 18→19, Zod 3→4, AI SDK 5→6), more `high`-verification promotions, project-aware compatibility analysis. Details will be announced.

## Security

Read-only by construction: every tool is a lookup over curated data. No code execution, no request-time fetching, no access to your project or filesystem. The hosted endpoint sees only tool arguments (package names, version strings); sessions are ephemeral, in-memory, and isolated. Report issues via GitHub security advisories.

## License

Source-available under [BSL 1.1](LICENSE): self-hosting for your own use — personal, team, company-internal — is always permitted; reselling it as a competing hosted service isn't. Converts automatically to Apache 2.0 on July 4, 2030.

---

Built with TypeScript, the official MCP SDK, Zod, and Supabase. Serving live at [`asynthetic.up.railway.app/mcp`](https://asynthetic.up.railway.app/).
