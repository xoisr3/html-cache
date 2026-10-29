import { mkdir, open, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

export async function writeDurable(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendDurable(file: string, line: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'a');
  try {
    await handle.write(line.endsWith('\n') ? line : `${line}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
