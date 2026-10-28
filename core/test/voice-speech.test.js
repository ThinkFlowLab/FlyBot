import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { fenceUntrusted } from '../src/host/delivery.js'

// Voice mode reads a Bot's reply aloud, and a stored turn is framing plus words: the host's header,
// a reply's delegation trace and an untrusted fence are routing, not content. The speech text is read
// the one way a row reads a stored line — `readableLine(text, names)` in text.js — because
// `speechSynthesis` repeats what it is handed: a fence mark reaches the user's ears as
// `<untrusted message from="User"`, and a trace as "Chief → Product".

// delivery.js:41 writes `headerFor(...)\n` and then the body, or `fenceUntrusted(...)` around it.
const stored = (header, name, body) => `${header}\n${fenceUntrusted(name, body)}`

const text = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/text.js', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', write: false,
})
const { speechOf } = await import(`data:text/javascript;base64,${Buffer.from(text.outputFiles[0].text).toString('base64')}`)

// The names a conversation's roster carries: a trace hop is a real Bot name, and only a hop that is
// one is routing (#1408).
const NAMES = ['Chief', 'Product', 'Dev Lead', 'Dev-1']

test('a fenced stored reply is spoken as its words, never as its fence mark', () => {
  assert.equal(typeof speechOf, 'function', 'text.js must export the read-side chain the voice speaks through')
  const line = stored('[Message from User]', 'User', 'B踢后测4')
  const spoken = speechOf(line, NAMES)
  assert.equal(spoken, 'B踢后测4')
  assert.equal(spoken.includes('<untrusted'), false, 'no fence mark is read aloud')
  assert.equal(spoken.includes('from="'), false, 'no fence attribute is read aloud')
  assert.equal(spoken.includes('untrusted-message'), false, 'no fence name is read aloud')
})

test('a reply\'s multi-line delegation trace is routing, so it is not read aloud', () => {
  assert.equal(speechOf('Chief → Product\nB踢后测4', NAMES), 'B踢后测4')
  assert.equal(speechOf('Chief → Product\nB踢后测4', NAMES).includes('Chief → Product'), false)
  // A sentence that merely carries an arrow is not a trace, and is said in full.
  assert.equal(speechOf('B踢后测4 → 已完成', NAMES), 'B踢后测4 → 已完成')
})

test('#1405: the outline flattens a trace onto the words, so a Latin sentence is not read with its routing', () => {
  // The shape the outline stores — one line, trace and words sharing it, no newline after the
  // trace (core/test/inbound-ui.test.js pins that same string). A rule that needs the trace to
  // end at a line break never fires here, and `speechSynthesis` says the routing out loud.
  assert.equal(speechOf('Chief → 助手 Hi! Message received.', ['Chief', '助手']), 'Hi! Message received.')
})

test('#1405: the same flat shape in front of a Chinese body is not read either', () => {
  assert.equal(speechOf('Chief → Product B踢后测4', NAMES), 'B踢后测4')
  assert.equal(speechOf('Chief → Dev Lead → Dev-1 点头', NAMES), '点头')
})

test('#1408: an ordinary arrow line keeps its words, as the row reads it', () => {
  // The blind flatten this issue first used would read `Settings → Models 页面` as "页面";
  // the shared name-aware reader keeps a line whose hops are not Bot names whole.
  assert.equal(speechOf('Settings → Models 页面', NAMES), 'Settings → Models 页面')
  assert.equal(speechOf('B踢后测4 → 已完成', NAMES), 'B踢后测4 → 已完成')
  // With no names nothing that merely looks like a trace is removed: the voice passes the roster.
  assert.equal(speechOf('Chief → 助手 Hi there'), 'Chief → 助手 Hi there')
})

test('a line that was never fenced is read byte for byte as it was', () => {
  for (const line of ['B踢后测4', 'hello there', 'It costs $5.']) assert.equal(speechOf(line, NAMES), line)
})

test('the rest of what the voice says is unchanged: markdown is words', () => {
  assert.equal(speechOf('**bold** and `code`', NAMES), 'bold and code')
  assert.equal(speechOf('see [the issue](https://example.com/1)', NAMES), 'see the issue')
  assert.equal(speechOf('```\nconst a = 1\n```', NAMES), '')
  assert.equal(speechOf('  spaced\t\tout  ', NAMES), 'spaced out')
})

test('voice.js speaks through text.js, not through a chain of its own', () => {
  const voice = readFileSync(new URL('../src/client/voice.js', import.meta.url), 'utf8')
  assert.match(voice, /import \{[^}]*\bbotNames\b[^}]*\bspeechOf\b[^}]*\} from '\.\/text\.js'/, 'the speech text and the conversation names come from the read side')
  assert.match(voice, /const spoken = speechOf\(text, botNames\(roster\)\)/, 'one chain: the voice hands the read side its names')
  assert.equal(/plainSpeech/.test(voice), false, 'the voice keeps no second reading of its own')
  assert.equal(/stripHeader\(text\)/.test(voice), false, 'the header, the trace and the fence are read once, not by the voice')
})
