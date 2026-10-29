import { routeAllowed } from './match.ts';
import { queryDirectory } from './query.ts';
import type { BypassDecision, CompiledPolicy, PolicyDecision, RequestView } from '../types.ts';

const MAX_SEGMENT_BYTES = 255;
const ROUTER_HEADERS = [
  'rsc',
  'next-action',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
  'next-url',
  'x-nextjs-data',
];

export function evaluate(policy: CompiledPolicy, request: RequestView): PolicyDecision {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return bypass('method');
  }

  const headers = lowerHeaders(request.headers ?? {});
  if (headers.cookie) return bypass('cookie');
  if (headers.authorization) return bypass('authorization');
  for (const name of ROUTER_HEADERS) {
    if (headers[name]) return bypass('router');
  }
  if ((headers.accept ?? '').includes('text/x-component')) return bypass('router');
  if (headers['sec-fetch-dest'] && headers['sec-fetch-dest'] !== 'document') {
    return bypass('fetch-dest');
  }

  const rawQuery = request.rawQuery ?? '';
  const pathResult = inspectPath(request.rawPath);
  if (pathResult.action === 'bypass') return pathResult;
  if (pathResult.action === 'redirect') {
    const query = rawQuery === '' ? '' : `?${rawQuery}`;
    return { action: 'redirect', location: `${pathResult.path}${query}` };
  }

  if (rawQuery.includes('_rsc=')) return bypass('router');
  const queryDir = queryDirectory(rawQuery, policy.config.policy.query.allow, policy.queryRules);
  if (queryDir === null) return bypass('query');

  const path = pathResult.path;
  if (!routeAllowed(path, policy.config.policy.include, policy.config.policy.exclude)) {
    return bypass('route');
  }

  const segments = path.split('/').filter((segment) => segment.length > 0);
  const file = cacheFile(segments, queryDir);
  return { action: 'eligible', file };
}

function cacheFile(segments: string[], queryDir: string): string {
  if (queryDir === '') {
    return segments.length === 0 ? 'index.html' : `${segments.join('/')}/index.html`;
  }
  const folder = `@${queryDir}`;
  return segments.length === 0 ? `${folder}/index.html` : `${segments.join('/')}/${folder}/index.html`;
}

function inspectPath(rawPath: string): { action: 'ok'; path: string } | { action: 'redirect'; path: string } | BypassDecision {
  if (!rawPath.startsWith('/') || rawPath.includes('\\') || rawPath.includes('\0')) {
    return bypass('path');
  }
  if (rawPath.includes('%') || rawPath.includes('//')) return bypass('path');
  let path = rawPath;
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
    return { action: 'redirect', path };
  }
  const segments = path === '/' ? [] : path.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return bypass('path');
    if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) return bypass('path');
    if (!/^[A-Za-z0-9._~-]+$/.test(segment)) return bypass('path');
  }
  return { action: 'ok', path };
}

function lowerHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const lowered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value) lowered[name.toLowerCase()] = value;
  }
  return lowered;
}

function bypass(reason: string): BypassDecision {
  return { action: 'bypass', reason };
}
