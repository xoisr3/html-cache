import { CacheError } from '../errors.ts';

export function isWritableRuntime(): boolean {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return false;
  if (process.env.NODE_ENV === 'development') return false;
  return true;
}

export function assertWritableRuntime(): void {
  if (!isWritableRuntime()) {
    throw new CacheError('POLICY_REJECTED', 'cache writes are disabled in next dev and non-nodejs runtimes');
  }
}
