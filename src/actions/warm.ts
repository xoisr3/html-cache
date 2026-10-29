import { rm } from 'node:fs/promises';
import { CacheError, toCacheError, type CacheErrorCode } from '../errors.ts';
import { evaluate } from '../policy/evaluator.ts';
import { cooldownFile, flightLock, globalLock, pathLock, token, variantLock } from '../storage/layout.ts';
import { withLease } from '../storage/lock.ts';
import {
  currentGeneration,
  intentConflicts,
  listIntents,
  publishEntry,
  readEntry,
  readPathFence,
  readVariantFence,
  writePathFence,
  writeVariantFence,
  type Meta,
} from '../storage/store.ts';
import { readJson, writeDurable } from '../storage/fsutil.ts';
import type { BatchResult, CompiledPolicy, RevisionOptions, WarmResult } from '../types.ts';
import { fetchDocument } from '../core/origin.ts';
import { assertWritableRuntime } from '../core/runtime.ts';
import { splitWarmTarget } from '../core/target.ts';
import { validateDocument } from '../core/validator.ts';
import { decideWarm, effectiveVersion } from '../core/version.ts';

const COOLDOWN_MS = 1000;
const COOLING = new Set<CacheErrorCode>(['INVALID_RESPONSE', 'ORIGIN_TIMEOUT', 'RELEASE_MISMATCH', 'FILESYSTEM']);

export async function warm(policy: CompiledPolicy, urlPath: string, options: RevisionOptions = {}): Promise<WarmResult> {
  assertWritableRuntime();
  const target = eligibleTarget(policy, urlPath);
  const root = policy.config.storage.directory;
  try {
    await assertCooldown(root, target.file);
    const result = await withLease(root, [flightLock(root, target.file)], async () => warmOnce(policy, target, options));
    await clearCooldown(root, target.file);
    return result;
  } catch (error) {
    const cacheError = toCacheError(error);
    if (COOLING.has(cacheError.code)) await markCooldown(root, target.file);
    throw cacheError;
  }
}

export async function warmMany(policy: CompiledPolicy, urls: string[]): Promise<BatchResult<WarmResult>> {
  const limit = Math.max(1, policy.config.warm.concurrency);
  const results = new Array<BatchResult<WarmResult>['results'][number]>(urls.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < urls.length) {
      const index = cursor;
      cursor += 1;
      const url = urls[index]!;
      try {
        results[index] = { url, ok: true, value: await warm(policy, url) };
      } catch (error) {
        const cacheError = toCacheError(error);
        results[index] = { url, ok: false, code: cacheError.code, message: cacheError.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, () => worker()));
  return { ok: results.every((item) => item.ok), results };
}

async function warmOnce(
  policy: CompiledPolicy,
  target: EligibleTarget,
  options: RevisionOptions,
): Promise<WarmResult> {
  const root = policy.config.storage.directory;
  const generation = await currentGeneration(policy.config);
  const pathFence = await readPathFence(root, target.path);
  const variantFence = target.scope === 'variant' ? await readVariantFence(root, target.file) : null;
  const snapshot = {
    generation: generation.name,
    pathFence: pathFence.pathFence,
    variantFence: variantFence?.fence ?? 0,
  };
  const decision = decideWarm(effectiveVersion(pathFence, variantFence), options);
  if (decision.kind === 'idempotent') {
    const kept = await withLease(
      root,
      [globalLock(root), pathLock(root, target.path), variantLock(root, target.file)],
      () => readPublished(policy, target, options, snapshot),
    );
    if (kept) return kept;
  }
  const response = await fetchDocument(policy.config, target.path, target.rawQuery);
  const validated = validateDocument({
    status: response.status,
    headers: response.headers,
    body: response.body,
    releaseId: policy.config.storage.releaseId,
    expectedRevision: options.expectedRevision ?? null,
    maxBytes: policy.config.warm.maxHtmlBytes,
  });

  return withLease(root, [globalLock(root), pathLock(root, target.path), variantLock(root, target.file)], async (lease) => {
    const freshGeneration = await currentGeneration(policy.config);
    const freshPath = await readPathFence(root, target.path);
    const freshVariant = target.scope === 'variant' ? await readVariantFence(root, target.file) : null;
    if (freshGeneration.name !== snapshot.generation || freshPath.pathFence !== snapshot.pathFence) {
      throw new CacheError('SUPERSEDED', 'pathFence changed during fetch');
    }
    if (target.scope === 'variant' && freshVariant!.fence !== snapshot.variantFence) {
      throw new CacheError('SUPERSEDED', 'variant fence changed during fetch');
    }
    if ((await listIntents(root)).some((intent) => intentConflicts(intent, target))) {
      throw new CacheError('SUPERSEDED', 'open purge intent still pending');
    }
    const decision = decideWarm(effectiveVersion(freshPath, freshVariant), options);
    if (decision.kind === 'idempotent') {
      const kept = await readPublished(policy, target, options, {
        generation: freshGeneration.name,
        pathFence: freshPath.pathFence,
        variantFence: freshVariant?.fence ?? 0,
      });
      if (kept) return kept;
    }
    if (decision.kind === 'advance') {
      if (target.scope === 'variant') {
        freshVariant!.commitVersion = options.commitVersion ?? null;
        freshVariant!.minRevision = options.expectedRevision ?? null;
        await writeVariantFence(root, target.file, freshVariant!);
      } else {
        freshPath.commitVersion = options.commitVersion ?? null;
        freshPath.minRevision = options.expectedRevision ?? null;
        await writePathFence(root, target.path, freshPath);
      }
    }
    const createdAt = Math.floor(Date.now() / 1000);
    const meta: Meta = {
      token: token(),
      fence: target.scope === 'variant' ? freshVariant!.fence : freshPath.fence,
      pathFence: freshPath.pathFence,
      commitVersion: options.commitVersion ?? null,
      revision: validated.revision,
      releaseId: policy.config.storage.releaseId,
      createdAt,
      expiresAt: createdAt + policy.config.ttl.seconds,
    };
    await publishEntry({
      root,
      generationDir: freshGeneration.dir,
      file: target.file,
      html: response.body,
      meta,
      lease,
      gzip: policy.config.document.compression === 'nginx',
    });
    const { appendJournal } = await import('../storage/journal.ts');
    await appendJournal(root, policy.config.storage.releaseId, freshGeneration.name, {
      token: meta.token,
      file: target.file,
      path: target.path,
      expiresAt: meta.expiresAt,
    });
    return {
      ok: true,
      file: target.file,
      revision: validated.revision,
      commitVersion: meta.commitVersion,
      revisionGuarantee: decision.guarantee,
    };
  });
}

async function readPublished(
  policy: CompiledPolicy,
  target: EligibleTarget,
  options: RevisionOptions,
  snapshot: { generation: string; pathFence: number; variantFence: number },
): Promise<WarmResult | null> {
  const root = policy.config.storage.directory;
  const generation = await currentGeneration(policy.config);
  const pathFence = await readPathFence(root, target.path);
  const variantFence = target.scope === 'variant' ? await readVariantFence(root, target.file) : null;
  if (generation.name !== snapshot.generation || pathFence.pathFence !== snapshot.pathFence) return null;
  if (target.scope === 'variant' && variantFence!.fence !== snapshot.variantFence) return null;
  if ((await listIntents(root)).some((intent) => intentConflicts(intent, target))) return null;
  if (decideWarm(effectiveVersion(pathFence, variantFence), options).kind !== 'idempotent') return null;
  const entry = await readEntry(generation.dir, target.file);
  const meta = entry.meta;
  const fence = target.scope === 'variant' ? variantFence!.fence : pathFence.fence;
  if (!entry.index || !meta) return null;
  if (meta.releaseId !== policy.config.storage.releaseId) return null;
  if (meta.revision !== options.expectedRevision || meta.commitVersion !== (options.commitVersion ?? null)) return null;
  if (meta.pathFence !== pathFence.pathFence || meta.fence !== fence) return null;
  return {
    ok: true,
    file: target.file,
    revision: meta.revision,
    commitVersion: meta.commitVersion,
    revisionGuarantee: 'exact',
  };
}

type EligibleTarget = { path: string; rawQuery: string; file: string; scope: 'path' | 'variant' };

function eligibleTarget(policy: CompiledPolicy, urlPath: string): EligibleTarget {
  const parsed = splitWarmTarget(urlPath);
  if (!parsed) throw new CacheError('POLICY_REJECTED', 'non-canonical path');
  const decision = evaluate(policy, { method: 'GET', rawPath: parsed.rawPath, rawQuery: parsed.rawQuery });
  if (decision.action !== 'eligible') {
    throw new CacheError('POLICY_REJECTED', decision.action === 'bypass' ? decision.reason : decision.action);
  }
  return {
    path: parsed.rawPath,
    rawQuery: parsed.rawQuery,
    file: decision.file,
    scope: parsed.rawQuery === '' ? 'path' : 'variant',
  };
}

async function assertCooldown(root: string, file: string): Promise<void> {
  const row = await readJson<{ until: number }>(cooldownFile(root, file));
  if (row && row.until > Date.now()) throw new CacheError('COOLDOWN', 'warm request is in cooldown');
}

async function markCooldown(root: string, file: string): Promise<void> {
  await writeDurable(cooldownFile(root, file), JSON.stringify({ until: Date.now() + COOLDOWN_MS }));
}

async function clearCooldown(root: string, file: string): Promise<void> {
  await rm(cooldownFile(root, file), { force: true });
}
