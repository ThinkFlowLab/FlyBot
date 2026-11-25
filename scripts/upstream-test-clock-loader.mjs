// Owned test-only completion overlay; pinned vendor bytes/assertions stay intact.
// v0.3.9+ already drains the VM's cross-realm send with mock timers, so this
// overlay is an identity check: unexpected fixture changes still fail closed.
import { createHash } from 'node:crypto';
import {target as cleanupTarget,transformRestartFixture} from './upstream-test-cleanup-overlay.mjs';
export const target = new URL('../runtime/ds-bot-upstream/ds-bot/test/text-annotation.test.js', import.meta.url).href;
const expected = '3f832ee90adcbfd661b404d0c979b5f896a88402d21d49a233fbd1eaa0eb48f7';
const required = [
  "beforeEach(t => t.mock.timers.enable({ apis: ['setTimeout'] }))",
  'const drain = () => new Promise(resolve => setImmediate(resolve))',
  't.mock.timers.tick(0)',
];
export function transformAnnotationFixture(source) {
  if (createHash('sha256').update(source).digest('hex') !== expected)
    throw new Error('Upstream annotation fixture changed: review completion overlay, never silently patch it');
  for (const snippet of required) {
    if (!source.includes(snippet)) throw new Error('Unexpected completion fixture wiring');
  }
  return source;
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if(url===cleanupTarget)return {...result,source:transformRestartFixture(Buffer.from(result.source).toString('utf8'))};
  if (url !== target) return result;
  return { ...result, source: transformAnnotationFixture(Buffer.from(result.source).toString('utf8')) };
}
