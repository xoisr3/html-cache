import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CacheError } from '../errors.ts';
import { assertWritableRuntime } from '../core/runtime.ts';
import type { MaintenanceBudget, MaintenanceResult } from '../types.ts';
import { appendDurable, exists, readJson, writeDurable } from './fsutil.ts';
import { entryDir, expiryDir, gcLock, gcStateFile, generationFile, homepageFile, homepageGzip, liveDir, pathLock, trashDir, variantLock } from './layout.ts';
import { withLease } from './lock.ts';
import { readEntry } from './store.ts';

type JournalLine = {
  token: string;
  file: string;
  path: string;
  expiresAt: number;
};

type GcState = {
  journal?: { generation: string; hour: string; offset: number };
  tree?: { generation: string; cursor: string };
  trash?: { cursor: string };
};

const EMPTY: MaintenanceResult = { ok: true, removed: 0, examined: 0, done: true, skipped: false };

export async function appendJournal(
  root: string,
  releaseId: string,
  generation: string,
  line: JournalLine,
): Promise<void> {
  const hour = journalHour(Math.floor(Date.now() / 1000));
  const file = path.join(expiryDir(root, releaseId, generation), `${hour}.log`);
  await appendDurable(file, JSON.stringify(line));
}

export async function dropGenerationJournal(root: string, releaseId: string, generation: string): Promise<void> {
  await rm(expiryDir(root, releaseId, generation), { recursive: true, force: true });
  const state = await readState(root, releaseId);
  if (state.journal?.generation === generation) delete state.journal;
  if (state.tree?.generation === generation) delete state.tree;
  await writeState(root, releaseId, state);
}

export async function clearExpired(
  storage: { directory: string; releaseId: string },
  budget: MaintenanceBudget,
): Promise<MaintenanceResult> {
  assertWritableRuntime();
  return withGc(storage.directory, () => clearExpiredUnlocked(storage, budget));
}

export async function cleanupOrphans(
  storage: { directory: string; releaseId: string },
  budget: MaintenanceBudget,
): Promise<MaintenanceResult> {
  assertWritableRuntime();
  return withGc(storage.directory, () => cleanupUnlocked(storage, budget));
}

export async function runMaintenance(
  storage: { directory: string; releaseId: string },
  budget: MaintenanceBudget,
): Promise<MaintenanceResult> {
  assertWritableRuntime();
  return withGc(storage.directory, async () => {
    const started = Date.now();
    const expired = await clearExpiredUnlocked(storage, budget);
    const orphans = await cleanupUnlocked(storage, {
      maxItems: Math.max(0, budget.maxItems - expired.examined),
      maxDurationMs: Math.max(0, budget.maxDurationMs - (Date.now() - started)),
    });
    return {
      ok: true,
      removed: expired.removed + orphans.removed,
      examined: expired.examined + orphans.examined,
      done: expired.done && orphans.done,
      skipped: false,
    };
  });
}

async function clearExpiredUnlocked(
  storage: { directory: string; releaseId: string },
  budget: MaintenanceBudget,
): Promise<MaintenanceResult> {
  assertBudget(budget);
  const generation = await generationOf(storage.directory, storage.releaseId);
  if (!generation) return { ...EMPTY };
  const started = Date.now();
  const deadline = started + budget.maxDurationMs;
  const state = await readState(storage.directory, storage.releaseId);
  const cursor =
    state.journal?.generation === generation.name ? state.journal : { generation: generation.name, hour: '', offset: 0 };
  const hours = await hourFiles(storage.directory, storage.releaseId, generation.name);
  const foundHour = hours.findIndex((hour) => hour >= cursor.hour);
  let hourIndex = foundHour === -1 ? hours.length : foundHour;
  let offset = cursor.hour === hours[hourIndex] ? cursor.offset : 0;
  let examined = 0;
  let removed = 0;
  let done = true;

  while (hourIndex < hours.length && examined < budget.maxItems && Date.now() < deadline) {
    const hour = hours[hourIndex]!;
    const file = path.join(expiryDir(storage.directory, storage.releaseId, generation.name), hour);
    const read = await readCompleteLines(file, offset);
    if (read.lines.length === 0) {
      if (read.partial && hour === journalHour(Math.floor(Date.now() / 1000))) {
        done = false;
        break;
      }
      hourIndex += 1;
      offset = 0;
      continue;
    }
    let advanced = offset;
    let hold = false;
    for (const line of read.lines) {
      if (examined >= budget.maxItems || Date.now() >= deadline) {
        done = false;
        hold = true;
        break;
      }
      const action = await applyLine(storage, generation, line.text);
      if (action === 'hold') {
        done = true;
        hold = true;
        break;
      }
      examined += 1;
      if (action === 'removed') removed += 1;
      advanced += line.bytes;
      if (examined % 100 === 0) {
        await writeState(storage.directory, storage.releaseId, {
          ...state,
          journal: { generation: generation.name, hour, offset: advanced },
        });
      }
    }
    offset = advanced;
    await writeState(storage.directory, storage.releaseId, {
      ...state,
      journal: { generation: generation.name, hour, offset },
    });
    if (hold) break;
    if (read.partial && hour === journalHour(Math.floor(Date.now() / 1000))) {
      done = false;
      break;
    }
    hourIndex += 1;
    offset = 0;
  }
  if (hours.length > 0 && examined === 0 && Date.now() >= deadline) done = false;
  if (hourIndex < hours.length && (examined >= budget.maxItems || Date.now() >= deadline)) done = false;
  return { ok: true, removed, examined, done, skipped: false };
}

async function cleanupUnlocked(
  storage: { directory: string; releaseId: string },
  budget: MaintenanceBudget,
): Promise<MaintenanceResult> {
  assertBudget(budget);
  const started = Date.now();
  const deadline = started + budget.maxDurationMs;
  let examined = 0;
  let removed = 0;
  const trash = await cleanTrash(storage.directory, budget, started, deadline);
  examined += trash.examined;
  removed += trash.removed;
  if (examined >= budget.maxItems || Date.now() >= deadline) {
    return { ok: true, removed, examined, done: false, skipped: false };
  }
  const tree = await cleanTree(storage, {
    maxItems: budget.maxItems - examined,
    maxDurationMs: Math.max(0, deadline - Date.now()),
  });
  return {
    ok: true,
    removed: removed + tree.removed,
    examined: examined + tree.examined,
    done: trash.done && tree.done,
    skipped: false,
  };
}

async function applyLine(
  storage: { directory: string; releaseId: string },
  generation: { name: string; dir: string },
  text: string,
): Promise<'removed' | 'skip' | 'hold'> {
  if (text.trim() === '') return 'skip';
  let line: JournalLine;
  try {
    line = JSON.parse(text) as JournalLine;
  } catch {
    return 'skip';
  }
  if (!line.token || !line.file || !line.path) return 'skip';
  const current = await generationOf(storage.directory, storage.releaseId);
  if (!current || current.name !== generation.name) return 'skip';
  return withLease(storage.directory, [pathLock(storage.directory, line.path), variantLock(storage.directory, line.file)], async () => {
    const entry = await readEntry(generation.dir, line.file);
    if (!entry.meta || entry.meta.token !== line.token) return 'skip';
    if (entry.meta.expiresAt > Math.floor(Date.now() / 1000)) return 'hold';
    await deleteLive(generation.dir, line.file);
    return 'removed';
  });
}

async function cleanTrash(
  root: string,
  budget: MaintenanceBudget,
  started: number,
  deadline: number,
): Promise<MaintenanceResult> {
  const names = (await readdir(trashDir(root)).catch(() => [] as string[])).sort();
  let examined = 0;
  let removed = 0;
  let done = true;
  for (const name of names) {
    if (examined >= budget.maxItems || Date.now() >= deadline || Date.now() - started >= budget.maxDurationMs) {
      done = false;
      break;
    }
    await rm(path.join(trashDir(root), name), { recursive: true, force: true });
    examined += 1;
    removed += 1;
  }
  return { ok: true, removed, examined, done, skipped: false };
}

async function cleanTree(
  storage: { directory: string; releaseId: string },
  budget: MaintenanceBudget,
): Promise<MaintenanceResult> {
  const generation = await generationOf(storage.directory, storage.releaseId);
  if (!generation) return { ...EMPTY };
  const state = await readState(storage.directory, storage.releaseId);
  const cursor = state.tree?.generation === generation.name ? (state.tree.cursor ?? '') : '';
  const deadline = Date.now() + budget.maxDurationMs;
  const found = await nextEntries(generation.dir, cursor, budget.maxItems, deadline);
  let removed = 0;
  for (const relative of found.paths) {
    const file = relative === homepageFile ? relative : `${relative}/index.html`;
    const urlPath = relative === homepageFile ? '/' : `/${relative}`;
    const deleted = await withLease(storage.directory, [pathLock(storage.directory, urlPath), variantLock(storage.directory, file)], async () => {
      const entry = await readEntry(generation.dir, file);
      const expired = entry.meta !== null && entry.meta.expiresAt <= Math.floor(Date.now() / 1000);
      const bare = entry.index && !entry.meta;
      const foreign = entry.meta !== null && entry.meta.releaseId !== storage.releaseId;
      if (!expired && !bare && !foreign) return false;
      await deleteLive(generation.dir, file);
      return true;
    });
    if (deleted) removed += 1;
  }
  await writeState(storage.directory, storage.releaseId, {
    ...state,
    tree: { generation: generation.name, cursor: found.cursor },
  });
  return { ok: true, removed, examined: found.paths.length, done: found.done, skipped: false };
}

async function nextEntries(
  generationDir: string,
  cursor: string,
  limit: number,
  deadline: number,
): Promise<{ paths: string[]; done: boolean; cursor: string }> {
  const paths: string[] = [];
  let done = true;
  let last = cursor;
  const walk = async (relative: string): Promise<void> => {
    if (paths.length >= limit || Date.now() >= deadline) {
      done = false;
      return;
    }
    const absolute = path.join(generationDir, ...relative.split('/').filter((part) => part.length > 0));
    const names = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    const dirs = names
      .filter((item) => item.isDirectory())
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let homePlaced = relative !== '';
    for (const entry of dirs) {
      if (!homePlaced && homepageFile < entry.name) {
        homePlaced = true;
        if (!(await noteHomepage(absolute))) return;
      }
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (cursor && child < cursor && !cursor.startsWith(`${child}/`)) continue;
      if ((await exists(path.join(generationDir, ...child.split('/'), 'index.html'))) && child > cursor) {
        paths.push(child);
        last = child;
        if (paths.length >= limit || Date.now() >= deadline) {
          done = false;
          return;
        }
      }
      await walk(child);
      if (!done) return;
    }
    if (!homePlaced) await noteHomepage(absolute);
  };
  const noteHomepage = async (absolute: string): Promise<boolean> => {
    if (!(await exists(path.join(absolute, 'index.html'))) || homepageFile <= cursor) return true;
    paths.push(homepageFile);
    last = homepageFile;
    if (paths.length >= limit || Date.now() >= deadline) {
      done = false;
      return false;
    }
    return true;
  };
  await walk('');
  return { paths, done, cursor: last };
}

async function deleteLive(generationDir: string, file: string): Promise<void> {
  if (file === homepageFile) {
    await rm(path.join(generationDir, homepageFile), { force: true });
    await rm(path.join(generationDir, homepageGzip), { force: true });
    await rm(path.join(generationDir, 'meta.json'), { force: true });
    return;
  }
  const relative = entryDir(file);
  if (!relative) return;
  await rm(path.join(generationDir, ...relative.split('/')), { recursive: true, force: true });
}

async function readCompleteLines(
  file: string,
  offset: number,
): Promise<{ lines: { text: string; bytes: number }[]; partial: boolean }> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return { lines: [], partial: false };
  }
  try {
    const info = await handle.stat();
    if (offset >= info.size) return { lines: [], partial: false };
    const buffer = Buffer.alloc(info.size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    const text = buffer.toString('utf8');
    const partial = !text.endsWith('\n');
    const parts = text.split('\n');
    if (partial) parts.pop();
    return {
      partial,
      lines: parts.map((line) => ({ text: line, bytes: Buffer.byteLength(`${line}\n`) })),
    };
  } finally {
    await handle.close();
  }
}

async function hourFiles(root: string, releaseId: string, generation: string): Promise<string[]> {
  const names = await readdir(expiryDir(root, releaseId, generation)).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.log')).sort();
}

async function generationOf(root: string, releaseId: string): Promise<{ name: string; dir: string } | null> {
  try {
    const name = (await readFile(generationFile(root, releaseId), 'utf8')).trim();
    if (!/^gen-\d+$/.test(name)) return null;
    return { name, dir: liveDir(root, releaseId) };
  } catch {
    return null;
  }
}

async function withGc<T extends MaintenanceResult>(root: string, fn: () => Promise<T>): Promise<T> {
  const dir = gcLock(root);
  await mkdir(path.dirname(dir), { recursive: true });
  try {
    const info = await stat(dir);
    if (Date.now() - info.mtimeMs > 60_000) await rm(dir, { recursive: true, force: true });
  } catch {
    // lock does not exist yet
  }
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ...EMPTY, skipped: true, done: false } as T;
    }
    throw error;
  }
  try {
    return await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assertBudget(budget: MaintenanceBudget): void {
  if (!Number.isSafeInteger(budget.maxItems) || budget.maxItems < 0) {
    throw new CacheError('POLICY_REJECTED', 'maxItems must be a non-negative integer');
  }
  if (!Number.isSafeInteger(budget.maxDurationMs) || budget.maxDurationMs < 0) {
    throw new CacheError('POLICY_REJECTED', 'maxDurationMs must be a non-negative integer');
  }
}

async function readState(root: string, releaseId: string): Promise<GcState> {
  return (await readJson<GcState>(gcStateFile(root, releaseId))) ?? {};
}

async function writeState(root: string, releaseId: string, state: GcState): Promise<void> {
  await writeDurable(gcStateFile(root, releaseId), JSON.stringify(state));
}

function journalHour(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 13).replace('T', '-');
}
