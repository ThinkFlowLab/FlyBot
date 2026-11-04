// Deterministic model transport. The DSH agent and bash tool still execute for real.
import { createServer } from 'node:http'

export const probeCommand = `node --input-type=module -e 'import {writeFileSync} from "node:fs"; import assert from "node:assert/strict"; writeFileSync("probe.mjs","export const add = (a,b) => a+b;\\n"); const {add}=await import("./probe.mjs"); assert.equal(add(2,3),5); writeFileSync("proof.json",JSON.stringify({cwd:process.cwd(),test:"passed",sum:add(2,3)})); console.log("M0_TEST_PASSED")'`

export function mockModel(observations, { reply } = {}) {
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.endsWith('/messages')) {
      response.writeHead(404).end()
      return
    }
    try {
      let raw = ''
      for await (const chunk of request) {
        raw += chunk
        if (raw.length > 4_000_000) throw new Error('request-limit')
      }
      const body = JSON.parse(raw)
      const last = body.messages?.at(-1)?.content
      const result = Array.isArray(last) && last.some(block => block.type === 'tool_result')
      const tools = body.tools?.some(tool => tool.name === 'bash')
      const blocks = await reply?.({ body, result, tools }) ?? (tools && !result
        ? [{ type: 'tool_use', id: 'm0-shell', name: 'bash', input: { description: 'Verify isolated cwd, write code and run a test', command: probeCommand } }]
        : [{ type: 'text', text: 'OUTPUT proof: M0 execution finished; verify proof.json independently.' }])
      observations.push({ toolRequested: tools && !result, toolResult: Boolean(result),
        sessionHeader: Boolean(request.headers['x-deepseek-harness-session-id']) })
      const stop = blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn'
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'm0', type: 'message', role: 'assistant', model: body.model,
          content: blocks, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 30 } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
      event({ type: 'message_start', message: { id: 'm0', type: 'message', role: 'assistant', model: body.model,
        content: [], usage: { input_tokens: 100, output_tokens: 0 } } })
      for (const [index, block] of blocks.entries()) {
        event({ type: 'content_block_start', index, content_block: block.type === 'text'
          ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} } })
        event({ type: 'content_block_delta', index, delta: block.type === 'text'
          ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
        event({ type: 'content_block_stop', index })
      }
      event({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 30 } })
      event({ type: 'message_stop' })
      response.end()
    } catch {
      response.writeHead(400).end('Invalid mock request')
    }
  })
}
