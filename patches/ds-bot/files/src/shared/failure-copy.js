// A failed turn's sentence a person can act on (#1347).
//
// The host keeps what the provider said, cut to a length that fits a card
// (`noteEnded` in host/turns.js). That text is a JSON body more often than not, so a real
// instance showed the Inbox as
//
//   404: {"code":"UnsupportedModel","message":"The requested model does not support …
//
// — cut off before the part that says what to do. The words below are the same fact in the
// reader's language: which setting is wrong, and where to change it. They are keyed on the
// provider's own `code` field, which is stable, not on the message text, which is not.
//
// Anything this does not recognise is returned unchanged: a failure nobody has mapped yet is
// still better shown as it came than replaced with a sentence that guessed.

// The provider code inside the failure text, from either shape the host may have stored:
// the raw JSON body, or `code: message`.
const providerCode = (text) => {
  const json = /"code"\s*:\s*"([A-Za-z0-9_.-]+)"/.exec(text)
  if (json) return json[1]
  const plain = /^([A-Za-z][A-Za-z0-9_.-]{2,40}):\s/.exec(text)
  return plain ? plain[1] : ''
}

// What is wrong and where to fix it, per provider code. `t` is the caller's translate, so the
// sentence is in the reader's language; the key is English, as everywhere else in the client.
const KNOWN = {
  UnsupportedModel: 'This model does not support that request. Pick another model in the Bot\'s settings.',
  ModelNotFound: 'The provider does not know this model. Check the model name in the Bot\'s settings.',
  ContextLengthExceeded: 'The conversation is longer than this model can read. Condense it, or pick a model with a larger window.',
  InvalidRequest: 'The model service refused the request. Check the model and the endpoint in the Bot\'s settings.',
  InsufficientQuota: 'The account is out of quota.',
  RateLimitExceeded: 'Too many requests right now. Try again in a moment.',
}

// `raw` is the stored failure text; `translate` turns a key into the reader's language. The fill after
// it is harmless where the translator already substituted, and keeps a caller without a locale service
// (or a test's identity translate) from showing a raw `{feature}`.
const fill = (text, params) => (params === undefined ? text : String(text).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)))

export function failureSentence(raw, translate = key => key) {
  const text = String(raw ?? '').trim()
  if (text === '') return text
  const key = KNOWN[providerCode(text)]
  if (key === undefined) return text
  // A refusal that names the feature is worth saying in that word, because the feature is what the
  // person has to stop asking for. The wording is the provider's, so it is quoted, not translated.
  const feature = /does not support\s+([a-z][a-z0-9 _-]{2,40})/i.exec(text)?.[1]?.trim()
  if (key !== KNOWN.UnsupportedModel || feature === undefined) return fill(translate(key), undefined)
  const withFeature = 'This model does not support {feature}. Pick another model in the Bot\'s settings.'
  return fill(translate(withFeature, { feature }), { feature })
}
