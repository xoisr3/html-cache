import { ConfigError } from '../errors.ts';
import {
  AUTH_COOKIE_DENYLIST,
  type CacheConfigInput,
  type QueryParamSpec,
  type ResolvedCacheConfig,
} from '../types.ts';

const PARAM_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const ENUM_VALUE = /^[a-z0-9_-]{1,32}$/;
const RELEASE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_QUERY_PARAMS = 3;

const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export function resolveConfig(input: CacheConfigInput): ResolvedCacheConfig {
  const basePath = normalizeBasePath(input.origin?.basePath ?? '');
  const include = requireStringArray(input.policy?.include, 'policy.include');
  const exclude = unique([
    ...builtinExcludes(basePath),
    ...requireStringArray(input.policy?.exclude ?? [], 'policy.exclude'),
  ]);
  validatePatterns([...include, ...exclude]);

  const harmless = input.policy?.cookies?.harmless ?? [];
  if (!Array.isArray(harmless) || harmless.length !== 0) {
    throw new ConfigError('policy.cookies.harmless must be an empty array in v0.1');
  }
  if (input.policy?.cookies?.mode && input.policy.cookies.mode !== 'allowlist') {
    throw new ConfigError('policy.cookies.mode only supports allowlist');
  }
  for (const name of harmless) {
    if ((AUTH_COOKIE_DENYLIST as readonly string[]).includes(name)) {
      throw new ConfigError(`cookie ${name} is in the permanent authentication denylist`);
    }
  }

  const onMiss = input.onMiss?.mode ?? 'passthrough';
  if (onMiss !== 'passthrough') {
    throw new ConfigError('onMiss.mode only supports passthrough');
  }

  const trailingSlash = input.policy?.trailingSlash ?? 'never';
  if (trailingSlash !== 'never') {
    throw new ConfigError('policy.trailingSlash only supports never');
  }

  const compression = input.document?.compression ?? 'nginx';
  if (compression !== 'nginx' && compression !== 'off') {
    throw new ConfigError('document.compression only supports nginx or off');
  }

  const ttlEnforcement = input.ttl?.enforcement ?? 'cron-soft';
  if (ttlEnforcement !== 'cron-soft') {
    throw new ConfigError('ttl.enforcement only supports cron-soft');
  }

  const allow = input.policy?.query?.allow ?? {};
  validateQueryAllow(allow);

  assertAbsoluteUrl(input.origin?.internalUrl, 'origin.internalUrl');
  assertAbsoluteUrl(input.origin?.publicUrl, 'origin.publicUrl');
  const staticRoot = staticDirectory(input.origin?.staticRoot, 'origin.staticRoot');
  const previousStaticRoot = staticDirectory(input.origin?.previousStaticRoot, 'origin.previousStaticRoot');
  if (previousStaticRoot && !staticRoot) {
    throw new ConfigError('origin.previousStaticRoot requires origin.staticRoot');
  }
  if (!input.storage?.directory) {
    throw new ConfigError('storage.directory is required');
  }
  if (!RELEASE_ID.test(input.storage?.releaseId ?? '')) {
    throw new ConfigError('storage.releaseId must contain only letters, numbers, dots, underscores, or hyphens');
  }

  return {
    origin: {
      internalUrl: input.origin.internalUrl,
      publicUrl: input.origin.publicUrl,
      basePath,
      staticRoot,
      previousStaticRoot,
    },
    storage: {
      directory: input.storage.directory,
      releaseId: input.storage.releaseId,
    },
    policy: {
      include,
      exclude,
      trailingSlash,
      query: { allow },
      cookies: { mode: 'allowlist', harmless: [] },
    },
    onMiss: { mode: 'passthrough' },
    warm: {
      concurrency: input.warm?.concurrency ?? 2,
      timeoutMs: input.warm?.timeoutMs ?? 10_000,
      maxHtmlBytes: input.warm?.maxHtmlBytes ?? 2 * 1024 * 1024,
    },
    ttl: {
      seconds: input.ttl?.seconds ?? 3600,
      enforcement: 'cron-soft',
    },
    document: {
      cacheControl: input.document?.cacheControl ?? 'private, no-store',
      compression,
      securityHeaders: input.document?.securityHeaders ?? { ...DEFAULT_SECURITY_HEADERS },
    },
    debug: input.debug ?? false,
    cron: { enabled: input.cron?.enabled ?? false },
  };
}

export function builtinExcludes(basePath: string): string[] {
  const prefix = basePath === '' ? '' : basePath;
  return ['/.well-known/**', `${prefix}/_next/**`, `${prefix}/api/**`];
}

function normalizeBasePath(value: string): string {
  if (value === '') return '';
  if (!value.startsWith('/') || value.endsWith('/') || value.includes('//') || value.split('/').includes('..')) {
    throw new ConfigError('origin.basePath must be empty or an absolute path without trailing slash');
  }
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ConfigError(`${label} must be an array of strings`);
  }
  return value;
}

function validatePatterns(patterns: string[]): void {
  for (const pattern of patterns) {
    if (!pattern.startsWith('/')) {
      throw new ConfigError(`pattern ${pattern} must start with /`);
    }
    const segments = pattern.split('/').filter((segment) => segment.length > 0);
    const star = segments.indexOf('**');
    if (star !== -1 && star !== segments.length - 1) {
      throw new ConfigError(`pattern ${pattern} may only place ** at the end`);
    }
    for (const segment of segments) {
      if (segment !== '**' && segment !== '*' && (segment.includes('*') || segment.includes('?'))) {
        throw new ConfigError(`pattern ${pattern} cannot be represented accurately in Nginx`);
      }
    }
  }
}

function validateQueryAllow(allow: Record<string, QueryParamSpec>): void {
  const names = Object.keys(allow);
  if (names.length > MAX_QUERY_PARAMS) {
    throw new ConfigError('query.allow supports a maximum of 3 parameters');
  }
  for (const name of names) {
    if (!PARAM_NAME.test(name) || name.startsWith('_') || name === '_rsc') {
      throw new ConfigError(`query parameter name ${name} is not allowed`);
    }
    const spec = allow[name];
    if (!spec || (spec.type !== 'digits' && spec.type !== 'enum')) {
      throw new ConfigError(`query parameter ${name} only supports type digits or enum`);
    }
    if (spec.type === 'enum') {
      if (!Array.isArray(spec.values) || spec.values.length === 0) {
        throw new ConfigError(`query parameter ${name} requires enum values list`);
      }
      if (new Set(spec.values).size !== spec.values.length) {
        throw new ConfigError(`query parameter ${name} has duplicate enum values`);
      }
      for (const value of spec.values) {
        if (!ENUM_VALUE.test(value)) {
          throw new ConfigError(`enum value ${value} is not safe for filesystem path`);
        }
      }
    }
  }
}

function staticDirectory(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ConfigError(`${label} must be a path string`);
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
  if (!absolute || /["'\r\n$;]/.test(normalized) || normalized.split('/').includes('..')) {
    throw new ConfigError(`${label} must be an absolute path safe for nginx`);
  }
  return normalized;
}

function assertAbsoluteUrl(value: string | undefined, label: string): void {
  if (!value) throw new ConfigError(`${label} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${label} must be an absolute URL`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${label} must not contain user credentials`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${label} only supports http or https`);
  }
}
