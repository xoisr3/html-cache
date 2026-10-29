import { CacheError, toCacheError } from '../errors.ts';
import { evaluate } from '../policy/evaluator.ts';
import { globalLock, pathLock, token, variantLock } from '../storage/layout.ts';
import { assertLease, withLease } from '../storage/lock.ts';
import {
  appendLog,
  bumpGlobalFence,
  currentGeneration,
  nextGenerationName,
  readPathFence,
  readServing,
  readVariantFence,
  removeTarget,
  swapGeneration,
  writeIntent,
  writePathFence,
  writeVariantFence,
  type Intent,
} from '../storage/store.ts';
import type { BatchResult, CompiledPolicy, PurgeResult, RevisionOptions } from '../types.ts';
import { splitWarmTarget } from '../core/target.ts';
import { assertWritableRuntime } from '../core/runtime.ts';
import { decidePurge, effectiveVersion, type StoredVersion } from '../core/version.ts';

type Target = { key: string; path: string; file: string; scope: 'path' | 'variant' };

export async function purge(
  policy: CompiledPolicy,
  urlPath: string,
  options: RevisionOptions = {},
): Promise<PurgeResult> {
  assertWritableRuntime();
  const target = eligibleTarget(policy, urlPath);
  const root = policy.config.storage.directory;
  await currentGeneration(policy.config);
  return withLease(root, [globalLock(root), pathLock(root, target.path), variantLock(root, target.file)], async (lease) => {
    await assertLease(lease);
    const pathFence = await readPathFence(root, target.path);
    const variantFence = target.scope === 'variant' ? await readVariantFence(root, target.file) : null;
    const stored = effectiveVersion(pathFence, variantFence);
    const decision = decidePurge(stored, options);
    const nextPath = { ...pathFence };
    const nextVariant = variantFence ? { ...variantFence } : null;
    if (target.scope === 'path') {
      nextPath.fence += 1;
      nextPath.pathFence += 1;
      if (decision.kind === 'advance') {
        nextPath.commitVersion = options.commitVersion ?? null;
        nextPath.minRevision = options.minRevision ?? null;
      }
    } else if (nextVariant) {
      nextVariant.fence += 1;
      if (decision.kind === 'advance') {
        nextVariant.commitVersion = options.commitVersion ?? null;
        nextVariant.minRevision = options.minRevision ?? null;
      }
    }
    const floor = floorAfter(target.scope, stored, nextPath, nextVariant, decision.kind);
    const intent: Intent = {
      id: token(),
      status: 'open',
      scope: target.scope,
      key: target.key,
      path: target.path,
      file: target.file,
      fence: target.scope === 'path' ? nextPath.fence : (nextVariant?.fence ?? 0),
      pathFence: nextPath.pathFence,
      minRevision: floor.minRevision,
      commitVersion: floor.commitVersion,
      releaseId: policy.config.storage.releaseId,
      logged: false,
    };
    await writeIntent(root, intent);
    if (target.scope === 'path') await writePathFence(root, target.path, nextPath);
    else if (nextVariant) await writeVariantFence(root, target.file, nextVariant);
    const removed = await removeTarget(root, target, lease);
    await appendLog(root, intent);
    intent.logged = true;
    intent.status = 'complete';
    await writeIntent(root, intent);
    return {
      ok: true,
      removed,
      fence: target.scope === 'path' ? nextPath.pathFence : (nextVariant?.fence ?? intent.fence),
      minRevision: floor.minRevision,
      revisionGuarantee: decision.guarantee,
    };
  });
}

export async function purgeMany(policy: CompiledPolicy, urls: string[]): Promise<BatchResult<PurgeResult>> {
  const results: BatchResult<PurgeResult>['results'] = [];
  for (const url of urls) {
    try {
      results.push({ url, ok: true, value: await purge(policy, url) });
    } catch (error) {
      const cacheError = toCacheError(error);
      results.push({ url, ok: false, code: cacheError.code, message: cacheError.message });
    }
  }
  return { ok: results.every((item) => item.ok), results };
}

export async function discardGeneration(policy: CompiledPolicy): Promise<{ generation: string }> {
  assertWritableRuntime();
  const root = policy.config.storage.directory;
  await currentGeneration(policy.config);
  if ((await readServing(root)) === policy.config.storage.releaseId) {
    throw new CacheError('POLICY_REJECTED', 'serving release must use purgeAll');
  }
  return withLease(root, [globalLock(root)], async (lease) => {
    await assertLease(lease);
    if ((await readServing(root)) === policy.config.storage.releaseId) {
      throw new CacheError('POLICY_REJECTED', 'serving release must use purgeAll');
    }
    const generation = await nextGenerationName(policy.config);
    await swapGeneration(policy.config, generation);
    return { generation };
  });
}

export async function purgeAll(policy: CompiledPolicy): Promise<PurgeResult> {
  assertWritableRuntime();
  const root = policy.config.storage.directory;
  await currentGeneration(policy.config);
  const serving = await readServing(root);
  if (serving !== policy.config.storage.releaseId) {
    throw new CacheError('POLICY_REJECTED', 'purgeAll can only be called on the active serving release');
  }
  return withLease(root, [globalLock(root)], async (lease) => {
    await assertLease(lease);
    const generation = await nextGenerationName(policy.config);
    const fence = await bumpGlobalFence(root);
    const intent: Intent = {
      id: token(),
      status: 'open',
      scope: 'all',
      fence,
      pathFence: fence,
      minRevision: null,
      commitVersion: null,
      generation,
      releaseId: policy.config.storage.releaseId,
      logged: false,
    };
    await writeIntent(root, intent);
    await swapGeneration(policy.config, generation);
    await appendLog(root, intent);
    intent.logged = true;
    intent.status = 'complete';
    await writeIntent(root, intent);
    return { ok: true, removed: true, fence, minRevision: null, revisionGuarantee: 'none' };
  });
}

function floorAfter(
  scope: 'path' | 'variant',
  stored: StoredVersion,
  pathFence: StoredVersion,
  variantFence: StoredVersion | null,
  kind: 'advance' | 'idempotent' | 'unversioned',
): StoredVersion {
  if (scope === 'path') return pathFence;
  if (kind === 'advance' && variantFence) return variantFence;
  return stored;
}

function eligibleTarget(policy: CompiledPolicy, urlPath: string): Target {
  const parsed = splitWarmTarget(urlPath);
  if (!parsed) throw new CacheError('POLICY_REJECTED', 'non-canonical path');
  const decision = evaluate(policy, { method: 'GET', rawPath: parsed.rawPath, rawQuery: parsed.rawQuery });
  if (decision.action !== 'eligible') {
    throw new CacheError('POLICY_REJECTED', decision.action === 'bypass' ? decision.reason : decision.action);
  }
  return {
    key: urlPath,
    path: parsed.rawPath,
    file: decision.file,
    scope: parsed.rawQuery === '' ? 'path' : 'variant',
  };
}
