import { CacheError } from '../errors.ts';

const VARY_ALLOW = new Set([
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
  'next-url',
  'accept-encoding',
]);

// Next.js may send HTTP 200 before streaming notFound(), redirect(), or Suspense error.
const STREAM_REJECTIONS = [
  'NEXT_HTTP_ERROR_FALLBACK;',
  'NEXT_REDIRECT;',
  'Switched to client rendering because the server rendering errored',
  '__next_error__',
];

export type ValidatedDocument = {
  revision: string;
  releaseId: string;
};

export function validateDocument(input: {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  releaseId: string;
  expectedRevision: string | null;
  maxBytes: number;
}): ValidatedDocument {
  if (input.status !== 200) {
    throw new CacheError('INVALID_RESPONSE', `origin returned HTTP ${input.status}`);
  }
  const headers = lowerHeaderMap(input.headers);
  if (headers['set-cookie'] || headers['www-authenticate'] || headers.location) {
    throw new CacheError('INVALID_RESPONSE', 'response contains non-cacheable headers');
  }
  const contentType = headers['content-type'] ?? '';
  if (!isHtml(contentType)) {
    throw new CacheError('INVALID_RESPONSE', 'content-type is not text/html');
  }
  rejectCacheControl(headers['cache-control']);
  rejectVary(headers.vary);
  rejectNonce(headers['content-security-policy']);
  if (input.body.byteLength === 0 || input.body.byteLength > input.maxBytes) {
    throw new CacheError('INVALID_RESPONSE', 'invalid HTML body size');
  }
  const declared = headers['content-length'];
  if (declared !== undefined && Number(declared) !== input.body.byteLength) {
    throw new CacheError('INVALID_RESPONSE', 'content-length does not match body size');
  }

  const html = input.body.toString('utf8');
  if (STREAM_REJECTIONS.some((marker) => html.includes(marker))) {
    throw new CacheError('INVALID_RESPONSE', 'body contains post-stream notFound, redirect, or error marker');
  }
  if (/nonce\s*=|['"]nonce-/i.test(html)) {
    throw new CacheError('INVALID_RESPONSE', 'HTML contains CSP nonce');
  }

  const releaseId = readRelease(html);
  if (releaseId !== input.releaseId) {
    throw new CacheError('RELEASE_MISMATCH', 'release marker does not match storage.releaseId');
  }
  const revision = readMeta(html, 'hiden-cache-revision');
  if (!revision) {
    throw new CacheError('INVALID_RESPONSE', 'missing revision marker');
  }
  if (input.expectedRevision !== null && revision !== input.expectedRevision) {
    throw new CacheError('REVISION_MISMATCH', 'revision marker does not match expectedRevision');
  }
  return { revision, releaseId };
}

function isHtml(contentType: string): boolean {
  const [type, ...params] = contentType.split(';').map((part) => part.trim().toLowerCase());
  if (type !== 'text/html') return false;
  return params.every((part) => part === '' || part === 'charset=utf-8');
}

function rejectCacheControl(value: string | undefined): void {
  if (!value) return;
  const tokens = value.split(',').map((token) => token.trim().toLowerCase());
  if (tokens.some((token) => token === 'private' || token === 'no-store' || token === 'no-cache' || token.startsWith('private;'))) {
    throw new CacheError('INVALID_RESPONSE', 'cache-control forbids caching HTML');
  }
}

function rejectVary(value: string | undefined): void {
  if (!value) return;
  const tokens = value.split(',').map((token) => token.trim().toLowerCase()).filter((token) => token.length > 0);
  if (tokens.some((token) => !VARY_ALLOW.has(token))) {
    throw new CacheError('INVALID_RESPONSE', 'vary header is outside allowlist');
  }
}

function rejectNonce(value: string | undefined): void {
  if (value && /nonce/i.test(value)) {
    throw new CacheError('INVALID_RESPONSE', 'CSP contains nonce');
  }
}

function readRelease(html: string): string | null {
  const attr = html.match(/<html\b[^>]*\sdata-dpl-id\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
  const meta = readMeta(html, 'hiden-cache-release');
  if (attr && meta && attr !== meta) return null;
  return attr ?? meta;
}

function readMeta(html: string, name: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const tagName = readAttr(tag, 'name');
    if (tagName?.toLowerCase() === name) return readAttr(tag, 'content');
  }
  return null;
}

function readAttr(tag: string, attr: string): string | null {
  const match = new RegExp(`\\s${attr}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return match?.[1] ?? null;
}

function lowerHeaderMap(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const lowered: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    lowered[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return lowered;
}
