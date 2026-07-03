/**
 * Store selection: Supabase when env vars are present, local JSON files
 * otherwise. Never throws on missing configuration — the local fallback
 * guarantees the server starts in development.
 */
import { LocalFileStore } from './local-store.js';
import type { MigrationStore } from './store.js';
import { SupabaseStore } from './supabase-store.js';

export function createStore(): MigrationStore {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY;
  if (url && key) return new SupabaseStore(url, key);

  if (url || key) {
    console.error(
      '[asynthetic] Incomplete Supabase config (need both SUPABASE_URL and SUPABASE_ANON_KEY); falling back to local files.',
    );
  }
  return new LocalFileStore();
}
