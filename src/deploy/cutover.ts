import { rename } from 'node:fs/promises';
import { CacheError } from '../errors.ts';
import { assertWritableRuntime } from '../core/runtime.ts';
import { generateNginxConfig } from '../nginx/config-generator.ts';
import { writeDurable } from '../storage/fsutil.ts';
import { globalLock, servingFile } from '../storage/layout.ts';
import { assertLease, withLease } from '../storage/lock.ts';
import { currentGeneration, readServing } from '../storage/store.ts';
import type { CompiledPolicy } from '../types.ts';
import { assertStagedClean } from './preflight.ts';

export type CutoverResult = {
  releaseId: string;
  generation: string;
  configPath: string;
};

export async function writeCutoverConfig(policy: CompiledPolicy, configPath: string): Promise<CutoverResult> {
  assertWritableRuntime();
  const root = policy.config.storage.directory;
  const releaseId = policy.config.storage.releaseId;
  return withLease(root, [globalLock(root)], async (lease) => {
    await assertLease(lease);
    const generation = await currentGeneration(policy.config);
    await assertStagedClean(policy);
    const snippet = generateNginxConfig(policy);
    assertBound(snippet, policy);
    const temporary = `${configPath}.${process.pid}.tmp`;
    await writeDurable(temporary, snippet);
    await assertLease(lease);
    await rename(temporary, configPath);
    return { releaseId, generation: generation.name, configPath };
  });
}

export async function activateServing(policy: CompiledPolicy, configPath: string): Promise<void> {
  assertWritableRuntime();
  const root = policy.config.storage.directory;
  const releaseId = policy.config.storage.releaseId;
  return withLease(root, [globalLock(root)], async (lease) => {
    await assertLease(lease);
    const { readFile } = await import('node:fs/promises');
    const config = await readFile(configPath, 'utf8').catch(() => {
      throw new CacheError('FILESYSTEM', 'unable to read cutover configuration file');
    });
    assertBound(config, policy);
    await writeDurable(servingFile(root), releaseId);
    await assertLease(lease);
  });
}

export async function servingRelease(policy: CompiledPolicy): Promise<string | null> {
  return readServing(policy.config.storage.directory);
}

function assertBound(config: string, policy: CompiledPolicy): void {
  const origin = new URL(policy.config.origin.internalUrl);
  const root = `/${policy.config.storage.releaseId}";`;
  if (!config.includes(`proxy_pass ${origin.protocol}//${origin.host};`)) {
    throw new CacheError('POLICY_REJECTED', 'config does not proxy to the correct release origin');
  }
  if (!config.includes(root)) {
    throw new CacheError('POLICY_REJECTED', 'config does not point to the cache root of the current release');
  }
}

