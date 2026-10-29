import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { CacheError, createCache } from '../src/index.ts';
import type { CacheConfigInput } from '../src/types.ts';

const RELEASE = 'build-b';
const REVISION = 'article-123:v42';

describe('warm and purge', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it('stores identity HTML and a gzip file when the document is cacheable', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const ctx = await boot((req, res) => {
      seen.push(req.headers);
      if (req.url === '/tin-tuc/private') {
        return send(res, page(REVISION), { 'cache-control': 'private, no-store' });
      }
      if (req.url === '/tin-tuc/cookie') return send(res, page(REVISION), { 'set-cookie': 'a=b' });
      if (req.url === '/tin-tuc/vary') return send(res, page(REVISION), { vary: 'Cookie' });
      if (req.url === '/tin-tuc/nonce') return send(res, page(REVISION), { 'content-security-policy': "script-src 'nonce-abc'" });
      if (req.url === '/tin-tuc/stream') return send(res, page(REVISION, 'NEXT_HTTP_ERROR_FALLBACK;404'));
      if (req.url === '/tin-tuc/redirected') return send(res, page(REVISION, 'NEXT_REDIRECT;replace;/x;307;'));
      if (req.url === '/tin-tuc/suspense') {
        return send(res, page(REVISION, 'Switched to client rendering because the server rendering errored'));
      }
      if (req.url === '/tin-tuc/wrong-release') return send(res, page(REVISION).replace(RELEASE, 'other'));
      if (req.url === '/elsewhere') return send(res, page(REVISION));
      if (req.url === '/tin-tuc/go') {
        res.writeHead(302, { location: '/elsewhere' });
        res.end();
        return;
      }
      const revision = new URL(req.url ?? '/', 'http://localhost').searchParams.get('rev') ?? REVISION;
      send(res, page(revision, '', req.url === '/tin-tuc/body'));
    });
    cleanups.push(ctx.close);

    const warmed = await ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 42 });
    assert.equal(warmed.file, 'tin-tuc/a/index.html');
    assert.equal(warmed.revisionGuarantee, 'exact');
    assert.equal((await ctx.cache.status('/tin-tuc/a')).state, 'hit');
    const request = seen[0]!;
    assert.equal(request.host, 'news.example.com');
    assert.equal(request.accept, 'text/html');
    assert.equal(request['accept-encoding'], 'identity');
    assert.equal(request['x-forwarded-host'], 'news.example.com');
    assert.equal(request['x-forwarded-proto'], 'https');
    assert.equal(request.cookie, undefined);
    assert.equal(request.authorization, undefined);
    const meta = JSON.parse(await readFile(await ctx.file('tin-tuc/a/meta.json'), 'utf8')) as { revision: string; releaseId: string };
    assert.equal(meta.revision, REVISION);
    assert.equal(meta.releaseId, RELEASE);
    const html = await readFile(await ctx.file('tin-tuc/a/index.html'));
    const gzip = await readFile(await ctx.file('tin-tuc/a/index.html.gz'));
    assert.equal(html[0], 0x3c);
    assert.equal(html.includes(Buffer.from([0x1f, 0x8b])), false);
    assert.deepEqual(gunzipSync(gzip), html);

    const before = seen.length;
    await rejects(ctx.cache.warm('/tin-tuc/private', { expectedRevision: REVISION, commitVersion: 1 }), 'INVALID_RESPONSE');
    await rejects(ctx.cache.warm('/tin-tuc/cookie', { expectedRevision: REVISION, commitVersion: 1 }), 'INVALID_RESPONSE');
    await rejects(ctx.cache.warm('/tin-tuc/vary', { expectedRevision: REVISION, commitVersion: 1 }), 'INVALID_RESPONSE');
    await rejects(ctx.cache.warm('/tin-tuc/nonce', { expectedRevision: REVISION, commitVersion: 1 }), 'INVALID_RESPONSE');
    await rejects(ctx.cache.warm('/tin-tuc/stream', { expectedRevision: REVISION, commitVersion: 1 }), 'INVALID_RESPONSE');
    await rejects(ctx.cache.warm('/tin-tuc/redirected', { expectedRevision: REVISION, commitVersion: 1 }), 'INVALID_RESPONSE');
    await rejects(ctx.cache.warm('/tin-tuc/suspense', { expectedRevision: REVISION, commitVersion: 1 }), 'INVALID_RESPONSE');
    await rejects(ctx.cache.warm('/tin-tuc/wrong-release', { expectedRevision: REVISION, commitVersion: 1 }), 'RELEASE_MISMATCH');
    await rejects(ctx.cache.warm('/tin-tuc/go', { expectedRevision: REVISION, commitVersion: 1 }), 'INVALID_RESPONSE');
    assert.equal(seen.length, before + 9);
    for (const url of ['private', 'cookie', 'vary', 'nonce', 'stream', 'redirected', 'suspense', 'wrong-release', 'go']) {
      assert.equal(await ctx.exists(`tin-tuc/${url}/index.html`), false);
    }

    const bodyMeta = await ctx.cache.warm('/tin-tuc/body', { expectedRevision: REVISION, commitVersion: 7 });
    assert.equal(bodyMeta.revision, REVISION);
  });

  it('does not write a gzip file when compression is off', async () => {
    const ctx = await boot((_req, res) => send(res, page(REVISION)), { document: { compression: 'off' } });
    cleanups.push(ctx.close);
    await ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 1 });
    assert.equal(await ctx.exists('tin-tuc/a/index.html'), true);
    assert.equal(await ctx.exists('tin-tuc/a/index.html.gz'), false);
    assert.doesNotMatch(ctx.cache.generateNginxConfig(), /gzip_static/);
  });

  it('keeps the revision floor and rejects a stale or conflicting event', async () => {
    let calls = 0;
    const ctx = await boot((_req, res) => {
      calls += 1;
      send(res, page(REVISION));
    });
    cleanups.push(ctx.close);

    const first = await ctx.cache.purge('/tin-tuc/a', { minRevision: REVISION, commitVersion: 42 });
    assert.equal(first.revisionGuarantee, 'exact');
    assert.equal(first.minRevision, REVISION);
    const again = await ctx.cache.purge('/tin-tuc/a', { minRevision: REVISION, commitVersion: 42 });
    assert.equal(again.fence, first.fence + 1);
    assert.equal(again.minRevision, REVISION);
    await rejects(ctx.cache.purge('/tin-tuc/a', { minRevision: 'article-123:v41', commitVersion: 41 }), 'STALE_EVENT');
    await rejects(ctx.cache.purge('/tin-tuc/a', { minRevision: 'article-123:v99', commitVersion: 42 }), 'VERSION_CONFLICT');

    await ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 42 });
    assert.equal((await ctx.cache.status('/tin-tuc/a')).state, 'hit');
    await rejects(ctx.cache.purge('/tin-tuc/a', { minRevision: 'article-123:v41', commitVersion: 41 }), 'STALE_EVENT');
    assert.equal((await ctx.cache.status('/tin-tuc/a')).state, 'hit');

    const bare = await ctx.cache.purge('/tin-tuc/a');
    assert.equal(bare.revisionGuarantee, 'none');
    assert.equal(bare.minRevision, REVISION);
    assert.equal((await ctx.cache.status('/tin-tuc/a')).state, 'miss');
    const before = calls;
    await rejects(ctx.cache.warm('/tin-tuc/a'), 'REVISION_REQUIRED');
    await rejects(ctx.cache.warm('/tin-tuc/a'), 'REVISION_REQUIRED');
    assert.equal(calls, before);
  });

  it('does not fetch or rewrite an idempotent warm', async () => {
    let calls = 0;
    const ctx = await boot((_req, res) => {
      calls += 1;
      send(res, page(REVISION));
    });
    cleanups.push(ctx.close);
    await ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 42 });
    const metaPath = await ctx.file('tin-tuc/a/meta.json');
    const before = JSON.parse(await readFile(metaPath, 'utf8')) as { token: string };
    const again = await ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 42 });
    const after = JSON.parse(await readFile(metaPath, 'utf8')) as { token: string };
    assert.equal(calls, 1);
    assert.equal(again.revisionGuarantee, 'exact');
    assert.equal(after.token, before.token);
    assert.equal((await ctx.cache.status('/tin-tuc/a')).state, 'hit');
  });

  it('does not let a variant purge lower the path revision', async () => {
    const ctx = await boot((_req, res) => send(res, page('listing:v5')));
    cleanups.push(ctx.close);
    await ctx.cache.purge('/tin-tuc/a', { minRevision: 'listing:v5', commitVersion: 5 });
    await ctx.cache.purge('/tin-tuc/a?page=2', { minRevision: 'page:v9', commitVersion: 9 });
    const path = await ctx.cache.purge('/tin-tuc/a', { minRevision: 'listing:v5', commitVersion: 5 });
    assert.equal(path.minRevision, 'listing:v5');
    await ctx.cache.warm('/tin-tuc/a?page=1', { expectedRevision: 'listing:v5', commitVersion: 5 });
    assert.equal((await ctx.cache.status('/tin-tuc/a?page=1')).state, 'hit');
    assert.equal(await ctx.exists('tin-tuc/a/@page-1/index.html'), true);
    await ctx.cache.purge('/tin-tuc/a', { minRevision: 'listing:v6', commitVersion: 6 });
    assert.equal(await ctx.exists('tin-tuc/a/@page-1/index.html'), false);
    assert.equal((await ctx.cache.status('/tin-tuc/a?page=1')).state, 'miss');
  });

  it('drops an in-flight warm when the path fence moves', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const ctx = await boot((_req, res) => {
      started();
      void gate.then(() => send(res, page(REVISION)));
    });
    cleanups.push(ctx.close);
    const pending = ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 42 });
    await ready;
    await ctx.cache.purge('/tin-tuc/a', { minRevision: REVISION, commitVersion: 42 });
    release();
    await rejects(pending, 'SUPERSEDED');
    assert.equal((await ctx.cache.status('/tin-tuc/a')).state, 'miss');
  });

  it('purges every release generation and keeps an incomplete publish off the live path', async () => {
    const ctx = await boot((_req, res) => send(res, page(REVISION)));
    cleanups.push(ctx.close);
    await ctx.cache.warm('/', { expectedRevision: REVISION, commitVersion: 1 });
    await ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 1 });
    await ctx.cache.purge('/');
    assert.equal((await ctx.cache.status('/')).state, 'miss');
    assert.equal((await ctx.cache.status('/tin-tuc/a')).state, 'hit');

    await ctx.cache.purgeAll();
    assert.equal(await readFile(path.join(ctx.directory, 'control', `generation-${RELEASE}`), 'utf8'), 'gen-2');
    assert.equal((await ctx.cache.status('/tin-tuc/a')).state, 'miss');
    assert.equal(await ctx.exists('tin-tuc/a/index.html', 'gen-1'), true);
    await ctx.cache.purge('/tin-tuc/a', { minRevision: REVISION, commitVersion: 1 });
    assert.equal(await ctx.exists('tin-tuc/a/index.html', 'gen-1'), false);

    const batch = await ctx.cache.purgeMany(['/tin-tuc/a', '/admin']);
    assert.equal(batch.ok, false);
    assert.equal(batch.results[0]?.ok, true);
    assert.equal(batch.results[1]?.ok, false);

    const live = path.join(ctx.directory, RELEASE, 'tin-tuc', 'b');
    await ctx.cache.warm('/tin-tuc/b', { expectedRevision: REVISION, commitVersion: 2 });
    const kept = path.join(ctx.directory, 'control', 'trash', 'kept');
    await mkdir(kept, { recursive: true });
    await renameDir(live, path.join(kept, 'entry'));
    await mkdir(path.join(ctx.directory, 'control', 'tmp', 'partial'), { recursive: true });
    await writeFile(path.join(ctx.directory, 'control', 'tmp', 'partial', 'index.html'), 'partial');
    await writeFile(
      path.join(ctx.directory, 'control', 'purge-intents', 'abc.json'),
      JSON.stringify({
        id: 'abc',
        status: 'open',
        scope: 'path',
        key: '/tin-tuc/a',
        path: '/tin-tuc/a',
        file: 'tin-tuc/a/index.html',
        fence: 4,
        pathFence: 4,
        minRevision: REVISION,
        commitVersion: 1,
        releaseId: RELEASE,
        logged: false,
      }),
    );
    await ctx.cache.init();
    assert.equal(await ctx.exists('tin-tuc/b/index.html', 'gen-2'), false);
    assert.equal(await fileExists(path.join(ctx.directory, 'control', 'tmp', 'partial', 'index.html')), false);
    assert.equal(await fileExists(path.join(kept, 'entry', 'index.html')), true);
    const intent = JSON.parse(await readFile(path.join(ctx.directory, 'control', 'purge-intents', 'abc.json'), 'utf8')) as {
      status: string;
    };
    assert.equal(intent.status, 'complete');
  });

  it('reports an expired file without deleting it and quarantines HTML that has no meta', async () => {
    const ctx = await boot((_req, res) => send(res, page(REVISION)), { ttl: { seconds: 0 } });
    cleanups.push(ctx.close);
    await ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 1 });
    assert.equal((await ctx.cache.status('/tin-tuc/a')).state, 'expired');
    assert.equal(await ctx.exists('tin-tuc/a/index.html'), true);
    await rm(await ctx.file('tin-tuc/a/meta.json'));
    assert.equal((await ctx.cache.status('/tin-tuc/a')).state, 'miss');
    assert.equal(await ctx.exists('tin-tuc/a/index.html'), false);
  });

  it('keeps a homepage query when purging the /page path', async () => {
    const ctx = await boot((_req, res) => send(res, page(REVISION)), {
      policy: {
        include: ['/', '/page'],
        exclude: ['/admin/**'],
        query: { allow: { page: { type: 'digits' } } },
      },
    });
    cleanups.push(ctx.close);
    await ctx.cache.warm('/?page=1', { expectedRevision: REVISION, commitVersion: 1 });
    await ctx.cache.warm('/page?page=1', { expectedRevision: REVISION, commitVersion: 1 });
    assert.equal(await ctx.exists('@page-1/index.html'), true);
    assert.equal(await ctx.exists('page/@page-1/index.html'), true);
    await ctx.cache.purge('/page', { minRevision: REVISION, commitVersion: 2 });
    assert.equal(await ctx.exists('@page-1/index.html'), true);
    assert.equal(await ctx.exists('page/@page-1/index.html'), false);
    await ctx.cache.purge('/', { minRevision: REVISION, commitVersion: 2 });
    assert.equal(await ctx.exists('@page-1/index.html'), false);
  });

  it('removes bare HTML when the process starts', async () => {
    const ctx = await boot((_req, res) => send(res, page(REVISION)));
    cleanups.push(ctx.close);
    const bare = await ctx.file('tin-tuc/bare');
    const kept = await ctx.file('tin-tuc/kept');
    await mkdir(bare, { recursive: true });
    await mkdir(kept, { recursive: true });
    await writeFile(path.join(bare, 'index.html'), 'bare');
    await writeFile(path.join(kept, 'index.html'), 'kept');
    await writeFile(path.join(kept, 'meta.json'), '{}');
    await ctx.cache.init();
    assert.equal(await ctx.exists('tin-tuc/bare/index.html'), false);
    assert.equal(await ctx.exists('tin-tuc/kept/index.html'), true);
  });

  it('refuses to write while next dev is running', async () => {
    const ctx = await boot((_req, res) => send(res, page(REVISION)));
    cleanups.push(ctx.close);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await rejects(ctx.cache.warm('/tin-tuc/a', { expectedRevision: REVISION, commitVersion: 1 }), 'POLICY_REJECTED');
      await rejects(ctx.cache.purge('/tin-tuc/a'), 'POLICY_REJECTED');
      await rejects(ctx.cache.init(), 'POLICY_REJECTED');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});

async function boot(
  handler: http.RequestListener,
  patch: Partial<CacheConfigInput> = {},
): Promise<{
  cache: ReturnType<typeof createCache>;
  directory: string;
  file: (relative: string, generation?: string) => string;
  exists: (relative: string, generation?: string) => Promise<boolean>;
  close: () => Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hiden-'));
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const cache = createCache({
    origin: { internalUrl: `http://127.0.0.1:${port}`, publicUrl: 'https://news.example.com' },
    storage: { directory, releaseId: RELEASE },
    policy: {
      include: ['/', '/tin-tuc/**'],
      exclude: ['/admin/**'],
      query: { allow: { page: { type: 'digits' } } },
    },
    ...patch,
  });
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
    file,
    exists: async (relative?: string, generation?: string) => fileExists(await file(relative ?? '', generation)),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function page(revision: string, extra = '', revisionInBody = false): string {
  const meta = `<meta name="hiden-cache-revision" content="${revision}">`;
  return `<!doctype html><html data-dpl-id="${RELEASE}">${revisionInBody ? '' : `<head>${meta}</head>`}<body>${revisionInBody ? meta : ''}${extra}</body></html>`;
}

function send(res: http.ServerResponse, body: string, headers: Record<string, string> = {}): void {
  const data = Buffer.from(body);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(data.byteLength),
    ...headers,
  });
  res.end(data);
}

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CacheError);
    assert.equal(error.code, code);
    return true;
  });
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function renameDir(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  const { rename } = await import('node:fs/promises');
  await rename(from, to);
}
