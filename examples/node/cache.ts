import { createCache } from '../../src/index.ts';

export const cache = createCache({
  origin: {
    internalUrl: 'http://127.0.0.1:3000',
    publicUrl: 'https://news.example.com',
  },
  storage: {
    directory: '/var/cache/hiden',
    releaseId: process.env.CACHE_RELEASE_ID ?? 'dev',
  },
  policy: {
    include: ['/', '/tin-tuc/**'],
    exclude: ['/api/**', '/admin/**'],
    query: { allow: { page: { type: 'digits' } } },
  },
});
