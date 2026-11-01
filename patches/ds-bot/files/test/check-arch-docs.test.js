import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  parseOwnedPaths,
  pathMatchesOwned,
  loadSubsystemMap,
} from '../scripts/check-arch-docs.mjs';

test('parseOwnedPaths reads front-matter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-'));
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

test('the gate never runs git through a shell', async () => {
  // #1954: on Windows `execSync('git rev-parse --verify origin/main^{commit}')` is handed to cmd.exe,
  // which eats `^`; rev-parse fails and the gate reports "cannot diff against origin/main" on a
  // checkout where origin/main exists. The gate must pass `^{commit}` to git as one argument, no shell
  // in between. A fake `git` early on PATH records the *name of its parent process*: a shell parent
  // means the command was built as a string and handed to sh (which is what cmd.exe does on Windows).
  const dir = mkdtempSync(join(tmpdir(), 'arch-shell-'));
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
