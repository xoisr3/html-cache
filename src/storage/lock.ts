import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CacheError } from '../errors.ts';
import { readJson, writeDurable } from './fsutil.ts';
import { epochFile, token as newToken } from './layout.ts';

const STALE_MS = 30_000;
const WAIT_MS = 5_000;

export type Lease = {
  root: string;
  epoch: number;
  locks: { dir: string; token: string }[];
};

const tails = new Map<string, Promise<void>>();

export async function withLease<T>(root: string, dirs: string[], fn: (lease: Lease) => Promise<T>): Promise<T> {
  const lease: Lease = { root, epoch: await readEpoch(root), locks: [] };
  const enter = async (index: number): Promise<T> => {
    if (index >= dirs.length) return fn(lease);
    const dir = dirs[index]!;
    return withLock(root, dir, async (token) => {
      lease.locks.push({ dir, token });
      try {
        return await enter(index + 1);
      } finally {
        lease.locks.pop();
      }
    });
  };
  return enter(0);
}

export async function assertLease(lease: Lease): Promise<void> {
  if ((await readEpoch(lease.root)) !== lease.epoch) {
    throw new CacheError('SUPERSEDED', 'epoch has changed');
  }
  for (const lock of lease.locks) {
    const owner = await readFile(path.join(lock.dir, 'owner'), 'utf8').catch(() => '');
    if (owner !== lock.token) throw new CacheError('SUPERSEDED', 'lock lost');
  }
}

export async function readEpoch(root: string): Promise<number> {
  const value = await readJson<number>(epochFile(root));
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
}

export async function bumpEpoch(root: string): Promise<number> {
  const next = (await readEpoch(root)) + 1;
  await writeDurable(epochFile(root), JSON.stringify(next));
  return next;
}

async function withLock<T>(root: string, dir: string, fn: (token: string) => Promise<T>): Promise<T> {
  const previous = tails.get(dir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn = previous.then(() => current);
  tails.set(dir, turn);
  const token = newToken();
  try {
    await previous;
    await mkdirExclusive(root, dir, token);
    return await fn(token);
  } finally {
    await unlock(dir, token).catch(() => undefined);
    release();
    if (tails.get(dir) === turn) tails.delete(dir);
  }
}

async function mkdirExclusive(root: string, dir: string, token: string): Promise<void> {
  const started = Date.now();
  await mkdir(path.dirname(dir), { recursive: true });
  while (true) {
    try {
      await mkdir(dir);
      await writeFile(path.join(dir, 'owner'), token);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await lockAge(dir) > STALE_MS) {
        await steal(root, dir);
        continue;
      }
      if (Date.now() - started > WAIT_MS) {
        throw new CacheError('FILESYSTEM', 'lock acquisition timed out');
      }
      await delay(20);
    }
  }
}

async function steal(root: string, dir: string): Promise<void> {
  const stale = `${dir}.stale-${newToken()}`;
  try {
    await rename(dir, stale);
  } catch {
    return;
  }
  await rm(stale, { recursive: true, force: true });
  await bumpEpoch(root);
}

async function unlock(dir: string, token: string): Promise<void> {
  const owner = await readFile(path.join(dir, 'owner'), 'utf8').catch(() => '');
  if (owner !== token) return;
  await rm(dir, { recursive: true, force: true });
}

async function lockAge(dir: string): Promise<number> {
  try {
    const info = await stat(dir);
    return Date.now() - info.mtimeMs;
  } catch {
    return 0;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
