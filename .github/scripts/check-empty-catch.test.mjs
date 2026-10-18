import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { maskSource, scanSource, scanTree } from './check-empty-catch.mjs'

test('scanSource: a catch block with no statement and no comment is a violation', () => {
  assert.deepEqual(scanSource('a.js', 'try { x() } catch {}\n'), ['a.js:1'])
  assert.deepEqual(scanSource('a.js', 'try { x() } catch (e) {}\n'), ['a.js:1'])
  assert.deepEqual(scanSource('a.js', 'try { x() } catch ({ message }) {}\n'), ['a.js:1'])
  assert.deepEqual(scanSource('a.js', 'try { x() } catch ({}) {}\n'), ['a.js:1'])
  assert.deepEqual(scanSource('a.js', 'try {\n  x()\n} catch {\n\n}\n'), ['a.js:3'])
})

test('scanSource: a comment in the block is the reason; statements handle the error', () => {
  assert.deepEqual(scanSource('a.js', 'try { x() } catch { /* racing unlink */ }\n'), [])
  assert.deepEqual(scanSource('a.js', 'try { x() } catch (e) { return }\n'), [])
  assert.deepEqual(scanSource('a.js', 'try { x() } catch {\n  // retries on the next poll\n}\n'), [])
})

test('scanSource: the promise form, plain blocks and other identifiers are out of scope', () => {
  assert.deepEqual(scanSource('a.js', 'void save().catch(() => {})\n'), [])
  assert.deepEqual(scanSource('a.js', 'for (;;) {}\nconst o = { catch: 1 }\n'), [])
})

test('scanSource: `catch {}` inside a comment, string, template or regex is not code (#213)', () => {
  assert.deepEqual(scanSource('a.js', '// never write try { x() } catch {} here\n'), [])
  assert.deepEqual(scanSource('a.js', '/* e.g. try { x() } catch (e) {} */\nconst a = 1\n'), [])
  assert.deepEqual(scanSource('a.js', "const hint = 'try { x() } catch {}'\n"), [])
  assert.deepEqual(scanSource('a.js', 'const hint = "catch (e) {}"\n'), [])
  assert.deepEqual(scanSource('a.js', 'const doc = `\n  try { x() } catch {}\n`\n'), [])
  assert.deepEqual(scanSource('a.js', 'const doc = `${a ? `catch {}` : b} and catch {}`\n'), [])
  assert.deepEqual(scanSource('a.js', 'const bare = /catch\\s*\\{\\}/g\n'), [])
  assert.deepEqual(scanSource('a.js', 'if (/catch {}/.test(line)) run()\n'), [])
})

test('scanSource: literals never hide a real bare catch, and braces in them do not end a block', () => {
  // A real one after every kind of literal, on the following lines.
  const tricky = [
    "const a = 'it\\'s } here', b = \"{\", c = `x ${'}'} y`, re = /[/}]/",
    'const half = total / 2 / count // a division, not a regex',
    'try { x() } catch {}',
  ].join('\n')
  assert.deepEqual(scanSource('a.js', tricky + '\n'), ['a.js:3'])
  // A `}` inside a string in the block is code, so the block is not empty, and it does
  // not close the block early either.
  assert.deepEqual(scanSource('a.js', "try { x() } catch { log('}') }\n"), [])
  // A comment still counts as the reason, a string-looking comment too.
  assert.deepEqual(scanSource('a.js', "try { x() } catch { /* 'gone' is fine */ }\n"), [])
  // A bare catch inside a template expression is code.
  assert.deepEqual(scanSource('a.js', 'const s = `${(() => { try { x() } catch {} })()}`\n'), ['a.js:1'])
  // An unclosed quote on a line is left as code: the next line is still scanned.
  assert.deepEqual(scanSource('a.js', "const odd = 1 ' 2\ntry { x() } catch {}\n"), ['a.js:2'])
})

test('maskSource keeps length and line breaks, blanks literals, and keeps comments in `commented`', () => {
  const source = "const s = 'a{b' // c}\nconst t = `x${y}z`\n"
  const { bare, commented } = maskSource(source)
  assert.equal(bare.length, source.length)
  assert.equal(bare.split('\n').length, source.split('\n').length)
  assert.doesNotMatch(bare, /a\{b|c\}/)
  assert.match(bare, /\$\{y\}/)
  assert.match(commented, /\/\/ c\}/)
  assert.doesNotMatch(commented, /a\{b/)
  // Astral characters count as two UTF-16 units, like String indexes.
  assert.equal(maskSource("const e = '😀'\n").bare.length, "const e = '😀'\n".length)
})

test('the shipped sources carry no bare catch', () => {
  assert.deepEqual(scanTree(join(import.meta.dirname, '..', '..')), [])
})
