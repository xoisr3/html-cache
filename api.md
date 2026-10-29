# API Reference: `@xoisr/html-cache`

Import from the installed package. For application setup and integration examples, see [README.md](README.md). For operational guide and deploy instructions, see [guide.md](guide.md).

```ts
import { CacheError, ConfigError, createCache, summarizeAccessLog } from '@xoisr/html-cache';
import type { CacheConfigInput, PublishInput, RevisionOptions } from '@xoisr/html-cache';
```

`createCache()` initializes an in-memory instance. Disk and process state mutate only when calling `init`, `warm`, `purge`, `publishDocument`, `writeCutoverConfig`, or `activateServing`.

## `createCache(input)`

```ts
const cache = createCache({
  origin: {
    internalUrl: 'http://127.0.0.1:3000',
    publicUrl: 'https://news.example.com',
  },
  storage: {
    directory: '/var/cache/hiden',
    releaseId: 'build-41',
  },
  policy: {
    include: ['/', '/news/**'],
    exclude: ['/admin/**'],
  },
});
```

Throws `ConfigError` if policy rules cannot be accurately represented in Nginx. The fields `origin.internalUrl`, `origin.publicUrl`, `storage.directory`, `storage.releaseId`, and `policy.include` are required. The rest have safe defaults: queries outside allowlist bypass cache, `cookies.harmless` is `[]`, document compression is `nginx`, and document `Cache-Control` is `private, no-store`.

## `cache.init()`

```ts
await cache.init();
```

Call once when the production process starts up. On first run, if `control/serving-release` does not yet exist, this release automatically becomes the active serving release.

## `cache.warm(url, options?)`

```ts
await cache.warm('/news/article-a', {
  expectedRevision: 'article-123:v42',
  commitVersion: 42,
});
```

Sends an internal GET request to `internalUrl` without cookies, validates origin response, and writes `index.html` (and `.gz` if enabled) when HTML matches the expected release and revision marker. Idempotent calls with identical revision and `commitVersion` while the file matches will skip re-fetching and rewriting.

`options` accepts `RevisionOptions`: `expectedRevision` and `commitVersion`. Note: `minRevision` belongs to `purge()`, not `warm()`.

## `cache.warmMany(urls)`

```ts
const batch = await cache.warmMany(['/', '/news/article-a']);
```

Warms URLs without revision assertions. Only valid when the URL does not have an existing revision floor. `batch.ok` is `true` when all URLs succeed. `batch.results` provides individual outcomes.

## `cache.purge(url, options?)`

```ts
await cache.purge('/news/article-a', {
  minRevision: 'article-123:v42',
  commitVersion: 42,
});
```

Removes files for the specified URL across all releases present on disk and advances the revision floor. Purging a directory path removes all nested child paths and query variants within it. Purging `/` only removes the homepage and its variants. Purging a specific query, such as `/news/a?page=1`, only removes that query variant.

Returns `{ ok, removed, fence, minRevision, revisionGuarantee }`.

## `cache.purgeMany(urls)`

```ts
await cache.purgeMany(['/news/old-slug', '/news/new-slug']);
```

Batch version of `purge()`. URLs already purged are not rolled back if a subsequent URL fails.

## `cache.purgeAll()`

```ts
await cache.purgeAll();
```

Applies to the active serving release. Renames the live HTML directory read by Nginx and creates an empty one instantly without requiring an Nginx reload. Subsequent requests result in MISS until re-warmed.

## `cache.discardGeneration()`

```ts
const { generation } = await cache.discardGeneration();
```

Used by staged (non-serving) releases when a staged generation was dirtied by a concurrent `purgeAll` from the serving release. Archives the dirty tree and creates a clean generation ready for pre-warming before `writeCutoverConfig()`. Throws `POLICY_REJECTED` if invoked by the serving release.

## `cache.publishDocument(input)`

```ts
await cache.publishDocument({
  url: '/news/article-a',
  minRevision: 'article-123:v42',
  commitVersion: 42,
  revalidate: async () => {
    revalidatePath('/news/article-a');
  },
});
```

Executes the atomic update sequence: purges the old cache, runs optional `revalidate` hook, and warms the new cache. Returns `{ purged, warmed }`.

## `cache.status(url)`

```ts
const page = await cache.status('/news/article-a');
```

Returns `page.state` as `hit`, `miss`, `expired`, `excluded`, or `error`. If expired on disk but cron has not cleaned it up yet, returns `expired`.

## `cache.writeCutoverConfig(configPath)`

```ts
await cache.writeCutoverConfig('/etc/nginx/snippets/hiden-html-cache.conf');
```

Atomically writes the Nginx configuration snippet included by the site server. Validates and refuses if the staged generation contains files older than an active purge or has open purge intents. Empty generations are allowed.

## `cache.activateServing(configPath)`

```ts
await cache.activateServing('/etc/nginx/snippets/hiden-html-cache.conf');
```

Call after `nginx -t` and reloading Nginx. Registers this release in `control/serving-release` so subsequent `purgeAll()` calls execute on it.

## `cache.generateNginxConfig(options?)`

```ts
const text = cache.generateNginxConfig();
```

Generates the Nginx snippet as a string for inspection. Does not check staged generation or write to disk.

## `cache.evaluate(request)`

```ts
const decision = cache.evaluate({
  method: 'GET',
  rawPath: '/news/article-a',
  rawQuery: '',
});
```

Returns `decision.action` as `eligible`, `redirect`, or `bypass`. Useful for inspecting whether a request is cacheable under current policy prior to warming.

## `cache.classifyWarmTarget(url)`

```ts
const target = cache.classifyWarmTarget('/news/article-a?page=1');
```

`target.ok` indicates whether the URL is warmable. `target.file` indicates the relative file path within the release cache directory.

## `cache.clearExpired(budget)` and `cache.cleanupOrphans(budget)`

```ts
await cache.clearExpired({ maxItems: 1000, maxDurationMs: 2000 });
await cache.cleanupOrphans({ maxItems: 1000, maxDurationMs: 2000 });
```

Performs bounded maintenance cleanup of expired entries and orphaned files. Stops cleanly when budget is exhausted and resumes on subsequent invocations.

## `cache.startCron()` and `cache.stopCron()`

```ts
cache.startCron();
cache.stopCron();
```

Starts the background maintenance scheduler when `cron.enabled` is `true`. Falls back to a 60-second `setInterval` if `node-cron` is not installed.

## `summarizeAccessLog(text)`

```ts
const summary = summarizeAccessLog(logText);
```

Parses Nginx access log lines containing `$html_cache_status`, `cookie=`, and `query_ok=`. Returns `{ total, hit, miss, bypass, bypassCookie, bypassQuery }`.

## Errors

```ts
try {
  await cache.warm('/news/article-a', {
    expectedRevision: 'article-123:v42',
    commitVersion: 42,
  });
} catch (error) {
  if (error instanceof ConfigError) throw error;
  if (error instanceof CacheError) {
    console.error(error.code, error.message);
  }
}
```

| `error.code` | Cause |
|---|---|
| `POLICY_REJECTED` | URL, query, runtime, or configuration disallowed by policy |
| `REVISION_REQUIRED` | Existing revision floor requires `expectedRevision` |
| `REVISION_MISMATCH` | Provided revision or HTML marker does not match stored revision floor |
| `STALE_EVENT` | `commitVersion` is older than existing revision floor |
| `VERSION_CONFLICT` | Same `commitVersion` with different revision string |
| `RELEASE_MISMATCH` | HTML release marker does not match `storage.releaseId` |
| `SUPERSEDED` | A newer purge occurred while warming was fetching |
| `INVALID_RESPONSE` | Origin returned non-cacheable status, headers, or body |
| `ORIGIN_TIMEOUT` | Origin request exceeded `warm.timeoutMs` |
| `FILESYSTEM` | Filesystem failure, lock timeout, or uninitialized cache |
| `COOLDOWN` | Target URL is in cooldown after an origin failure |
