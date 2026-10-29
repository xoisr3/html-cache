import { evaluate } from '../policy/evaluator.ts';
import { currentGeneration, quarantineIfBare, readEntry } from '../storage/store.ts';
import type { CompiledPolicy, StatusResult } from '../types.ts';
import { splitWarmTarget } from '../core/target.ts';

export async function status(policy: CompiledPolicy, urlPath: string): Promise<StatusResult> {
  const parsed = splitWarmTarget(urlPath);
  if (!parsed) return { state: 'error', reason: 'path' };
  const decision = evaluate(policy, { method: 'GET', rawPath: parsed.rawPath, rawQuery: parsed.rawQuery });
  if (decision.action !== 'eligible') {
    return { state: 'excluded', reason: decision.action === 'bypass' ? decision.reason : decision.action };
  }
  const root = policy.config.storage.directory;
  const generation = await currentGeneration(policy.config);
  if (await quarantineIfBare(root, generation.dir, decision.file)) {
    return { state: 'miss', file: decision.file };
  }
  const entry = await readEntry(generation.dir, decision.file);
  if (!entry.index || !entry.meta) return { state: 'miss', file: decision.file };
  if (entry.meta.releaseId !== policy.config.storage.releaseId) {
    return { state: 'error', file: decision.file, reason: 'release' };
  }
  const result = {
    file: decision.file,
    revision: entry.meta.revision,
    commitVersion: entry.meta.commitVersion,
    expiresAt: entry.meta.expiresAt,
  };
  if (entry.meta.expiresAt <= Math.floor(Date.now() / 1000)) {
    return { state: 'expired', ...result };
  }
  return { state: 'hit', ...result };
}
