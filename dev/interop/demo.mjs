import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pilot } from './harness.mjs'
import { FakeClock, MockPolicy, ScriptedRuntime, input, eventFor } from './mocks.mjs'

const dir = mkdtempSync(join(tmpdir(), 'flybot-interop-demo-'))
const runtime = new ScriptedRuntime()
const pilot = new Pilot({ dir, clock: new FakeClock(), policy: new MockPolicy(), runtime })
try {
  const task = pilot.enroll({ id: 'retry-analysis', actor: 'owner-a', from: 'flybot', to: 'opencode', input })
  const deliver = event => {
    const forward = ['request', 'answer'].includes(event.kind)
    pilot.receive(JSON.stringify(event), { server: 'mock-social', sender: forward ? 'flybot' : 'opencode', recipient: forward ? 'opencode' : 'flybot' })
    pilot.approve(event.eventId, forward ? 'owner-a' : 'owner-b', 'delivery', true)
    if (forward) pilot.approve(event.eventId, 'owner-b', 'execution', true)
  }
  const request = eventFor(task, 'request')
  deliver(request)
  const question = eventFor(task, 'question', { inReplyTo: request.eventId, payload: { text: 'Must cancellation stop the next retry?' } })
  deliver(question)
  const answer = eventFor(task, 'answer', { turnId: 'turn-2', seq: 2, inReplyTo: question.eventId, payload: { text: 'Yes. Never start another attempt after cancellation.' } })
  deliver(answer)
  deliver(eventFor(task, 'result', { turnId: 'turn-2', seq: 2, inReplyTo: answer.eventId, payload: { summary: 'Cancellation after the pre-check can race the awaited operation. Bound attempts, pass a cancellation signal to attempt, and recheck before each retry.', evidence: ['excerpt-1'] } }))
  const beforeAcceptance = pilot.task(task.id).status
  pilot.accept(task.id, 'owner-a')
  console.log(JSON.stringify({ evidence: 'offline-mock', owners: ['owner-a', 'owner-b'], beforeAcceptance, afterAcceptance: pilot.task(task.id).status, sessions: runtime.sessions.length, submittedTurns: runtime.submissions.length, realModelRequests: 0, realCost: 0, liveCompatibility: 'not tested' }, null, 2))
} finally { pilot.close(); rmSync(dir, { recursive: true, force: true }) }
