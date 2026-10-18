import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { maskSource, scanPromiseSource, scanPromiseTree, scanSource, scanTree } from './check-empty-catch.mjs'

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

test('scanSource: the promise form, plain blocks and other identifiers are out of scope here', () => {
  assert.deepEqual(scanSource('a.js', 'save().catch(() => {})\n'), [])
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

const promise = source => scanPromiseSource('a.js', source)

test('promise form: a discarded `.catch(() => {})` needs `void` or a one-line reason (#213)', () => {
  assert.deepEqual(promise('save().catch(() => {})\n'), ['a.js:1'])
  assert.deepEqual(promise('await save().catch(() => {})\n'), ['a.js:1'])
  assert.deepEqual(promise('await save().catch((e) => {})\n'), ['a.js:1'])
  assert.deepEqual(promise('await save().catch(() => undefined)\n'), ['a.js:1'])
  assert.deepEqual(promise('await save().catch(() => null)\n'), ['a.js:1'])
  assert.deepEqual(promise('if (fresh) await unlink(path).catch(() => {})\n'), ['a.js:1'])
  assert.deepEqual(promise('for (const id of ids) await drop(id).catch(() => {})\n'), ['a.js:1'])
  assert.deepEqual(promise('x.then((v) => { use(v) }).catch(() => {})\n'), ['a.js:1'], 'a callback in the chain is not a used value')
  assert.deepEqual(promise('async function f() {\n  await a()\n  await b()\n    .catch(() => {})\n}\n'), ['a.js:4'], 'a multi-line chain is one statement')
  assert.deepEqual(promise('run(() => { save().catch(() => {}) })\n'), ['a.js:1'], 'a statement in a callback body is dropped too')
})

test('promise form: `void` or a reason comment is the answer', () => {
  assert.deepEqual(promise('void save().catch(() => {})\n'), [])
  assert.deepEqual(promise('if (fresh) void save().catch(() => {})\n'), [])
  assert.deepEqual(promise('void save().then(() => b()).catch(() => {})\n'), [])
  assert.deepEqual(promise('await unlink(path).catch(() => { /* may not exist */ })\n'), [])
  assert.deepEqual(promise('await unlink(path).catch(() => {}) // may not exist\n'), [])
  assert.deepEqual(promise('// may not exist\nawait unlink(path).catch(() => {})\n'), [])
  assert.deepEqual(promise('/* may not exist */\nawait unlink(path).catch(() => {})\n'), [])
  assert.deepEqual(promise('await unlink(path).catch(() => {})\n\n// a later comment is not its reason\n'), ['a.js:1'])
})

test('promise form: a fallback value that is used stays allowed', () => {
  assert.deepEqual(promise('const info = await load().catch(() => undefined)\n'), [])
  assert.deepEqual(promise('const info = await load().catch(() => null)\n'), [])
  assert.deepEqual(promise('info = await load().catch(() => undefined)\n'), [])
  assert.deepEqual(promise('return load().catch(() => undefined)\n'), [])
  assert.deepEqual(promise('if ((await load().catch(() => undefined))?.ok) go()\n'), [])
  assert.deepEqual(promise('use(await load().catch(() => undefined))\n'), [])
  assert.deepEqual(promise('const member = known ?? await register(bot).catch(() => undefined)\n'), [])
  assert.deepEqual(promise('const refresh = () => call(x).catch(() => {})\n'), [])
  assert.deepEqual(promise('writing = run.catch(() => {})\n'), [])
  assert.deepEqual(promise('list.map(item => item.done.catch(() => {}))\n'), [])
  assert.deepEqual(promise('const v = ok ? await a().catch(() => undefined) : 1\n'), [])
})

test('promise form: handlers that do something, and literals, are not reported', () => {
  assert.deepEqual(promise('await save().catch(() => log())\n'), [])
  assert.deepEqual(promise('await save().catch((e) => { warn(e) })\n'), [])
  assert.deepEqual(promise('// await save().catch(() => {})\n'), [])
  assert.deepEqual(promise("const hint = 'save().catch(() => {})'\n"), [])
})

test('the shipped sources carry no bare discarded `.catch` (#213)', () => {
  assert.deepEqual(scanPromiseTree(join(import.meta.dirname, '..', '..')), [])
})

test('the shipped sources carry no bare catch', () => {
  assert.deepEqual(scanTree(join(import.meta.dirname, '..', '..')), [])
})
