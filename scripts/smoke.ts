/**
 * End-to-end smoke test: spawns the built server (dist/index.js) over real
 * stdio and exercises every tool the way an agent would.
 *
 * Usage: npm run smoke   (builds first)
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
assert.deepEqual(names, ['check_compatibility', 'get_breaking_changes', 'get_migration']);
console.log('ok: listTools ->', names.join(', '));

// 2. Exact-version lookup
let p = payloadOf(
  await client.callTool({
    name: 'get_migration',
    arguments: { package: '@modelcontextprotocol/sdk', from_version: '1.29.0', to_version: '2.0.0-beta.2' },
  }),
);
assert.equal(p.found, true);
assert.equal(p.match_type, 'exact');
assert.equal(p.resolved_via, 'exact_string');
assert.equal(p.migration.breaking_changes.length, 21);
assert.ok(p.migration.source_urls.length >= 1, 'source citations present');
assert.ok(p.migration.last_verified, 'last_verified present');
console.log('ok: get_migration exact -> 21 breaking changes, cited, last_verified', p.migration.last_verified);

// 3. Major-version fallback (agent asks 1.20.0 -> 2.0.0)
p = payloadOf(
  await client.callTool({
    name: 'get_migration',
    arguments: { package: '@modelcontextprotocol/sdk', from_version: '1.20.0', to_version: '2.0.0' },
  }),
);
assert.equal(p.found, true);
assert.equal(p.match_type, 'major-version');
assert.equal(p.resolved_via, 'major_version');
assert.ok(p.match_note, 'non-exact match is disclosed');
console.log('ok: get_migration major-version fallback discloses match_note');

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
console.log('ok: get_migration unknown package -> found=false + available_maps');

// 5. get_breaking_changes by major version
p = payloadOf(
  await client.callTool({
    name: 'get_breaking_changes',
    arguments: { package: '@modelcontextprotocol/sdk', version: '2' },
  }),
);
assert.equal(p.found, true);
assert.equal(p.results.length, 1);
assert.equal(p.results[0].breaking_changes.length, 21);
console.log('ok: get_breaking_changes v2 -> 21 changes');

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

await client.close();

// 16 + 17. HTTP mode (the Railway path): boot with PORT set, then connect via
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
  assert.equal(httpTools.tools.length, 3);
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
  assert.equal(sseTools.tools.length, 3);
  await sseClient.close();
  console.log('ok: HTTP mode serves legacy SSE at /sse + /messages');
} finally {
  httpProc.kill();
}

console.log('\nSMOKE TEST PASSED (17/17)');
