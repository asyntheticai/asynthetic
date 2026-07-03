/**
 * Asynthetic — migration-map types.
 *
 * These mirror schema/schema.sql exactly. The Zod schema at the bottom validates
 * map JSON files (data/maps/**) before they are inserted into Postgres, so a
 * malformed hand-curated map fails at ingestion, not at serve time.
 */
// zod/v4 subpath: the v1 MCP SDK pairs with the Zod v3 API (used for tool inputs
// in src/index.ts), while this ingestion validator uses the v4 API. zod@^3.25
// ships both, so one installed package serves both consumers.
import * as z from 'zod/v4';

export type Ecosystem = 'npm'; // widen when a non-npm library is curated

export type ChangeCategory =
  | 'signature-change'
  | 'removal'
  | 'deprecation'
  | 'behavior-change'
  | 'config-change'
  | 'import-change'
  | 'rename';

export type MigrationStatus = 'draft' | 'verified' | 'stale';

export interface BreakingChange {
  title: string;
  description: string;
  category: ChangeCategory;
  /** Functions/exports/config keys affected. Empty when the change is package-wide. */
  affected_symbols: string[];
  before_code: string | null;
  after_code: string | null;
  /** Plain-language "how to fix". */
  migration_note: string;
  /** Per-change citation; falls back to MigrationMap.source_urls when null. */
  source_url: string | null;
}

export interface Deprecation {
  symbol: string;
  replacement: string | null;
  removal_timeline: string | null;
  note: string | null;
}

export interface MigrationMap {
  ecosystem: Ecosystem;
  package: string;
  /** Concrete semver the map was verified from (e.g. "1.29.0"). */
  from_version: string;
  /** Concrete semver the map was verified to (e.g. "2.0.0-beta.2"). */
  to_version: string;
  summary: string;
  breaking_changes: BreakingChange[];
  deprecations: Deprecation[];
  source_urls: string[];
  /** ISO date (YYYY-MM-DD) the sources were last checked against this map. */
  last_verified: string;
  status: MigrationStatus;
}

export const BreakingChangeSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.enum([
    'signature-change',
    'removal',
    'deprecation',
    'behavior-change',
    'config-change',
    'import-change',
    'rename',
  ]),
  affected_symbols: z.array(z.string().min(1)),
  before_code: z.string().min(1).nullable(),
  after_code: z.string().min(1).nullable(),
  migration_note: z.string().min(1),
  source_url: z.url().nullable(),
});

export const DeprecationSchema = z.object({
  symbol: z.string().min(1),
  replacement: z.string().min(1).nullable(),
  removal_timeline: z.string().min(1).nullable(),
  note: z.string().min(1).nullable(),
});

export const MigrationMapSchema = z.object({
  ecosystem: z.literal('npm'),
  package: z.string().min(1),
  from_version: z.string().min(1),
  to_version: z.string().min(1),
  summary: z.string().min(1),
  breaking_changes: z.array(BreakingChangeSchema).min(1),
  deprecations: z.array(DeprecationSchema),
  source_urls: z.array(z.url()).min(1),
  last_verified: z.iso.date(),
  status: z.enum(['draft', 'verified', 'stale']),
}) satisfies z.ZodType<MigrationMap>;
