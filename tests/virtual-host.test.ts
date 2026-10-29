import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { documents } from '../examples/next-site/app/content.js';
import { summarizeAccessLog } from '../src/index.ts';

type Sample = { status: number; headers: Map<string, string[]>; body: Buffer };
type Lab = { origin: string; directory: string; releaseId: string; accessLog?: string };
type DocumentCase = {
  path: string;
  revision: string;
  heading: string;
  body?: string;
  summary?: string;
  crumbs?: Array<{ href: string; label: string }>;
  links?: Array<{ href: string; label: string }>;
};

const lab = await readLab();

describe('virtual host news.example.com', { skip: lab ? false : 'run node --experimental-strip-types examples/next-site/lab.ts' }, () => {
  const origin = lab?.origin ?? 'http://news.example.com:8080';
  const directory = lab?.directory ?? '';

  for (const document of documents as DocumentCase[]) {
    it(`renders ${document.path} as plain HTML`, async () => {
      const hit = await get(origin, document.path, { 'Accept-Encoding': 'identity' });
      assert.equal(header(hit, 'x-html-cache'), 'HIT');
      assert.equal(hit.status, 200);
      assert.equal(header(hit, 'content-encoding'), '');
      assert.deepEqual(headers(hit, 'vary'), ['Accept-Encoding']);
      assert.deepEqual(headers(hit, 'cache-control'), ['private, no-store']);
      assertDocument(text(hit), document);
      const file = cacheFile(directory, document.path);
      const stored = await readFile(file);
      const gzip = await readFile(`${file}.gz`);
      assert.equal(stored[0], 0x3c);
      assert.equal(stored.includes(Buffer.from([0x1f, 0x8b])), false);
      assert.deepEqual(gunzipSync(gzip), stored);
      assert.deepEqual(hit.body, stored);
    });
  }

  it('reads the precompressed file when the client accepts gzip', async () => {
    const file = cacheFile(directory, '/tin-tuc/a');
    const stored = await readFile(file);
    const gzip = await readFile(`${file}.gz`);
    const hit = await get(origin, '/tin-tuc/a', { 'Accept-Encoding': 'gzip' });
    assert.equal(hit.status, 200);
    assert.equal(header(hit, 'x-html-cache'), 'HIT');
    assert.equal(header(hit, 'content-encoding'), 'gzip');
    assert.equal(header(hit, 'content-type').split(';')[0], 'text/html');
    assert.equal(header(hit, 'content-length'), String(gzip.byteLength));
    assert.deepEqual(headers(hit, 'vary'), ['Accept-Encoding']);
    assert.deepEqual(headers(hit, 'cache-control'), ['private, no-store']);
    assert.deepEqual(hit.body, gzip);
    assert.deepEqual(gunzipSync(hit.body), stored);

    const refused = await get(origin, '/tin-tuc/a', { 'Accept-Encoding': 'gzip;q=0' });
    assert.equal(header(refused, 'x-html-cache'), 'HIT');
    assert.equal(header(refused, 'content-encoding'), '');
    assert.deepEqual(refused.body, stored);

    const head = await get(origin, '/tin-tuc/a', { 'Accept-Encoding': 'gzip' }, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(header(head, 'content-encoding'), 'gzip');
    assert.equal(header(head, 'content-length'), String(gzip.byteLength));
    assert.equal(head.body.byteLength, 0);

    const exposed = await get(origin, '/tin-tuc/a/index.html.gz', { 'Accept-Encoding': 'identity' });
    assert.notEqual(header(exposed, 'x-html-cache'), 'HIT');
    assert.notDeepEqual(exposed.body, gzip);
  });

  it('records HIT, MISS and BYPASS without the cookie value', async () => {
    assert.ok(lab?.accessLog, 'rerun lab to generate access log');
    const start = await stat(lab.accessLog).then((info) => info.size);
    await get(origin, '/tin-tuc/a', { 'Accept-Encoding': 'identity' });
    await get(origin, '/tin-tuc/khong-co-log', { 'Accept-Encoding': 'identity' });
    await get(origin, '/tin-tuc/a?limit=100', { 'Accept-Encoding': 'identity' });
    await get(origin, '/tin-tuc/a', { 'Accept-Encoding': 'identity', Cookie: 'a=1' });
    const file = await readFile(lab.accessLog);
    const summary = summarizeAccessLog(file.subarray(start).toString('utf8'));
    assert.equal(summary.hit, 1);
    assert.equal(summary.miss, 1);
    assert.equal(summary.bypassCookie, 1);
    assert.equal(summary.bypassQuery, 1);
    assert.equal(file.subarray(start).toString('utf8').includes('a=1'), false);
  });

  it('proxies an unwarmed deep url again instead of storing the miss', async () => {
    const first = await get(origin, '/tin-tuc/the-gioi/kinh-te/khong-co', { 'Accept-Encoding': 'identity' });
    const second = await get(origin, '/tin-tuc/the-gioi/kinh-te/khong-co', { 'Accept-Encoding': 'identity' });
    assert.equal(header(first, 'x-html-cache'), 'MISS');
    assert.equal(header(second, 'x-html-cache'), 'MISS');
    assert.deepEqual(headers(first, 'cache-control'), ['private, no-store']);
  });

  it('proxies the publish route without an html cache header', async () => {
    const sample = await get(
      origin,
      '/api/publish',
      { 'Content-Type': 'application/json', 'Content-Length': '1' },
      'POST',
      '{',
    );
    assert.equal(sample.status, 400);
    assert.equal(header(sample, 'content-type').split(';')[0], 'application/json');
    assert.equal(header(sample, 'x-html-cache'), '');
    assert.equal(JSON.parse(text(sample)).ok, false);
  });

  it('misses an allowlisted query that Next refused to store', async () => {
    const query = await get(origin, '/tin-tuc?page=1', { 'Accept-Encoding': 'identity' });
    assert.equal(header(query, 'x-html-cache'), 'MISS');
    assert.equal(query.status, 200);
  });

  it('bypasses a query outside the allowlist on a deep article', async () => {
    const limit = await get(origin, '/tin-tuc/the-gioi/kinh-te/bai-viet-a?limit=100', { 'Accept-Encoding': 'identity' });
    const mixed = await get(origin, '/tin-tuc/the-gioi/kinh-te/bai-viet-a?page=1&limit=100', { 'Accept-Encoding': 'identity' });
    assert.equal(header(limit, 'x-html-cache'), 'BYPASS');
    assert.equal(header(mixed, 'x-html-cache'), 'BYPASS');
  });

  it('bypasses an encoded deep path and a dot segment', async () => {
    const encoded = await get(origin, '/tin-tuc/the-gioi/%6Binh-te', { 'Accept-Encoding': 'identity' });
    const dots = await get(origin, '/tin-tuc/the-gioi/kinh-te/../kinh-te/bai-viet-a', { 'Accept-Encoding': 'identity' });
    assert.equal(header(encoded, 'x-html-cache'), 'BYPASS');
    assert.equal(header(dots, 'x-html-cache'), 'BYPASS');
  });

  it('redirects a trailing slash on a deep article', async () => {
    const slash = await get(origin, '/tin-tuc/the-gioi/kinh-te/bai-viet-a/', { 'Accept-Encoding': 'identity' });
    const encoded = await get(origin, '/tin-tuc/%61/', { 'Accept-Encoding': 'identity' });
    assert.equal(slash.status, 301);
    assert.equal(header(slash, 'location'), `${origin}/tin-tuc/the-gioi/kinh-te/bai-viet-a`);
    assert.notEqual(encoded.status, 301);
  });

  it('sends an app router flight to the origin instead of the html file', async () => {
    const flightHeaders = {
      Accept: 'text/x-component',
      RSC: '1',
      'Next-Url': '/',
    };
    const flight = await get(origin, '/tin-tuc/the-gioi/kinh-te/bai-viet-a', flightHeaders);
    const direct = await get('http://127.0.0.1:3210', '/tin-tuc/the-gioi/kinh-te/bai-viet-a', flightHeaders);
    assert.equal(header(flight, 'x-html-cache'), 'BYPASS');
    assert.equal(flight.body.includes(Buffer.from('<!DOCTYPE html>')), false);
    assert.equal(header(flight, 'content-encoding'), '');
    assert.deepEqual(headers(flight, 'cache-control'), headers(direct, 'cache-control'));
  });

  it('bypasses a request that carries a cookie', async () => {
    const cookie = await get(origin, '/chuyen-muc/xa-hoi/giao-duc/tuyen-sinh', {
      'Accept-Encoding': 'identity',
      Cookie: 'a=1',
    });
    assert.equal(header(cookie, 'x-html-cache'), 'BYPASS');
    assert.deepEqual(headers(cookie, 'cache-control'), ['private, no-store']);
  });

  it('serves a built static asset from the current disk root', async () => {
    const home = await get(origin, '/', { 'Accept-Encoding': 'identity' });
    const asset = text(home).match(/\/_next\/static\/[^"']+/)?.[0];
    assert.ok(asset, 'homepage missing /_next/static asset');
    const statik = await get(origin, asset, { 'Accept-Encoding': 'identity' });
    assert.equal(header(statik, 'x-html-cache'), '');
    assert.match(header(statik, 'cache-control'), /immutable/);
    assert.equal(statik.status, 200);
  });

  it('serves next static js ahead of an aaPanel regex', async () => {
    const asset = await get(origin, '/_next/static/lab-panel.js', { 'Accept-Encoding': 'identity' });
    const plain = await get(origin, '/site.js', { 'Accept-Encoding': 'identity' });
    assert.equal(asset.status, 200);
    assert.equal(text(asset), 'current-js\n');
    assert.match(header(asset, 'cache-control'), /immutable/);
    assert.equal(header(asset, 'x-html-cache'), '');
    assert.equal(header(asset, 'x-panel-regex'), '');
    assert.equal(plain.status, 200);
    assert.equal(text(plain), 'panel-site\n');
    assert.equal(header(plain, 'x-panel-regex'), 'js');
    assert.doesNotMatch(header(plain, 'cache-control'), /immutable/);
  });

  it('reads the current static file before the previous release', async () => {
    const current = await get(origin, '/_next/static/lab-current.txt', { 'Accept-Encoding': 'identity' });
    const previous = await get(origin, '/_next/static/lab-previous.txt', { 'Accept-Encoding': 'identity' });
    const missing = await get(origin, '/_next/static/lab-missing.txt', { 'Accept-Encoding': 'identity' });
    assert.equal(current.status, 200);
    assert.equal(text(current), 'current-release\n');
    assert.match(header(current, 'cache-control'), /immutable/);
    assert.equal(previous.status, 200);
    assert.equal(text(previous), 'previous-release\n');
    assert.match(header(previous, 'cache-control'), /immutable/);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(header(missing, 'cache-control'), /immutable/);
  });

  it('bypasses every document while the maintenance file exists', async () => {
    const maintenance = path.join(directory, 'control', 'maintenance');
    await writeFile(maintenance, '1');
    try {
      const blocked = await get(origin, '/tin-tuc/the-gioi/kinh-te/bai-viet-a', { 'Accept-Encoding': 'identity' });
      assert.equal(header(blocked, 'x-html-cache'), 'BYPASS');
    } finally {
      await rm(maintenance, { force: true });
    }
    const restored = await get(origin, '/tin-tuc/the-gioi/kinh-te/bai-viet-a', { 'Accept-Encoding': 'identity' });
    assert.equal(header(restored, 'x-html-cache'), 'HIT');
  });
});

function assertDocument(body: string, document: DocumentCase): void {
  assert.match(body, /^<!DOCTYPE html>/i);
  assert.match(body, /<html[^>]*lang="vi"[^>]*data-dpl-id="next-dev"/);
  assert.match(body, /<header>/);
  assert.match(body, /<footer>Ban quyen<\/footer>/);
  assert.match(body, new RegExp(`<h1>${document.heading}</h1>`));
  assert.match(body, new RegExp(`content="${document.revision}"`));
  assert.doesNotMatch(body, new RegExp(`<h1>[^<]*<!-- -->`));
  if (document.body) assert.match(body, new RegExp(`<p>${document.body}</p>`));
  if (document.summary) assert.match(body, new RegExp(`<p>${document.summary}</p>`));
  for (const crumb of document.crumbs ?? []) {
    assert.match(body, new RegExp(`<a href="${crumb.href}">${crumb.label}</a>`));
  }
  for (const link of document.links ?? []) {
    assert.match(body, new RegExp(`<a href="${link.href}">${link.label}</a>`));
  }
}

function text(sample: Sample): string {
  return sample.body.toString('utf8');
}

function cacheFile(directory: string, urlPath: string): string {
  if (urlPath === '/') return path.join(directory, 'next-dev', 'index.html');
  return path.join(directory, 'next-dev', ...urlPath.slice(1).split('/'), 'index.html');
}

async function readLab(): Promise<Lab | undefined> {
  try {
    return JSON.parse(await readFile(new URL('../examples/next-site/.lab.json', import.meta.url), 'utf8')) as Lab;
  } catch {
    return undefined;
  }
}

function get(
  origin: string,
  urlPath: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: string,
): Promise<Sample> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: urlPath,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const map = new Map<string, string[]>();
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            const name = res.rawHeaders[i]?.toLowerCase() ?? '';
            const value = res.rawHeaders[i + 1] ?? '';
            map.set(name, [...(map.get(name) ?? []), value]);
          }
          resolve({ status: res.statusCode ?? 0, headers: map, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function headers(sample: Sample, name: string): string[] {
  return sample.headers.get(name) ?? [];
}

function header(sample: Sample, name: string): string {
  return headers(sample, name).join(' | ');
}
