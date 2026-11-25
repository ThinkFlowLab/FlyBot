import assert from 'node:assert/strict';
import test from 'node:test';
import {inlineTokens, markdownToBlocks} from '../flybot_workspace/static/shell/markdown.mjs';
import {readMarkdownTable} from '../flybot_workspace/static/shell/markdown-table.mjs';

test('tables accept compact alignment separators and preserve the list that follows', () => {
  const source = '步骤 | 结果 | 备注\n- | :-: | --:\n甲 | 乙 | 丙\n- 后续 | 核对';
  const [table, list] = markdownToBlocks(source, {readTable:readMarkdownTable});
  assert.deepEqual(table, {
    type:'table', header:['步骤', '结果', '备注'], alignments:[null, 'center', 'right'], rows:[['甲', '乙', '丙']],
  });
  assert.deepEqual(list, {type:'ul', items:['后续 | 核对']});
});

test('cell-only line breaks preserve inline code and keep other tags as text', () => {
  const source = '**第一行<BR />第二行**<br/>`<br>` \\<br> <br title=x> <img src=x>';
  assert.deepEqual(inlineTokens(source, {cellBreaks:true}), [
    {type:'b', children:[{type:'text', text:'第一行'}, {type:'br'}, {type:'text', text:'第二行'}]},
    {type:'br'},
    {type:'code', text:'<br>'},
    {type:'text', text:' <br> <br title=x> <img src=x>'},
  ]);
  assert.deepEqual(inlineTokens('段落<br>正文'), [{type:'text', text:'段落<br>正文'}]);
});
