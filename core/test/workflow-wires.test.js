// #2122: the run flowchart drew every edge as one symmetric cubic between the two card
// centres, so parallel and back edges stacked into one stroke and crossed the cards. The
// route is now its own rule: ports on the card edges, a lane per edge in the gap between
// rows, a side loop for a back edge. These cases pin that route, not only the node layout.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export * as wf from './src/client/workflows.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const env = { module: { exports: {} } }
env.require = (name) => {
  if (name === 'react') return { createElement: () => null }
  if (name === 'react-dom') return { createPortal: (node) => node }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
  throw new Error(`Unexpected platform module ${name}`)
}
runInNewContext(outputFiles[0].text, env)
const { wf } = env.module.exports

// The shape in the owner's screenshot: Triage → Claim → (Gate ‖ 取证) → Enqueue →
// Escalate, with Escalate's back edge to Triage. 取证 sits one row lower than its
// partner, as #1752 pinned; the cards are taller than the authored 72px metric.
const HEIGHTS = { triage: 46, claim: 46, forensics: 46, gate: 46, enqueue: 46, escalate: 46 }
const GRAPH = {
  id: 'wf-wires',
  name: 'Wires',
  nodes: [
    { id: 'triage', name: 'Triage', role: '分诊', x: 0, y: 0 },
    { id: 'claim', name: 'Claim', role: '认领', x: -94, y: 108 },
    { id: 'forensics', name: '取证', role: '真机取证', x: 94, y: 159 },
    { id: 'gate', name: 'Gate', role: '门禁', x: 0, y: 267 },
    { id: 'enqueue', name: 'Enqueue', role: '入队', x: 0, y: 375 },
    { id: 'escalate', name: 'Escalate', role: '升级', x: 0, y: 483 },
  ],
  edges: [
    { from: 'triage', to: 'claim' },
    { from: 'triage', to: 'forensics' },
    { from: 'claim', to: 'gate' },
    { from: 'forensics', to: 'gate' },
    { from: 'gate', to: 'enqueue' },
    { from: 'enqueue', to: 'escalate' },
    { from: 'escalate', to: 'triage' },
  ],
  layers: [['triage'], ['claim', 'forensics'], ['gate'], ['enqueue'], ['escalate']],
}
const CARD_HALF = 84
const boxesOf = (nodes) => nodes.map((node) => ({
  id: node.id,
  left: node.x - CARD_HALF,
  right: node.x + CARD_HALF,
  top: node.y,
  bottom: node.y + HEIGHTS[node.id],
}))

// A route is axis-aligned, so "within 3px for more than 20px" is exactly a shared run:
// two horizontals on the same y, or two verticals on the same x, overlapping for > 20px.
function sharedRuns(a, b, limit = 3) {
  const runs = []
  const horizontal = (points) => points.slice(1).map((point, at) => [points[at], point])
    .filter(([from, to]) => Math.abs(from[1] - to[1]) < 0.001)
  const vertical = (points) => points.slice(1).map((point, at) => [points[at], point])
    .filter(([from, to]) => Math.abs(from[0] - to[0]) < 0.001)
  for (const [from, to] of horizontal(a)) {
    for (const [otherFrom, otherTo] of horizontal(b)) {
      if (Math.abs(from[1] - otherFrom[1]) > limit) continue
      const overlap = Math.min(Math.max(from[0], to[0]), Math.max(otherFrom[0], otherTo[0]))
        - Math.max(Math.min(from[0], to[0]), Math.min(otherFrom[0], otherTo[0]))
      if (overlap > 20) runs.push(overlap)
    }
  }
  for (const [from, to] of vertical(a)) {
    for (const [otherFrom, otherTo] of vertical(b)) {
      if (Math.abs(from[0] - otherFrom[0]) > limit) continue
      const overlap = Math.min(Math.max(from[1], to[1]), Math.max(otherFrom[1], otherTo[1]))
        - Math.max(Math.min(from[1], to[1]), Math.min(otherFrom[1], otherTo[1]))
      if (overlap > 20) runs.push(overlap)
    }
  }
  return runs
}

test('#2122: every wire attaches to a card port and never crosses a card', () => {
  const routes = wf.routeWires(GRAPH.nodes, GRAPH.edges, HEIGHTS)
  assert.equal(routes.length, GRAPH.edges.length, 'one route per edge')
  const byId = new Map(GRAPH.nodes.map((node) => [node.id, node]))
  const boxes = boxesOf(GRAPH.nodes)
  for (const route of routes) {
    const from = byId.get(route.from)
    const to = byId.get(route.to)
    assert.ok(Array.isArray(route.points) && route.points.length >= 2, `${route.from} → ${route.to} has a route`)
    assert.match(route.d, /^M /, `${route.from} → ${route.to} renders a path`)
    const [sx, sy] = route.points[0]
    const [ex, ey] = route.points[route.points.length - 1]
    assert.equal(sy, from.y + HEIGHTS[from.id], `${route.from} leaves its own bottom edge`)
    assert.ok(sx >= from.x - CARD_HALF && sx <= from.x + CARD_HALF, `${route.from} starts on its card edge`)
    assert.equal(ey, to.y, `${route.to} lands on its own top edge`)
    assert.ok(ex >= to.x - CARD_HALF && ex <= to.x + CARD_HALF, `${route.to} ends on its card edge`)
    // Every segment is axis-aligned; sample it and keep the stroke out of every card.
    for (let at = 1; at < route.points.length; at += 1) {
      const [x1, y1] = route.points[at - 1]
      const [x2, y2] = route.points[at]
      assert.ok(Math.abs(x1 - x2) < 0.001 || Math.abs(y1 - y2) < 0.001,
        `${route.from} → ${route.to} bends without a horizontal or vertical segment`)
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 2))
      for (let step = 0; step <= steps; step += 1) {
        const x = x1 + ((x2 - x1) * step) / steps
        const y = y1 + ((y2 - y1) * step) / steps
        for (const box of boxes) {
          const inside = x > box.left + 1 && x < box.right - 1 && y > box.top + 1 && y < box.bottom - 1
          assert.ok(!inside, `${route.from} → ${route.to} crosses ${box.id} at ${x},${y}`)
        }
      }
    }
  }
})

test('#2122: two wires never share a stroke within 3px for more than 20px', () => {
  const routes = wf.routeWires(GRAPH.nodes, GRAPH.edges, HEIGHTS)
  for (let a = 0; a < routes.length; a += 1) {
    for (let b = a + 1; b < routes.length; b += 1) {
      const runs = sharedRuns(routes[a].points, routes[b].points)
      assert.deepEqual(runs, [],
        `${routes[a].from} → ${routes[a].to} and ${routes[b].from} → ${routes[b].to} share a stroke for ${runs.join(', ')}px`)
    }
  }
})

test('#2122: a back edge is a loop around the cards, not a stub in whitespace', () => {
  const routes = wf.routeWires(GRAPH.nodes, GRAPH.edges, HEIGHTS)
  const back = routes.find((route) => route.from === 'escalate' && route.to === 'triage')
  assert.ok(back, 'the back edge has a route')
  assert.equal(back.back, true, 'the route knows its target sits above its source')
  const xs = back.points.map((point) => point[0])
  const ys = back.points.map((point) => point[1])
  const rightOfCards = Math.max(...GRAPH.nodes.map((node) => node.x + CARD_HALF))
  assert.ok(Math.max(...xs) > rightOfCards, 'the loop swings outside the branch cards')
  assert.ok(Math.min(...ys) < GRAPH.nodes[0].y, 'the loop rises above the top card before it comes down')
  const length = back.points.slice(1)
    .reduce((sum, point, at) => sum + Math.hypot(point[0] - back.points[at][0], point[1] - back.points[at][1]), 0)
  assert.ok(length > GRAPH.nodes.at(-1).y, `the loop is a real path longer than the graph is tall (${length}px)`)
})

test('#2122: the parallel frame takes its margin from the measured cards on every side', () => {
  const members = GRAPH.nodes.filter((node) => ['claim', 'forensics'].includes(node.id))
  const measured = { claim: 46, forensics: 63 }
  const frame = wf.parallelFrame(members, measured)
  const boxes = members.map((node) => ({
    id: node.id,
    left: node.x - CARD_HALF,
    right: node.x + CARD_HALF,
    top: node.y,
    bottom: node.y + measured[node.id],
  }))
  const left = frame.left
  const right = frame.left + frame.width
  const top = frame.top
  const bottom = frame.top + frame.height
  const margins = [
    Math.min(...boxes.map((box) => box.left)) - left,
    right - Math.max(...boxes.map((box) => box.right)),
    Math.min(...boxes.map((box) => box.top)) - top,
    bottom - Math.max(...boxes.map((box) => box.bottom)),
  ]
  assert.ok(margins.every((margin) => Math.abs(margin - margins[0]) < 0.001),
    `the four margins are equal (${margins.join(', ')})`)
  assert.ok(margins[0] > 0, 'the frame encloses the measured cards')
  assert.ok(bottom >= 159 + 63 + margins[0], 'the taller card is enclosed by its own measured height, not 72')
})
