import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CacheError } from '../errors.ts';
import { splitWarmTarget } from '../core/target.ts';
import { evaluate } from '../policy/evaluator.ts';
import { readJson } from '../storage/fsutil.ts';
import { logFile, manifestFile } from '../storage/layout.ts';
import { currentGeneration, listIntents, readEntry } from '../storage/store.ts';
import type { CompiledPolicy } from '../types.ts';

type AllLine = { scope: 'all'; fence: number };
type KeyLine = { fence: number; pathFence: number; key: string };
type LogLine = AllLine | KeyLine;

export async function assertStagedClean(policy: CompiledPolicy): Promise<void> {
  const root = policy.config.storage.directory;
  const releaseId = policy.config.storage.releaseId;
  if ((await listIntents(root)).some((intent) => intent.status === 'open')) {
    throw new CacheError('POLICY_REJECTED', 'open purge intent still pending');
  }
  const generation = await currentGeneration(policy.config);
  const files = await listIndexes(generation.dir);
  const lines = await readLog(root);
  const birth = await birthFence(root, releaseId, generation.name);
  if (files.length > 0 && lines.some((line) => 'scope' in line && line.fence > birth)) {
    throw new CacheError('POLICY_REJECTED', 'staged generation is dirty after purgeAll');
  }
  for (const file of files) {
    const entry = await readEntry(generation.dir, file);
    if (!entry.meta) throw new CacheError('POLICY_REJECTED', `staged HTML is missing meta: ${file}`);
    if (entry.meta.releaseId !== releaseId) {
      throw new CacheError('POLICY_REJECTED', `meta.releaseId does not match staged release: ${file}`);
    }
    for (const line of lines) {
      if ('scope' in line) continue;
      const match = applies(policy, line, file);
      if (match === 'none') continue;
      const staleFence = match === 'exact' && line.fence > entry.meta.fence;
      const stalePath = line.pathFence > entry.meta.pathFence;
      if (staleFence || stalePath) throw new CacheError('POLICY_REJECTED', `staged file is dirty: ${line.key}`);
    }
  }
}

function applies(policy: CompiledPolicy, line: KeyLine, file: string): 'exact' | 'variant' | 'none' {
  const staged = resolveFile(policy, line.key);
  if (!staged) return 'none';
  if (staged === file) return 'exact';
  if (line.key.includes('?')) return 'none';
  const directory = staged === 'index.html' ? '' : staged.slice(0, -'index.html'.length);
  if (!file.startsWith(directory)) return 'none';
  const rest = file.slice(directory.length);
  return rest.startsWith('@') && rest.endsWith('/index.html') ? 'variant' : 'none';
}

function resolveFile(policy: CompiledPolicy, key: string): string | null {
  const parsed = splitWarmTarget(key);
  if (!parsed) return null;
  const decision = evaluate(policy, { method: 'GET', rawPath: parsed.rawPath, rawQuery: parsed.rawQuery });
  return decision.action === 'eligible' ? decision.file : null;
}

async function birthFence(root: string, releaseId: string, generation: string): Promise<number> {
  const manifest = await readJson<{ generation?: string; fence?: number }>(manifestFile(root, releaseId));
  if (manifest?.generation === generation && typeof manifest.fence === 'number') return manifest.fence;
  return 0;
}

async function readLog(root: string): Promise<LogLine[]> {
  let text: string;
  try {
    text = await readFile(logFile(root), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const lines: LogLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const line = logLine(parsed);
    if (!line) throw new CacheError('POLICY_REJECTED', 'invalidations.log contains unreadable line');
    lines.push(line);
  }
  return lines;
}

function logLine(value: unknown): LogLine | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.scope === 'all') return typeof row.fence === 'number' ? { scope: 'all', fence: row.fence } : null;
  if (typeof row.fence !== 'number' || typeof row.pathFence !== 'number' || typeof row.key !== 'string') return null;
  return { fence: row.fence, pathFence: row.pathFence, key: row.key };
}

async function listIndexes(directory: string): Promise<string[]> {
  const found: string[] = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.name === 'index.html') {
        found.push(path.relative(directory, absolute).split(path.sep).join('/'));
      }
    }
  }
  return found;
}
