// What a chat says about turns that died before writing a word (#1044). The host marks those `ended`
// entries `silent` and counts the streak at the same place; this turns the snapshot the client already
// has into the lines a chat draws. Kept free of React so both the bundle and the tests can read it.
import { failureSentence } from './failure-copy.js'

export const FAILURE_LINES_SHOWN = 3

export const failureLines = (snapshot, place, t, limit = FAILURE_LINES_SHOWN) => {
  const ended = Array.isArray(snapshot?.ended) ? snapshot.ended : []
  return ended
    .filter(entry => entry?.silent === true && (entry.roomId ?? entry.sessionId) === place)
    .slice(-limit)
    .map(entry => ({
      id: `turn-failure-${entry.id}`,
      // A turn cut off at the output limit did run (#2679): it gets its own sentence, because "could not
      // run" would name a failure nobody saw. The stored failure text can be a provider's JSON body cut
      // mid-sentence; `failureSentence` says that same fact in words that name what to change (#1347).
      text: entry.limited === true
        ? t('The reply was cut off at the model\'s output limit')
        : t('Could not run: {error}', { error: entry.failed === undefined ? t('the model call failed') : failureSentence(entry.failed, t) }),
      ...(Number(entry.streak) > 1 ? { streak: Number(entry.streak) } : {}),
    }))
}
