/**
 * Supabase (Postgres) store. Reads the three tables defined in schema/schema.sql
 * and reassembles rows into the same MigrationMap shape the local store serves.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { MigrationMap } from '../types/migration-map.js';
import { toSummary, type MapSummary, type MigrationStore } from './store.js';

interface BreakingChangeRow {
  position: number;
  title: string;
  description: string;
  category: MigrationMap['breaking_changes'][number]['category'];
  affected_symbols: string[] | null;
  before_code: string | null;
  after_code: string | null;
  migration_note: string;
  source_url: string | null;
}

interface DeprecationRow {
  symbol: string;
  replacement: string | null;
  removal_timeline: string | null;
  note: string | null;
}

interface MigrationRow {
  ecosystem: MigrationMap['ecosystem'];
  package: string;
  from_version: string;
  to_version: string;
  summary: string;
  source_urls: string[];
  last_verified: string;
  status: MigrationMap['status'];
  breaking_changes: BreakingChangeRow[];
  deprecations: DeprecationRow[];
}

function rowToMap(row: MigrationRow): MigrationMap {
  return {
    ecosystem: row.ecosystem,
    package: row.package,
    from_version: row.from_version,
    to_version: row.to_version,
    summary: row.summary,
    breaking_changes: [...row.breaking_changes]
      .sort((a, b) => a.position - b.position)
      .map(({ position: _position, affected_symbols, ...bc }) => ({
        ...bc,
        affected_symbols: affected_symbols ?? [],
      })),
    deprecations: row.deprecations,
    source_urls: row.source_urls,
    last_verified: row.last_verified,
    status: row.status,
  };
}

const SELECT = '*, breaking_changes(*), deprecations(*)';

export class SupabaseStore implements MigrationStore {
  private readonly client: SupabaseClient;

  constructor(
    private readonly url: string,
    key: string,
  ) {
    this.client = createClient(url, key, { auth: { persistSession: false } });
  }

  async getMapsForPackage(ecosystem: string, pkg: string): Promise<MigrationMap[]> {
    const { data, error } = await this.client
      .from('migrations')
      .select(SELECT)
      .eq('ecosystem', ecosystem)
      .ilike('package', pkg.trim()) // no wildcards -> case-insensitive equality
      .neq('status', 'stale');
    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    return ((data ?? []) as unknown as MigrationRow[]).map(rowToMap);
  }

  async listMaps(): Promise<MapSummary[]> {
    const { data, error } = await this.client
      .from('migrations')
      .select('ecosystem, package, from_version, to_version, status, last_verified')
      .neq('status', 'stale')
      .order('package');
    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    return (data ?? []) as MapSummary[];
  }

  describe(): string {
    return `Supabase (${this.url})`;
  }
}

// Re-exported here so map assembly stays reusable by scripts/seed.ts.
export { toSummary };
