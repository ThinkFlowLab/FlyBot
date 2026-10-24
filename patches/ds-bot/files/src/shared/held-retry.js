// #968: can a failed hold ever succeed? One answer, one place.
//
// A failed send is drawn on three surfaces: the reply's own bubble (`src/client/held-reply.js`), the
// approval card in the session dock (`src/client/flybot-slots.js`), and the social plugin's dock
// (`plugins/social/client.js`). The sender that knows its failure is terminal marks it — `noRetry: true`
// on the stored approval (#954), which `heldRepliesOf` turns into `retry: false` — and the same rule used
// to exist in three readers, two of which read nothing at all.
//
// The two spellings mean the same thing, and a record written before #954 carries neither: it only has
// the error sentence the sender produced ("… is no longer shared with you … Ask its owner for a new
// invite."). So the derivation from those sentences lives here too, not in a renderer: a view asks this
// function, and no other file matches a reason string.
const TERMINAL = [
  // A friend's Bot that is gone or no longer shared (plugins/social/src/social.js: botGoneError / notSharedError).
  /no such remote bot/i,
  /is not shared with your Bots/i,
  /is no longer shared with you/i,
  // Only chat.public is a share taken back (#971). capability_not_granted is Bot Social's generic
  // "peer has not granted <capability>" code, so the bare code does not decide (#988).
  /has not granted chat\.public/i,
  // The codes, when a transport passes the code instead of its sentence.
  /bot_not_shared/i,
  /bot_not_found/i,
]

// `false` = this card must not offer Retry; `true` = Retry is still meaningful (429, timeout, a changed
// file, a paused Bot). A record with no failure text and no flag keeps the old behaviour: Retry.
export const canRetry = (record) => {
  if (!record) return true
  if (record.retry === false || record.noRetry === true) return false
  const said = `${record.error ?? ''} ${record.code ?? ''}`
  return !TERMINAL.some((reason) => reason.test(said))
}
