#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runMaintenance } from '../storage/journal.ts';
import { manifestFile } from '../storage/layout.ts';

type CliArgs = {
  directory: string;
  release: string;
  maxItems: number;
  maxDurationMs: number;
};

export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const manifestPath = manifestFile(args.directory, args.release);
  let manifest: { releaseId?: string };
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { releaseId?: string };
  } catch {
    process.stderr.write(`unable to read manifest for release ${args.release}\n`);
    return 1;
  }
  if (manifest.releaseId !== args.release) {
    process.stderr.write('manifest does not belong to specified release\n');
    return 1;
  }
  const result = await runMaintenance(
    { directory: args.directory, releaseId: args.release },
    { maxItems: args.maxItems, maxDurationMs: args.maxDurationMs },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) continue;
    values.set(key.slice(2), argv[index + 1] ?? '');
    index += 1;
  }
  const directory = values.get('directory') ?? '';
  const release = values.get('release') ?? '';
  if (!directory || !release) {
    throw new Error('missing --directory or --release');
  }
  return {
    directory,
    release,
    maxItems: Number(values.get('max-items') ?? 1000),
    maxDurationMs: Number(values.get('max-duration-ms') ?? 2000),
  };
}

const entry = process.argv[1]?.replaceAll('\\', '/') ?? '';
if (entry.endsWith('/cron/cli.ts') || entry.endsWith('/cron/cli.js')) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'gc failed'}\n`);
      process.exit(1);
    });
}
