import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { revalidatePath } from 'next/cache';
import { CacheError, createCache } from '@xoisr/html-cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let ready;

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, message: 'body is not valid JSON' }, { status: 400 });
  }
  if (typeof body?.url !== 'string' || typeof body.minRevision !== 'string' || !Number.isSafeInteger(body.commitVersion)) {
    return Response.json({ ok: false, message: 'missing url, minRevision or commitVersion' }, { status: 400 });
  }
  try {
    const cache = await openCache();
    const result = await cache.publishDocument({
      url: body.url,
      minRevision: body.minRevision,
      commitVersion: body.commitVersion,
      revalidate: async () => {
        revalidatePath(body.url);
      },
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const status = error instanceof CacheError ? 409 : 500;
    const message = error instanceof Error ? error.message : 'publish failed';
    return Response.json({ ok: false, message }, { status });
  }
}

async function openCache() {
  if (!ready) {
    ready = loadCache().catch((error) => {
      ready = undefined;
      throw error;
    });
  }
  return ready;
}

async function loadCache() {
  const labPath = path.join(process.cwd(), '.lab.json');
  const lab = JSON.parse(await readFile(labPath, 'utf8'));
  const cache = createCache({
    origin: {
      internalUrl: 'http://127.0.0.1:3210',
      publicUrl: lab.origin,
    },
    storage: { directory: lab.directory, releaseId: lab.releaseId },
    policy: {
      include: ['/', '/tin-tuc/**', '/chuyen-muc/**'],
      exclude: ['/api/**'],
      query: { allow: { page: { type: 'digits' } } },
    },
  });
  try {
    await cache.status('/');
  } catch {
    await cache.init();
  }
  return cache;
}
