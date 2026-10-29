import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCache } from '../src/index.ts';
import { nginxRouteAllowed } from '../src/nginx/config-generator.ts';

const cache = createCache({
  origin: {
    internalUrl: 'http://127.0.0.1:3000',
    publicUrl: 'https://news.example.com',
  },
  storage: { directory: '/var/cache/hiden', releaseId: 'build-b' },
  policy: {
    include: ['/', '/tin-tuc/**'],
    exclude: ['/api/**', '/admin/**'],
  },
});

describe('nginx snippet', () => {
  const config = cache.generateNginxConfig({ releaseId: 'build-b', upstream: 'http://127.0.0.1:3000' });

  it('keeps one document cache header and leaves static responses alone', () => {
    const store = block(config, 'store');
    const miss = block(config, 'miss');
    const document = block(config, 'document');
    const router = block(config, 'router');
    const statik = block(config, '_nextstatic');
    assert.equal(count(store, 'add_header Cache-Control'), 1);
    assert.equal(count(miss, 'add_header Cache-Control'), 1);
    assert.equal(count(document, 'add_header Cache-Control'), 1);
    assert.equal(count(router, 'add_header Cache-Control'), 0);
    assert.equal(count(router, 'private, no-store'), 0);
    assert.match(router, /add_header X-HTML-Cache BYPASS always;/);
    assert.doesNotMatch(router, /proxy_hide_header Cache-Control/);
    assert.doesNotMatch(router, /gzip/);
    assert.ok(document.indexOf('error_page 419 = @hiden_router;') < document.indexOf('return 301'));
    assert.equal(count(statik, 'private, no-store'), 0);
    assert.match(store, /gzip_static on;/);
    assert.match(store, /gzip on;/);
    assert.match(store, /gzip_vary on;/);
    assert.doesNotMatch(miss, /gzip on;/);
    assert.doesNotMatch(miss, /gzip_static/);
    assert.doesNotMatch(document, /gzip on;/);
    assert.doesNotMatch(document, /gzip_static/);
    assert.doesNotMatch(statik, /gzip on;/);
    assert.doesNotMatch(statik, /gzip_static/);
    assert.doesNotMatch(config, /mirror/);
    assert.doesNotMatch(config, /Access-Control-Allow-Origin/);
    assert.doesNotMatch(config, /\$http_accept_encoding\s*~\s*.*gzip/);
    assert.match(miss, /proxy_hide_header Cache-Control;/);
    assert.match(miss, /proxy_set_header Accept-Encoding \$http_accept_encoding;/);
    assert.match(store, /internal;/);
    assert.match(store, /expires off;/);
    assert.match(store, /open_file_cache off;/);
    assert.match(store, /root "\/var\/cache\/hiden\/build-b";/);
    assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
    assert.doesNotMatch(config, /\nmap /);
    assert.doesNotMatch(config, /\nupstream /);
    assert.doesNotMatch(config, /\nserver \{/);
    assert.match(config, /include \/path\/to\/this-file\.conf;/);
    assert.match(config, /control\/maintenance/);
    assert.match(config, /return 301 https:\/\/news\.example\.com\$html_cache_slash_path\$is_args\$args;/);
    assert.match(config, /\$request_uri/);
    assert.doesNotMatch(config, /\$uri/);
    assert.match(config, /\[A-Za-z0-9\._~-\]\{1,255\}/);
    assert.match(config, /1:0:1:1:1:1:0:0:0:0/);
    assert.doesNotMatch(config, /access_log off/);
    assert.doesNotMatch(config, /log_format/);
    assert.match(block(config, 'vars'), /set \$html_cache_status "";/);
    assert.match(block(config, 'vars'), /set \$html_cache_cookie_bypass "";/);
    assert.match(block(config, 'vars'), /set \$html_cache_query_ok "";/);
    assert.match(config, /set \$hiden_file "\/index\.html";/);
    assert.match(config, /set \$hiden_query_at "\/@";/);
    assert.match(config, /set \$hiden_file "\$hiden_query_at\$html_cache_query_dir\/index\.html";/);
    assert.doesNotMatch(config, /\/pages/);
    assert.doesNotMatch(config, /\/queries/);
    const staticAt = config.indexOf('location ^~ /_next/static/');
    const documentAt = config.indexOf('location / {');
    assert.ok(staticAt >= 0 && staticAt < documentAt);
    const api = block(config, 'api');
    assert.match(api, /location \^~ \/api\//);
    assert.doesNotMatch(api, /X-HTML-Cache/);
    assert.doesNotMatch(api, /Cache-Control/);
  });

  it('proxies with the scheme of the internal origin', () => {
    const secure = createCache({
      origin: {
        internalUrl: 'https://10.0.0.8:8443',
        publicUrl: 'https://news.example.com',
      },
      storage: { directory: '/var/cache/hiden', releaseId: 'build-b' },
      policy: { include: ['/'], exclude: [] },
    });
    const text = secure.generateNginxConfig();
    assert.match(text, /proxy_pass https:\/\/10\.0\.0\.8:8443;/);
    assert.doesNotMatch(text, /proxy_pass http:\/\//);
  });

  it('turns precompressed files off with document compression', () => {
    const quiet = createCache({
      origin: {
        internalUrl: 'http://127.0.0.1:3000',
        publicUrl: 'https://news.example.com',
      },
      storage: { directory: '/var/cache/hiden', releaseId: 'build-b' },
      policy: { include: ['/'], exclude: [] },
      document: { compression: 'off' },
    });
    const text = quiet.generateNginxConfig();
    assert.match(block(text, 'store'), /# compression off/);
    assert.doesNotMatch(text, /gzip_static/);
    assert.doesNotMatch(text, /gzip on;/);
  });

  it('is one file included from the site server', () => {
    assert.match(config, /location \^~ \/_next\/static\//);
    assert.match(config, /location \^~ \/api\//);
    assert.match(config, /location \//);
    assert.equal(count(config, 'proxy_pass http://127.0.0.1:3000;') > 0, true);
  });

  it('uses the same route decision as the node evaluator', () => {
    for (const rawPath of ['/', '/tin-tuc/a', '/admin', '/admin/posts', '/api/x', '/_next/static/chunk.js', '/.well-known/acme']) {
      const node = cache.evaluate({ method: 'GET', rawPath });
      const nginx = nginxRouteAllowed(cache.policy, rawPath);
      assert.equal(nginx, node.action === 'eligible', rawPath);
    }
  });

  it('keeps well-known at the domain root when basePath is set', () => {
    const based = createCache({
      origin: {
        internalUrl: 'http://127.0.0.1:3000',
        publicUrl: 'https://news.example.com',
        basePath: '/news',
      },
      storage: { directory: '/var/cache/hiden', releaseId: 'build-b' },
      policy: { include: ['/**'], exclude: [] },
    });
    const text = based.generateNginxConfig();
    assert.match(text, /location \^~ \/\.well-known\//);
    assert.doesNotMatch(text, /location \^~ \/news\/\.well-known\//);
    assert.match(text, /location \^~ \/news\/api\//);
    assert.match(text, /location \^~ \/news\/_next\/static\//);
    assert.equal(based.evaluate({ method: 'GET', rawPath: '/news/api/x' }).action, 'bypass');
    assert.equal(based.evaluate({ method: 'GET', rawPath: '/.well-known/acme' }).action, 'bypass');
    assert.equal(nginxRouteAllowed(based.policy, '/news/tin-tuc/a'), true);
  });

  it('serves the current static directory before the previous release', () => {
    const rooted = createCache({
      origin: {
        internalUrl: 'http://127.0.0.1:3000',
        publicUrl: 'https://news.example.com',
        staticRoot: '/var/www/releases/current',
        previousStaticRoot: '/var/www/releases/previous',
      },
      storage: { directory: '/var/cache/hiden', releaseId: 'build-b' },
      policy: { include: ['/'], exclude: [] },
    });
    const text = rooted.generateNginxConfig();
    const current = block(text, '_nextstatic');
    const previous = block(text, 'static-prev');
    const proxy = block(text, 'static-proxy');
    assert.match(current, /alias "\/var\/www\/releases\/current\/_next\/static\/";/);
    assert.match(current, /error_page 404 = @hiden_static_prev;/);
    assert.match(current, /public, max-age=31536000, immutable/);
    assert.equal(count(current, 'private, no-store'), 0);
    assert.match(previous, /root "\/var\/www\/releases\/previous";/);
    assert.match(previous, /try_files \$uri @hiden_static_proxy;/);
    assert.match(proxy, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
    assert.equal(count(proxy, 'add_header Cache-Control'), 0);
    assert.doesNotMatch(current, /proxy_pass/);
  });

  it('strips basePath only while looking up a static file', () => {
    const rooted = createCache({
      origin: {
        internalUrl: 'http://127.0.0.1:3000',
        publicUrl: 'https://news.example.com',
        basePath: '/news',
        staticRoot: '/var/www/current',
      },
      storage: { directory: '/var/cache/hiden', releaseId: 'build-b' },
      policy: { include: ['/news'], exclude: [] },
    });
    const text = rooted.generateNginxConfig();
    const current = block(text, '_nextstatic');
    assert.match(current, /location \^~ \/news\/_next\/static\//);
    assert.match(current, /error_page 404 = @hiden_static_proxy;/);
    assert.match(text, /rewrite \^\/_next\/static\/\(\.\*\)\$ \/news\/_next\/static\/\$1 break;/);
    assert.doesNotMatch(text, /@hiden_static_prev/);
  });
});

function block(text: string, name: string): string {
  const match = new RegExp(`# hiden-block:${name}\\n([\\s\\S]*?)\\n# hiden-block:${name}-end`).exec(text);
  assert.ok(match?.[1], name);
  return match[1];
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
