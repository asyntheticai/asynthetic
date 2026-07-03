-- Asynthetic — Postgres schema (Supabase)
-- One migration map = one row in `migrations` + N rows in `breaking_changes` + N rows in `deprecations`.
-- Retrieval is structured lookup by (ecosystem, package, from_version, to_version). No vector search.

create type change_category as enum (
  'signature-change',
  'removal',
  'deprecation',
  'behavior-change',
  'config-change',
  'import-change',
  'rename'
);

-- Maintainability (§14 of the brief): every map carries a lifecycle status so stale
-- maps can be flagged without deleting them. Only 'verified' maps are served by default.
create type migration_status as enum ('draft', 'verified', 'stale');

create table migrations (
  id            uuid primary key default gen_random_uuid(),
  ecosystem     text not null default 'npm',
  package       text not null,
  from_version  text not null,  -- concrete semver the map was verified from (e.g. '1.29.0')
  to_version    text not null,  -- concrete semver the map was verified to   (e.g. '2.0.0-beta.2')
  summary       text not null,
  -- Peer requirements of to_version (CompatibilityEntry[] as JSON); see
  -- src/types/migration-map.ts. Empty array when none are curated.
  compatible_with jsonb not null default '[]'::jsonb,
  source_urls   text[] not null check (cardinality(source_urls) > 0),
  last_verified date not null,
  status        migration_status not null default 'draft',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (ecosystem, package, from_version, to_version)
);

create index migrations_lookup_idx on migrations (ecosystem, package);

create table breaking_changes (
  id               uuid primary key default gen_random_uuid(),
  migration_id     uuid not null references migrations(id) on delete cascade,
  position         int not null,  -- curated order: most-impactful / first-hit changes first
  title            text not null,
  description      text not null,
  category         change_category not null,
  affected_symbols text[] not null default '{}',
  before_code      text,          -- null when the change has no meaningful code diff (e.g. runtime requirement)
  after_code       text,
  migration_note   text not null, -- plain-language "how to fix"
  source_url       text,          -- per-change citation; falls back to migrations.source_urls when null
  unique (migration_id, position)
);

create index breaking_changes_migration_idx on breaking_changes (migration_id);

create table deprecations (
  id               uuid primary key default gen_random_uuid(),
  migration_id     uuid not null references migrations(id) on delete cascade,
  symbol           text not null,
  replacement      text,          -- null when there is no direct replacement
  removal_timeline text,          -- free text; null when unknown
  note             text
);

create index deprecations_migration_idx on deprecations (migration_id);
