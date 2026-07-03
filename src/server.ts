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
import {
  interpretDescriptor,
  majorOf,
  normalizeVersion,
  resolveMigration,
  resolvedViaOf,
  toSummary,
  type MigrationStore,
} from './store/store.js';

export const SERVER_NAME = 'asynthetic';
export const SERVER_VERSION = '0.1.0-beta';

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
          const available = maps.length > 0 ? maps.map(toSummary) : await store.listMaps();
          return jsonResult({
            found: false,
            requested,
            message: NOT_FOUND_GUIDANCE,
            available_maps: available,
          });
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
          const available = maps.length > 0 ? maps.map(toSummary) : await store.listMaps();
          return jsonResult({
            found: false,
            requested,
            message: NOT_FOUND_GUIDANCE,
            available_maps: available,
          });
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

  // Stub per brief §7/§11: declared so agents can discover it, but explicitly
  // returns "not implemented" — it must never look like real compatibility data.
  server.registerTool(
    'check_compatibility',
    {
      title: 'Check cross-package compatibility (not yet implemented)',
      description:
        'PLANNED: known compatibility issues between two package versions. Currently returns implemented=false ' +
        'and no data. Do not infer compatibility (or incompatibility) from this response.',
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
