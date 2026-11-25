import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// The management workflow does not use a glob: it names every node test file on
// its own line. A page test that nobody adds there silently never runs, and two
// PRs that each add the same line run it twice, so this guard compares the
// directory against the workflow text in both directions and counts repeats.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(root, '.github', 'workflows', 'tests.yml');

export function listedTestFiles(source) {
  const listed = [];
  // A step line only: an indented `- run: node --test tests/x.test.mjs`. A commented
  // out step (`# - run: ...`), and a line that only looks like a step because it sits
  // inside a `run: |` or `run: >` block scalar body, must NOT count as listed, or the
  // guard goes green while CI never runs the file.
  let blockIndent = null;
  for (const line of source.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (line.trim() === '' || indent > blockIndent) continue;
      blockIndent = null;
    }
    // `key: |`, `key: >-`, `key: |2`: everything indented under this line is scalar
    // text, so nothing inside it is a workflow step.
    if (/^[ \t]*[^\s#][^:]*:[ \t]*[|>][0-9]?[-+]?[ \t]*$/.test(line)) {
      blockIndent = indent;
      continue;
    }
    const match = /^[ \t]*-[ \t]+run:[ \t]+node --test (tests\/[\w.-]+\.test\.mjs)/.exec(line);
    if (match) listed.push(match[1]);
  }
  return listed;
}

export function testFilesOnDisk(testsDir) {
  return readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => 'tests/' + name);
}

test('the CI workflow names every tests/*.test.mjs exactly once, and names none that is gone', () => {
  const listed = listedTestFiles(readFileSync(WORKFLOW, 'utf8'));
  const onDisk = testFilesOnDisk(path.join(root, 'tests'));
  const counted = new Map();
  for (const file of listed) counted.set(file, (counted.get(file) || 0) + 1);
  const missing = onDisk.filter((file) => !counted.has(file));
  const repeated = [...counted].filter(([, times]) => times > 1).map(([file]) => file).sort();
  const stale = [...counted.keys()].filter((file) => !onDisk.includes(file)).sort();
  assert.deepEqual(
    missing,
    [],
    'these test files exist but CI never runs them: ' + (missing.join(', ') || '(none)'),
  );
  assert.deepEqual(
    repeated,
    [],
    'the workflow runs these test files more than once: ' + (repeated.join(', ') || '(none)'),
  );
  assert.deepEqual(
    stale,
    [],
    'the workflow names test files that no longer exist: ' + (stale.join(', ') || '(none)'),
  );
});

test('a step line inside a run: block scalar does not count as listed', () => {
  const source = [
    '    steps:',
    '      - run: |',
    '          echo hi',
    '          - run: node --test tests/chat_page.test.mjs',
    '      - run: node --test tests/guide_page.test.mjs',
  ].join('\n');
  assert.deepEqual(listedTestFiles(source), ['tests/guide_page.test.mjs'],
    'a line inside a run: block scalar was counted as a real workflow step');
});

test('a step line inside a folded run: > block scalar does not count either', () => {
  const source = [
    '      - run: >',
    '          echo hi',
    '          - run: node --test tests/chat_page.test.mjs',
  ].join('\n');
  assert.deepEqual(listedTestFiles(source), [],
    'a line inside a folded run: block scalar was counted as a real workflow step');
});

test('the same step line spelled as a real step still counts', () => {
  const source = '      - run: node --test tests/chat_page.test.mjs\n';
  assert.deepEqual(listedTestFiles(source), ['tests/chat_page.test.mjs'],
    'a real indented step line was not counted as listed');
});
