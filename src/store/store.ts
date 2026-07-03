/**
 * Store abstraction + version-matching logic shared by every backend.
 *
 * Stores are deliberately dumb: they return all maps for a package and let
 * `resolveMigration` do the matching, so Supabase and the local-file fallback
 * can never disagree on semantics.
 *
 * Matching is SemVer-aware: descriptors may be concrete versions ("14.2.35"),
 * partial versions ("14", "14.2"), or ranges ("^14.2.0", "~14.1.0", "14.x").
 */
import semver from 'semver';
import type { MigrationMap, MigrationStatus } from '../types/migration-map.js';

export interface MapSummary {
  ecosystem: string;
  package: string;
  from_version: string;
  to_version: string;
  status: MigrationStatus;
  last_verified: string;
}

export interface StoreListFilter {
  ecosystem?: string;
  package?: string;
}

export interface MigrationStore {
  /** All non-stale maps for a package (case-insensitive package match). */
  getMapsForPackage(ecosystem: string, pkg: string): Promise<MigrationMap[]>;
  /** Summaries of every non-stale map in the store, optionally filtered. */
  list(filter?: StoreListFilter): Promise<MapSummary[]>;
  /** Human-readable description of the backing store, for stderr logging. */
  describe(): string;
}

export function toSummary(map: MigrationMap): MapSummary {
  return {
    ecosystem: map.ecosystem,
    package: map.package,
    from_version: map.from_version,
    to_version: map.to_version,
    status: map.status,
    last_verified: map.last_verified,
  };
}

export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '');
}

export type MatchType = 'exact' | 'semver-range' | 'major-version';

/** Wire-format disclosure of how a lookup was resolved. */
export type ResolvedVia = 'exact_string' | 'semver_range' | 'major_version';

export function resolvedViaOf(match: MatchType): ResolvedVia {
  switch (match) {
    case 'exact':
      return 'exact_string';
    case 'semver-range':
      return 'semver_range';
    case 'major-version':
      return 'major_version';
  }
}

export interface DescriptorInfo {
  major: number;
  kind: 'version' | 'range';
}

/**
 * Interpret a user-supplied version descriptor.
 *
 * - Concrete/partial versions ("14.2.35", "2.0.0-beta.2", "14", "14.2") ->
 *   kind 'version'.
 * - SemVer ranges ("^14.2.0", "~14.1.0", "14.x", ">=14.2 <15") -> kind
 *   'range', anchored at the range's minimum satisfying version. A range
 *   spanning multiple majors resolves to its lowest major.
 */
export function interpretDescriptor(desc: string): DescriptorInfo | null {
  const norm = normalizeVersion(desc);

  const exact = semver.valid(norm, { loose: true });
  if (exact) return { major: semver.major(exact), kind: 'version' };

  // Partial versions count as versions, not ranges, even though semver
  // technically parses "14" as an X-range.
  if (/^\d+(\.\d+)?$/.test(norm)) {
    return { major: Number.parseInt(norm, 10), kind: 'version' };
  }

  if (semver.validRange(norm, { loose: true })) {
    const min = semver.minVersion(norm, { loose: true });
    if (min) return { major: min.major, kind: 'range' };
  }

  // Last resort for non-semver strings like "1.x-legacy": leading digits.
  const lead = norm.match(/^(\d+)/);
  return lead ? { major: Number(lead[1]), kind: 'version' } : null;
}

/** Major version of a descriptor ("2.0.0-beta.2" -> 2, "^14.2.0" -> 14). */
export function majorOf(v: string): number | null {
  return interpretDescriptor(v)?.major ?? null;
}

/**
 * Does a version descriptor satisfy a declared peer range?
 * - Concrete version -> definitive semver.satisfies check.
 * - Range descriptor -> semver.intersects (some overlap exists; the caller's
 *   phrasing must reflect that this is "possibly compatible", not a guarantee).
 * - Unparsable -> 'unknown'.
 */
export function satisfiesRange(versionDesc: string, range: string): boolean | 'unknown' {
  const norm = normalizeVersion(versionDesc);
  const v = semver.valid(norm, { loose: true });
  if (v) return semver.satisfies(v, range, { loose: true, includePrerelease: true });
  if (semver.validRange(norm, { loose: true })) {
    return semver.intersects(norm, range, { loose: true });
  }
  return 'unknown';
}

/**
 * Exact from/to string match first; otherwise interpret both descriptors via
 * SemVer and match maps whose from/to majors cover the requested window
 * (e.g. "^14.2.0" -> "^15.0.0" finds the map verified for 14.2.35 -> 15.0.0).
 * Callers must surface non-exact matches to the agent — the map's verified
 * endpoints may differ from what was asked.
 */
export function resolveMigration(
  maps: MigrationMap[],
  fromDesc: string,
  toDesc: string,
): { map: MigrationMap; match_type: MatchType } | null {
  const from = normalizeVersion(fromDesc);
  const to = normalizeVersion(toDesc);

  const exact = maps.find(
    (m) => normalizeVersion(m.from_version) === from && normalizeVersion(m.to_version) === to,
  );
  if (exact) return { map: exact, match_type: 'exact' };

  const fromInfo = interpretDescriptor(fromDesc);
  const toInfo = interpretDescriptor(toDesc);
  if (!fromInfo || !toInfo) return null;

  const candidate = maps.find(
    (m) => majorOf(m.from_version) === fromInfo.major && majorOf(m.to_version) === toInfo.major,
  );
  if (!candidate) return null;

  const match_type: MatchType =
    fromInfo.kind === 'range' || toInfo.kind === 'range' ? 'semver-range' : 'major-version';
  return { map: candidate, match_type };
}
