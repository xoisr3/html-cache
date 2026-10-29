type CacheLike = {
  startCron(): void;
  stopCron(): void;
};

export function registerCron(cache: CacheLike): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NODE_ENV !== 'production') return;
  cache.startCron();
}
