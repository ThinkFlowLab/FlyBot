// What a chat says about turns that died before writing a word (#1044). The host marks those `ended`
// entries `silent` and counts the streak at the same place; this turns the snapshot the client already
// has into the lines a chat draws. Kept free of React so both the bundle and the tests can read it.

export const FAILURE_LINES_SHOWN = 3

export const failureLines = (snapshot, place, t, limit = FAILURE_LINES_SHOWN) => {
  const ended = Array.isArray(snapshot?.ended) ? snapshot.ended : []
  return ended
    .filter(entry => entry?.silent === true && (entry.roomId ?? entry.sessionId) === place)
    .slice(-limit)
    .map(entry => ({
      id: `turn-failure-${entry.id}`,
      text: t('Could not run: {error}', { error: entry.failed ?? t('the model call failed') }),
      ...(Number(entry.streak) > 1 ? { streak: Number(entry.streak) } : {}),
    }))
}
