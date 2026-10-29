import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CacheError, createCache, summarizeAccessLog } from '../src/index.ts';

describe('cutover', () => {
  it('writes one config for an empty generation and does not retarget the serving release', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hiden-'));
    const server = http.createServer((req, res) => {
      const release = req.url === '/tin-tuc/a' ? 'build-a' : 'build-b';
      const body = Buffer.from(
        `<!doctype html><html data-dpl-id="${release}"><head><meta name="hiden-cache-revision" content="listing:v1"></head><body>ok</body></html>`,
      );
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.byteLength) });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const shared = {
      origin: { internalUrl: `http://127.0.0.1:${port}`, publicUrl: 'https://news.example.com' },
      policy: { include: ['/', '/tin-tuc/**'] },
    };
    const serving = createCache({ ...shared, storage: { directory, releaseId: 'build-a' } });
    const next = createCache({
      ...shared,
      origin: shared.origin,
      storage: { directory, releaseId: 'build-b' },
      policy: shared.policy,
    });
    const configPath = path.join(directory, 'nginx.conf');
    try {
      await serving.init();
      await next.init();
      const before = await readFile(path.join(directory, 'control', 'generation-build-a'), 'utf8');
      const cut = await next.writeCutoverConfig(configPath);
      assert.equal(cut.generation, 'gen-1');
      assert.equal(await readFile(path.join(directory, 'control', 'generation-build-a'), 'utf8'), before);
      const written = await readFile(configPath, 'utf8');
      assert.match(written, /\/build-b";/);
      assert.match(written, new RegExp(`proxy_pass http://127\\.0\\.0\\.1:${port};`));
      assert.doesNotMatch(written, /\nmap /);
      assert.equal(await readFile(path.join(directory, 'control', 'serving-release'), 'utf8'), 'build-a');
      await assert.rejects(
        () => next.purgeAll(),
        (error: unknown) => error instanceof CacheError && error.code === 'POLICY_REJECTED',
      );
      await next.activateServing(configPath);
      assert.equal(await readFile(path.join(directory, 'control', 'serving-release'), 'utf8'), 'build-b');
      await serving.warm('/tin-tuc/a', { expectedRevision: 'listing:v1', commitVersion: 1 });
      await next.warm('/tin-tuc/b', { expectedRevision: 'listing:v1', commitVersion: 1 });
      assert.equal(await exists(path.join(directory, 'build-a', 'tin-tuc', 'a', 'index.html')), true);
      assert.equal(await exists(path.join(directory, 'build-b', 'tin-tuc', 'a', 'index.html')), false);
      assert.equal(await exists(path.join(directory, 'build-b', 'tin-tuc', 'b', 'index.html')), true);
      const second = path.join(directory, 'second.conf');
      const again = await next.writeCutoverConfig(second);
      assert.equal(again.releaseId, 'build-b');
      assert.match(await readFile(second, 'utf8'), /\/build-b";/);
    } finally {
      server.closeAllConnections();
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses cutover when a staged file is older than a purge', async () => {
    await withOrigin('build-b', async ({ directory, port, setRevision }) => {
      const { serving, staged } = await pair(directory, port);
      await serving.init();
      await staged.init();
      await staged.warm('/tin-tuc/a', { expectedRevision: 'listing:v1', commitVersion: 1 });
      const entry = path.join(directory, 'build-b', 'tin-tuc', 'a');
      const html = await readFile(path.join(entry, 'index.html'));
      const meta = await readFile(path.join(entry, 'meta.json'));
      setRevision('listing:v2');
      await serving.purge('/tin-tuc/a', { minRevision: 'listing:v2', commitVersion: 2 });
      assert.equal(await exists(path.join(entry, 'index.html')), false);
      await staged.warm('/tin-tuc/a', { expectedRevision: 'listing:v2', commitVersion: 2 });
      assert.equal((await staged.writeCutoverConfig(path.join(directory, 'clean.conf'))).releaseId, 'build-b');
      await writeFile(path.join(entry, 'index.html'), html);
      await writeFile(path.join(entry, 'meta.json'), meta);
      const dirty = path.join(directory, 'dirty.conf');
      await assert.rejects(
        () => staged.writeCutoverConfig(dirty),
        (error: unknown) => error instanceof CacheError && error.code === 'POLICY_REJECTED' && /staged file is dirty/.test(error.message),
      );
      assert.equal(await exists(dirty), false);
    });
  });

  it('refuses cutover when purgeAll is newer than the staged generation', async () => {
    await withOrigin('build-b', async ({ directory, port }) => {
      const { serving, staged } = await pair(directory, port);
      await serving.init();
      await staged.init();
      await staged.warm('/tin-tuc/a', { expectedRevision: 'listing:v1', commitVersion: 1 });
      await serving.purgeAll();
      const blocked = path.join(directory, 'blocked.conf');
      await assert.rejects(
        () => staged.writeCutoverConfig(blocked),
        (error: unknown) =>
          error instanceof CacheError && error.code === 'POLICY_REJECTED' && error.message === 'staged generation is dirty after purgeAll',
      );
      assert.equal(await exists(blocked), false);
      assert.equal(await exists(path.join(directory, 'build-b', 'tin-tuc', 'a', 'index.html')), true);
      await rm(path.join(directory, 'build-b', 'tin-tuc'), { recursive: true, force: true });
      await staged.writeCutoverConfig(path.join(directory, 'empty.conf'));
    });
  });

  it('discards a staged generation dirtied by purgeAll and warms the next one', async () => {
    await withOrigin('build-b', async ({ directory, port }) => {
      const { serving, staged } = await pair(directory, port);
      await serving.init();
      await staged.init();
      await staged.warm('/tin-tuc/a', { expectedRevision: 'listing:v1', commitVersion: 1 });
      await serving.purgeAll();
      const discarded = await staged.discardGeneration();
      assert.equal(discarded.generation, 'gen-2');
      assert.equal(await exists(path.join(directory, 'build-b', 'tin-tuc', 'a', 'index.html')), false);
      assert.equal(await exists(path.join(directory, '.build-b.gen-1', 'tin-tuc', 'a', 'index.html')), true);
      await assert.rejects(
        () => serving.discardGeneration(),
        (error: unknown) => error instanceof CacheError && error.code === 'POLICY_REJECTED',
      );
      await staged.warm('/tin-tuc/a', { expectedRevision: 'listing:v1', commitVersion: 1 });
      assert.equal((await staged.writeCutoverConfig(path.join(directory, 'fresh.conf'))).generation, 'gen-2');
    });
  });

  it('refuses a homepage variant left behind by a path purge', async () => {
    await withOrigin('build-b', async ({ directory, port }) => {
      const { serving, staged } = await pair(directory, port);
      await serving.init();
      await staged.init();
      await staged.warm('/?page=1', { expectedRevision: 'listing:v1', commitVersion: 1 });
      const variant = path.join(directory, 'build-b', '@page-1');
      const html = await readFile(path.join(variant, 'index.html'));
      const meta = await readFile(path.join(variant, 'meta.json'));
      await serving.purge('/');
      assert.equal(await exists(path.join(variant, 'index.html')), false);
      await mkdir(variant, { recursive: true });
      await writeFile(path.join(variant, 'index.html'), html);
      await writeFile(path.join(variant, 'meta.json'), meta);
      await assert.rejects(
        () => staged.writeCutoverConfig(path.join(directory, 'variant.conf')),
        (error: unknown) => error instanceof CacheError && error.code === 'POLICY_REJECTED' && /staged file is dirty: \//.test(error.message),
      );
    });
  });

  it('refuses a staged file from another release and an open purge intent', async () => {
    await withOrigin('build-b', async ({ directory, port }) => {
      const { serving, staged } = await pair(directory, port);
      await serving.init();
      await staged.init();
      await staged.warm('/tin-tuc/a', { expectedRevision: 'listing:v1', commitVersion: 1 });
      const metaPath = path.join(directory, 'build-b', 'tin-tuc', 'a', 'meta.json');
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { releaseId: string };
      meta.releaseId = 'build-a';
      await writeFile(metaPath, JSON.stringify(meta));
      await assert.rejects(
        () => staged.writeCutoverConfig(path.join(directory, 'release.conf')),
        (error: unknown) => error instanceof CacheError && error.code === 'POLICY_REJECTED' && /meta.releaseId/.test(error.message),
      );
      await rm(path.join(directory, 'build-b', 'tin-tuc'), { recursive: true, force: true });
      await mkdir(path.join(directory, 'control', 'purge-intents'), { recursive: true });
      await writeFile(
        path.join(directory, 'control', 'purge-intents', 'open.json'),
        JSON.stringify({ id: 'open', status: 'open', scope: 'path', fence: 1, pathFence: 1, minRevision: null, commitVersion: null }),
      );
      await assert.rejects(
        () => staged.writeCutoverConfig(path.join(directory, 'intent.conf')),
        (error: unknown) => error instanceof CacheError && error.code === 'POLICY_REJECTED' && error.message === 'open purge intent still pending',
      );
    });
  });

  it('counts cookie and query bypasses without reading cookie values', () => {
    const summary = summarizeAccessLog(`
127.0.0.1 "GET /tin-tuc/a HTTP/1.1" 200 HIT cookie=0 query_ok=1
127.0.0.1 "GET /tin-tuc/a HTTP/1.1" 200 MISS cookie=0 query_ok=1
127.0.0.1 "GET /tin-tuc/a HTTP/1.1" 200 BYPASS cookie=1 query_ok=1
127.0.0.1 "GET /tin-tuc/a?limit=100 HTTP/1.1" 200 BYPASS cookie=0 query_ok=0
not a log line
`);
    assert.deepEqual(summary, {
      total: 4,
      hit: 1,
      miss: 1,
      bypass: 2,
      bypassCookie: 1,
      bypassQuery: 1,
    });
  });
});

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

function page(release: string, revision: string): string {
  return `<!doctype html><html data-dpl-id="${release}"><head><meta name="hiden-cache-revision" content="${revision}"></head><body>ok</body></html>`;
}

function pair(directory: string, port: number) {
  const shared = {
    origin: { internalUrl: `http://127.0.0.1:${port}`, publicUrl: 'https://news.example.com' },
    policy: {
      include: ['/', '/tin-tuc/**'],
      query: { allow: { page: { type: 'digits' as const } } },
    },
  };
  return {
    serving: createCache({ ...shared, storage: { directory, releaseId: 'build-a' } }),
    staged: createCache({ ...shared, storage: { directory, releaseId: 'build-b' } }),
  };
}

async function withOrigin(
  release: string,
  run: (ctx: { directory: string; port: number; setRevision: (revision: string) => void }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hiden-'));
  let revision = 'listing:v1';
  const server = http.createServer((_req, res) => {
    const body = Buffer.from(page(release, revision));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.byteLength) });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await run({
      directory,
      port,
      setRevision(next: string) {
        revision = next;
      },
    });
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}
