export function splitWarmTarget(urlPath: string): { rawPath: string; rawQuery: string } | null {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/') || urlPath.includes('://')) return null;
  if (/[\u0000\r\n\\]/.test(urlPath) || urlPath.includes('#')) return null;
  const queryAt = urlPath.indexOf('?');
  const rawPath = queryAt === -1 ? urlPath : urlPath.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? '' : urlPath.slice(queryAt + 1);
  if (rawPath.length > 1 && rawPath.endsWith('/')) return null;
  if (rawQuery.includes('#')) return null;
  return { rawPath, rawQuery };
}
