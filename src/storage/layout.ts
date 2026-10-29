import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

export function token(): string {
  return randomBytes(4).toString('hex');
}

export function controlDir(root: string): string {
  return path.join(root, 'control');
}

export function epochFile(root: string): string {
  return path.join(controlDir(root), 'epoch');
}

export function intentDir(root: string): string {
  return path.join(controlDir(root), 'purge-intents');
}

export function intentFile(root: string, id: string): string {
  return path.join(intentDir(root), `${id}.json`);
}

export function logFile(root: string): string {
  return path.join(controlDir(root), 'invalidations.log');
}

export function tmpDir(root: string): string {
  return path.join(controlDir(root), 'tmp');
}

export function trashDir(root: string): string {
  return path.join(controlDir(root), 'trash');
}

export function lockDir(root: string, name: string): string {
  return path.join(controlDir(root), 'locks', name);
}

export function globalLock(root: string): string {
  return lockDir(root, 'global');
}

export function pathLock(root: string, urlPath: string): string {
  return lockDir(root, `path-${digest(urlPath)}`);
}

export function variantLock(root: string, file: string): string {
  return lockDir(root, `variant-${digest(file)}`);
}

export function flightLock(root: string, file: string): string {
  return lockDir(root, `flight-${digest(file)}`);
}

export function pathFenceFile(root: string, urlPath: string): string {
  return path.join(controlDir(root), 'fence', `path-${digest(urlPath)}.json`);
}

export function variantFenceFile(root: string, file: string): string {
  return path.join(controlDir(root), 'fence', `variant-${digest(file)}.json`);
}

export function globalFenceFile(root: string): string {
  return path.join(controlDir(root), 'fence-global.json');
}

export function cooldownFile(root: string, file: string): string {
  return path.join(controlDir(root), 'cooldowns', `${digest(file)}.json`);
}

export function liveDir(root: string, releaseId: string): string {
  return path.join(root, releaseId);
}

export function archiveDir(root: string, releaseId: string, generation: string): string {
  return path.join(root, `.${releaseId}.${generation}`);
}

export function generationFile(root: string, releaseId: string): string {
  return path.join(controlDir(root), `generation-${releaseId}`);
}

export function servingFile(root: string): string {
  return path.join(controlDir(root), 'serving-release');
}

export function manifestFile(root: string, releaseId: string): string {
  return path.join(controlDir(root), `manifest-${releaseId}.json`);
}

export function expiryDir(root: string, releaseId: string, generation: string): string {
  return path.join(controlDir(root), 'expiry', `${releaseId}--${generation}`);
}

export function gcStateFile(root: string, releaseId: string): string {
  return path.join(controlDir(root), `gc-${releaseId}.json`);
}

export function gcLock(root: string): string {
  return lockDir(root, 'gc');
}

export const homepageFile = 'index.html';
export const homepageGzip = 'index.html.gz';

export function entryDir(file: string): string | null {
  if (file === homepageFile) return null;
  return path.posix.dirname(file);
}
