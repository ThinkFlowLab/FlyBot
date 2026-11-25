import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');

test('CI runs all web tests and the compose planner in one test invocation', () => {
  assert.match(
    workflow,
    /^ {6}- run: node --test tests\/\*\.test\.mjs manager\/compose-planner\/compose-command-planner\.test\.js$/m,
  );
});

test('CI runs the same required suites on pull requests and merge groups', () => {
  assert.match(workflow, /^ {2}pull_request:$/m);
  assert.match(workflow, /^ {2}merge_group:\n {4}types: \[checks_requested\]$/m);
  assert.match(workflow, /^ {4}name: FlyBot required checks\n {4}if: \$\{\{ always\(\) \}\}$/m);
});
