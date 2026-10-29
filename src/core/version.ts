import { CacheError } from '../errors.ts';
import type { RevisionOptions } from '../types.ts';

export type StoredVersion = {
  commitVersion: number | null;
  minRevision: string | null;
};

export type VersionDecision =
  | { kind: 'advance' | 'idempotent'; guarantee: 'exact' }
  | { kind: 'unversioned'; guarantee: 'none' };

export function assertRevisionPair(
  revision: string | undefined,
  commitVersion: number | undefined,
  revisionLabel: string,
): void {
  const hasRevision = revision !== undefined;
  const hasVersion = commitVersion !== undefined;
  if (hasRevision !== hasVersion) {
    throw new CacheError('POLICY_REJECTED', `${revisionLabel} and commitVersion must be provided together`);
  }
  if (revision !== undefined) {
    if (revision.length === 0 || revision.length > 256 || /[\u0000\r\n]/.test(revision)) {
      throw new CacheError('POLICY_REJECTED', 'invalid revision string');
    }
  }
  if (commitVersion !== undefined && (!Number.isSafeInteger(commitVersion) || commitVersion < 0)) {
    throw new CacheError('POLICY_REJECTED', 'commitVersion must be a non-negative safe integer');
  }
}

export function decidePurge(stored: StoredVersion, options: RevisionOptions): VersionDecision {
  assertRevisionPair(options.minRevision, options.commitVersion, 'minRevision');
  if (options.commitVersion === undefined || options.minRevision === undefined) {
    return { kind: 'unversioned', guarantee: 'none' };
  }
  return decideExact(stored, options.commitVersion, options.minRevision);
}

export function decideWarm(stored: StoredVersion, options: RevisionOptions): VersionDecision {
  assertRevisionPair(options.expectedRevision, options.commitVersion, 'expectedRevision');
  if (options.commitVersion === undefined || options.expectedRevision === undefined) {
    if (stored.minRevision !== null || stored.commitVersion !== null) {
      throw new CacheError('REVISION_REQUIRED', 'version fence already has minRevision');
    }
    return { kind: 'unversioned', guarantee: 'none' };
  }
  return decideExact(stored, options.commitVersion, options.expectedRevision);
}

function decideExact(stored: StoredVersion, commitVersion: number, revision: string): VersionDecision {
  if (stored.commitVersion === null) {
    return { kind: 'advance', guarantee: 'exact' };
  }
  if (commitVersion < stored.commitVersion) {
    throw new CacheError('STALE_EVENT', 'commitVersion is older than fence');
  }
  if (commitVersion === stored.commitVersion) {
    if (stored.minRevision !== revision) {
      throw new CacheError('VERSION_CONFLICT', 'same commitVersion with different revision');
    }
    return { kind: 'idempotent', guarantee: 'exact' };
  }
  return { kind: 'advance', guarantee: 'exact' };
}

export function effectiveVersion(pathVersion: StoredVersion, variantVersion: StoredVersion | null): StoredVersion {
  if (
    variantVersion?.commitVersion != null &&
    (pathVersion.commitVersion === null || variantVersion.commitVersion > pathVersion.commitVersion)
  ) {
    return {
      commitVersion: variantVersion.commitVersion,
      minRevision: variantVersion.minRevision,
    };
  }
  return pathVersion;
}
