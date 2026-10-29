export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const CACHE_ERROR_CODES = [
  'POLICY_REJECTED',
  'ORIGIN_TIMEOUT',
  'INVALID_RESPONSE',
  'REVISION_REQUIRED',
  'REVISION_MISMATCH',
  'STALE_EVENT',
  'VERSION_CONFLICT',
  'RELEASE_MISMATCH',
  'SUPERSEDED',
  'FILESYSTEM',
  'COOLDOWN',
] as const;

export type CacheErrorCode = (typeof CACHE_ERROR_CODES)[number];

export class CacheError extends Error {
  readonly code: CacheErrorCode;

  constructor(code: CacheErrorCode, message: string) {
    super(message);
    this.name = 'CacheError';
    this.code = code;
  }
}

export function toCacheError(error: unknown): CacheError {
  if (error instanceof CacheError) return error;
  const message = error instanceof Error ? error.message : 'filesystem error';
  return new CacheError('FILESYSTEM', message);
}
