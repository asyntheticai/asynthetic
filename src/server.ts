/**
 * Asynthetic — MCP server factory.
 *
 * builds a fully-registered McpServer instance. A factory (rather than a
 * module-level singleton) because HTTP mode serves many concurrent sessions
 * and a Protocol instance binds to exactly one transport; stdio mode simply
 * builds one.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MigrationMap } from './types/migration-map.js';
import {
  interpretDescriptor,
  majorOf,
  normalizeVersion,
  resolveMigration,
  resolvedViaOf,
  satisfiesRange,
  toSummary,
  type MigrationStore,
} from './store/store.js';

export const SERVER_NAME = 'asynthetic';
export const SERVER_VERSION = '0.1.2';

const NOT_FOUND_GUIDANCE =
  'No verified migration map exists for this request. Do NOT fabricate migration steps from model memory — ' +
  'consult the official changelog / release notes for this package instead.';

function jsonResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function storeError(err: unknown) {
  console.error('[asynthetic] Store error:', err);
  return jsonResult(
    { error: `Store lookup failed: ${err instanceof Error ? err.message : String(err)}` },
    true,
  );
}

const packageArg = z.string().min(1).describe('Package name as published, e.g. "@modelcontextprotocol/sdk"');
const ecosystemArg = z.string().default('npm').describe('Package ecosystem (default "npm")');

// Inline at most this many map summaries in found:false responses; beyond
// that, point the agent at list_available_maps instead of dumping the list.
const AVAILABLE_MAPS_INLINE_LIMIT = 10;

/**
 * Derived confidence signal for responses. Purely additive — the underlying
 * status field and validation are unchanged.
 *
 * Thresholds are a deliberate judgment call and may be revisited:
 * - status "verified"          -> "high"   (snippets checked against real code)
 * - status "draft", 2+ sources -> "medium" (multiple independent official sources)
 * - status "draft", 1 source   -> "low"    (single-source curation)
 * Stale maps are never served, so they never reach this function in practice.
 *
 * Pre-release cap: a map whose to_version is a pre-release
 * (target_release_status: "pre-release") can never be "high" — even verified
 * snippets may be invalidated before the target ships stable.
 */
function verificationLevelOf(map: MigrationMap): 'high' | 'medium' | 'low' {
  const base = map.status === 'verified' ? 'high' : map.source_urls.length >= 2 ? 'medium' : 'low';
  if (base === 'high' && isPreRelease(map)) return 'medium';
  return base;
}

function isPreRelease(map: MigrationMap): boolean {
  // Absent field (e.g. Supabase rows predating it) means "stable".
  return (map.target_release_status ?? 'stable') === 'pre-release';
}

const PRE_RELEASE_WARNING =
  'This migration targets a pre-release version that has not shipped as stable. Do not apply to ' +
  'production code without verifying against the current pre-release build.';

async function notFound(store: MigrationStore, requested: unknown, packageMaps: MigrationMap[]) {
  const available = packageMaps.length > 0 ? packageMaps.map(toSummary) : await store.list();
  return jsonResult({
    found: false,
    requested,
    message: NOT_FOUND_GUIDANCE,
    available_maps: available.slice(0, AVAILABLE_MAPS_INLINE_LIMIT),
    ...(available.length > AVAILABLE_MAPS_INLINE_LIMIT ? { available_maps_truncated: true } : {}),
    coverage_hint: 'Call list_available_maps (optional filters: ecosystem, package) to see full coverage.',
  });
}

export function buildServer(store: MigrationStore): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'get_migration',
    {
      title: 'Get migration map',
      description:
        'Returns the verified migration map for upgrading a package between two versions: ordered breaking ' +
        'changes with before/after code, deprecations, source-citation URLs, and a last_verified date. ' +
        'Accepts concrete versions or SemVer ranges (e.g. "^14.2.0", "~14.1.0", "15.x"); non-exact lookups ' +
        'resolve to the covering map and disclose how via match_type/resolved_via/match_note. ' +
        'If found=false, no verified data exists — do not guess.',
      inputSchema: {
        package: packageArg,
        from_version: z
          .string()
          .min(1)
          .describe('Version or SemVer range currently in use, e.g. "1.29.0", "^14.2.0", "1.x"'),
        to_version: z
          .string()
          .min(1)
          .describe('Version or SemVer range upgrading to, e.g. "2.0.0", "^15.0.0", "2.x"'),
        ecosystem: ecosystemArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ package: pkg, from_version, to_version, ecosystem }) => {
      const requested = { package: pkg, ecosystem, from_version, to_version };
      try {
        const maps = await store.getMapsForPackage(ecosystem, pkg);
        const resolved = resolveMigration(maps, from_version, to_version);

        if (!resolved) {
          return notFound(store, requested, maps);
        }

        const { map, match_type } = resolved;
        const match_note =
          match_type === 'exact'
            ? undefined
            : match_type === 'semver-range'
              ? `Resolved via SemVer range processing: the requested window ${from_version} -> ${to_version} ` +
                `falls inside the map verified for ${map.from_version} -> ${map.to_version}. ` +
                'Details specific to intermediate minor/patch versions may not be covered.'
              : `No map exists for exactly ${from_version} -> ${to_version}; returning the map verified for ` +
                `${map.from_version} -> ${map.to_version} (same major-version jump). ` +
                'Details specific to intermediate minor/patch versions may not be covered.';
        return jsonResult({
          found: true,
          requested,
          match_type,
          resolved_via: resolvedViaOf(match_type),
          ...(match_note ? { match_note } : {}),
          source_count: map.source_urls.length,
          verification_level: verificationLevelOf(map),
          ...(isPreRelease(map) ? { warning: PRE_RELEASE_WARNING } : {}),
          migration: map,
        });
      } catch (err) {
        return storeError(err);
      }
    },
  );

  server.registerTool(
    'get_breaking_changes',
    {
      title: 'Get breaking changes in a version',
      description:
        'Returns the breaking changes introduced when upgrading TO the given version of a package (matched by ' +
        'major version against curated migration maps), with source citations and last_verified dates. ' +
        'Accepts concrete versions or SemVer ranges ("15", "^15.0.0", "15.x"); resolution is disclosed via ' +
        'match_type/resolved_via. If found=false, no verified data exists — do not guess.',
      inputSchema: {
        package: packageArg,
        version: z
          .string()
          .min(1)
          .describe('The version (or SemVer range) whose breaking changes you want, e.g. "2.0.0", "^15.0.0"'),
        ecosystem: ecosystemArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ package: pkg, version, ecosystem }) => {
      const requested = { package: pkg, ecosystem, version };
      try {
        const target = interpretDescriptor(version);
        const maps = await store.getMapsForPackage(ecosystem, pkg);
        const matching = target === null ? [] : maps.filter((m) => majorOf(m.to_version) === target.major);

        if (matching.length === 0) {
          return notFound(store, requested, maps);
        }

        return jsonResult({
          found: true,
          requested,
          results: matching.map((map) => {
            const match_type =
              normalizeVersion(map.to_version) === normalizeVersion(version)
                ? ('exact' as const)
                : target!.kind === 'range'
                  ? ('semver-range' as const)
                  : ('major-version' as const);
            return {
              from_version: map.from_version,
              to_version: map.to_version,
              match_type,
              resolved_via: resolvedViaOf(match_type),
              status: map.status,
              source_count: map.source_urls.length,
              verification_level: verificationLevelOf(map),
              ...(isPreRelease(map) ? { warning: PRE_RELEASE_WARNING } : {}),
              last_verified: map.last_verified,
              source_urls: map.source_urls,
              summary: map.summary,
              breaking_changes: map.breaking_changes,
              deprecations: map.deprecations,
            };
          }),
        });
      } catch (err) {
        return storeError(err);
      }
    },
  );

  server.registerTool(
    'list_available_maps',
    {
      title: 'List available migration maps',
      description:
        'Lists every migration map in the store: package, ecosystem, from_version, to_version, status ' +
        '(draft/verified/stale), last_verified. Optional filters: ecosystem, package. Use this to discover ' +
        'coverage before calling get_migration.',
      inputSchema: {
        ecosystem: z.string().optional().describe('Filter by ecosystem, e.g. "npm"'),
        package: z.string().optional().describe('Filter by exact package name (case-insensitive)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ecosystem, package: pkg }) => {
      try {
        const maps = await store.list({ ecosystem, package: pkg });
        return jsonResult({ count: maps.length, maps });
      } catch (err) {
        return storeError(err);
      }
    },
  );

  server.registerTool(
    'check_peer_compatibility',
    {
      title: 'Check peer compatibility between two package versions',
      description:
        'Static SemVer check of two known package versions against curated compatible_with peer data from ' +
        'migration maps. Purely declarative — no filesystem access or project inspection (that is the scope ' +
        'of the separate, unimplemented check_compatibility). Returns compatible: true | false | "unknown". ' +
        'Treat "unknown" as absence of curated data, never as evidence of incompatibility.',
      inputSchema: {
        package_a: z.string().min(1).describe('First package name, e.g. "next"'),
        version_a: z.string().min(1).describe('Version (or SemVer range) of package_a, e.g. "15.0.0"'),
        package_b: z.string().min(1).describe('Second package name, e.g. "react"'),
        version_b: z.string().min(1).describe('Version (or SemVer range) of package_b, e.g. "18.2.0"'),
        ecosystem: ecosystemArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ package_a, version_a, package_b, version_b, ecosystem }) => {
      const requested = { package_a, version_a, package_b, version_b, ecosystem };
      try {
        interface PeerCheck {
          declared_by: string;
          requires: string;
          required: boolean;
          note: string | null;
          satisfied: boolean | 'unknown';
        }
        const checks: PeerCheck[] = [];
        const sourceMaps = new Map<string, object>();

        // Peer data may be declared on either side of the pair — check both.
        const directions: Array<[string, string, string, string]> = [
          [package_a, version_a, package_b, version_b],
          [package_b, version_b, package_a, version_a],
        ];
        for (const [declPkg, declVersion, peerPkg, peerVersion] of directions) {
          const info = interpretDescriptor(declVersion);
          if (!info) continue;
          const maps = await store.getMapsForPackage(ecosystem, declPkg);
          for (const map of maps) {
            // compatible_with describes the map's to_version, so only maps
            // whose target major matches the declared version apply.
            if (majorOf(map.to_version) !== info.major) continue;
            const entries = map.compatible_with.filter(
              (e) => e.package.toLowerCase() === peerPkg.trim().toLowerCase(),
            );
            if (entries.length === 0) continue;
            sourceMaps.set(`${map.package}@${map.from_version}->${map.to_version}`, {
              ...toSummary(map),
              source_urls: map.source_urls,
            });
            for (const entry of entries) {
              checks.push({
                declared_by: `${map.package}@${map.to_version}`,
                requires: `${entry.package}@${entry.version_range}`,
                required: entry.required,
                note: entry.note,
                satisfied: satisfiesRange(peerVersion, entry.version_range),
              });
            }
          }
        }

        if (checks.length === 0) {
          return jsonResult({
            compatible: 'unknown',
            requested,
            reason:
              'No curated peer-compatibility data covers this package pair. This is absence of data, not ' +
              'evidence of incompatibility — do not infer either way.',
            checks: [],
            source_maps_used: [],
          });
        }

        const failed = checks.filter((c) => c.required && c.satisfied === false);
        const hasUnknown = checks.some((c) => c.satisfied === 'unknown');
        const compatible = failed.length > 0 ? false : hasUnknown ? ('unknown' as const) : true;
        const reason =
          failed.length > 0
            ? failed
                .map((c) => `${c.declared_by} requires ${c.requires}${c.note ? ` (${c.note})` : ''}`)
                .join('; ')
            : hasUnknown
              ? 'Some declared requirements could not be evaluated against the given version descriptors.'
              : checks.map((c) => `${c.declared_by} requires ${c.requires} — satisfied`).join('; ');
        return jsonResult({
          compatible,
          requested,
          reason,
          checks,
          source_maps_used: [...sourceMaps.values()],
        });
      } catch (err) {
        return storeError(err);
      }
    },
  );

  // Stub per brief §7/§11: declared so agents can discover it, but explicitly
  // returns "not implemented" — it must never look like real compatibility data.
  server.registerTool(
    'check_compatibility',
    {
      title: 'Check cross-package compatibility (not yet implemented)',
      description:
        'PLANNED: project-aware compatibility analysis. Currently returns implemented=false and no data. ' +
        'Do not infer compatibility (or incompatibility) from this response. For a static SemVer check ' +
        'between two known package versions, use check_peer_compatibility instead.',
      inputSchema: {
        package_a: z.string().min(1),
        version_a: z.string().min(1),
        package_b: z.string().min(1),
        version_b: z.string().min(1),
        ecosystem: ecosystemArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      jsonResult({
        implemented: false,
        message:
          'Cross-package compatibility lookup is planned but not yet available. This response contains no ' +
          'compatibility data — do not treat it as evidence that the packages are (or are not) compatible.',
      }),
  );

  return server;
}
