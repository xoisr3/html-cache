import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCache, CacheError } from '../dist/index.js';

const cache = createCache({
  origin: {
    internalUrl: 'http://127.0.0.1:3000',
    publicUrl: 'https://news.example.com',
  },
  storage: { directory: '/var/cache/hiden', releaseId: 'build-41' },
  policy: { include: ['/'], exclude: ['/admin/**'] },
});

const config = cache.generateNginxConfig();
assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
assert.match(config, /\/build-41"/);
assert.doesNotMatch(config, /log_format/);
assert.equal(new CacheError('POLICY_REJECTED', 'x').code, 'POLICY_REJECTED');

const cli = spawnSync(process.execPath, ['dist/cron/cli.js'], { encoding: 'utf8' });
assert.equal(cli.status, 1);
assert.match(cli.stderr, /missing --directory or --release/);

console.log('dist ok');
