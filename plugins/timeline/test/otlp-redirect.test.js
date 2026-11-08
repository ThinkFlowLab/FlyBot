// #2687: the OTLP exporter treats a collector redirect as a failed export, never as a hop.
// Two local node:http servers, no external network: A is the configured collector, it answers
// a 307 that points at B (the other origin). The only credential in the test is TEST-TOKEN.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'

const TOKEN = 'TEST-TOKEN'

function recordingServer(onRequest) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString('utf8') })
      onRequest(req, res)
    })
  })
  return { server, seen }
}

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

// A collector that answers `status` redirecting to `location`, and a second origin to catch a hop.
async function collectorPair(status) {
  const second = recordingServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const secondPort = await listen(second.server)
  const first = recordingServer((req, res) => {
    res.writeHead(status, { location: `http://127.0.0.1:${secondPort}/stolen` })
    res.end()
  })
  const firstPort = await listen(first.server)
  return {
    firstPort,
    seenFirst: first.seen,
    seenSecond: second.seen,
    close() { first.server.close(); second.server.close() },
  }
}

// The plugin's own apply() over a fake ctx.flybot, with the OTLP exporter pointed at `port`.
function boot(port) {
  const handlers = new Map()
  const warnings = []
  const warn = (...args) => warnings.push(args.map(String).join(' '))
  const ctx = {
    flybot: {
      version: 1,
      pluginEnabled: () => true,
      warn,
      scope: () => ({
        version: 1,
        on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name) },
        bot: { list: () => [{ id: 'bot-1', name: 'Scout' }] },
        rooms: { list: () => [] },
        readOnly: () => false,
        api: { handle: () => () => {} },
        warn,
      }),
    },
    effect: () => {},
    on: () => () => {},
  }
  const plugin = apply(ctx, {
    enabled: true,
    persist: false,
    dir: mkdtempSync(join(tmpdir(), 'timeline-redirect-')),
    exporter: 'otlp',
    otlpUrl: `http://127.0.0.1:${port}/v1/traces`,
    otlpHeaders: { 'x-api-key': TOKEN },
    exportMs: 600_000,
  })
  // The trace drops records older than its retention window, so the events run at the wall clock.
  const started = Date.now()
  handlers.get('turn.start')({ turnId: 'turn-1', time: started, place: 'chat', botId: 'bot-1', trigger: { exchangeId: 'x1', from: { kind: 'user' }, role: 'user', hop: 0 } })
  handlers.get('turn.end')({ turnId: 'turn-1', time: started + 5, outcome: 'completed', model: 'mock/model' })
  return { plugin, warnings }
}

test('a collector 307 is a failed export: the other origin receives nothing', async () => {
  const pair = await collectorPair(307)
  const { plugin, warnings } = boot(pair.firstPort)
  let delivered
  try {
    delivered = await plugin.timeline.exportNow()
  } finally {
    plugin.dispose()
    pair.close()
  }
  // The configured collector is asked, once, and really carries the credential (not an empty run).
  assert.equal(pair.seenFirst.length, 1, 'the exporter posts to the configured otlpUrl')
  assert.equal(pair.seenFirst[0].method, 'POST')
  assert.equal(pair.seenFirst[0].url, '/v1/traces')
  assert.equal(pair.seenFirst[0].headers['x-api-key'], TOKEN)
  assert.match(pair.seenFirst[0].body, /resourceSpans/, 'the span payload is posted to the configured collector')
  // The Location origin chosen by the collector's answer is never contacted.
  assert.equal(pair.seenSecond.length, 0, 'a redirect target is not contacted, so no header or payload leaves for it')
  // And the refusal is reported: not delivered, and a warning says why.
  assert.equal(delivered, 0, 'a refused export is not counted as delivered')
  assert.ok(warnings.some(line => /OTLP export failed/.test(line)), `expected an export warning, got ${JSON.stringify(warnings)}`)
})

test('a collector 200 still counts as delivered, with the configured headers', async () => {
  const pair = await collectorPair(200)
  const { plugin, warnings } = boot(pair.firstPort)
  let delivered
  try {
    delivered = await plugin.timeline.exportNow()
  } finally {
    plugin.dispose()
    pair.close()
  }
  assert.equal(pair.seenFirst.length, 1)
  assert.equal(pair.seenFirst[0].headers['x-api-key'], TOKEN)
  assert.equal(pair.seenSecond.length, 0)
  assert.equal(delivered, 1, 'a 200 is delivered')
  assert.deepEqual(warnings, [])
})
