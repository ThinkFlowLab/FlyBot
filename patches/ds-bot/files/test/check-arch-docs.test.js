import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
