import http from 'node:http';
import https from 'node:https';
import { CacheError } from '../errors.ts';
import type { ResolvedCacheConfig } from '../types.ts';

export type OriginResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

export function fetchDocument(
  config: ResolvedCacheConfig,
  rawPath: string,
  rawQuery: string,
): Promise<OriginResponse> {
  const internal = new URL(config.origin.internalUrl);
  const pub = new URL(config.origin.publicUrl);
  const target = new URL(rawPath, internal);
  if (rawQuery) target.search = rawQuery;
  const client = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(error);
    };
    const succeed = (value: OriginResponse): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = client.request(
      target,
      {
        method: 'GET',
        headers: {
          Host: pub.host,
          Accept: 'text/html',
          'Accept-Encoding': 'identity',
          'X-Forwarded-Host': pub.host,
          'X-Forwarded-Proto': pub.protocol.replace(':', ''),
          'User-Agent': 'HidenHTMLCache/1.0',
          Connection: 'close',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > config.warm.maxHtmlBytes) {
            fail(new CacheError('INVALID_RESPONSE', 'HTML exceeded maximum allowed size'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          succeed({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', (error) => fail(new CacheError('INVALID_RESPONSE', error.message)));
      },
    );
    req.setTimeout(config.warm.timeoutMs, () => {
      fail(new CacheError('ORIGIN_TIMEOUT', 'origin request timed out'));
    });
    req.on('error', (error) => {
      if (settled) return;
      fail(new CacheError('INVALID_RESPONSE', error.message));
    });
    req.end();
  });
}
