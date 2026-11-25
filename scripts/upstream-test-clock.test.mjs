import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { target, transformAnnotationFixture, load } from './upstream-test-clock-loader.mjs';

const original = readFileSync(new URL(target), 'utf8');

test('upstream annotation fixture now settles with mock timers; overlay is identity', () => {
  const patched = transformAnnotationFixture(original);
  assert.equal(patched, original);
  assert.match(original, /t\.mock\.timers\.enable\(\{ apis: \['setTimeout'\] \}\)/);
  assert.match(original, /setImmediate\(resolve\)/);
  assert.match(original, /t\.mock\.timers\.tick\(0\)/);
});

test('overlay retains fixture bytes and rejects unexpected source changes', async () => {
  assert.equal((await load(target, {}, async () => ({ format: 'module', source: Buffer.from(original) }))).source, original);
  const other = { format: 'module' };
  assert.equal(await load('file:///other.test.js', {}, async () => other), other);
  assert.throws(() => transformAnnotationFixture(original + '\n'), /fixture changed/);
  assert.throws(() => transformAnnotationFixture(original.replace('tick(0)', 'tick(1)')), /fixture changed/);
});
