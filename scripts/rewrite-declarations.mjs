import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../dist');
let files = 0;

await walk(root);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) continue;
    const text = await readFile(full, 'utf8');
    const next = text.replaceAll(/(\.[cm]?ts)(?=['"])/g, (match) => `${match.slice(0, -2)}js`);
    if (next === text) continue;
    await writeFile(full, next);
    files += 1;
  }
}

if (files === 0) {
  console.error('no .d.ts files required import extension rewriting');
  process.exit(1);
}
