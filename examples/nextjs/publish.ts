import type { PublishInput } from '../../src/types.ts';

type CacheLike = {
  publishDocument(input: PublishInput): Promise<unknown>;
};

export async function publishFromRoute(cache: CacheLike, input: PublishInput): Promise<unknown> {
  return cache.publishDocument(input);
}
