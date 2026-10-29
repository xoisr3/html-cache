import { publishDocument } from './actions/publish.ts';
import { discardGeneration, purge, purgeAll, purgeMany } from './actions/purge.ts';
import { status } from './actions/status.ts';
import { warm, warmMany } from './actions/warm.ts';
import { startCron, stopCron } from './cron/scheduler.ts';
import { activateServing, writeCutoverConfig } from './deploy/cutover.ts';
import { splitWarmTarget } from './core/target.ts';
import { generateNginxConfig } from './nginx/config-generator.ts';
import { compilePolicy } from './policy/compiler.ts';
import { evaluate } from './policy/evaluator.ts';
import { cleanupOrphans, clearExpired } from './storage/journal.ts';
import { initStore } from './storage/store.ts';
import type {
  CacheConfigInput,
  MaintenanceBudget,
  PolicyDecision,
  PublishInput,
  RequestView,
  RevisionOptions,
} from './types.ts';

export function createCache(input: CacheConfigInput) {
  const policy = compilePolicy(input);
  return {
    config: policy.config,
    policy,
    evaluate(request: RequestView): PolicyDecision {
      return evaluate(policy, request);
    },
    classifyWarmTarget(urlPath: string):
      | { ok: true; file: string }
      | { ok: false; code: 'POLICY_REJECTED'; reason: string } {
      const parsed = splitWarmTarget(urlPath);
      if (!parsed) return { ok: false, code: 'POLICY_REJECTED', reason: 'path' };
      const decision = evaluate(policy, {
        method: 'GET',
        rawPath: parsed.rawPath,
        rawQuery: parsed.rawQuery,
      });
      if (decision.action === 'eligible') return { ok: true, file: decision.file };
      return {
        ok: false,
        code: 'POLICY_REJECTED',
        reason: decision.action === 'bypass' ? decision.reason : decision.action,
      };
    },
    generateNginxConfig(options?: { upstream?: string; releaseId?: string }): string {
      return generateNginxConfig(policy, options);
    },
    writeCutoverConfig(configPath: string) {
      return writeCutoverConfig(policy, configPath);
    },
    activateServing(configPath: string) {
      return activateServing(policy, configPath);
    },
    init(): Promise<void> {
      return initStore(policy.config);
    },
    warm(urlPath: string, options?: RevisionOptions) {
      return warm(policy, urlPath, options);
    },
    warmMany(urls: string[]) {
      return warmMany(policy, urls);
    },
    purge(urlPath: string, options?: RevisionOptions) {
      return purge(policy, urlPath, options);
    },
    purgeMany(urls: string[]) {
      return purgeMany(policy, urls);
    },
    purgeAll() {
      return purgeAll(policy);
    },
    discardGeneration() {
      return discardGeneration(policy);
    },
    status(urlPath: string) {
      return status(policy, urlPath);
    },
    publishDocument(input: PublishInput) {
      return publishDocument(policy, input);
    },
    clearExpired(budget: MaintenanceBudget) {
      return clearExpired(policy.config.storage, budget);
    },
    cleanupOrphans(budget: MaintenanceBudget) {
      return cleanupOrphans(policy.config.storage, budget);
    },
    startCron() {
      startCron(policy);
    },
    stopCron() {
      stopCron();
    },
  };
}

export { CacheError, ConfigError } from './errors.ts';
export { summarizeAccessLog } from './nginx/access-log.ts';
export { AUTH_COOKIE_DENYLIST } from './types.ts';
export type {
  BatchResult,
  CacheConfigInput,
  MaintenanceBudget,
  MaintenanceResult,
  PolicyDecision,
  PublishInput,
  PurgeResult,
  RequestView,
  ResolvedCacheConfig,
  StatusResult,
  WarmResult,
} from './types.ts';
