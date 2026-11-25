import assert from 'node:assert/strict';
import test from 'node:test';
import {compareDocumentLines, mergeStudioDraft} from '../flybot_workspace/static/artifacts/studio-merge.mjs';

const doc = (body, title = '共同大纲') => ({title, body});
const merge = (base, local, remote) => mergeStudioDraft(doc(base), doc(local), doc(remote))?.body ?? null;

test('saved version comparison preserves exact lines and describes changes after a reorder', () => {
  const historical = '计划  \r\n初稿\n交付\n验证';
  const current = '计划  \r\n交付\n初稿\n验证完成';
  const result = compareDocumentLines(historical, current);
  assert.equal(result.before.join(''), historical);
  assert.equal(result.after.join(''), current);
  const replay = [...result.before];
  for (const {from, to, items} of result.edits.toReversed()) replay.splice(from, to - from, ...items);
  assert.equal(replay.join(''), current);
  assert.deepEqual(compareDocumentLines(historical, historical).edits, []);

  const before = '甲\n'.repeat(1500), after = '乙\n'.repeat(1500);
  const bounded = compareDocumentLines(before, after);
  assert.equal(bounded.edits, null);
  assert.equal(bounded.before.join(''), before);
  assert.equal(bounded.after.join(''), after);
});

test('combines several disjoint edits and preserves exact whitespace and line endings', () => {
  const base = '计划  \r\n版本 1\n\n\t交付\n验证\r备注';
  const local = '计划  \r\n版本 2\n\n\t交付\n验证通过\r备注';
  const remote = '计划  \r\n版本 1\n\n\t交付周三\n验证\r备注\r\n签字\t';
  const expected = '计划  \r\n版本 2\n\n\t交付周三\n验证通过\r备注\r\n签字\t';
  assert.equal(merge(base, local, remote), expected);
  assert.equal(merge(base, remote, local), expected);
});

test('merges independent changes within a line at Unicode code-point boundaries', () => {
  assert.equal(
    merge('\t😀 draft · 中文  \r\nlast', '\t🌿 draft · 中文  \r\nlast', '\t😀 draft · 完成  \r\nlast'),
    '\t🌿 draft · 完成  \r\nlast',
  );
  assert.equal(merge('Red far from end', 'Blue far from end', 'Red far from end today'), 'Blue far from end today');
});

test('keeps identical changes once, including line insertion and concurrent edit in another block', () => {
  assert.equal(
    merge('First\nSecond\nThird', 'First\nshared\nSecond revised\nThird', 'First\nshared\nSecond\nThird revised'),
    'First\nshared\nSecond revised\nThird revised',
  );
  assert.equal(merge('', 'same', 'same'), 'same');
  assert.equal(merge('a\nb\nc', 'a\nc', 'a\nc'), 'a\nc');
  assert.equal(merge('alpha\nbravo\ncharlie\n', 'alpha\ncharlie\n',
    'alpha\nbravo\ninsert remote\ncharlie\n'), 'alpha\ninsert remote\ncharlie\n');
});

test('detects true overlap, incompatible insertion at the same location, and contested repeats', () => {
  assert.equal(merge('one two three', 'one four three', 'one five three'), null);
  assert.equal(merge('a\nb\nc', 'a\nc', 'a\nfixed\nc'), null);
  assert.equal(merge('lead\ntail\n', 'lead\nleft\ntail\n', 'lead\nright\ntail\n'), null);
  assert.equal(merge('X\nX\nX\nend', 'X\nX\nend', 'X\nB\nX\nend'), null);
  assert.equal(merge('', 'left', 'right'), null);
  assert.equal(merge('first\nA\nB\nlast', 'first\nB\nA\nlast', 'first\nchanged A\nB\nlast'), null);
});

test('keeps titles atomic while allowing a title edit and body edit to coexist', () => {
  const base = doc('初稿');
  const own = doc('初稿', '编辑的标题');
  const remote = doc('第二段');
  assert.deepEqual(mergeStudioDraft(base, own, remote), doc('第二段', '编辑的标题'));
  assert.equal(mergeStudioDraft(base, own, doc('更多', '远端不同标题')), null);
  assert.deepEqual(mergeStudioDraft(doc(''), doc(''), doc('first')), doc('first'));
  assert.deepEqual(base, doc('初稿'));
});

test('uses line anchors for larger documents and never truncates a completed merge', () => {
  const base = Array.from({length:2000}, (_, i) => 'question ' + i + '\n').join('');
  const local = base.replace('question 7\n', 'local seven\n').replace('question 1699\n', 'local last\n');
  const remote = base.replace('question 200\n', 'remote two hundred\n').replace('question 1331\n', 'remote odd\n');
  assert.equal(merge(base, local, remote),
    local.replace('question 200\n', 'remote two hundred\n').replace('question 1331\n', 'remote odd\n'));
  const full = 'a'.repeat(59_998);
  assert.equal(merge(full, '12' + full, full + '34'), null);
  assert.equal(mergeStudioDraft(doc(full), doc('x'.repeat(60_001)), doc('remote')), null);
});

test('reports an unresolved draft when the diff exceeds its work allowance', () => {
  const base = 'x'.repeat(6000);
  assert.equal(merge(base, 'l' + base.slice(1, -1) + 'l', 'r' + base.slice(1, -1) + 'r'), null);
});
