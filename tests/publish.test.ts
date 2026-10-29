import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createCache } from '../src/index.ts';
import { publishFromRoute } from '../examples/nextjs/publish.ts';

describe('publish after commit', () => {
  it('revalidates only after purge and before warm', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hiden-'));
    const server = http.createServer((_req, res) => {
      const body = Buffer.from(
        '<!doctype html><html data-dpl-id="build-b"><head><meta name="hiden-cache-revision" content="listing:v3"></head><body>home</body></html>',
      );
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.byteLength),
      });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const cache = createCache({
      origin: { internalUrl: `http://127.0.0.1:${port}`, publicUrl: 'https://news.example.com' },
      storage: { directory, releaseId: 'build-b' },
      policy: { include: ['/', '/tin-tuc/**'] },
    });
    await cache.init();
    try {
      await cache.warm('/', { expectedRevision: 'listing:v3', commitVersion: 3 });
      let seen = '';
      await publishFromRoute(cache, {
        url: '/',
        minRevision: 'listing:v3',
        commitVersion: 3,
        revalidate: async () => {
          seen = (await cache.status('/')).state;
        },
      });
      assert.equal(seen, 'miss');
      assert.equal((await cache.status('/')).state, 'hit');
      assert.equal((await cache.status('/')).revision, 'listing:v3');
    } finally {
      server.closeAllConnections();
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
