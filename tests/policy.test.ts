import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, createCache } from '../src/index.ts';
import type { CacheConfigInput } from '../src/types.ts';

const config: CacheConfigInput = {
  origin: {
    internalUrl: 'http://127.0.0.1:3000',
    publicUrl: 'https://news.example.com',
  },
  storage: {
    directory: '/var/cache/hiden',
    releaseId: 'build-b',
  },
  policy: {
    include: ['/', '/tin-tuc/**', '/chuyen-muc/**'],
    exclude: ['/api/**', '/admin/**', '/booking/**'],
    query: {
      allow: {
        page: { type: 'digits' },
      },
    },
  },
};

describe('policy corpus', () => {
  const cache = createCache(config);

  it('maps canonical pages and whitelisted query', () => {
    assert.equal(file(cache, '/'), 'index.html');
    assert.equal(file(cache, '/tin-tuc/a'), 'tin-tuc/a/index.html');
    assert.equal(file(cache, '/tin-tuc/doanh-nghiep', 'page=1'), 'tin-tuc/doanh-nghiep/@page-1/index.html');
  });

  it('redirects a trailing slash and does not store it', () => {
    const decision = cache.evaluate({ method: 'GET', rawPath: '/tin-tuc/a/', rawQuery: 'page=1' });
    assert.deepEqual(decision, { action: 'redirect', location: '/tin-tuc/a?page=1' });
    assert.equal(cache.classifyWarmTarget('/tin-tuc/doanh-nghiep/?page=1').ok, false);
  });

  it('does not create a file for a query outside the allowlist', () => {
    assert.equal(cache.evaluate({ method: 'GET', rawPath: '/tin-tuc/doanh-nghiep', rawQuery: 'limit=100' }).action, 'bypass');
    assert.equal(
      cache.evaluate({ method: 'GET', rawPath: '/tin-tuc/doanh-nghiep', rawQuery: 'page=1&limit=100' }).action,
      'bypass',
    );
    assert.equal(cache.classifyWarmTarget('/tin-tuc/doanh-nghiep?limit=100').ok, false);
  });

  it('bypasses unsafe paths, router requests, cookies and excluded routes', () => {
    for (const rawPath of ['/tin-tuc//a', '/tin-tuc/../a', '/tin-tuc/%2e%2e/a', '/tin-tuc/%2Fsecret']) {
      assert.equal(cache.evaluate({ method: 'GET', rawPath }).action, 'bypass', rawPath);
    }
    assert.equal(cache.evaluate({ method: 'POST', rawPath: '/tin-tuc/a' }).action, 'bypass');
    assert.equal(cache.evaluate({ method: 'GET', rawPath: '/tin-tuc/a', rawQuery: '_rsc=1' }).action, 'bypass');
    assert.equal(
      cache.evaluate({
        method: 'GET',
        rawPath: '/tin-tuc/a',
        headers: { RSC: '1' },
      }).action,
      'bypass',
    );
    assert.equal(
      cache.evaluate({
        method: 'GET',
        rawPath: '/tin-tuc/a',
        headers: { Cookie: 'payload-token=abc' },
      }).action,
      'bypass',
    );
    assert.equal(cache.evaluate({ method: 'GET', rawPath: '/admin' }).action, 'bypass');
    assert.equal(cache.evaluate({ method: 'GET', rawPath: '/_next/static/chunk.js' }).action, 'bypass');
    assert.equal(cache.classifyWarmTarget('/admin/posts').ok, false);
  });

  it('matches one segment and a deep wildcard differently', () => {
    const single = createCache({
      ...config,
      policy: { ...config.policy, include: ['/tin-tuc/*'], exclude: [] },
    });
    assert.equal(single.evaluate({ method: 'GET', rawPath: '/tin-tuc/a' }).action, 'eligible');
    assert.equal(single.evaluate({ method: 'GET', rawPath: '/tin-tuc' }).action, 'bypass');
    assert.equal(single.evaluate({ method: 'GET', rawPath: '/tin-tuc/a/b' }).action, 'bypass');
  });

  it('lets exclude win over include', () => {
    const mixed = createCache({
      ...config,
      policy: {
        ...config.policy,
        include: ['/tin-tuc/**'],
        exclude: ['/tin-tuc/secret/**'],
      },
    });
    assert.equal(mixed.evaluate({ method: 'GET', rawPath: '/tin-tuc/a' }).action, 'eligible');
    assert.equal(mixed.evaluate({ method: 'GET', rawPath: '/tin-tuc/secret' }).action, 'bypass');
  });

  it('accepts either param order and emits the same nginx directory', () => {
    const ordered = createCache({
      ...config,
      policy: {
        ...config.policy,
        query: {
          allow: {
            page: { type: 'digits' },
            sort: { type: 'enum', values: ['new', 'old'] },
          },
        },
      },
    });
    const first = ordered.evaluate({ method: 'GET', rawPath: '/tin-tuc/a', rawQuery: 'page=2&sort=new' });
    const second = ordered.evaluate({ method: 'GET', rawPath: '/tin-tuc/a', rawQuery: 'sort=new&page=2' });
    assert.equal(first.action, 'eligible');
    assert.equal(second.action, 'eligible');
    if (first.action === 'eligible' && second.action === 'eligible') {
      assert.equal(first.file, second.file);
      assert.equal(first.file, 'tin-tuc/a/@page-2.sort-new/index.html');
    }
    const nginx = ordered.generateNginxConfig();
    assert.match(nginx, /page=\(\?<page>\[1-9\]\[0-9\]\{0,5\}\)/);
    assert.match(nginx, /sort=\(\?<sort>new\|old\)/);
    assert.doesNotMatch(nginx, /limit=/);
  });

  it('rejects page values that are not canonical digits', () => {
    for (const rawQuery of ['page=0', 'page=01', 'page=', 'page=1%30']) {
      assert.equal(cache.evaluate({ method: 'GET', rawPath: '/', rawQuery }).action, 'bypass', rawQuery);
    }
  });

  it('stores the homepage query away from the /page path', () => {
    const both = createCache({
      ...config,
      policy: { ...config.policy, include: ['/', '/page'] },
    });
    assert.equal(file(both, '/', 'page=1'), '@page-1/index.html');
    assert.equal(file(both, '/page', 'page=1'), 'page/@page-1/index.html');
  });

  it('bypasses api and well-known even when include is broad', () => {
    const broad = createCache({
      ...config,
      policy: { include: ['/**'], exclude: [], query: config.policy.query },
    });
    assert.equal(broad.evaluate({ method: 'GET', rawPath: '/api/x' }).action, 'bypass');
    assert.equal(broad.evaluate({ method: 'GET', rawPath: '/.well-known/acme' }).action, 'bypass');
    assert.equal(broad.classifyWarmTarget('/api/x').ok, false);
    assert.equal(file(broad, '/tin-tuc/a'), 'tin-tuc/a/index.html');
  });
});

describe('config', () => {
  it('rejects rules Nginx cannot share', () => {
    assert.throws(
      () =>
        createCache({
          ...config,
          policy: { ...config.policy, cookies: { harmless: ['_ga'] } },
        }),
      ConfigError,
    );
    assert.throws(
      () =>
        createCache({
          ...config,
          policy: {
            ...config.policy,
            query: {
              allow: {
                page: { type: 'digits' },
                sort: { type: 'enum', values: ['new'] },
                order: { type: 'enum', values: ['asc'] },
                cursor: { type: 'enum', values: ['a'] },
              },
            },
          },
        }),
      ConfigError,
    );
    assert.throws(() => createCache({ ...config, onMiss: { mode: 'mirror' as 'passthrough' } }), ConfigError);
    assert.throws(
      () => createCache({ ...config, origin: { ...config.origin, previousStaticRoot: '/var/www/prev' } }),
      ConfigError,
    );
    assert.throws(
      () => createCache({ ...config, origin: { ...config.origin, staticRoot: 'releases/current' } }),
      ConfigError,
    );
    assert.throws(
      () => createCache({ ...config, origin: { ...config.origin, staticRoot: '/var/www/../secret' } }),
      ConfigError,
    );
  });
});

function file(cache: ReturnType<typeof createCache>, rawPath: string, rawQuery = ''): string {
  const decision = cache.evaluate({ method: 'GET', rawPath, rawQuery });
  assert.equal(decision.action, 'eligible');
  if (decision.action !== 'eligible') throw new Error('unreachable');
  return decision.file;
}
