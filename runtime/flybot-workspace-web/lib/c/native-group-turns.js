import { setTimeout as delay } from 'node:timers/promises'

const TURN_ID = /^otnt_[0-9A-HJKMNP-TV-Z]{26}$/
const MAX_TEXT = 4000
const TURN_DEADLINE = 245_000
const MAX_WORKERS = 4

const transient = new Set(['social/unreachable', 'social/http_502', 'social/http_503', 'social/http_504'])

async function retry(call, signal) {
  for (const wait of [200, 800, 1600, null]) {
    signal.throwIfAborted()
    try { return await call() }
    catch (error) {
      if (!transient.has(error?.code) || wait === null) throw error
      await delay(wait, undefined, {signal})
    }
  }
}

export function nativeGroupTurns({raw, turn, exchangePath, signal, report}) {
  const pending = new Map()
  const workers = new Map()

  async function execute({room, bot, text, signal:roundSignal, callKey}) {
    const cancellation = AbortSignal.any([signal, roundSignal, AbortSignal.timeout(TURN_DEADLINE)])
    cancellation.throwIfAborted()
    if (!bot.remote) return turn(bot.flybotWorkspace.agent_id, text, cancellation)
    const source = room.flybotWorkspace.native_exchange.id
    const path = exchangePath(room, source) + '/turns'
    const receipt = await retry(() => raw.post(path, {
      owner_id:bot.owner_id, agent_ref:bot.agent_ref, call_key:callKey, prompt:text.slice(-64000).toWellFormed(),
    }), cancellation)
    if (!TURN_ID.test(receipt?.id)) throw new Error('Invalid native group turn receipt')
    cancellation.throwIfAborted()
    let result = receipt.result
    if (!result) {
      const {promise, resolve, reject} = Promise.withResolvers()
      const stop = () => reject(cancellation.reason)
      pending.set(receipt.id, {source, resolve})
      cancellation.addEventListener('abort', stop, {once:true})
      try { result = await promise }
      finally {
        pending.delete(receipt.id)
        cancellation.removeEventListener('abort', stop)
      }
    }
    if (result?.outcome === 'message' && typeof result.text === 'string') return {text:result.text,turnId:receipt.id}
    if (result?.outcome === 'pass') return '[PASS]'
    throw new Error('Remote group Bot did not complete its turn')
  }

  async function poll(room, exchange) {
    if (![...pending.values()].some(item => item.source === exchange.id)) return
    const response = await raw.get(exchangePath(room, exchange.id) + '/turns')
    for (const receipt of response.items ?? []) {
      const waiting = pending.get(receipt.id)
      if (waiting?.source === exchange.id && receipt.result) waiting.resolve(receipt.result)
    }
  }

  async function run(task, cancel) {
    const path = '/v1/ot/native-group-turns/' + task.id
    if (task.state === 'running') {
      // The single account runtime restarted before completion, or lost the
      // start response. There is no model call to resume in this process.
      await retry(() => raw.post(path, {action:'finish',outcome:'failed'}), cancel)
      return
    }
    const claim = await retry(() => raw.post(path, {action:'start'}), cancel)
    if (claim?.started !== true) return
    let outcome
    let text
    try {
      const reply = await turn(task.agent_ref, task.prompt, cancel)
      text = typeof reply === 'string' ? reply.trim().slice(0, MAX_TEXT).toWellFormed() : ''
      outcome = !text || /^\s*[[【(（]\s*pass\s*[\]】)）][.。!！]?$/i.test(text) ? 'pass' : 'message'
    } catch (error) {
      if (cancel.aborted) return
      report(error)
      outcome = 'failed'
    }
    await retry(() => raw.post(path, {action:'finish', outcome, ...(outcome === 'message' ? {text} : {})}), cancel)
  }

  function accept(tasks) {
    if (signal.aborted || typeof turn !== 'function') return
    const reachable = new Set(tasks.map(item => item.id))
    for (const [id, control] of workers) if (!reachable.has(id)) control.abort()
    for (const task of tasks) {
      if (workers.size >= MAX_WORKERS) break
      if (!['queued', 'running'].includes(task.state) || !TURN_ID.test(task.id) || workers.has(task.id) ||
          typeof task.agent_ref !== 'string' || typeof task.prompt !== 'string') continue
      const control = new AbortController()
      const cancel = AbortSignal.any([signal, control.signal, AbortSignal.timeout(TURN_DEADLINE)])
      workers.set(task.id, control)
      void run(task, cancel).catch(error => { if (!cancel.aborted) report(error) }).finally(() => workers.delete(task.id))
    }
  }

  return {execute, poll, accept}
}
