#!/usr/bin/env node
/**
 * One-command before/after screenshots for the FlyBot management UI.
 *
 *   # two already-running servers
 *   ot=... node scripts/shots.mjs --slug help-center \
 *     --before http://127.0.0.1:8101 --after http://127.0.0.1:8102 \
 *     --routes /chat --states account-menu-open
 *
 *   # two commits: each side gets its own worktree + seeded fixture app
 *   node scripts/shots.mjs --slug help-center \
 *     --before 310d468 --after <pr-tip> --routes /chat --states account-menu-open
 *
 * Writes .shots/<slug>/<before|after>/<locale>__<theme>__<viewport>__<route>.png
 * plus .shots/<slug>/diff.json (changed-pixel ratio and bounding box per pair).
 *
 * The browser driving is deliberately thin. Server startup and fixture seeding
 * reuse the existing scripts/ci_ui_screenshots.py --serve harness; this script
 * only adds the two-arm orchestration, state actions and the pixel diff.
 *
 * Read-only towards the checkout: it writes only .shots/, worktrees under
 * ../.shots-servers/ and state under ../.shots-state/. Credentials come from
 * ready.json (ref mode), --login-file, or FLYBOT_WORKSPACE_USERNAME/FLYBOT_WORKSPACE_PASSWORD; never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const WORK_ROOT = path.resolve(REPO_ROOT, '..');
const SERVER_ROOT = path.join(WORK_ROOT, '.shots-servers');
const STATE_ROOT = path.join(WORK_ROOT, '.shots-state');

function die(message) {
  process.stderr.write(`shots: ${message}\n`);
  process.exit(2);
}

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function argList(name, fallback) {
  const raw = argValue(name, '');
  if (!raw) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function safePart(text) {
  return text.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function readLoginFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const username = /(?:^|\n)username=([^\n]+)/.exec(text)?.[1];
  const password = /(?:^|\n)password=([^\n]+)/.exec(text)?.[1];
  if (!username || !password) die(`login file ${file} is missing username= or password=`);
  return { username: username.trim(), password: password.trim() };
}

function envLogin() {
  const username = process.env.FLYBOT_WORKSPACE_USERNAME || argValue('--username');
  const password = process.env.FLYBOT_WORKSPACE_PASSWORD || argValue('--password');
  if (!username || !password) {
    die('no credentials: pass --login-file, or set FLYBOT_WORKSPACE_USERNAME and FLYBOT_WORKSPACE_PASSWORD (or use a git ref, which seeds its own login)');
  }
  return { username, password };
}

function routeToName(route) {
  const cleaned = route.split('?')[0].split('#')[0];
  if (cleaned === '/' || cleaned === '') return 'index';
  return cleaned.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

function viewportFrom(text) {
  const match = /^(\d+)x(\d+)$/.exec(text.trim());
  if (!match) die(`viewport must look like 1440x900, got ${text}`);
  return { width: Number(match[1]), height: Number(match[2]), label: text.trim() };
}

function csrfFromCookies(cookies) {
  return cookies.find((item) => /_csrf$/.test(item.name))?.value || '';
}

function waitForFile(file, timeoutMs, since = 0) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (fs.statSync(file).mtimeMs >= since) return resolve();
      } catch { /* not written yet */ }
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${file}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function isHttpUrl(value) {
  return /^https?:\/\//.test(value);
}

const children = new Set();
const worktrees = new Set();

function cleanup() {
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
  for (const tree of worktrees) {
    spawnSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', tree], { stdio: 'ignore' });
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

/**
 * A side is either an already-running server URL or a git ref. In ref mode the
 * side gets a detached worktree plus the existing seeded fixture app, exactly
 * like scripts/ci_ui_screenshots.py starts it for CI.
 */
function assertPortFree(port, name) {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', (error) => reject(new Error(
      `port ${port} is busy (${error.code}); free it or pass --${name}-port`)));
    socket.once('listening', () => socket.close(() => resolve()));
    socket.listen(port, '127.0.0.1');
  });
}

async function ensureWorktree(name, ref) {
  const tree = path.join(SERVER_ROOT, `${name}-${safePart(ref)}`);
  fs.mkdirSync(SERVER_ROOT, { recursive: true });
  if (fs.existsSync(tree)) {
    spawnSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', tree], { stdio: 'ignore' });
  }
  const add = spawnSync('git', ['-C', REPO_ROOT, 'worktree', 'add', '--detach', tree, ref], { encoding: 'utf8' });
  if (add.status !== 0) throw new Error(`git worktree add ${ref} failed: ${add.stderr.trim()}`);
  worktrees.add(tree);
  const nested = path.join(tree, 'workspace');
  return fs.existsSync(path.join(nested, 'scripts', 'ci_ui_screenshots.py')) ? nested : tree;
}

/**
 * Seed the synthetic fixtures ONCE with the existing CI harness. Both sides
 * then run against a byte-identical copy of that database: the fixture picks
 * random workspace/conversation ids, and an independently seeded pair would
 * land on different default workspaces, drowning the real UI change in noise.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

async function seedFixtures(tree, timeoutMs) {
  const state = path.join(STATE_ROOT, 'seed');
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  const readyPath = path.join(state, 'out', 'ready.json');
  const logPath = path.join(state, 'seed.log');
  const log = fs.openSync(logPath, 'w');
  const python = process.env.SHOTS_PYTHON || 'python3.11';
  const child = spawn(python, [
    path.join(tree, 'scripts', 'ci_ui_screenshots.py'),
    '--data-dir', path.join(state, 'data'),
    '--out', path.join(state, 'out'),
    '--port', String(await findFreePort()),
  ], { cwd: tree, env: { ...process.env, PYTHONPATH: tree }, stdio: ['ignore', log, log], detached: true });
  children.add(child);
  child.unref();
  child.on('exit', () => children.delete(child));
  const spawnAt = Date.now();
  try {
    await waitForFile(readyPath, timeoutMs, spawnAt);
  } catch (error) {
    throw new Error(`${error.message}; seed log tail: ${fs.readFileSync(logPath, 'utf8').slice(-600)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
  const login = readLoginFile(ready.login_file);
  process.stdout.write(`seeded fixtures once (workspace ${ready.workspace_id.slice(0, 8)}…), reused by both sides\n`);
  return { dataDir: path.join(state, 'data'), login, ready };
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become ready: ${last}`);
}

async function startServerSide({ name, ref, port, tree, seedData, login, timeoutMs }) {
  const state = path.join(STATE_ROOT, `${name}-${safePart(ref)}`);
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  const dataDir = path.join(state, 'data');
  fs.cpSync(seedData, dataDir, { recursive: true });
  // Store fails closed unless the directory is private; cpSync is subject to umask.
  fs.chmodSync(dataDir, 0o700);
  fs.chmodSync(path.join(dataDir, 'state'), 0o700);
  await assertPortFree(port, name);
  const origin = `http://127.0.0.1:${port}`;
  const logPath = path.join(state, 'server.log');
  const log = fs.openSync(logPath, 'w');
  const python = process.env.SHOTS_PYTHON || 'python3.11';
  const child = spawn(python, [
    '-m', 'flybot-workspace.server',
    '--data-dir', path.join(dataDir, 'state'),
    '--origin', origin,
    '--port', String(port),
    '--insecure-local',
  ], { cwd: tree, env: { ...process.env, PYTHONPATH: tree }, stdio: ['ignore', log, log], detached: true });
  children.add(child);
  child.unref();
  child.on('exit', () => children.delete(child));
  try {
    await waitForHttp(`${origin}/settings`, timeoutMs);
  } catch (error) {
    throw new Error(`${name}: ${error.message}; server log: ${fs.readFileSync(logPath, 'utf8').slice(-500) || '<empty>'}`);
  }
  if (child.exitCode !== null) throw new Error(`${name}: server exited ${child.exitCode}`);
  process.stdout.write(`ready ${name}: ${origin} (${ref})\n`);
  return { name, ref, url: origin, login, child, tree, state, dataDir };
}

async function apiFetch(context, base, method, route, body) {
  return context.request.fetch(base + route, {
    method,
    data: body,
    headers: { Origin: base, Accept: 'application/json' },
  });
}

async function signIn(context, base, login, registerAllowed) {
  let response = await apiFetch(context, base, 'POST', '/v1/auth/login', login);
  if (response.status() === 401 && registerAllowed) {
    response = await apiFetch(context, base, 'POST', '/v1/auth/register', login);
  }
  if (response.status() !== 200 && response.status() !== 201) {
    throw new Error(`sign-in failed: HTTP ${response.status()} ${(await response.text()).slice(0, 200)}`);
  }
  const csrf = csrfFromCookies(await context.cookies());
  if (!csrf) throw new Error('sign-in did not yield a CSRF cookie');
  return csrf;
}

async function applyPreferences(context, base, csrf, { locale, theme }) {
  const current = await apiFetch(context, base, 'GET', '/v1/settings');
  if (current.status() !== 200) throw new Error(`GET /v1/settings HTTP ${current.status()}`);
  const payload = await current.json();
  const changes = { appearance: theme };
  if (locale === 'en' || locale === 'zh-CN') changes.language = locale;
  const response = await context.request.fetch(base + '/v1/settings', {
    method: 'POST',
    data: { revision: payload.settings.revision, changes },
    headers: { Origin: base, 'X-CSRF-Token': csrf, Accept: 'application/json' },
  });
  if (response.status() !== 200) {
    throw new Error(`POST /v1/settings HTTP ${response.status()}: ${(await response.text()).slice(0, 160)}`);
  }
}

const STATES = {
  default: async () => {},
  // Every signed-in page shares the shell account menu; the 帮助中心 entry
  // lives in its help submenu, so this state opens both levels.
  'account-menu-open': async (page) => {
    await page.locator('#account-menu-button').click();
    await page.waitForSelector('#account-menu:not([hidden])', { timeout: 5000 });
    const helpButton = page.locator('#help-menu-button');
    if (await helpButton.count()) {
      await helpButton.click();
      await page.waitForSelector('#help-menu:not([hidden])', { timeout: 5000 });
    }
  },
  'help-menu-open': async (page) => {
    await page.locator('#account-menu-button').click();
    await page.waitForSelector('#account-menu:not([hidden])', { timeout: 5000 });
    const helpButton = page.locator('#help-menu-button');
    if (!(await helpButton.count())) throw new Error('no #help-menu-button on this page');
    await helpButton.click();
    await page.waitForSelector('#help-menu:not([hidden])', { timeout: 5000 });
  },
};

async function loadStates(names) {
  const file = argValue('--state-file');
  const table = { ...STATES };
  if (file) Object.assign(table, (await import(path.resolve(file))).states || {});
  const missing = names.filter((name) => !table[name]);
  if (missing.length) die(`unknown state(s): ${missing.join(', ')} (built-in: ${Object.keys(table).join(', ')})`);
  return names.map((name) => ({ name, run: table[name] }));
}

async function assertSafeToCapture(page) {
  const filled = await page.$$eval('input[type="password"]',
    (inputs) => inputs.map((input) => input.value).filter(Boolean));
  if (filled.length) throw new Error('a password field is not empty; refusing to screenshot');
}

async function waitForShell(page, theme) {
  await page.waitForFunction(() => {
    const doc = document.documentElement;
    return doc.dataset.themeResolved !== undefined || document.body?.dataset?.themeResolved !== undefined;
  }, null, { timeout: 5000 }).catch(() => {});
  const applied = await page.evaluate(() => document.documentElement.dataset.themeResolved || '');
  if (applied && applied !== theme) {
    throw new Error(`theme resolved to ${applied}, expected ${theme}`);
  }
  await page.waitForTimeout(150);
}

/**
 * The seeded pages fill lists and transcripts from /v1 fetches after load;
 * networkidle can fire before the last render. Wait until the visible text
 * length stops changing so before/after do not race different render states.
 */
async function waitForStableText(page) {
  let last = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const length = await page.evaluate(() => document.body?.innerText.length || 0);
    if (length === last && length > 0) {
      stable += 1;
      if (stable >= 3) return;
    } else {
      stable = 0;
      last = length;
    }
    await page.waitForTimeout(120);
  }
}

function compareText(a, b) {
  const left = a.split('\n').map((line) => line.trim()).filter(Boolean);
  const right = b.split('\n').map((line) => line.trim()).filter(Boolean);
  const rightSet = new Map();
  for (const line of right) rightSet.set(line, (rightSet.get(line) || 0) + 1);
  const sample = [];
  let changedLines = 0;
  for (const line of left) {
    const count = rightSet.get(line) || 0;
    if (count > 0) {
      rightSet.set(line, count - 1);
    } else {
      changedLines += 1;
      if (sample.length < 5) sample.push(line);
    }
  }
  for (const [line, count] of rightSet) {
    if (count > 0) {
      changedLines += count;
      if (sample.length < 5) sample.push(`+${line}`);
    }
  }
  return { changedLines, sample };
}

/** Pixel diff in the same Chromium, so no extra image dependency is needed. */
async function diffPair(page, beforeFile, afterFile) {
  const before = fs.readFileSync(beforeFile).toString('base64');
  const after = fs.readFileSync(afterFile).toString('base64');
  return page.evaluate(async ({ a, b }) => {
    const load = (src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('image decode failed'));
      image.src = `data:image/png;base64,${src}`;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { sizeMismatch: true, before: [ia.width, ia.height], after: [ib.width, ib.height] };
    }
    const canvas = document.createElement('canvas');
    canvas.width = ia.width;
    canvas.height = ia.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(ia, 0, 0);
    const da = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(ib, 0, 0);
    const db = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let changed = 0;
    let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
    for (let i = 0; i < da.length; i += 4) {
      if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) {
        changed += 1;
        const pixel = i / 4;
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const total = canvas.width * canvas.height;
    return {
      sizeMismatch: false,
      width: canvas.width,
      height: canvas.height,
      total,
      changed,
      ratio: changed / total,
      bbox: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    };
  }, { a: before, b: after });
}

async function main() {
  const slug = argValue('--slug');
  if (!slug) die('--slug is required');
  const beforeArg = argValue('--before');
  const afterArg = argValue('--after');
  const baseUrl = argValue('--base-url');
  const outRoot = path.resolve(argValue('--out', '.shots'));
  const routes = argList('--routes', ['/']);
  const viewports = argList('--viewports', ['1440x900', '390x844']).map(viewportFrom);
  const locales = argList('--locales', ['zh-CN', 'en']);
  const themes = argList('--themes', ['light', 'dark']);
  const stateNames = argList('--states', ['default']);
  const fullPage = hasFlag('--full-page');
  const registerAllowed = hasFlag('--register');
  const timeout = Number(argValue('--timeout', '20000'));
  const startTimeout = Number(argValue('--start-timeout', '180000'));
  const skipDiff = hasFlag('--no-diff');

  const specs = [];
  if (beforeArg) specs.push({ name: 'before', value: beforeArg, port: Number(argValue('--before-port', '8101')) });
  if (afterArg) specs.push({ name: 'after', value: afterArg, port: Number(argValue('--after-port', '8102')) });
  if (!specs.length && baseUrl) {
    specs.push({ name: argValue('--side-name', 'current'), value: baseUrl, port: 0 });
  }
  if (!specs.length) die('give --before and/or --after, or --base-url');

  const states = await loadStates(stateNames);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || argValue('--browser') || undefined;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath });
  const results = [];
  const sides = [];
  const started = Date.now();

  try {
    const trees = new Map();
    const refSpecs = specs.filter((spec) => !isHttpUrl(spec.value));
    let seed = null;
    if (refSpecs.length) {
      const seedTree = await ensureWorktree(refSpecs[0].name, refSpecs[0].value);
      trees.set(refSpecs[0].name, seedTree);
      seed = await seedFixtures(seedTree, startTimeout);
    }
    for (const spec of specs) {
      if (isHttpUrl(spec.value)) {
        sides.push({ name: spec.name, url: spec.value.replace(/\/+$/, ''), login: envLogin() });
      } else {
        let tree = trees.get(spec.name);
        if (!tree) {
          tree = await ensureWorktree(spec.name, spec.value);
          trees.set(spec.name, tree);
        }
        sides.push(await startServerSide({
          name: spec.name, ref: spec.value, port: spec.port, tree,
          seedData: seed.dataDir, login: seed.login, timeoutMs: startTimeout,
        }));
      }
    }

    // One sign-in per side, reused by every context: the app rate-limits
    // logins per username and per peer address, so a login per viewport
    // would trip 429 by design.
    const auth = new Map();
    for (const side of sides) {
      const authContext = await browser.newContext();
      const csrf = await signIn(authContext, side.url, side.login, registerAllowed);
      auth.set(side.name, { storageState: await authContext.storageState(), csrf });
      await authContext.close();
    }
    // Interleave the two sides inside each combo so time-dependent state (a
    // runtime heartbeat, a countdown, a worker tick) is seconds apart instead
    // of minutes; only the code under test should differ.
    for (const viewport of viewports) {
      for (const locale of locales) {
        for (const theme of themes) {
          for (const side of sides) {
            const { storageState, csrf } = auth.get(side.name);
            const context = await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              colorScheme: theme,
              locale,
              deviceScaleFactor: 1,
              storageState,
            });
            context.setDefaultTimeout(timeout);
            try {
              await applyPreferences(context, side.url, csrf, { locale, theme });
              const page = await context.newPage();
              for (const route of routes) {
                const target = side.url + (route.startsWith('/') ? route : `/${route}`);
                const response = await page.goto(target, { waitUntil: 'networkidle', timeout });
                const status = response ? response.status() : 0;
                if (!status || status >= 400) throw new Error(`GET ${route} HTTP ${status}`);
                await waitForShell(page, theme);
                await waitForStableText(page);
                for (const state of states) {
                  await state.run(page);
                  await waitForStableText(page);
                  await assertSafeToCapture(page);
                  const dir = path.join(outRoot, slug, side.name);
                  fs.mkdirSync(dir, { recursive: true });
                  const file = `${safePart(locale)}__${safePart(theme)}__${safePart(viewport.label)}__`
                    + `${routeToName(route)}${state.name === 'default' ? '' : `__${safePart(state.name)}`}.png`;
                  const full = path.join(dir, file);
                  await page.screenshot({ path: full, fullPage, animations: 'disabled' });
                  const text = (await page.evaluate(() => document.body?.innerText || '')).trim();
                  if (text.length < 20) throw new Error(`page ${route} rendered almost no text`);
                  const diagnostics = await page.evaluate(() => ({
                    themeResolved: document.documentElement.dataset.themeResolved || '',
                    language: document.documentElement.lang || '',
                    accountMenuOpen: Boolean(document.getElementById('account-menu'))
                      && !document.getElementById('account-menu').hasAttribute('hidden'),
                    helpMenuOpen: Boolean(document.getElementById('help-menu'))
                      && !document.getElementById('help-menu').hasAttribute('hidden'),
                    textLength: (document.body?.innerText || '').length,
                  }));
                  results.push({
                    side: side.name, route, locale, theme, viewport: viewport.label,
                    state: state.name, file: full, ok: true, diagnostics, text,
                  });
                  process.stdout.write(`ok ${path.relative(process.cwd(), full)}\n`);
                }
              }
            } catch (error) {
              results.push({
                side: side.name, locale, theme, viewport: viewport.label,
                ok: false, error: String(error.message || error),
              });
              process.stderr.write(`fail ${side.name} ${locale} ${theme} ${viewport.label}: ${error.message || error}\n`);
            } finally {
              await context.close();
            }
          }
        }
      }
    }

    let diffs = [];
    if (!skipDiff && sides.length === 2) {
      const before = results.filter((item) => item.ok && item.side === sides[0].name);
      const after = results.filter((item) => item.ok && item.side === sides[1].name);
      const comparePage = await browser.newPage();
      for (const left of before) {
        const right = after.find((item) => item.route === left.route && item.locale === left.locale
          && item.theme === left.theme && item.viewport === left.viewport && item.state === left.state);
        if (!right) continue;
        const diff = await diffPair(comparePage, left.file, right.file);
        const textDiff = compareText(left.text || '', right.text || '');
        const entry = {
          route: left.route, locale: left.locale, theme: left.theme,
          viewport: left.viewport, state: left.state,
          before: path.relative(outRoot, left.file),
          after: path.relative(outRoot, right.file),
          before_diagnostics: left.diagnostics,
          after_diagnostics: right.diagnostics,
          ...diff,
          text: textDiff,
        };
        diffs.push(entry);
        process.stdout.write(`diff ${entry.locale} ${entry.theme} ${entry.viewport} ${entry.route}`
          + ` changed=${(entry.ratio * 100).toFixed(3)}%`
          + (entry.bbox ? ` bbox=${entry.bbox.x},${entry.bbox.y},${entry.bbox.width}x${entry.bbox.height}` : ' bbox=none')
          + (entry.sizeMismatch ? ' SIZE-MISMATCH' : '')
          + ` textLinesChanged=${entry.text.changedLines}`
          + (entry.text.sample.length ? ` first="${entry.text.sample[0].slice(0, 80)}"` : '') + '\n');
      }
      await comparePage.close();
    }

    if (diffs.length) {
      fs.writeFileSync(path.join(outRoot, slug, 'diff.json'), `${JSON.stringify({
        slug, sides: sides.map((side) => side.url), diffs,
      }, null, 2)}\n`);
    }

    const failures = results.filter((item) => !item.ok);
    const summary = {
      slug,
      sides: sides.map((side) => side.url),
      routes,
      images: results.filter((item) => item.ok).length,
      failures: failures.length,
      diffs: diffs.length,
      elapsed_ms: Date.now() - started,
      output: outRoot,
      detail: hasFlag('--json') ? results : undefined,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (failures.length) process.exitCode = 1;
  } finally {
    await browser.close();
    for (const side of sides) {
      if (side.child && side.child.exitCode === null) {
        side.child.kill('SIGTERM');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    cleanup();
  }
}

main().catch((error) => {
  process.stderr.write(`shots: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
