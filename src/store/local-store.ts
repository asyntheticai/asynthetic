/**
 * Local-file fallback store: reads migration maps from data/maps/**\/*.json.
 *
 * Used when Supabase env vars are absent so the server always starts in
 * development. Every file is validated with MigrationMapSchema on load;
 * invalid files are skipped with a stderr warning, never served.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MigrationMapSchema, type MigrationMap } from '../types/migration-map.js';
import { toSummary, type MapSummary, type MigrationStore, type StoreListFilter } from './store.js';

// Resolves to <project>/data/maps from both src/store (tsx) and dist/store (build).
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data/maps', import.meta.url));

export function loadLocalMaps(dataDir: string, opts: { includeStale?: boolean } = {}): MigrationMap[] {
  let entries;
  try {
    entries = readdirSync(dataDir, { recursive: true, withFileTypes: true });
  } catch (err) {
    console.error(`[asynthetic] Cannot read data directory ${dataDir}:`, err);
    return [];
  }

  const maps: MigrationMap[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    try {
      const parsed = MigrationMapSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));
      if (!parsed.success) {
        console.error(
          `[asynthetic] Skipping invalid map ${filePath}: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        );
        continue;
      }
      if (!opts.includeStale && parsed.data.status === 'stale') continue;
      maps.push(parsed.data);
    } catch (err) {
      console.error(`[asynthetic] Skipping unreadable map ${filePath}:`, err);
    }
  }
  return maps;
}

export class LocalFileStore implements MigrationStore {
  private cache: MigrationMap[] | null = null;

  constructor(
    private readonly dataDir: string = process.env.MIGRATION_DATA_DIR ?? DEFAULT_DATA_DIR,
  ) {}

  private load(): MigrationMap[] {
    this.cache ??= loadLocalMaps(this.dataDir);
    return this.cache;
  }

  async getMapsForPackage(ecosystem: string, pkg: string): Promise<MigrationMap[]> {
    const wanted = pkg.trim().toLowerCase();
    return this.load().filter(
      (m) => m.ecosystem === ecosystem && m.package.toLowerCase() === wanted,
    );
  }

  // Maps are already parsed once into the cache (required for validation and
  // lookups anyway), so listing reuses it and only projects the metadata —
  // no re-reading or re-parsing of JSON files per call.
  async list(filter?: StoreListFilter): Promise<MapSummary[]> {
    const eco = filter?.ecosystem?.trim().toLowerCase();
    const pkg = filter?.package?.trim().toLowerCase();
    return this.load()
      .filter(
        (m) =>
          (!eco || m.ecosystem.toLowerCase() === eco) &&
          (!pkg || m.package.toLowerCase() === pkg),
      )
      .map(toSummary);
  }

  describe(): string {
    return `local JSON files (${this.dataDir})`;
  }
}
