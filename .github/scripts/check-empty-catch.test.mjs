import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { scanSource, scanTree } from './check-empty-catch.mjs'

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

test('the shipped sources carry no bare catch', () => {
  assert.deepEqual(scanTree(join(import.meta.dirname, '..', '..')), [])
})
