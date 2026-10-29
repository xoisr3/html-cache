import { CacheError } from '../errors.ts';
import type { CompiledPolicy } from '../types.ts';
import { runMaintenance } from '../storage/journal.ts';

let started = false;
let stopped = false;
let stopTask: (() => void) | null = null;

export function startCron(policy: CompiledPolicy): void {
  assertNodeRuntime();
  if (!policy.config.cron.enabled || started) return;
  started = true;
  stopped = false;
  const tick = (): void => {
    if (stopped) return;
    void runMaintenance(policy.config.storage, { maxItems: 5000, maxDurationMs: 2000 }).catch(() => undefined);
  };
  const arm = (stop: () => void): void => {
    if (stopped) {
      stop();
      return;
    }
    stopTask = stop;
  };
  void import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'node-cron')
    .then((loaded) => {
      const cron = loaded.default ?? loaded;
      const task = cron.schedule('* * * * *', tick);
      arm(() => task.stop());
    })
    .catch(() => {
      const timer = setInterval(tick, 60_000);
      timer.unref?.();
      arm(() => clearInterval(timer));
    });
}

export function stopCron(): void {
  stopped = true;
  started = false;
  stopTask?.();
  stopTask = null;
}

function assertNodeRuntime(): void {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') {
    throw new CacheError('POLICY_REJECTED', 'cron scheduler only runs when NEXT_RUNTIME is nodejs');
  }
  if (process.env.NODE_ENV === 'development') {
    throw new CacheError('POLICY_REJECTED', 'production cache cron scheduler cannot run under next dev');
  }
}
