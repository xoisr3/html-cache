type CacheLike = {
  purge(url: string, options: { minRevision: string; commitVersion: number }): Promise<unknown>;
  warm(url: string, options: { expectedRevision: string; commitVersion: number }): Promise<unknown>;
};

export async function onArticleCommitted(
  cache: CacheLike,
  input: { articleUrl: string; articleRevision: string; articleVersion: number; listingUrl: string; listingRevision: string; listingVersion: number },
): Promise<void> {
  await cache.purge(input.articleUrl, { minRevision: input.articleRevision, commitVersion: input.articleVersion });
  await cache.purge(input.listingUrl, { minRevision: input.listingRevision, commitVersion: input.listingVersion });
  await cache.warm(input.articleUrl, { expectedRevision: input.articleRevision, commitVersion: input.articleVersion });
  await cache.warm(input.listingUrl, { expectedRevision: input.listingRevision, commitVersion: input.listingVersion });
}
