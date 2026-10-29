import { purge } from './purge.ts';
import { warm } from './warm.ts';
import type { CompiledPolicy, PublishInput, PurgeResult, WarmResult } from '../types.ts';

export async function publishDocument(
  policy: CompiledPolicy,
  input: PublishInput,
): Promise<{ purged: PurgeResult; warmed: WarmResult }> {
  const purged = await purge(policy, input.url, {
    minRevision: input.minRevision,
    commitVersion: input.commitVersion,
  });
  if (input.revalidate) await input.revalidate();
  const warmed = await warm(policy, input.url, {
    expectedRevision: input.minRevision,
    commitVersion: input.commitVersion,
  });
  return { purged, warmed };
}
