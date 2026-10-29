import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { CacheError } from '../errors.ts';
import { assertWritableRuntime, isWritableRuntime } from '../core/runtime.ts';
import type { ResolvedCacheConfig } from '../types.ts';
import { appendDurable, exists, readJson, writeDurable } from './fsutil.ts';
import { assertLease, bumpEpoch, type Lease } from './lock.ts';
import {
  archiveDir,
  entryDir,
  generationFile,
  globalFenceFile,
  homepageFile,
  homepageGzip,
  intentDir,
  intentFile,
  liveDir,
  logFile,
  manifestFile,
  servingFile,
  tmpDir,
  token,
  trashDir,
  pathFenceFile,
  variantFenceFile,
} from './layout.ts';

export type PathFence = {
  fence: number;
  pathFence: number;
  commitVersion: number | null;
  minRevision: string | null;
};

export type VariantFence = {
  fence: number;
  commitVersion: number | null;
  minRevision: string | null;
};

export type Intent = {
  id: string;
  status: 'open' | 'complete';
  scope: 'path' | 'variant' | 'all';
  key?: string;
  path?: string;
  file?: string;
  fence: number;
  pathFence: number;
  minRevision: string | null;
  commitVersion: number | null;
  generation?: string;
  releaseId?: string;
  logged?: boolean;
};

export type Meta = {
  token: string;
  fence: number;
  pathFence: number;
  commitVersion: number | null;
  revision: string | null;
  releaseId: string;
  createdAt: number;
  expiresAt: number;
};

const EMPTY_PATH: PathFence = { fence: 0, pathFence: 0, commitVersion: null, minRevision: null };
const EMPTY_VARIANT: VariantFence = { fence: 0, commitVersion: null, minRevision: null };

export async function initStore(config: ResolvedCacheConfig): Promise<void> {
  assertWritableRuntime();
  const root = config.storage.directory;
  await mkdir(liveDir(root, config.storage.releaseId), { recursive: true });
  await mkdir(intentDir(root), { recursive: true });
  await mkdir(trashDir(root), { recursive: true });
  await bumpEpoch(root);
  await ensureGeneration(config);
  await rm(tmpDir(root), { recursive: true, force: true });
  await mkdir(tmpDir(root), { recursive: true });
  if (!(await exists(servingFile(root)))) {
    await writeDurable(servingFile(root), config.storage.releaseId);
  }
  await recoverIntents(root);
  const generation = await currentGeneration(config);
  await repairBareEntries(root, generation.dir);
}

export async function currentGeneration(config: ResolvedCacheConfig): Promise<{ name: string; dir: string }> {
  const name = await readGeneration(config.storage.directory, config.storage.releaseId);
  if (!name) throw new CacheError('FILESYSTEM', 'cache has not been initialized');
  return { name, dir: liveDir(config.storage.directory, config.storage.releaseId) };
}

export async function readPathFence(root: string, urlPath: string): Promise<PathFence> {
  return { ...EMPTY_PATH, ...(await readJson<PathFence>(pathFenceFile(root, urlPath))) };
}

export async function writePathFence(root: string, urlPath: string, fence: PathFence): Promise<void> {
  await writeDurable(pathFenceFile(root, urlPath), JSON.stringify(fence));
}

export async function readVariantFence(root: string, file: string): Promise<VariantFence> {
  return { ...EMPTY_VARIANT, ...(await readJson<VariantFence>(variantFenceFile(root, file))) };
}

export async function writeVariantFence(root: string, file: string, fence: VariantFence): Promise<void> {
  await writeDurable(variantFenceFile(root, file), JSON.stringify(fence));
}

export async function readServing(root: string): Promise<string | null> {
  try {
    return (await readFile(servingFile(root), 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function listIntents(root: string): Promise<Intent[]> {
  let names: string[];
  try {
    names = await readdir(intentDir(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const intents: Intent[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const intent = await readJson<Intent>(path.join(intentDir(root), name));
    if (!intent) throw new CacheError('FILESYSTEM', `unable to read intent ${name}`);
    intents.push(intent);
  }
  return intents;
}

export function intentConflicts(intent: Intent, target: { path: string; file: string }): boolean {
  if (intent.status !== 'open') return false;
  if (intent.scope === 'all') return true;
  if (intent.scope === 'path') return intent.path === target.path;
  return intent.file === target.file;
}

export async function writeIntent(root: string, intent: Intent): Promise<void> {
  await writeDurable(intentFile(root, intent.id), JSON.stringify(intent));
}

export async function appendLog(root: string, intent: Intent): Promise<void> {
  const line =
    intent.scope === 'all'
      ? { intentId: intent.id, fence: intent.fence, scope: 'all' }
      : {
          intentId: intent.id,
          fence: intent.fence,
          pathFence: intent.pathFence,
          key: intent.key ?? intent.path,
          minRevision: intent.minRevision,
        };
  await appendDurable(logFile(root), JSON.stringify(line));
}

export async function bumpGlobalFence(root: string): Promise<number> {
  const current = (await readJson<{ fence: number }>(globalFenceFile(root)))?.fence ?? 0;
  const next = current + 1;
  await writeDurable(globalFenceFile(root), JSON.stringify({ fence: next }));
  return next;
}

export async function nextGenerationName(config: ResolvedCacheConfig): Promise<string> {
  const root = config.storage.directory;
  const releaseId = config.storage.releaseId;
  let max = generationNumber(await readGeneration(root, releaseId));
  const names = await readdir(root).catch(() => [] as string[]);
  const marker = `.${releaseId}.`;
  for (const name of names) {
    if (!name.startsWith(marker)) continue;
    max = Math.max(max, generationNumber(name.slice(marker.length)));
  }
  return `gen-${max + 1}`;
}

export async function swapGeneration(config: ResolvedCacheConfig, generation: string): Promise<void> {
  const previous = await replaceLiveDirectory(config.storage.directory, config.storage.releaseId, generation);
  await writeManifest(config, generation);
  if (previous && previous !== generation) {
    const { dropGenerationJournal } = await import('./journal.ts');
    await dropGenerationJournal(config.storage.directory, config.storage.releaseId, previous);
  }
}

export async function removeTarget(
  root: string,
  target: { path: string; file: string; scope: 'path' | 'variant' },
  lease?: Lease,
): Promise<boolean> {
  let removed = false;
  for (const generationDir of await generationDirs(root)) {
    if (await relocateEntry(root, generationDir, target.file, lease)) removed = true;
    if (target.scope === 'path' && target.path === '/') {
      if (await relocateHomepageQueries(root, generationDir, lease)) removed = true;
    }
  }
  return removed;
}

export async function publishEntry(input: {
  root: string;
  generationDir: string;
  file: string;
  html: Buffer;
  meta: Meta;
  lease: Lease;
  gzip: boolean;
}): Promise<void> {
  const staging = path.join(tmpDir(input.root), input.meta.token);
  await mkdir(staging, { recursive: true });
  await writeDurable(path.join(staging, 'meta.json'), JSON.stringify(input.meta));
  if (input.gzip) await writeDurable(path.join(staging, homepageGzip), gzipSync(input.html));
  await writeDurable(path.join(staging, 'index.html'), input.html);
  await assertLease(input.lease);
  if (input.file === homepageFile) {
    await relocateHomepage(input.root, input.generationDir, input.lease);
    await rename(path.join(staging, 'meta.json'), path.join(input.generationDir, 'meta.json'));
    if (input.gzip) await rename(path.join(staging, homepageGzip), path.join(input.generationDir, homepageGzip));
    await rename(path.join(staging, 'index.html'), path.join(input.generationDir, 'index.html'));
    await rm(staging, { recursive: true, force: true });
    return;
  }
  const live = path.join(input.generationDir, ...(entryDir(input.file) ?? '').split('/'));
  await mkdir(path.dirname(live), { recursive: true });
  if (await exists(live)) await relocate(input.root, live, input.lease);
  await assertLease(input.lease);
  await rename(staging, live);
}

export async function readEntry(generationDir: string, file: string): Promise<{ index: boolean; meta: Meta | null }> {
  const index = await exists(path.join(generationDir, ...file.split('/')));
  const meta = await readJson<Meta>(metaPath(generationDir, file));
  return { index, meta };
}

export async function quarantineIfBare(root: string, generationDir: string, file: string): Promise<boolean> {
  if (!isWritableRuntime()) return false;
  const entry = await readEntry(generationDir, file);
  if (!entry.index || entry.meta) return false;
  if (file === homepageFile) await relocateHomepage(root, generationDir);
  else await relocate(root, path.join(generationDir, ...(entryDir(file) ?? '').split('/')));
  return true;
}

async function repairBareEntries(root: string, generationDir: string): Promise<void> {
  await walkBare(root, generationDir, generationDir, '');
}

async function walkBare(root: string, generationDir: string, absolute: string, relative: string): Promise<void> {
  const names = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  const hasIndex = names.some((entry) => entry.isFile() && entry.name === 'index.html');
  const hasMeta = names.some((entry) => entry.isFile() && entry.name === 'meta.json');
  if (hasIndex && !hasMeta) {
    if (relative === '') await relocateHomepage(root, generationDir);
    else {
      await relocate(root, absolute);
      return;
    }
  }
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    await walkBare(root, generationDir, path.join(absolute, entry.name), child);
  }
}

async function ensureGeneration(config: ResolvedCacheConfig): Promise<void> {
  const root = config.storage.directory;
  const releaseId = config.storage.releaseId;
  await mkdir(liveDir(root, releaseId), { recursive: true });
  const current = await readGeneration(root, releaseId);
  const generation = current ?? 'gen-1';
  if (!current) await writeDurable(generationFile(root, releaseId), generation);
  await writeManifest(config, generation);
}

async function recoverIntents(root: string): Promise<void> {
  for (const intent of await listIntents(root)) {
    if (intent.status !== 'open') continue;
    if (intent.scope === 'all' && intent.generation && intent.releaseId) {
      if ((await readGeneration(root, intent.releaseId)) !== intent.generation) {
        await replaceLiveDirectory(root, intent.releaseId, intent.generation);
      }
    } else if (intent.path && intent.file && (intent.scope === 'path' || intent.scope === 'variant')) {
      await applyFence(root, intent);
      await removeTarget(root, { path: intent.path, file: intent.file, scope: intent.scope });
    }
    if (!intent.logged) {
      await appendLog(root, intent);
      intent.logged = true;
    }
    intent.status = 'complete';
    await writeIntent(root, intent);
  }
}

async function applyFence(root: string, intent: Intent): Promise<void> {
  if (intent.scope === 'variant' && intent.file) {
    const current = await readVariantFence(root, intent.file);
    if (current.fence < intent.fence) {
      await writeVariantFence(root, intent.file, {
        fence: intent.fence,
        commitVersion: intent.commitVersion,
        minRevision: intent.minRevision,
      });
    }
    return;
  }
  if (intent.scope === 'path' && intent.path && (await readPathFence(root, intent.path)).pathFence < intent.pathFence) {
    await writePathFence(root, intent.path, {
      fence: intent.fence,
      pathFence: intent.pathFence,
      commitVersion: intent.commitVersion,
      minRevision: intent.minRevision,
    });
  }
}

async function relocateEntry(root: string, generationDir: string, file: string, lease?: Lease): Promise<boolean> {
  if (file === homepageFile) return relocateHomepage(root, generationDir, lease);
  return relocateRelative(root, generationDir, entryDir(file) ?? file, lease);
}

async function relocateRelative(root: string, generationDir: string, relative: string, lease?: Lease): Promise<boolean> {
  const absolute = path.join(generationDir, ...relative.split('/'));
  if (!(await exists(absolute))) return false;
  await relocate(root, absolute, lease);
  return true;
}

async function relocateHomepage(root: string, generationDir: string, lease?: Lease): Promise<boolean> {
  let removed = false;
  for (const name of [homepageFile, homepageGzip, 'meta.json']) {
    const file = path.join(generationDir, name);
    if (!(await exists(file))) continue;
    await relocate(root, file, lease);
    removed = true;
  }
  return removed;
}

async function relocateHomepageQueries(root: string, generationDir: string, lease?: Lease): Promise<boolean> {
  const names = await readdir(generationDir, { withFileTypes: true }).catch(() => []);
  let removed = false;
  for (const entry of names) {
    if (!entry.isDirectory() || !entry.name.startsWith('@')) continue;
    await relocate(root, path.join(generationDir, entry.name), lease);
    removed = true;
  }
  return removed;
}

async function relocate(root: string, absolute: string, lease?: Lease): Promise<void> {
  if (lease) await assertLease(lease);
  await mkdir(trashDir(root), { recursive: true });
  await rename(absolute, path.join(trashDir(root), token()));
}

function metaPath(generationDir: string, file: string): string {
  if (file === homepageFile) return path.join(generationDir, 'meta.json');
  return path.join(generationDir, ...(entryDir(file) ?? '').split('/'), 'meta.json');
}

async function replaceLiveDirectory(root: string, releaseId: string, generation: string): Promise<string | null> {
  const live = liveDir(root, releaseId);
  const previous = await readGeneration(root, releaseId);
  const incoming = path.join(root, `.${releaseId}.incoming`);
  if (!(await exists(incoming))) await mkdir(incoming);
  if ((await exists(live)) && previous && previous !== generation) {
    const archive = archiveDir(root, releaseId, previous);
    if (await exists(archive)) throw new CacheError('FILESYSTEM', 'previous generation still exists on disk');
    await rename(live, archive);
  }
  if (!(await exists(live))) await rename(incoming, live);
  await rm(incoming, { recursive: true, force: true });
  await writeDurable(generationFile(root, releaseId), generation);
  return previous;
}

async function readGeneration(root: string, releaseId: string): Promise<string | null> {
  try {
    const name = (await readFile(generationFile(root, releaseId), 'utf8')).trim();
    return /^gen-\d+$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

function generationNumber(name: string | null): number {
  const match = /^gen-(\d+)$/.exec(name ?? '');
  return match ? Number(match[1]) : 0;
}

async function generationDirs(root: string): Promise<string[]> {
  const names = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs: string[] = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'control' || entry.name.startsWith('.')) {
      if (/^\..+\.gen-\d+$/.test(entry.name)) dirs.push(path.join(root, entry.name));
      continue;
    }
    dirs.push(path.join(root, entry.name));
  }
  return dirs;
}

async function writeManifest(config: ResolvedCacheConfig, generation: string): Promise<void> {
  const root = config.storage.directory;
  const file = manifestFile(root, config.storage.releaseId);
  const existing = await readJson<{ generation?: string; fence?: number }>(file);
  const sameGeneration = existing?.generation === generation;
  const globalFence = (await readJson<{ fence: number }>(globalFenceFile(root)))?.fence ?? 0;
  const fence = sameGeneration ? (typeof existing?.fence === 'number' ? existing.fence : 0) : globalFence;
  await writeDurable(
    file,
    JSON.stringify({
      releaseId: config.storage.releaseId,
      generation,
      internalUrl: config.origin.internalUrl,
      publicUrl: config.origin.publicUrl,
      createdAt: Math.floor(Date.now() / 1000),
      fence,
    }),
  );
}
