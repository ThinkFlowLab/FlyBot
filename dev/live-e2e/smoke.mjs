// The keyless browser smoke (#2565): the same FlyBot web adapter, the same bench and the
// same evidence path as the #204 suite, against the scripted mock instead of a real model.
// The four #204 tasks cannot run here — the mock answers a task prompt with a canned
// acknowledgement and writes no files — so these checks assert only what a scripted model
// can drive: a message goes in through the composer, a reply comes out, and both survive a
// reload. That is the class of regression the repository had no browser-level check for.
//
// The message is one of the mock's scripted commands (`想想`), whose reply does not echo
// the message: that keeps "a reply appeared" distinguishable from "the user's own bubble is
// rendered", which is the difference between a UI that delivered and a UI that only echoed.
// Assertions never compare the reply's wording, so a mock edit cannot make this pass or fail.
export class SmokeError extends Error {}

const fail = message => { throw new SmokeError(message) }

export const MESSAGE = '想想'

// Same result shape as scenarios.mjs (id, title, outcome, problems, durationMs) so the
// runner's report, budgets and classification stay one code path.
export async function runSmoke(adapter, { checkMs, betweenChecks }) {
  const checks = []
  let stopped
  const step = async (id, title, run) => {
    const entry = { id, title, problems: [] }
    checks.push(entry)
    const started = performance.now()
    try { await run() } catch (error) { entry.problems.push(error.message) }
    entry.durationMs = performance.now() - started
    const verdict = betweenChecks ? await betweenChecks(entry) : undefined
    if (verdict?.stop) { stopped = verdict.reason ?? 'stopped between checks'; return false }
    return true
  }
  const replyLines = lines => lines.filter(line => line.who !== 'user')
  const mentionsMessage = lines => lines.some(line => line.who === 'user' && line.text.includes(MESSAGE))

  if (!await step('message-and-reply', 'a message sent through the composer gets a reply beside it', async () => {
    await adapter.sendTask(MESSAGE)
    await adapter.settle(checkMs)
    const lines = await adapter.conversationLines()
    if (!mentionsMessage(lines)) fail(`the sent message is not in the conversation: ${MESSAGE}`)
    if (replyLines(lines).length === 0) fail('no reply is visible beside the message')
  })) return { results: finish(), stopped }

  await step('survive-reload', 'a reload keeps the message and the reply', async () => {
    await adapter.reload()
    const lines = await adapter.conversationLines()
    if (!mentionsMessage(lines)) fail('after reload the sent message is gone from the conversation')
    if (replyLines(lines).length === 0) fail('after reload no reply is visible')
  })

  function finish() {
    return checks.map(({ problems, ...entry }) => ({ ...entry, outcome: problems.length === 0 ? 'pass' : 'assertion_failed', problems }))
  }
  return { results: finish(), stopped }
}
