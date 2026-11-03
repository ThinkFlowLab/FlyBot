// #2247: a read-only window told the person to reload, and there was no reload entry. The
// sidebar's new Reload button asks for the team again. Two rules make that read useful, and
// they belong together: the request must carry no `since` (otherwise the host answers
// `unchanged`, with no team at all), and the answer must be drawn even though the revision did
// not move (otherwise the stale read-only sentence stays). Neither rule alone is enough: a
// skipped answer still drawn would be an empty roster, and a drawn answer still skipped is
// today's behaviour.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { stateRequest, stateAnswerIsStale } from './src/client/sources.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, Date, JSON, Promise, Symbol,
  require: (name) => {
    if (name === 'react') return { createElement: () => ({}) }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { stateRequest, stateAnswerIsStale } = module.exports

test('the poll asks for a revision delta; a reload asks for the whole team', () => {
  const known = { revision: 7, modelsKey: 'models-1' }
  const polled = stateRequest(known)
  assert.equal(polled.since, 7)
  assert.equal(polled.models, 'models-1')
  const fresh = stateRequest(known, { fresh: true })
  assert.equal(fresh.since, undefined, 'no `since`, or the host answers `unchanged` and sends no team')
  assert.equal(fresh.models, 'models-1')
  // An empty roster before the first pull sends no number either.
  assert.equal(stateRequest({ revision: undefined, modelsKey: undefined }).since, undefined)
})

test('a reload draws the same revision; the poll still skips it', () => {
  const current = { revision: 7, modelsKey: 'models-1', readOnly: 'open in another dsh' }
  const answer = { revision: 7, modelsKey: 'models-1', readOnly: null, bots: [] }
  assert.equal(stateAnswerIsStale(answer, current), true, 'the poll skips an unchanged revision')
  assert.equal(stateAnswerIsStale(answer, current, { fresh: true }), false, 'a reload draws it, which is how the sentence can clear')
  // An `unchanged` answer carries no team, so it is never indexed, reload or not.
  assert.equal(stateAnswerIsStale({ revision: 7, unchanged: true }, current, { fresh: true }), true)
  // A new revision is always drawn.
  assert.equal(stateAnswerIsStale({ revision: 8, modelsKey: 'models-1' }, current), false)
  // A new models key is drawn even at the same revision.
  assert.equal(stateAnswerIsStale({ revision: 7, modelsKey: 'models-2' }, current), false)
})
