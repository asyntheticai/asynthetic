/**
 * Seeds Supabase with every map under data/maps/ (including stale ones — the
 * database is the full record; serving-time filtering happens in the store).
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (writes bypass RLS) —
 * SUPABASE_ANON_KEY is accepted but will fail if RLS blocks inserts.
 *
 * Usage: npm run seed
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadLocalMaps } from '../src/store/local-store.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY;
if (!url || !key) {
  console.error('seed: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) must be set.');
  process.exit(1);
}

const dataDir =
  process.env.MIGRATION_DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'maps');

const maps = loadLocalMaps(dataDir, { includeStale: true });
if (maps.length === 0) {
  console.error(`seed: no valid maps found under ${dataDir}`);
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

for (const map of maps) {
  const { breaking_changes, deprecations, ...migration } = map;

  const { data: row, error: upsertError } = await supabase
    .from('migrations')
    .upsert(migration, { onConflict: 'ecosystem,package,from_version,to_version' })
    .select('id')
    .single();
  if (upsertError || !row) {
    console.error(`seed: upsert failed for ${map.package} ${map.from_version}->${map.to_version}:`, upsertError?.message);
    process.exitCode = 1;
    continue;
  }

  // Replace children wholesale — the JSON file is the source of truth.
  for (const table of ['breaking_changes', 'deprecations'] as const) {
    const { error } = await supabase.from(table).delete().eq('migration_id', row.id);
    if (error) {
      console.error(`seed: clearing ${table} failed:`, error.message);
      process.exitCode = 1;
    }
  }

  const { error: bcError } = await supabase.from('breaking_changes').insert(
    breaking_changes.map((bc, i) => ({ ...bc, migration_id: row.id, position: i + 1 })),
  );
  if (bcError) {
    console.error(`seed: inserting breaking_changes failed:`, bcError.message);
    process.exitCode = 1;
  }

  if (deprecations.length > 0) {
    const { error: depError } = await supabase.from('deprecations').insert(
      deprecations.map((d) => ({ ...d, migration_id: row.id })),
    );
    if (depError) {
      console.error(`seed: inserting deprecations failed:`, depError.message);
      process.exitCode = 1;
    }
  }

  console.log(
    `seed: ${map.package} ${map.from_version} -> ${map.to_version} (${breaking_changes.length} changes, ${deprecations.length} deprecations)`,
  );
}
