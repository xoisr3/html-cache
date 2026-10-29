import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { CacheError, createCache } from '../src/index.ts';

const RELEASE = 'build-b';
const REVISION = 'article-123:v42';

describe('maintenance', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it('does not delete a newer token and resumes the journal cursor', async () => {
    let body = page(REVISION);
    const ctx = await boot((_req, res) => send(res, body), { ttl: { seconds: 0 } });
    cleanups.push(ctx.close);
    await ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 1 });
    body = page('article-123:v43');
    await ctx.cache.warm('/tin-tuc/a', { expectedRevision: 'article-123:v43', commitVersion: 2 });
    const first = await ctx.cache.clearExpired({ maxItems: 1, maxDurationMs: 2000 });
    assert.equal(first.removed, 0);
    assert.equal(await ctx.exists('tin-tuc/a/index.html'), true);
    const restarted = createCache(ctx.input);
    const second = await restarted.clearExpired({ maxItems: 10, maxDurationMs: 2000 });
    assert.equal(second.removed, 1);
    assert.equal(await ctx.exists('tin-tuc/a/index.html'), false);
  });

  it('stops when the time budget is gone and continues later', async () => {
    const ctx = await boot((_req, res) => send(res, page(REVISION)), { ttl: { seconds: 0 } });
    cleanups.push(ctx.close);
    await ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 1 });
    const stopped = await ctx.cache.clearExpired({ maxItems: 100, maxDurationMs: 0 });
    assert.equal(stopped.examined, 0);
    assert.equal(stopped.done, false);
    assert.equal(await ctx.exists('tin-tuc/a/index.html'), true);
    const continued = await ctx.cache.clearExpired({ maxItems: 100, maxDurationMs: 2000 });
    assert.equal(continued.removed, 1);
    assert.equal(await ctx.exists('tin-tuc/a/index.html'), false);
  });

  it('drops the dead generation journal and cleans trash without removing a live child', async () => {
    const ctx = await boot((_req, res) => send(res, page(REVISION)));
    cleanups.push(ctx.close);
    await ctx.cache.warm('/', { expectedRevision: REVISION, commitVersion: 1 });
    await ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 1 });
    const homeMeta = await ctx.file('meta.json');
    const meta = JSON.parse(await readFile(homeMeta, 'utf8')) as { expiresAt: number };
    meta.expiresAt = 1;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(homeMeta, JSON.stringify(meta));
    const orphans = await ctx.cache.cleanupOrphans({ maxItems: 20, maxDurationMs: 2000 });
    assert.ok(orphans.removed >= 1);
    assert.equal(await ctx.exists('index.html'), false);
    assert.equal(await ctx.exists('index.html.gz'), false);
    assert.equal(await ctx.exists('tin-tuc/a/index.html'), true);

    await ctx.cache.warm('/tin-tuc/b', { expectedRevision: REVISION, commitVersion: 3 });
    await ctx.cache.purge('/tin-tuc/b');
    const before = await readdir(path.join(ctx.directory, 'control', 'trash'));
    assert.ok(before.length > 0);
    await ctx.cache.cleanupOrphans({ maxItems: 1, maxDurationMs: 2000 });
    const mid = await readdir(path.join(ctx.directory, 'control', 'trash'));
    assert.ok(mid.length < before.length);
    await ctx.cache.cleanupOrphans({ maxItems: 100, maxDurationMs: 2000 });
    assert.equal((await readdir(path.join(ctx.directory, 'control', 'trash'))).length, 0);

    await ctx.cache.purgeAll();
    const expiry = path.join(ctx.directory, 'control', 'expiry', `${RELEASE}--gen-1`);
    await assert.rejects(() => readdir(expiry));
  });

  it('ignores a partial journal line and the cli only cleans', async () => {
    let calls = 0;
    const ctx = await boot((_req, res) => {
      calls += 1;
      send(res, page(REVISION));
    }, { ttl: { seconds: 0 } });
    cleanups.push(ctx.close);
    await ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 1 });
    const hourDir = path.join(ctx.directory, 'control', 'expiry', `${RELEASE}--gen-1`);
    const [hour] = await readdir(hourDir);
    await appendFile(path.join(hourDir, hour!), '{"token":"broken"');
    const code = await runGc(ctx.directory);
    assert.equal(code, 0);
    assert.equal(calls, 1);
    assert.equal(await ctx.exists('tin-tuc/a/index.html'), false);
  });

  it('refuses cron outside the nodejs production runtime', () => {
    const ctx = createCache({
      origin: { internalUrl: 'http://127.0.0.1:9', publicUrl: 'https://news.example.com' },
      storage: { directory: '/tmp/hiden', releaseId: RELEASE },
      policy: { include: ['/'] },
      cron: { enabled: true },
    });
    const previous = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = 'edge';
    assert.throws(() => ctx.startCron(), (error: unknown) => error instanceof CacheError && error.code === 'POLICY_REJECTED');
    if (previous === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = previous;
    ctx.stopCron();
  });
});

async function boot(
  handler: http.RequestListener,
  patch: { ttl?: { seconds: number } } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hiden-'));
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const input = {
    origin: { internalUrl: `http://127.0.0.1:${port}`, publicUrl: 'https://news.example.com' },
    storage: { directory, releaseId: RELEASE },
    policy: {
      include: ['/', '/tin-tuc/**'],
      query: { allow: { page: { type: 'digits' as const } } },
    },
    ttl: patch.ttl,
  };
  const cache = createCache(input);
  await cache.init();
  const file = async (relative: string, generation = 'gen-1') => {
    const live = await readFile(path.join(directory, 'control', `generation-${RELEASE}`), 'utf8')
      .then((text) => text.trim())
      .catch(() => 'gen-1');
    const base = generation === live ? path.join(directory, RELEASE) : path.join(directory, `.${RELEASE}.${generation}`);
    return path.join(base, ...relative.split('/'));
  };
  return {
    cache,
    directory,
    input,
    file,
    exists: async (relative: string, generation?: string) => {
      try {
        await readFile(await file(relative, generation));
        return true;
      } catch {
        return false;
      }
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function page(revision: string): string {
  return `<!doctype html><html data-dpl-id="${RELEASE}"><head><meta name="hiden-cache-revision" content="${revision}"></head><body>ok</body></html>`;
}

function send(res: http.ServerResponse, body: string): void {
  const data = Buffer.from(body);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(data.byteLength),
  });
  res.end(data);
}

function runGc(directory: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        'src/cron/cli.ts',
        '--directory',
        directory,
        '--release',
        RELEASE,
        '--max-items',
        '20',
        '--max-duration-ms',
        '2000',
      ],
      { cwd: fileURLToPath(new URL('..', import.meta.url)) },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(stderr || `gc exit ${code}`));
      else resolve(0);
    });
  });
}
