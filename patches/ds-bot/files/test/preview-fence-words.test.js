// A preview is still the line someone said (#1347): the fence is data, but so are the words on either
// side of it. A complete wrap that sits in the middle of a line must lose its markers and keep the
// sentence around it — including the reply that quotes a remote line and then answers it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleText } from '../src/shared/preview.js'
import { previewOf, readableLine } from '../src/client/text.js'

test('words before and after a complete wrap stay in the line', () => {
  assert.equal(visibleText('He said <untrusted-message from="Coder">quoted</untrusted-message> then left'), 'He said quoted then left')
  assert.equal(visibleText('before <untrusted-message from="Coder">a</untrusted-message>'), 'before a')
  assert.equal(visibleText('<untrusted-message from="Coder">a</untrusted-message> after'), 'a after')
})

test('every complete wrap in one line is unwrapped, not only the outermost pair', () => {
  assert.equal(visibleText('a <untrusted-message from="C">one</untrusted-message> b <untrusted-message from="D">two</untrusted-message> c'), 'a one b two c')
})

test('a wrap on its own still reads as just its words', () => {
  assert.equal(visibleText('<untrusted-message from="Coder">\nhello there\n</untrusted-message>'), 'hello there')
})

test('a broken marker fragment still loses the marker and keeps the words', () => {
  assert.equal(visibleText('kick from="User"> B test 4 >'), 'kick B test 4 >')
  assert.equal(visibleText('before <untrusted-message from="C">x'), 'before x')
})

test('a reply that quotes a remote line shows the reply, not only the quote', () => {
  const reply = 'He said <untrusted-message from="Coder">\nplease rebase the branch\n</untrusted-message> and I answered that it is done.'
  const line = readableLine(reply)
  assert.equal(line, 'He said please rebase the branch and I answered that it is done.')
  assert.doesNotMatch(line, /untrusted|from="/)

  const list = { projectionsBySession: { s1: { values: { turnOutline: [{ turn: 1, response: reply }] } } }, byId: {} }
  assert.equal(previewOf(list, 's1'), line)
})
