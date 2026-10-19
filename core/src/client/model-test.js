// Test connection (#409): one tiny real request on the Bot's own model route. The
// host answers with a code only, never the provider's text, which can echo a key.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

const FAILURE_COPY = {
  NO_MODEL: 'Pick a model first.',
  NO_KEY: 'This model has no API key yet. Set one up in the model settings.',
  AUTH: 'The API key was rejected. Check it in the model settings.',
  QUOTA: 'The account is out of quota.',
  RATE_LIMIT: 'Too many requests right now. Try again in a moment.',
  TIMEOUT: 'The model did not answer within 30 seconds.',
  NOT_SERVED: 'This model is not available now. Check its provider in the model settings.',
  MODEL_NOT_FOUND: 'The provider does not know this model. Check the model name.',
  TRANSPORT: 'Could not reach the model service. Check the endpoint address and your network.',
  SERVER: 'The model service failed. Try again later.',
  INVALID_REQUEST: 'The model service refused the request. Check the endpoint and the model.',
  UNKNOWN: 'The test failed.',
}

// The words for one test outcome: `{ ok, text, code? }`.
export function testOutcome(result, modelName) {
  if (result?.ok === true) {
    const seconds = typeof result.ms === 'number' ? Math.max(0.1, Math.round(result.ms / 100) / 10) : undefined
    return { ok: true, text: seconds === undefined ? t('Works. {model} answered.', { model: modelName }) : t('Works. {model} answered in {seconds} s.', { model: modelName, seconds }) }
  }
  const code = Object.hasOwn(FAILURE_COPY, result?.code) ? result.code : 'UNKNOWN'
  return { ok: false, code, text: t(FAILURE_COPY[code]) }
}

export const testModel = id => call('test-model', { id })

// A row under the model picker. `test` is the request, swappable for tests.
export function ModelTestRow({ bot, modelName, test = testModel }) {
  const [state, setState] = useState({ busy: false, outcome: undefined })
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  // A result belongs to the model it ran on; picking another clears it.
  useEffect(() => { setState({ busy: false, outcome: undefined }) }, [bot.id, bot.model])
  const start = () => {
    if (state.busy) return
    setState({ busy: true, outcome: undefined })
    Promise.resolve().then(() => test(bot.id)).then(
      result => testOutcome(result, modelName ?? result?.ref ?? ''),
      error => ({ ok: false, text: String(error?.message ?? t('The test failed.')) }),
    ).then((outcome) => { if (live.current) setState({ busy: false, outcome }) })
  }
  const { busy, outcome } = state
  return h('div', { className: 'bt-set-row bt-bs-row bt-model-test' },
    h('span', { className: 'bt-set-copy' },
      h('span', { className: 'bt-set-hint' }, t('Sends one short request to this model. It may be billed.')),
      h('span', { className: 'bt-model-test-result', role: 'status', 'aria-live': 'polite', 'data-ok': outcome === undefined ? undefined : String(outcome.ok) },
        busy ? t('Testing…') : outcome === undefined ? null : outcome.text,
        outcome?.code ? h('code', { className: 'bt-model-test-code' }, outcome.code) : null)),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, 'aria-busy': busy || undefined, onClick: start }, t('Test connection')))
}

export const MODEL_TEST_CSS = `
.bt-model-test-result{font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-model-test-result:empty{display:none}
.bt-model-test-result[data-ok=true]{color:#1a7f37}
.bt-model-test-result[data-ok=false]{color:#c21d2e}
.bt-model-test-code{margin-left:6px;font-size:11px;color:var(--bt-ink-3)}
`
