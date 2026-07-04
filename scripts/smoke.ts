/**
 * End-to-end smoke test: spawns the built server (dist/index.js) over real
 * stdio and exercises every tool the way an agent would.
 *
 * Usage: npm run smoke   (builds first)
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

// Pin the smoke run to the local JSON store regardless of any local .env:
// pre-set (empty) Supabase vars take precedence over process.loadEnvFile(),
// keeping the suite deterministic against data/maps.
const localOnlyEnv = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_KEY: '' };

const client = new Client({ name: 'smoke-test', version: '0.0.1' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...getDefaultEnvironment(), ...localOnlyEnv },
  }),
);

function payloadOf(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as Array<{ type: string; text: string }>;
  assert.equal(content[0]?.type, 'text', 'expected text content');
  return JSON.parse(content[0].text);
}

// 1. Tool discovery
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, [
  'check_compatibility',
  'check_peer_compatibility',
  'get_breaking_changes',
  'get_migration',
  'list_available_maps',
]);
console.log('ok: listTools ->', names.join(', '));

// 2. Stale lifecycle: the SDK map is status "stale" and must never be served,
// even for an exact-version request.
let p = payloadOf(
  await client.callTool({
    name: 'get_migration',
    arguments: { package: '@modelcontextprotocol/sdk', from_version: '1.29.0', to_version: '2.0.0-beta.2' },
  }),
);
assert.equal(p.found, false, 'stale maps are never served');
assert.match(p.coverage_hint, /list_available_maps/);
console.log('ok: get_migration stale SDK map -> found=false (stale never served)');

// 4. Unknown package -> found=false with anti-hallucination guidance
p = payloadOf(
  await client.callTool({
    name: 'get_migration',
    arguments: { package: 'left-pad', from_version: '1.0.0', to_version: '2.0.0' },
  }),
);
assert.equal(p.found, false);
assert.match(p.message, /Do NOT fabricate/i);
assert.ok(Array.isArray(p.available_maps) && p.available_maps.length >= 1);
assert.match(p.coverage_hint, /list_available_maps/);
console.log('ok: get_migration unknown package -> found=false + available_maps + coverage_hint');

// 5. get_breaking_changes on the stale SDK map -> also not served
p = payloadOf(
  await client.callTool({
    name: 'get_breaking_changes',
    arguments: { package: '@modelcontextprotocol/sdk', version: '2' },
  }),
);
assert.equal(p.found, false, 'stale maps are never served via get_breaking_changes either');
console.log('ok: get_breaking_changes stale SDK map -> found=false');

// 6. Vercel AI SDK map: exact lookup
p = payloadOf(
  await client.callTool({
    name: 'get_migration',
    arguments: { package: 'ai', from_version: '4.3.19', to_version: '5.0.0' },
  }),
);
assert.equal(p.found, true);
assert.equal(p.match_type, 'exact');
assert.ok(p.migration.breaking_changes.length >= 20, 'ai map has 20+ breaking changes');
assert.ok(p.migration.source_urls.length >= 3, 'ai map cites multiple sources');
console.log(
  `ok: get_migration ai 4.3.19->5.0.0 exact -> ${p.migration.breaking_changes.length} breaking changes`,
);

// 7. Vercel AI SDK map: major-version fallback (e.g. agent on 4.0.0 targeting 5.x)
p = payloadOf(
  await client.callTool({
    name: 'get_migration',
    arguments: { package: 'ai', from_version: '4.0.0', to_version: '5' },
  }),
);
assert.equal(p.found, true);
assert.equal(p.match_type, 'major-version');
assert.equal(p.resolved_via, 'major_version');
assert.ok(p.match_note, 'non-exact match is disclosed');
console.log('ok: get_migration ai 4.0.0->5 falls back to major-version match');

// 8. get_breaking_changes for ai v5
p = payloadOf(
  await client.callTool({
    name: 'get_breaking_changes',
    arguments: { package: 'ai', version: '5.0.0' },
  }),
);
assert.equal(p.found, true);
assert.ok(p.results[0].breaking_changes.length >= 20);
console.log('ok: get_breaking_changes ai v5');

// 9. Next.js map: exact lookup
p = payloadOf(
  await client.callTool({
    name: 'get_migration',
    arguments: { package: 'next', from_version: '14.2.35', to_version: '15.0.0' },
  }),
);
assert.equal(p.found, true);
assert.equal(p.match_type, 'exact');
assert.ok(p.migration.breaking_changes.length >= 15, 'next map has 15+ breaking changes');
assert.equal(p.source_count, p.migration.source_urls.length, 'source_count derived from source_urls');
assert.equal(p.verification_level, 'high', 'verified map -> high');
assert.deepEqual(p.migration.verified_versions, ['14.2.35', '15.5.20'], 'verified_versions served');
assert.ok(
  p.migration.breaking_changes.some((bc: any) => bc.bundler_caveat || bc.verification_method),
  'verification caveat fields served',
);
assert.ok(
  p.migration.breaking_changes.some((bc: any) => bc.title.includes('async')),
  'async request APIs are mapped',
);
console.log(
  `ok: get_migration next 14.2.35->15.0.0 exact -> ${p.migration.breaking_changes.length} breaking changes`,
);

// 10. Next.js map: major-version fallback (agent on 14.0.0 targeting 15.1.0)
p = payloadOf(
  await client.callTool({
    name: 'get_migration',
    arguments: { package: 'next', from_version: '14.0.0', to_version: '15.1.0' },
  }),
);
assert.equal(p.found, true);
assert.equal(p.match_type, 'major-version');
assert.ok(p.match_note, 'non-exact match is disclosed');
console.log('ok: get_migration next 14.0.0->15.1.0 falls back to major-version match');

// 11. get_breaking_changes for next v15 includes deprecations with timelines
p = payloadOf(
  await client.callTool({
    name: 'get_breaking_changes',
    arguments: { package: 'next', version: '15' },
  }),
);
assert.equal(p.found, true);
assert.ok(p.results[0].breaking_changes.length >= 15);
assert.ok(p.results[0].deprecations.length >= 2, 'deprecations present');
assert.equal(p.results[0].source_count, p.results[0].source_urls.length);
assert.equal(p.results[0].verification_level, 'high');
console.log('ok: get_breaking_changes next v15');

// 12. SemVer caret-range resolution (Next.js): ^14.2.0 -> ^15.0.0
p = payloadOf(
  await client.callTool({
    name: 'get_migration',
    arguments: { package: 'next', from_version: '^14.2.0', to_version: '^15.0.0' },
  }),
);
assert.equal(p.found, true);
assert.equal(p.match_type, 'semver-range');
assert.equal(p.resolved_via, 'semver_range');
assert.match(p.match_note, /SemVer range/i);
assert.ok(p.migration.breaking_changes.length >= 15);
console.log('ok: get_migration next ^14.2.0 -> ^15.0.0 resolves via semver_range');

// 13. SemVer tilde/x-range resolution (AI SDK): ~4.3.0 -> 5.x
p = payloadOf(
  await client.callTool({
    name: 'get_migration',
    arguments: { package: 'ai', from_version: '~4.3.0', to_version: '5.x' },
  }),
);
assert.equal(p.found, true);
assert.equal(p.resolved_via, 'semver_range');
assert.equal(p.migration.to_version, '5.0.0');
console.log('ok: get_migration ai ~4.3.0 -> 5.x resolves via semver_range');

// 14. get_breaking_changes with a range descriptor
p = payloadOf(
  await client.callTool({
    name: 'get_breaking_changes',
    arguments: { package: 'next', version: '^15.0.0' },
  }),
);
assert.equal(p.found, true);
assert.equal(p.results[0].resolved_via, 'semver_range');
console.log('ok: get_breaking_changes next ^15.0.0 resolves via semver_range');

// 15. check_compatibility stub is explicit about being unimplemented
p = payloadOf(
  await client.callTool({
    name: 'check_compatibility',
    arguments: { package_a: 'react', version_a: '19.0.0', package_b: 'next', version_b: '15.0.0' },
  }),
);
assert.equal(p.implemented, false);
console.log('ok: check_compatibility stub -> implemented=false');

// check_peer_compatibility: declared requirement violated -> false
p = payloadOf(
  await client.callTool({
    name: 'check_peer_compatibility',
    arguments: { package_a: 'next', version_a: '15.0.0', package_b: 'react', version_b: '18.2.0' },
  }),
);
assert.equal(p.compatible, false);
assert.match(p.reason, /next@15\.0\.0 requires react@\^19\.0\.0/);
assert.ok(p.source_maps_used.length >= 1, 'cites the map used');
console.log('ok: check_peer_compatibility next@15 + react@18.2.0 -> false');

// check_peer_compatibility: satisfied requirement, reversed argument order -> true
p = payloadOf(
  await client.callTool({
    name: 'check_peer_compatibility',
    arguments: { package_a: 'react', version_a: '19.1.0', package_b: 'next', version_b: '15.0.0' },
  }),
);
assert.equal(p.compatible, true);
console.log('ok: check_peer_compatibility react@19.1.0 + next@15 (reversed) -> true');

// check_peer_compatibility: no curated data -> "unknown", never a guess
p = payloadOf(
  await client.callTool({
    name: 'check_peer_compatibility',
    arguments: { package_a: 'left-pad', version_a: '1.3.0', package_b: 'lodash', version_b: '4.17.21' },
  }),
);
assert.equal(p.compatible, 'unknown');
assert.match(p.reason, /absence of data/i);
console.log('ok: check_peer_compatibility unknown pair -> "unknown"');

// list_available_maps: full store, then filtered
p = payloadOf(await client.callTool({ name: 'list_available_maps', arguments: {} }));
assert.equal(p.count, 2, 'stale SDK map excluded from listing');
assert.ok(p.maps.every((m: any) => m.package && m.from_version && m.to_version && m.status && m.last_verified));
console.log('ok: list_available_maps -> 2 maps (stale excluded)');

p = payloadOf(await client.callTool({ name: 'list_available_maps', arguments: { package: 'next' } }));
assert.equal(p.count, 1);
assert.equal(p.maps[0].package, 'next');
console.log('ok: list_available_maps package filter -> 1 map');

await client.close();

// Pre-release cap + warning: exercised via a synthetic map in a temp data dir
// so the real curated maps stay untouched. The map is status "verified" with
// 2 sources — it would be "high" — but targets a pre-release, so it must cap
// at "medium" and carry the warning.
const preReleaseDir = mkdtempSync(path.join(os.tmpdir(), 'asynthetic-smoke-'));
writeFileSync(
  path.join(preReleaseDir, 'prerelease.json'),
  JSON.stringify({
    ecosystem: 'npm',
    package: 'prerelease-test-pkg',
    from_version: '8.0.0',
    to_version: '9.0.0-rc.1',
    summary: 'Synthetic smoke-test map targeting a pre-release version.',
    breaking_changes: [
      {
        title: 'Example removal',
        description: 'Synthetic entry for smoke testing.',
        category: 'removal',
        affected_symbols: ['example'],
        before_code: null,
        after_code: null,
        migration_note: 'None — synthetic.',
        source_url: null,
      },
    ],
    deprecations: [],
    compatible_with: [],
    source_urls: ['https://example.com/changelog', 'https://example.com/releases'],
    last_verified: '2026-07-04',
    status: 'verified',
    target_release_status: 'pre-release',
  }),
);
const preClient = new Client({ name: 'smoke-prerelease', version: '0.0.1' });
try {
  await preClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...getDefaultEnvironment(), ...localOnlyEnv, MIGRATION_DATA_DIR: preReleaseDir },
    }),
  );
  p = payloadOf(
    await preClient.callTool({
      name: 'get_migration',
      arguments: { package: 'prerelease-test-pkg', from_version: '8.0.0', to_version: '9.0.0-rc.1' },
    }),
  );
  assert.equal(p.found, true);
  assert.equal(p.verification_level, 'medium', 'verified map targeting pre-release capped at medium');
  assert.match(p.warning, /pre-release version that has not shipped as stable/);
  console.log('ok: pre-release target caps verified map at medium + warning');

  p = payloadOf(
    await preClient.callTool({
      name: 'get_breaking_changes',
      arguments: { package: 'prerelease-test-pkg', version: '9.0.0-rc.1' },
    }),
  );
  assert.equal(p.results[0].verification_level, 'medium');
  assert.match(p.results[0].warning, /pre-release/);
  console.log('ok: pre-release warning present in get_breaking_changes too');
} finally {
  await preClient.close().catch(() => {});
  rmSync(preReleaseDir, { recursive: true, force: true });
}

// HTTP mode (the Railway path): boot with PORT set, then connect via
// modern Streamable HTTP and via the legacy SSE endpoints.
const PORT = 3917;
const httpProc = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, ...localOnlyEnv, PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});
try {
  const deadline = Date.now() + 15_000;
  let up = false;
  while (!up && Date.now() < deadline) {
    try {
      up = (await fetch(`http://127.0.0.1:${PORT}/`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert.ok(up, 'HTTP server came up on PORT');

  const httpClient = new Client({ name: 'smoke-http', version: '0.0.1' });
  await httpClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const httpTools = await httpClient.listTools();
  assert.equal(httpTools.tools.length, 5);
  p = payloadOf(
    await httpClient.callTool({
      name: 'get_migration',
      arguments: { package: 'next', from_version: '^14.2.0', to_version: '^15.0.0' },
    }),
  );
  assert.equal(p.found, true);
  assert.equal(p.resolved_via, 'semver_range');
  await httpClient.close();
  console.log('ok: HTTP mode serves Streamable HTTP at /mcp');

  const sseClient = new Client({ name: 'smoke-sse', version: '0.0.1' });
  await sseClient.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${PORT}/sse`)));
  const sseTools = await sseClient.listTools();
  assert.equal(sseTools.tools.length, 5);
  await sseClient.close();
  console.log('ok: HTTP mode serves legacy SSE at /sse + /messages');
} finally {
  httpProc.kill();
}

console.log('\nSMOKE TEST PASSED (23/23)');
