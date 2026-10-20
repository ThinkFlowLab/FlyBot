import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { holdComposerLabel } from '../src/client/composer-label.js'

// jsdom comes from the DSH harness, like the dsh packages (test/harness-resolve.mjs sets DSH_HARNESS).
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS, 'package.json'))('jsdom')

// The shell's own composer copy (dsh-client-ui-conversation: placeholder.hero / placeholder.default).
const HERO = 'Describe what you want to build, / commands, @ files or sessions'
const CODING = 'Message or run a task, / commands, @ files or sessions'
const CODING_WORDS = /build|commands|@ files|sessions|run a task/

// The composer the shell renders: the input carries the copy as aria-label and data-placeholder,
// and an aria-hidden placeholder element shows it (styles.js draws --bt-placeholder over it).
function composer(doc, copy) {
  const el = doc.createElement('div')
  el.setAttribute('data-composer-input', '')
  el.setAttribute('role', 'textbox')
  el.setAttribute('aria-label', copy)
  el.setAttribute('data-placeholder', copy)
  return el
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const shown = (doc) => {
  const el = doc.querySelector('[data-composer-input]')
  return { aria: el.getAttribute('aria-label'), placeholder: el.getAttribute('data-placeholder'), css: JSON.parse(doc.body.style.getPropertyValue('--bt-placeholder')) }
}

test('#499: a friend\'s Bot chat reads "Message <Bot (owner)>" from the first paint, before and after a send', async () => {
  const { window } = new JSDOM('<!doctype html><body><main></main></body>')
  const doc = window.document
  const label = 'Message Chief (SelfA1233)'
  // First open: the shell renders its new-session hero copy.
  doc.querySelector('main').append(composer(doc, HERO))
  const release = holdComposerLabel(doc, label)
  // Synchronously, as in the header's layout effect: nothing is painted with the hero copy.
  assert.deepEqual(shown(doc), { aria: label, placeholder: label, css: label })
  // A send: the shell re-renders the same input with its coding copy.
  const input = doc.querySelector('[data-composer-input]')
  input.setAttribute('aria-label', CODING)
  input.setAttribute('data-placeholder', CODING)
  await settle()
  assert.deepEqual(shown(doc), { aria: label, placeholder: label, css: label })
  // The shell mounts a fresh composer (phase change or reload of the view).
  input.replaceWith(composer(doc, CODING))
  await settle()
  assert.deepEqual(shown(doc), { aria: label, placeholder: label, css: label })
  for (const value of Object.values(shown(doc))) assert.doesNotMatch(value, CODING_WORDS)
  // Leaving the chat hands the shell its own latest copy back and stops watching.
  release()
  assert.equal(doc.querySelector('[data-composer-input]').getAttribute('aria-label'), CODING)
  doc.querySelector('[data-composer-input]').setAttribute('aria-label', HERO)
  await settle()
  assert.equal(doc.querySelector('[data-composer-input]').getAttribute('aria-label'), HERO)
})

test('#499: the next chat\'s label takes over without a flash of the previous one', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>')
  const doc = window.document
  doc.body.append(composer(doc, HERO))
  const first = holdComposerLabel(doc, 'Message Writer')
  first()
  const second = holdComposerLabel(doc, 'Message Chief (SelfB1233)')
  assert.equal(shown(doc).aria, 'Message Chief (SelfB1233)')
  await settle()
  assert.equal(shown(doc).placeholder, 'Message Chief (SelfB1233)')
  second()
})
