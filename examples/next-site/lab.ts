import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCache, CacheError, summarizeAccessLog } from '../../src/index.ts';
import { documents } from './app/content.js';

const siteDir = path.dirname(fileURLToPath(import.meta.url));
const originPort = 3210;
const listenPort = 8080;
const host = 'news.example.com';
const publicUrl = `http://${host}:${listenPort}`;
const releaseId = 'next-dev';
const nginxExe = 'C:/Users/Administrator/AppData/Local/Temp/2/hiden-nginx/nginx-1.27.4/nginx.exe';
const nginxDir = path.dirname(nginxExe);
const includePath = `${nginxDir}/hiden-lab.conf`;
const confPath = `${nginxDir}/lab-site.conf`;
const hostsPath = 'C:/Windows/System32/drivers/etc/hosts';

await ensureHost();
const rebuilt = await ensureBuild();
if (rebuilt) {
  await stopListeners(originPort);
  const stopped = Date.now();
  while ((await reachable(originPort, '/')) && Date.now() - stopped < 5_000) await delay(200);
  if (await reachable(originPort, '/')) throw new Error(`Old Next instance still occupying port ${originPort}`);
}
await ensureNext();

const staticRoots = await prepareStatic();
const cacheDir = path.join(siteDir, '.cache');
await mkdir(cacheDir, { recursive: true });
const directory = await realpath(cacheDir);
const cache = createCache({
  origin: {
    internalUrl: `http://127.0.0.1:${originPort}`,
    publicUrl,
    staticRoot: staticRoots.current,
    previousStaticRoot: staticRoots.previous,
  },
  storage: { directory, releaseId },
  policy: {
    include: ['/', '/tin-tuc/**', '/chuyen-muc/**'],
    exclude: ['/api/**'],
    query: { allow: { page: { type: 'digits' } } },
  },
});
await cache.init();
for (const document of documents) {
  await warm(document.path, document.revision);
}
await expectRejected('/tin-tuc?page=1', 'listing:query-1');

const accessLog = path.join(nginxDir, 'logs', 'lab-access.log');
const panelRoot = await preparePanel();
await writeFile(includePath, cache.generateNginxConfig());
await writeFile(confPath, siteConfig(panelRoot));
await reloadNginx();
await writeFile(
  path.join(siteDir, '.lab.json'),
  JSON.stringify({ origin: publicUrl, directory, releaseId, accessLog }, null, 2),
);
await measure(accessLog);

console.log(`Domain: ${publicUrl}/`);
console.log(`HIT  ${publicUrl}/tin-tuc/a`);
console.log(`MISS ${publicUrl}/tin-tuc/khong-co`);
console.log(`BYPASS ${publicUrl}/tin-tuc/a?limit=100`);
console.log(`STATIC ${publicUrl}/_next/static/lab-current.txt`);
console.log(`PREV   ${publicUrl}/_next/static/lab-previous.txt`);

async function prepareStatic(): Promise<{ current: string; previous: string }> {
  const base = path.join(siteDir, '.static');
  const current = path.join(base, 'current');
  const previous = path.join(base, 'previous');
  const link = path.join(current, '_next', 'static');
  const source = await realpath(path.join(siteDir, '.next', 'static'));
  await mkdir(path.dirname(link), { recursive: true });
  await mkdir(path.join(previous, '_next', 'static'), { recursive: true });
  await replaceJunction(link, source);
  await writeFile(path.join(source, 'lab-current.txt'), 'current-release\n');
  await writeFile(path.join(source, 'lab-panel.js'), 'current-js\n');
  await writeFile(path.join(previous, '_next', 'static', 'lab-previous.txt'), 'previous-release\n');
  return { current: await realpath(current), previous: await realpath(previous) };
}

async function replaceJunction(link: string, target: string): Promise<void> {
  const info = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (info?.isSymbolicLink()) await rm(link);
  else if (info) throw new Error(`${link} must be a junction to Next static directory`);
  await symlink(target, link, 'junction');
}

async function warm(urlPath: string, revision: string): Promise<void> {
  await cache.warm(urlPath, { expectedRevision: revision, commitVersion: 3 });
  console.log(`warm ${urlPath}`);
}

async function expectRejected(urlPath: string, revision: string): Promise<void> {
  try {
    await cache.warm(urlPath, { expectedRevision: revision, commitVersion: 3 });
    throw new Error(`${urlPath} was unexpectedly cached`);
  } catch (error) {
    if (error instanceof CacheError && error.code === 'INVALID_RESPONSE') {
      console.log(`reject ${urlPath}: ${error.message}`);
      return;
    }
    throw error;
  }
}

async function preparePanel(): Promise<string> {
  const root = path.join(siteDir, '.panel-root');
  await mkdir(path.join(root, '_next', 'static'), { recursive: true });
  await writeFile(path.join(root, '_next', 'static', 'lab-panel.js'), 'panel-stole\n');
  await writeFile(path.join(root, 'site.js'), 'panel-site\n');
  return (await realpath(root)).replaceAll('\\', '/');
}

function siteConfig(panelRoot: string): string {
  return `worker_processes 1;
error_log logs/lab-error.log info;
pid logs/lab.pid;
events { worker_connections 64; }
http {
    log_format hiden_lab '$remote_addr "$request" $status $html_cache_status cookie=$html_cache_cookie_bypass query_ok=$html_cache_query_ok';
    server {
        listen 127.0.0.1:${listenPort};
        server_name ${host};
        root "${panelRoot}";
        access_log logs/lab-access.log hiden_lab;
        # aaPanel-style regex location, placed before include. Without ^~ it captures /_next/static/*.js.
        location ~ .*\\.(js|css)$ {
            add_header X-Panel-Regex js;
            try_files $uri =404;
        }
        location ~ .*\\.(gif|jpg|jpeg|png|webp|svg|ico)$ {
            add_header X-Panel-Regex image;
            try_files $uri =404;
        }
        include ${includePath};
    }
}
`;
}

async function measure(logPath: string): Promise<void> {
  await waitReady();
  const start = await stat(logPath).then((info) => info.size).catch(() => 0);
  const samples = [
    ['/', {}],
    ['/tin-tuc/a', {}],
    ['/tin-tuc/the-gioi/kinh-te/bai-viet-a', {}],
    ['/chuyen-muc/xa-hoi/giao-duc/tuyen-sinh', {}],
    ['/tin-tuc/khong-co', {}],
    ['/tin-tuc/the-gioi/kinh-te/khong-co', {}],
    ['/tin-tuc?page=1', {}],
    ['/tin-tuc/a?limit=100', {}],
    ['/tin-tuc/a?page=1&limit=100', {}],
    ['/tin-tuc/a', { Cookie: 'a=1' }],
    ['/_next/static/lab-current.txt', {}],
  ] as const;
  for (const [urlPath, headers] of samples) await send(urlPath, headers);
  const file = await readFile(logPath).catch(() => Buffer.alloc(0));
  const summary = summarizeAccessLog(file.subarray(start).toString('utf8'));
  if (summary.total === 0) throw new Error('access log has no HIT, MISS or BYPASS entries');
  const share = (count: number) => `${count} (${Math.round((count / summary.total) * 100)}%)`;
  console.log(`LOG ${logPath}`);
  console.log(`document ${summary.total}: HIT ${share(summary.hit)}, MISS ${share(summary.miss)}, BYPASS ${share(summary.bypass)}`);
  console.log(`BYPASS cookie ${summary.bypassCookie}, query ${summary.bypassQuery}`);
}

async function waitReady(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    try {
      await send('/', {});
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ECONNRESET' && code !== 'ECONNREFUSED') throw error;
      await delay(200);
    }
  }
  throw new Error('Nginx did not accept requests after reload');
}

function send(urlPath: string, headers: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const req = request(
      {
        hostname: host,
        port: listenPort,
        path: urlPath,
        method: 'GET',
        headers: { ...headers, Connection: 'close' },
        timeout: 5000,
        agent: false,
      },
      (res) => {
        res.on('error', finish);
        res.resume();
        res.on('end', () => finish());
      },
    );
    req.on('socket', (socket) => socket.on('error', finish));
    req.on('error', finish);
    req.on('timeout', () => {
      req.destroy();
      finish(new Error(`probe timed out: ${urlPath}`));
    });
    req.end();
  });
}

async function ensureHost(): Promise<void> {
  const buffer = await readFile(hostsPath);
  const utf16 = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const text = buffer.toString(utf16 ? 'utf16le' : 'utf8');
  if (new RegExp(`\\b${host}\\b`).test(text)) return;
  const next = `${text.endsWith('\n') || text.endsWith('\r') ? text : `${text}\n`}127.0.0.1 ${host}\n`;
  try {
    await writeFile(hostsPath, utf16 ? Buffer.from(next, 'utf16le') : next);
    console.log(`hosts + 127.0.0.1 ${host}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES') throw error;
    console.log(`Could not write to hosts file. Add this entry and query ${publicUrl} :`);
    console.log(`127.0.0.1 ${host}`);
  }
}

async function ensureBuild(): Promise<boolean> {
  const buildId = path.join(siteDir, '.next', 'BUILD_ID');
  const builtAt = await stat(buildId).then((info) => info.mtimeMs).catch(() => 0);
  const sourceAt = await newest(path.join(siteDir, 'app'));
  if (builtAt >= sourceAt) return false;
  await run(process.execPath, [path.join(siteDir, 'node_modules/next/dist/bin/next'), 'build'], siteDir);
  return true;
}

async function newest(directory: string): Promise<number> {
  let max = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) max = Math.max(max, await newest(full));
    else max = Math.max(max, (await stat(full)).mtimeMs);
  }
  return max;
}

async function stopListeners(port: number): Promise<void> {
  const output = await new Promise<string>((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout));
  });
  const pids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue;
    const pid = line.trim().split(/\s+/).at(-1);
    if (pid && pid !== '0') pids.add(pid);
  }
  await Promise.all(
    [...pids].map(
      (pid) =>
        new Promise<void>((resolve) => {
          execFile('taskkill', ['/PID', pid, '/F'], { windowsHide: true }, () => resolve());
        }),
    ),
  );
}

async function ensureNext(): Promise<void> {
  if (await reachable(originPort, '/')) return;
  const child = spawn(process.execPath, [path.join(siteDir, 'node_modules/next/dist/bin/next'), 'start', '-p', String(originPort)], {
    cwd: siteDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (await reachable(originPort, '/')) return;
    await delay(200);
  }
  throw new Error(`Next did not start on port ${originPort}`);
}

async function reloadNginx(): Promise<void> {
  const running = await reachable(listenPort, '/');
  const args = ['-p', nginxDir, '-c', confPath];
  if (running) {
    await run(nginxExe, [...args, '-s', 'reload'], nginxDir);
    return;
  }
  const child = spawn(nginxExe, args, { cwd: nginxDir, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    if (await reachable(listenPort, '/')) return;
    await delay(200);
  }
  const log = await readFile(path.join(nginxDir, 'logs', 'lab-error.log'), 'utf8').catch(() => '');
  throw new Error(`Nginx did not start on port ${listenPort}\n${log}`);
}

function reachable(port: number, urlPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
        timeout: 1000,
        agent: false,
        headers: { Connection: 'close' },
      },
      (res) => {
        res.on('error', () => done(false));
        res.resume();
        res.on('end', () => done((res.statusCode ?? 500) < 500));
      },
    );
    req.on('socket', (socket) => socket.on('error', () => done(false)));
    req.on('error', () => done(false));
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.end();
  });
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code}`));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
