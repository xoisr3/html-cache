# IMPLEMENTATION PLAN — HTML Cache Engine

**Package:** `@xoisr/html-cache`  
**Package Version:** v1.0.0  
**Type:** Headless npm package / TypeScript  
**Deployment:** Single-site / Self-hosted / Nginx OSS / Node.js  

Application integration: [README.md](README.md). API reference: [api.md](api.md). Operations & cutover guide: [guide.md](guide.md). This document defines the definitive behavioral contract.

**Goal:** A headless, framework-agnostic HTML full-page cache management engine. Nginx directly serves HTML files on HIT. Node.js renders dynamically on MISS. Cache files are created only when the application explicitly calls `warm()`.

v0.1 is a **manual / hook-driven HTML cache** for high-value URLs warmed proactively. It does not auto-cache every un-cached MISS and does not replace full-featured dynamic page caches like WP Rocket. Un-warmed URLs continue hitting the Node origin on every request (including search crawlers).

The true quality of this package does not lie in disk read speeds (Nginx handles that). Quality is ensuring that served files strictly match committed database revisions, point to the correct upstream release, and strictly adhere to caching policy.

---

## 1. Scope

### 1.1. Included in v0.1

| Component | Milestone | Functionality |
|---|---|---|
| Policy and Eligibility | P0 | Compiler, canonical URL/query mapping, Next.js response header evaluation, real-world eligibility ratio measurement |
| Safe Publish and Purge | P1 | Atomic `index.html` + `meta.json`, monotonic `commitVersion`, `pathFence`, HTML release markers |
| Nginx HIT / MISS | P2 | Zero Node requests on HIT. Single proxy on MISS. Pre-compressed `index.html.gz` for gzip-capable clients |
| CMS Hooks | P3 | Post-commit purge and warm workflows |
| TTL, Cron, Garbage Collection | P4 | Bounded background maintenance driven by empirical benchmarks |
| Deployment Pre-warming | P5 | Staged pre-warming when benchmark measurements justify it |

P0 and P1 ensure document correctness. P4 and P5 are non-blocking for proving HIT, purge, and cutover correctness.

### 1.2. Excluded from v0.1

- Auto-caching every MISS via Nginx `mirror` or capturing HTML from the initial proxy response.
- Admin UI, standalone API daemon, or persistent background service.
- Multi-site, multi-server clustering, distributed shared filesystems, Redis, database backends, or tag indexing.
- Direct runtime coupling to Payload CMS or Next.js internals. Does not touch `.next/cache` or purge Cloudflare CDN.
- Built-in authentication or access control for admin actions.
- Content variation based on language cookies, `Accept-Language`, or distinct mobile vs. desktop HTML.
- Stripping unexpected query parameters to serve a generic cache file. Any unlisted parameter causes a full request bypass (no file created).
- Non-empty `harmless` cookie lists, until proven safe via Nginx differential testing.
- Sub-second hard TTL expiration evaluated natively within Nginx.
- Cache purges executing when all Node processes are offline.

**Principle:** Every website installs the package locally, defines its own configuration, and invokes its own lifecycle actions.

### 1.3. Explicit Limitations

Under standard `next start`, Nginx OSS, and a headless npm package, there is no shared in-flight buffer to capture a MISS response, validate headers, and persist the HTML concurrently without an extra fetch. Nginx `proxy_store` saves upstream responses without a second fetch, but bypasses `Cache-Control` and `Set-Cookie` validation; it is therefore not used as the default path.

Next.js `cacheHandler` (singular) stores HTML and RSC payloads using internal composite keys, not raw URLs. Next.js `cacheHandlers` (plural) serves the `use cache` directive. Neither API produces static files directly consumable by Nginx. While Next.js `deploymentId` can be reflected in HTML (`data-dpl-id`) to verify release identity, it does not replace an atomic Nginx configuration binding both cache root and upstream.

---

## 2. Architecture

```text
HTTP REQUEST
     |
     v
   NGINX  (one config generation = one release)
     |
     +-- Ineligible ---------------------> Proxy to matching upstream release
     |
     +-- Eligible, index.html exists ----> HIT (0 Node requests)
     |
     +-- Eligible, no file on disk ------> MISS (proxies once, no mirror)
```

```text
CMS / Deployment Script
      |
      v
 Public Actions
      |
      +-- purge:    intent log, version fence, removes key across all releases
      +-- warm:     clean internal fetch, verifies revision, atomic directory publish
      +-- purgeAll: swaps live generation for the release currently served by Nginx
```

**Division of Responsibilities:**

- **Nginx:** Executes the compiled location snippet. Serves static files on HIT; proxies to the upstream release declared in the same snippet otherwise.
- **Application:** Renders HTML, invokes purge/warm post-commit, and preserves public static chunk URLs during cutovers.
- **Package:** Manages policy compilation, filesystem layout, fences, revision floors, and intent logs.
- **Cron (P4):** Ephemeral CLI task or in-process scheduler. No standalone persistent daemon.

App Router client navigation produces RSC payload requests that always hit Node. Cached HTML files exclusively serve full page loads, browser refreshes, and web crawlers.

---

## 3. Configuration

`createCache()` initializes an in-memory instance without touching disk, binding ports, or launching schedulers.

Release manifests on disk are written exclusively by `cache.init()` or deployment scripts to their release-scoped path:

```text
control/manifest-<releaseId>.json
```

A process running Release A must never overwrite the manifest of Release B.

```ts
import { createCache } from '@xoisr/html-cache';

export const cache = createCache({
  origin: {
    internalUrl: 'http://127.0.0.1:3000',
    publicUrl: 'https://news.example.com',
    basePath: '',
  },

  storage: {
    directory: '/var/cache/hiden',
    releaseId: process.env.CACHE_RELEASE_ID!,
  },

  policy: {
    include: ['/', '/news/**', '/categories/**'],
    exclude: [
      '/api/**',
      '/admin/**',
      '/_next/**',
      '/next/preview/**',
      '/booking/**',
    ],
    trailingSlash: 'never',
    query: {
      allow: {
        page: { type: 'digits' },
      },
    },
    cookies: {
      mode: 'allowlist',
      harmless: [],
    },
  },

  onMiss: { mode: 'passthrough' },

  warm: {
    concurrency: 2,
    timeoutMs: 10000,
    maxHtmlBytes: 2 * 1024 * 1024,
  },

  ttl: {
    seconds: 3600,
    enforcement: 'cron-soft',
  },

  document: {
    cacheControl: 'private, no-store',
    compression: 'nginx',
    securityHeaders: {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  },

  debug: false,
  cron: { enabled: false },
});

await cache.init();
```

| Option | Description | Default |
|---|---|---|
| `origin.internalUrl` | Target loopback address for `warm()` fetches | Required |
| `origin.publicUrl` | Canonical public host and protocol | Required |
| `origin.basePath` | Matches Next.js `basePath`. Empty string for root domain | `''` |
| `origin.staticRoot` | Directory containing `_next/static` for current release | `null` |
| `origin.previousStaticRoot` | Directory containing `_next/static` for previous release | `null` |
| `storage.directory` | Cache root path on filesystem | Required |
| `storage.releaseId` | Release ID declared by this process | Required |
| `policy.include` | Patterns of cacheable routes | Empty = no caching |
| `policy.exclude` | Route patterns to bypass | See example |
| `policy.trailingSlash` | Must be `'never'` in v0.1 | `'never'` |
| `policy.query.allow` | Allowed query parameter specifications | `{}` (all queries bypass) |
| `policy.cookies.harmless` | Cookies that do not alter HTML | Must be `[]` in v0.1 |
| `onMiss.mode` | MISS handling mode | `'passthrough'` |
| `warm.*` | Concurrency, timeout (ms), and uncompressed byte ceiling | `2` / `10000` / `2097152` |
| `ttl.seconds` | Expiration duration recorded in journal | `3600` |
| `ttl.enforcement` | TTL enforcement mode | `'cron-soft'` |
| `document.cacheControl` | Unified `Cache-Control` header for document responses | `'private, no-store'` |
| `document.compression` | Pre-compression mode (`'nginx'` writes `.gz`, `'off'` writes raw HTML) | `'nginx'` |
| `document.securityHeaders` | Standard security headers applied to cache responses | Minimum set above |
| `debug` | Emits debugging reason headers (never logs filesystem paths) | `false` |
| `cron.enabled` | In-process maintenance scheduler | `false` |

The policy compiler rejects configurations where `onMiss.mode !== 'passthrough'`, `cookies.harmless` is non-empty, query parameters exceed 3 entries, or `compression` is not `'nginx'` or `'off'`.

`ttl.seconds` does not guarantee that Nginx immediately purges files at that second; Nginx only checks file existence. Background maintenance cleans expired entries asynchronously.

---

## 4. Single Source of Truth for Policy

```text
createCache(config)
        |
        v
  Policy Compiler
        |
        +----> Node Policy Evaluator
        +----> Nginx snippet
        +----> Corpus differential test
```

1. Any request considered HIT-eligible by Nginx must also be considered cacheable by the Node evaluator.
2. Any rule that cannot be accurately represented in Nginx OSS causes the compiler to reject the configuration or force a request bypass.

### 4.1. HIT-eligible Criteria

All conditions must be satisfied simultaneously:

- Method is `GET` or `HEAD`. `warm()` always issues `GET`.
- Canonical path, matching `include`, not matching `exclude`. Exclude always wins.
- Query string is empty, or strictly matches canonical parameter allowlist rules (Section 5.1).
- No `Cookie` and no `Authorization` headers.
- No router-specific signals: query `_rsc`; path `/_next/data/`; headers `RSC`, `Next-Action`, `Next-Router-State-Tree`, `Next-Router-Prefetch`, `Next-Router-Segment-Prefetch`, `Next-Url`, `x-nextjs-data`; or `Accept: text/x-component`.
- Does not fall under `${basePath}/_next/` or `${basePath}/_next/image`.
- If `Sec-Fetch-Dest` is present, value must be `document`.
- Path contains no directory traversal (`..`), double slashes, or non-canonical percent-encodings.

### 4.2. Globs and Cookies

| Pattern | Match Behavior |
|---|---|
| `/news/**` | `/news` and all recursive sub-paths |
| `/news/*` | Exactly one path segment |
| Include ∩ Exclude | Exclude always takes precedence |

Calling `warm()` on an excluded path throws `POLICY_REJECTED`.

Permanent authentication denylist includes `payload-token`, `__prerender_bypass`, `__next_preview_data`, and common authentication session keys. Any overlap with `harmless` is rejected at compile time.

### 4.3. Cache Boundaries

The following always bypass cache:
- RSC payloads, prefetch requests, Server Actions, non-GET/HEAD methods.
- Query strings with unlisted parameters (e.g. `?page=1&limit=100`, `?page=1&_rsc=...`).
- Content varying by cookies or `Accept-Language` (locales must be path-encoded, e.g. `/en/...`).
- User-Agent dependent HTML variants.
- Routes where middleware computes authentication, redirects, or dynamic headers.

---

## 5. URL to Filesystem Mapping

Both Nginx and Node inspect the raw request URI without relying on normalized `$uri`.

| Request | Result |
|---|---|
| `/` | `index.html` |
| `/news/a` | `news/a/index.html` |
| `/news/a/` | Canonical redirect at Nginx; not cached |
| `/news/business?page=1` | `news/business/@page-1/index.html` |
| `/news/business/?page=1` | Non-canonical trailing slash; redirected to clean URL |
| `/news/business?limit=100` | Bypassed; no cache file created |
| `/news/business?page=1&limit=100` | Bypassed; no cache file created |
| Double slashes, `..`, `%2e%2e`, `%2F` | Bypassed |

### 5.1. Query Allowlist

The cache key is the canonical path plus the canonicalized query string. An empty query and `?page=1` map to separate files. `?page=1` and `?page=2` also map to separate files.

```ts
query: {
  allow: {
    page: { type: 'digits' },
  },
}
```

Supported types generating identical regex across Node and Nginx:

| `type` | Allowed Values |
|---|---|
| `digits` | `^[1-9][0-9]{0,5}$` (accepts `page=1`; rejects `page=0`, `page=01`, `page=`) |
| `enum` | Explicit list of strings matching `^[a-z0-9_-]{1,32}$` |

Query Evaluation Algorithm (applied to raw `$args` without decoding):
1. Empty query maps directly to the path directory.
2. Query containing `%`, `+`, or whitespace immediately bypasses cache.
3. Split by `&`. Each part must strictly match `name=value`.
4. Duplicate parameter names trigger bypass.
5. Any parameter name absent from `allow` triggers bypass.
6. Parameter values not conforming to their declared `type` trigger bypass.
7. Construct query folder `@name1-val.name2-val` sorted by declaration order in `allow`.
8. Different permutations of the same valid parameters resolve to the same canonical folder.

Cached query files reside inside the path directory under a `@`-prefixed name:

```text
news/business/@page-1/index.html
news/business/@page-1/meta.json
```

Each published document entry forms a complete self-contained directory:

```text
<cache>/<releaseId>/news/a/
├── index.html
├── index.html.gz
└── meta.json
```

`meta.json` is the sole authoritative source of truth for `token`, `revision`, `createdAt`, and `expiresAt` for the companion HTML file.

---

## 6. `warm()` Lifecycle

### 6.1. Clean Fetch

```http
GET /news/article-a HTTP/1.1
Host: news.example.com
Accept: text/html
Accept-Encoding: identity
X-Forwarded-Host: news.example.com
X-Forwarded-Proto: https
User-Agent: HidenHTMLCache/1.0
```

Requests are dispatched over TCP to `internalUrl`. No client cookies, authorization credentials, or forwarding client IPs are sent. Redirects are not followed; non-200 responses fail the warming operation.

### 6.2. Response Validator

| Validation Check | Failure Action |
|---|---|
| HTTP 200 status, body free of streamed errors/redirects | Rejected |
| Content-Type `text/html`, optional `charset=utf-8` | Rejected |
| No `Set-Cookie` header | Rejected |
| No `private`, `no-store`, or `no-cache` directives | Rejected |
| `Vary` restricted strictly to allowlist | Rejected |
| No CSP nonces in headers or HTML body | Rejected |
| Matching `Content-Length` and body within size ceiling | Rejected |
| Content revision and `commitVersion` validated | Rejected |
| HTML release marker matches `storage.releaseId` | Rejected (`RELEASE_MISMATCH`) |

Allowed `Vary` tokens: `RSC`, `Next-Router-State-Tree`, `Next-Router-Prefetch`, `Next-Router-Segment-Prefetch`, `Next-Url`, and `Accept-Encoding`. All other tokens (including `Cookie` or `User-Agent`) cause validation rejection.

### 6.3. Revision Floor

Revisions are opaque string identifiers (e.g. `article-123:v42`) compared using strict character equality.

```ts
await cache.purge('/news/article-a', {
  minRevision: 'article-123:v42',
  commitVersion: 42,
});

await cache.warm('/news/article-a', {
  expectedRevision: 'article-123:v42',
  commitVersion: 42,
});
```

- `commitVersion` is a strictly increasing integer provided per URL.
- Purge or warm calls with a `commitVersion` lower than the stored floor throw `STALE_EVENT`.
- Identical `commitVersion` with an identical revision is idempotent (skips re-fetching if file is intact).
- Identical `commitVersion` with a different revision throws `VERSION_CONFLICT`.
- Higher `commitVersion` safely advances `minRevision`.

Markers:
- Release marker: `data-dpl-id` attribute on `<html>` (from Next `deploymentId`), or `<meta name="hiden-cache-release">`.
- Content revision: `<meta name="hiden-cache-revision">`.

### 6.4. Atomic Publishing

Publishing coordinates through two locks: path lock first, then variant lock. Origin fetches occur outside lock acquisition.

1. Route validated by policy evaluator.
2. Single-flight lock acquired; origin fetched outside filesystem locks.
3. Response body, revision, and release markers validated.
4. Path lock and variant lock acquired. Version fences and intents re-verified.
5. Directory published atomically via two filesystem renames:

```text
Write tmp/<token>/index.html and meta.json
rename(live -> trash/<id>)     # live unlinked; Nginx momentarily MISSes
rename(tmp/<token> -> live)    # live appears complete with html + meta
```

`meta.json`:
```json
{
  "token": "b7e0",
  "fence": 11,
  "pathFence": 4,
  "commitVersion": 42,
  "revision": "article-123:v42",
  "releaseId": "build-B",
  "createdAt": 1760705400,
  "expiresAt": 1760709000
}
```

### 6.5. Gzip Pre-Compression

When `compression: 'nginx'`, `warm()` generates `index.html.gz` directly from the raw HTML buffer.

Nginx serves `index.html.gz` via `gzip_static on`. Gzip-capable clients receive pre-compressed files directly with zero compression overhead on Node or Nginx. Clients requesting `identity` or `q=0` receive the uncompressed `index.html`.

---

## 7. Filesystem Layout

```text
/var/cache/hiden/
├── build-41/                   # Live cache directory read by Nginx
│   ├── index.html
│   ├── index.html.gz
│   ├── meta.json
│   └── news/a/
│       ├── index.html
│       ├── index.html.gz
│       └── meta.json
├── .build-41.gen-1/            # Archived generation following purgeAll
└── control/
    ├── manifest-build-41.json
    ├── generation-build-41
    ├── serving-release
    ├── invalidations.log
    ├── fence-global.json
    ├── fence/
    ├── expiry/
    ├── purge-intents/
    ├── locks/
    ├── trash/
    └── tmp/
```

Nginx mounts `<cache>/<releaseId>` as its document root. `control/` is strictly private to Node and is never exposed or referenced by Nginx.

---

## 8. Invalidation

### 8.1. Purging Across All Releases

`purge()` removes files across all releases and generations on disk.

`purge('/news/business', { minRevision, commitVersion })` acquires the path lock, bumps `pathFence`, and atomically renames `news/business/` to `trash/`. This clears the index file, all sub-paths, and all pagination variants (`@page-...`). Background tasks clean up trash files asynchronously.

### 8.2. Invalidation Journal & Deployment Gate

Every purge operation appends an entry to `control/invalidations.log`:

```json
{"fence":11,"pathFence":4,"key":"/news/a","minRevision":"article-123:v42"}
{"fence":12,"scope":"all"}
```

`writeCutoverConfig()` validates the staged release against `invalidations.log` before emitting Nginx configuration:
- Rejects cutover if an un-cleared `scope: all` event occurred after the generation was initialized.
- Rejects cutover if staged files are older than recorded fence invalidations.
- Rejects cutover if any purge intent remains open.

### 8.3. Write-Ahead Purge Logging

```text
T1: fsync intent { key, new fence, minRevision }
T2: Increment fence record
T3: Unlink target files across all releases
T4: Mark intent completed
T5: Return success to caller
```

If a crash occurs before T5, startup recovery processes the pending intent. Purge operations never acknowledge success prematurely.

### 8.4. `purgeAll()`

Only the active serving release can trigger `purgeAll()`. It atomically renames `<releaseId>` to `.<releaseId>.gen-N` and creates a fresh empty directory at the same path without requiring an Nginx reload. Subsequent requests MISS until re-warmed.

### 8.5. Deployments: Cache and Upstream Bound to a Single Release

**Invariant:** In any given Nginx configuration generation, the cache `root` and the upstream `proxy_pass` point to the same release.

Traffic cutover occurs via an atomic `nginx reload` to a newly generated include snippet.

---

## 9. TTL and Cron Maintenance (P4)

- Expirations are logged to generation-specific journals during `warm()`.
- Background maintenance compares journal tokens with companion `meta.json` records. Files are only deleted if tokens match and current time exceeds `expiresAt`.
- Maintenance runs in bounded batches respecting `maxItems` and `maxDurationMs`.
- The CLI command `npx hiden-html-cache-gc` allows execution via system crontab.

---

## 10. Nginx Snippet Architecture

`generateNginxConfig()` produces an include file designed for insertion inside an HTTPS `server` block:

```nginx
include /etc/nginx/snippets/hiden-html-cache.conf;
```

Key guarantees:
1. Exact matches and `^~` static prefixes take precedence over document caching rules.
2. Direct requests to `/api/` or excluded paths proxy directly without document caching headers.
3. Cache HITs set `X-HTML-Cache: HIT` and enforce `document.cacheControl`.
4. MISS and BYPASS proxy to the upstream Node process and preserve client encoding headers.
5. Presence of `control/maintenance` forces immediate cache bypass without reloading Nginx.

---

## 11. Public API Summary

```ts
await cache.init();
await cache.warm('/news/article-a', { expectedRevision: 'article-123:v42', commitVersion: 42 });
await cache.purge('/news/article-a', { minRevision: 'article-123:v42', commitVersion: 42 });
await cache.publishDocument({ url: '/news/article-a', minRevision: 'article-123:v42', commitVersion: 42, revalidate });
await cache.purgeAll();
await cache.discardGeneration();
await cache.writeCutoverConfig('/etc/nginx/snippets/hiden-html-cache.conf');
await cache.activateServing('/etc/nginx/snippets/hiden-html-cache.conf');
```

---

## 12. Next.js and Node Integration

- `trailingSlash` must be `false` in `next.config`.
- `deploymentId` must match `storage.releaseId`.
- Routes reading `cookies()`, `headers()`, or `draftMode()` emit `no-store` and are excluded by the validator.
- Revalidation hooks (`revalidatePath()`) are invoked inside Route Handlers or Server Actions after database transaction commit.

---

## 13. Package Structure

```text
html-cache/
├── src/
│   ├── index.ts
│   ├── errors.ts
│   ├── types.ts
│   ├── core/        origin.ts  target.ts  runtime.ts  version.ts  config.ts  validator.ts
│   ├── policy/      match.ts  evaluator.ts  query.ts  compiler.ts
│   ├── storage/     lock.ts  fsutil.ts  layout.ts  journal.ts  store.ts
│   ├── actions/     status.ts  publish.ts  warm.ts  purge.ts
│   ├── deploy/      preflight.ts  cutover.ts
│   ├── cron/        scheduler.ts  cli.ts
│   └── nginx/       access-log.ts  config-generator.ts
├── tests/
├── examples/        nextjs/  payload/  node/  next-site/
├── scripts/
├── package.json
├── tsconfig.json
├── README.md
├── api.md
├── guide.md
└── docs.md
```

Distribution targets Node.js ESM with `.d.ts` declaration maps generated in `dist/`.

---

## 14. Acceptance Milestones

- **P0:** Policy compilation, canonical URL/query mapping, and live header validation.
- **P1:** Safe clean requests, path-locked atomic publishing, revision floor enforcement, and crash-resilient write-ahead logging.
- **P2:** Nginx snippet compilation, zero-overhead gzip serving, and single-reload cutover.
- **P3:** Next.js Metadata API integration and post-commit CMS publication workflows.
- **P4:** Journal cursor maintenance and bounded garbage collection.
- **P5:** Safe pre-warming against invalidation logs prior to cutover.

---

## 15. Benchmarks & Operational Goals

- Nginx HIT: 0 upstream Node requests.
- Concurrency: Zero race conditions between parallel warming and invalidation.
- Zero Downtime: Staged generations verified clean before traffic cutover.
- Safety: No stale HTML served when database transactions roll back or advance.

---

## 16. Post-v0.1 Roadmap

- Single-pass body capture on initial MISS.
- Dynamic allowlist for non-altering tracking parameters (`utm_*`).
- Tag indexing and native CDN cache invalidation integrations.
- Shared-disk clustering across multiple Node instances.

---

## 17. References

- Next.js CDN caching & Vary: https://nextjs.org/docs/app/guides/cdn-caching
- Next.js deploymentId: https://nextjs.org/docs/app/api-reference/config/next-config-js/generateBuildId
- Next.js instrumentation: https://nextjs.org/docs/app/guides/instrumentation
- Payload Transactions: https://payloadcms.com/docs/database/transactions
- Nginx Core Module: https://nginx.org/en/docs/http/ngx_http_core_module.html
