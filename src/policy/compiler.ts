import { builtinExcludes, resolveConfig } from '../core/config.ts';
import { compileQueryRules } from './query.ts';
import type { CacheConfigInput, CompiledPolicy } from '../types.ts';

export function compilePolicy(input: CacheConfigInput): CompiledPolicy {
  const config = resolveConfig(input);
  return {
    config,
    queryRules: compileQueryRules(config.policy.query.allow),
    builtinExcludes: builtinExcludes(config.origin.basePath),
  };
}
