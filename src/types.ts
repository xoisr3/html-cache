export const AUTH_COOKIE_DENYLIST = [
  'payload-token',
  '__prerender_bypass',
  '__next_preview_data',
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
] as const;

export type QueryParamSpec =
  | { type: 'digits' }
  | { type: 'enum'; values: string[] };

export type CacheConfigInput = {
  origin: {
    internalUrl: string;
    publicUrl: string;
    basePath?: string;
    staticRoot?: string;
    previousStaticRoot?: string;
  };
  storage: {
    directory: string;
    releaseId: string;
  };
  policy: {
    include: string[];
    exclude?: string[];
    trailingSlash?: 'never';
    query?: {
      allow?: Record<string, QueryParamSpec>;
    };
    cookies?: {
      mode?: 'allowlist';
      harmless?: string[];
    };
  };
  onMiss?: { mode?: 'passthrough' };
  warm?: {
    concurrency?: number;
    timeoutMs?: number;
    maxHtmlBytes?: number;
  };
  ttl?: {
    seconds?: number;
    enforcement?: 'cron-soft';
  };
  document?: {
    cacheControl?: string;
    compression?: 'nginx' | 'off';
    securityHeaders?: Record<string, string>;
  };
  debug?: boolean;
  cron?: { enabled?: boolean };
};

export type ResolvedCacheConfig = {
  origin: {
    internalUrl: string;
    publicUrl: string;
    basePath: string;
    staticRoot: string | null;
    previousStaticRoot: string | null;
  };
  storage: {
    directory: string;
    releaseId: string;
  };
  policy: {
    include: string[];
    exclude: string[];
    trailingSlash: 'never';
    query: {
      allow: Record<string, QueryParamSpec>;
    };
    cookies: {
      mode: 'allowlist';
      harmless: [];
    };
  };
  onMiss: { mode: 'passthrough' };
  warm: {
    concurrency: number;
    timeoutMs: number;
    maxHtmlBytes: number;
  };
  ttl: {
    seconds: number;
    enforcement: 'cron-soft';
  };
  document: {
    cacheControl: string;
    compression: 'nginx' | 'off';
    securityHeaders: Record<string, string>;
  };
  debug: boolean;
  cron: { enabled: boolean };
};

export type RequestView = {
  method: string;
  rawPath: string;
  rawQuery?: string;
  headers?: Record<string, string | undefined>;
};

export type EligibleDecision = {
  action: 'eligible';
  file: string;
};

export type RedirectDecision = {
  action: 'redirect';
  location: string;
};

export type BypassDecision = {
  action: 'bypass';
  reason: string;
};

export type PolicyDecision = EligibleDecision | RedirectDecision | BypassDecision;

export type QueryRule = {
  source: string;
  nginxMatch: string;
  directory: string;
};

export type CompiledPolicy = {
  config: ResolvedCacheConfig;
  queryRules: QueryRule[];
  builtinExcludes: string[];
};

export type RevisionOptions = {
  minRevision?: string;
  expectedRevision?: string;
  commitVersion?: number;
};

export type WarmResult = {
  ok: true;
  file: string;
  revision: string;
  commitVersion: number | null;
  revisionGuarantee: 'exact' | 'none';
};

export type PurgeResult = {
  ok: true;
  removed: boolean;
  fence: number;
  minRevision: string | null;
  revisionGuarantee: 'exact' | 'none';
};

export type BatchResult<T> = {
  ok: boolean;
  results: Array<
    | { url: string; ok: true; value: T }
    | { url: string; ok: false; code: string; message: string }
  >;
};

export type StatusState = 'hit' | 'miss' | 'expired' | 'excluded' | 'error';

export type StatusResult = {
  state: StatusState;
  file?: string;
  revision?: string | null;
  commitVersion?: number | null;
  expiresAt?: number;
  reason?: string;
};

export type MaintenanceBudget = {
  maxItems: number;
  maxDurationMs: number;
};

export type MaintenanceResult = {
  ok: true;
  removed: number;
  examined: number;
  done: boolean;
  skipped: boolean;
};

export type PublishInput = {
  url: string;
  minRevision: string;
  commitVersion: number;
  revalidate?: () => Promise<void>;
};
