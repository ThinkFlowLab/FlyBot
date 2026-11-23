import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  parseOwnedPaths,
  pathMatchesOwned,
  loadSubsystemMap,
} from '../scripts/check-arch-docs.mjs';

test('parseOwnedPaths reads front-matter', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, 'x.md');
  writeFileSync(p, `---\nsubsystem: demo\nowned_paths:\n  - plugins/demo/\n  - core/x.js\n---\n# demo\n`);
  const { subsystem, ownedPaths } = parseOwnedPaths(p);
  assert.equal(subsystem, 'demo');
  assert.deepEqual(ownedPaths, ['plugins/demo/', 'core/x.js']);
});

test('pathMatchesOwned directory and exact', () => {
  assert.ok(pathMatchesOwned('plugins/tree/index.js', 'plugins/tree/'));
  assert.ok(pathMatchesOwned('core/index.js', 'core/index.js'));
  assert.ok(!pathMatchesOwned('core/src/a.js', 'core/index.js'));
  assert.ok(!pathMatchesOwned('plugins/social/x.js', 'plugins/tree/'));
});

test('loadSubsystemMap loads docs dir', () => {
  const map = loadSubsystemMap();
  assert.ok(map.has('ds-bot-core'));
  assert.ok(map.has('plugin-runtime'));
  assert.ok(map.has('tree'));
  assert.ok(map.has('social'));
  assert.ok(map.has('install'));
});

test('empty diff passes', async () => {
  const { filesNeedDocs } = await import('../scripts/check-arch-docs.mjs');
  const r = filesNeedDocs({ ref: 'HEAD' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test('invalid base ref fails closed', async () => {
  const { filesNeedDocs, hasDocsNotNeededTrailer } = await import(
    '../scripts/check-arch-docs.mjs'
  );
  const bad = 'refs/heads/nonexistent-review-base';
  assert.throws(() => filesNeedDocs({ ref: bad }), /cannot diff against/);
  assert.throws(() => hasDocsNotNeededTrailer(bad), /cannot diff against/);
});

test('#1076: the refusal names both places the trailer has to appear', async () => {
  // The gate reads `git log <base>..HEAD`; on a merge-queue entry that is the squashed pull request
  // title and body, so a branch-only trailer is gone exactly when main is judged. The old text said
  // "add a trailer" and sent the author to the commit they had just pushed.
  const { failureLines } = await import('../scripts/check-arch-docs.mjs');
  assert.equal(typeof failureLines, 'function', 'the refusal text is readable without running the gate');
  const text = failureLines([{ file: 'plugins/social/test/social.test.js', subsystem: 'social', doc: join(tmpdir(), 'docs/subsystems/social.md') }]).join('\n');
  assert.match(text, /pull request body/);
  assert.match(text, /branch commit/);
  assert.match(text, /squash/i);
  assert.match(text, /Docs-not-needed:/);
});

// #1973: this case can only observe the property by running a fake `git` that has to be an executable
// script with an interpreter line. Windows cannot launch one through CreateProcess, and a bare `git`
// with no `.cmd`/`.exe` is not what PATH lookup finds, so the marker is never written. The case is
// marked skipped there rather than quietly passing: the Windows behaviour is exercised by the real gate
// in nightly.yml's `Lint` step on `windows-latest`.
test('the gate never runs git through a shell', { skip: process.platform === 'win32' }, async (t) => {
  // #1954: on Windows `execSync('git rev-parse --verify origin/main^{commit}')` is handed to cmd.exe,
  // which eats `^`; rev-parse fails and the gate reports "cannot diff against origin/main" on a
  // checkout where origin/main exists. The gate must pass `^{commit}` to git as one argument, no shell
  // in between. A fake `git` early on PATH records the *name of its parent process*: a shell parent
  // means the command was built as a string and handed to sh (which is what cmd.exe does on Windows).
  const dir = mkdtempSync(join(tmpdir(), 'arch-shell-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const marker = join(dir, 'parent.txt');
  const fakeGit = join(bin, 'git');
  writeFileSync(
    fakeGit,
    [
      '#!/bin/sh',
      'p=$PPID',
      'c=$(cat /proc/$p/comm 2>/dev/null)',
      'if [ -z "$c" ]; then c=$(ps -o comm= -p "$p" 2>/dev/null); fi',
      'printf "%s" "$c" > ' + JSON.stringify(marker),
      'case "$c" in',
      '  sh|dash|bash|zsh|ksh|cmd*|cmd.exe) exit 1 ;;',
      'esac',
      'case "$1" in',
      '  rev-parse) echo 0123456789012345678901234567890123456789 ;;',
      '  diff|log) ;;',
      '  *) exit 1 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const script = fileURLToPath(new URL('../scripts/check-arch-docs.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  const parent = readFileSync(marker, 'utf8').trim();
  assert.notEqual(parent, '', 'the fake git must actually run');
  assert.ok(
    !/^(sh|dash|bash|zsh|ksh|cmd)/.test(parent),
    `git was started by a shell (${parent}), so ^{commit} is mangled on Windows`,
  );
  assert.equal(r.status, 0, `gate must pass: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /arch-docs: OK/);
});

// #3322: on a pull_request run the trailer has to be in the branch commits AND in the pull request
// title/body. The gate read `git log` alone, so a branch-commit trailer was green on the pull request
// and the queue entry — whose range holds the squash of the title and body — went red and ejected it.
test('#3322: a pull request needs the trailer in the branch commits and in its own title/body', async () => {
  const { filesNeedDocs } = await import('../scripts/check-arch-docs.mjs');
  const map = new Map([['demo', { path: 'docs/subsystems/demo.md', ownedPaths: ['core/x.js'] }]]);
  const gate = ({ log = '', body = '', files = ['core/x.js'], changed = () => false } = {}) =>
    filesNeedDocs({
      ref: 'HEAD',
      map,
      files,
      changed,
      logText: log,
      event: { name: 'pull_request', title: 'Change the thing', body },
    });
  // Branch commits only: this is the bug — green on the pull request, red in the queue it feeds.
  const commitOnly = gate({ log: 'Docs-not-needed: comments only' });
  assert.equal(commitOnly.ok, false, 'a branch-commit trailer alone must not pass the pull request');
  assert.deepEqual(commitOnly.trailer, { log: true, body: false, event: 'pull_request' });
  assert.deepEqual(commitOnly.missing.map((m) => m.file), ['core/x.js']);
  // Both places: the one shape the queue can read too.
  assert.equal(
    gate({ log: 'Docs-not-needed: comments only', body: 'Docs-not-needed: comments only' }).ok,
    true,
  );
  // Body only: the branch commits are not there either, so the pull request stays red.
  const bodyOnly = gate({ body: 'Docs-not-needed: comments only' });
  assert.equal(bodyOnly.ok, false);
  assert.deepEqual(bodyOnly.trailer, { log: false, body: true, event: 'pull_request' });
  // Neither: red as before.
  assert.equal(gate().ok, false);
  // A merge-queue entry and a local run keep judging the log alone. `null` is "no event supplied":
  // `undefined` is the default parameter, which reads the runner's own event (#3329).
  for (const event of [{ name: 'merge_group' }, null]) {
    const entry = filesNeedDocs({
      ref: 'HEAD',
      map,
      files: ['core/x.js'],
      changed: () => false,
      logText: 'Docs-not-needed: comments only',
      event,
    });
    assert.equal(entry.ok, true);
    assert.equal(entry.trailer.event, event?.name ?? 'local');
  }
  // The documented remedy still works: the subsystem doc in the same pull request.
  assert.equal(gate({ changed: () => true }).ok, true);
  // No owned file changed: nothing to document, whatever the event says.
  assert.equal(gate({ files: ['README.md'] }).ok, true);
});

// #3329: a `pull_request` run whose event cannot be read must fail closed, and only an explicit
// `null` says "no event". The default parameter is the runner's own event, so the case above used to
// read the ambient pull request and depended on that pull request's body having the trailer.
test('#3329: an unreadable pull_request event fails closed', async (t) => {
  const { filesNeedDocs } = await import('../scripts/check-arch-docs.mjs');
  const savedName = process.env.GITHUB_EVENT_NAME;
  const savedPath = process.env.GITHUB_EVENT_PATH;
  t.after(() => {
    if (savedName === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = savedName;
    if (savedPath === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = savedPath;
  });
  process.env.GITHUB_EVENT_NAME = 'pull_request';
  process.env.GITHUB_EVENT_PATH = join(tmpdir(), 'no-such-arch-docs-event.json');
  const map = new Map([['demo', { path: 'docs/subsystems/demo.md', ownedPaths: ['core/x.js'] }]]);
  const run = (logText) => filesNeedDocs({ ref: 'HEAD', map, files: ['core/x.js'], changed: () => false, logText });
  const noTrailer = run('');
  assert.equal(noTrailer.ok, false, 'an unreadable body counts as no trailer, never as a pass');
  assert.deepEqual(noTrailer.trailer, { log: false, body: false, event: 'pull_request' });
  const commitOnly = run('Docs-not-needed: comments only');
  assert.equal(commitOnly.ok, false, 'a branch-commit trailer alone cannot prove the body it cannot read');
  assert.deepEqual(commitOnly.trailer, { log: true, body: false, event: 'pull_request' });
  // With no event at all this is a local run: no second place exists, so the log decides.
  delete process.env.GITHUB_EVENT_NAME;
  const local = run('Docs-not-needed: comments only');
  assert.equal(local.ok, true);
  assert.equal(local.trailer.event, 'local');
});

test('#3322: the refusal names the place where the trailer is missing', async () => {
  const { failureLines } = await import('../scripts/check-arch-docs.mjs');
  const missing = [{ file: 'core/x.js', subsystem: 'demo', doc: join(tmpdir(), 'docs/subsystems/demo.md') }];
  const commitOnly = failureLines(missing, tmpdir(), { log: true, body: false, event: 'pull_request' }).join('\n');
  assert.match(commitOnly, /branch commits have `Docs-not-needed:`, but the pull request title and body do not/);
  const bodyOnly = failureLines(missing, tmpdir(), { log: false, body: true, event: 'pull_request' }).join('\n');
  assert.match(bodyOnly, /pull request body has `Docs-not-needed:`, but the branch commits do not/);
  // A merge-queue entry has no second place, so it keeps the plain refusal.
  const entry = failureLines(missing, tmpdir(), { log: false, body: true, event: 'merge_group' }).join('\n');
  assert.doesNotMatch(entry, /branch commits have/);
});

test('#3322: a pull_request run reads the event the runner wrote', async (t) => {
  const { pullRequestEvent } = await import('../scripts/check-arch-docs.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'arch-event-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify({ pull_request: { title: 'A title', body: 'Docs-not-needed: x' } }));
  const savedName = process.env.GITHUB_EVENT_NAME;
  const savedPath = process.env.GITHUB_EVENT_PATH;
  t.after(() => {
    if (savedName === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = savedName;
    if (savedPath === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = savedPath;
  });
  process.env.GITHUB_EVENT_NAME = 'push';
  assert.equal(pullRequestEvent(), undefined, 'only a pull_request run has a second place');
  process.env.GITHUB_EVENT_NAME = 'pull_request';
  process.env.GITHUB_EVENT_PATH = path;
  assert.deepEqual(pullRequestEvent(), { name: 'pull_request', title: 'A title', body: 'Docs-not-needed: x' });
  // An event the run cannot read counts as a body without the trailer, never as a pass.
  process.env.GITHUB_EVENT_PATH = join(dir, 'missing.json');
  assert.deepEqual(pullRequestEvent(), { name: 'pull_request', title: '', body: '' });
});
