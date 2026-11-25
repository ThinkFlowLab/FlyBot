// Stream C: public agent homepages and team-run shares (fake Bot Social + in-process host.call).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial } from '../lib/c/bot-social.js'
import homepages from '../features/homepages/index.js'
import shares from '../features/shares/index.js'

const SERVER = 'https://social.example.test'
const AGENT = { id: 'a'.repeat(32), name: 'Writer', summary: 'drafts', category: 'content-creation', quick_starts: ['outline this'], instructions: 'SECRET PROMPT never publish' }
const RUN = { id: 'b'.repeat(32), title: 'Q3 plan', goal: 'write the plan', status: 'succeeded', progress: { succeeded: 2, total: 2 },
  steps: [{ position: 0, agent_name: 'Writer', instruction: 'PRIVATE INSTR', status: 'succeeded', output: 'draft ok', error_code: 'x' }] }

function setup(calls, agents, runs) {
  const dir = mkdtempSync(join(tmpdir(), 'ot-c5-'))
  mkdirSync(join(dir, 'bot'))
  writeFileSync(join(dir, 'bot', 'flybot-social.json'), JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const fetch = async (url, init) => {
    calls.push({ method: init.method, path: url.slice(SERVER.length), body: init.body ? JSON.parse(init.body) : undefined })
    return new Response(JSON.stringify({ id: 'otl_1', kind: 'agent', slug: 'writer', snapshot: JSON.stringify({ name: 'Writer' }), creator: { handle: 'ann.home' } }), { status: 200 })
  }
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: join(dir, 'bot', 'flybot-social.json'), fetch }))
  const host = {
    dataDir: dir,
    async call(endpoint, payload) {
      if (endpoint === 'agents/get') { assert.equal(payload.id, AGENT.id); return { agent: agents ?? AGENT } }
      if (endpoint === 'team-runs/get') { assert.equal(payload.id, RUN.id); return { run: runs ?? RUN } }
      throw Object.assign(new Error(endpoint), { code: 'flybot-workspace/not-found' })
    },
  }
  return host
}

test('homepage publish and get, and team-run share omit private fields', async () => {
  const calls = []
  const host = setup(calls)
  const H = homepages(host).endpoints
  const S = shares(host).endpoints
  await H.publish({ agent_id: AGENT.id, workspace_id: 'c'.repeat(32), slug: 'writer' }, { host })
  const page = await H.get({ slug: 'writer' }, { host })
  assert.equal(page.page.name, 'Writer')
  await S.publish({ team_id: 'ott_1', run_id: RUN.id, workspace_id: 'c'.repeat(32) }, { host })
  const putListing = calls.find((c) => c.method === 'PUT' && c.path === '/v1/ot/listings')
  const body = putListing.body
  assert.equal(body.kind, 'agent')
  assert.equal(body.ref, AGENT.id)
  assert.equal(body.title, 'Writer')
  assert.ok(!JSON.stringify(body).includes('SECRET'), 'instructions never published')
  const snap = JSON.parse(body.snapshot)
  assert.deepEqual(snap.quick_starts, ['outline this'])
  assert.ok(!('instructions' in snap))
  const share = calls.find((c) => c.path === '/v1/ot/teams/ott_1/shared-runs')
  assert.equal(share.method, 'PUT')
  assert.equal(share.body.run_ref, RUN.id)
  assert.equal(share.body.title, 'Q3 plan')
  assert.deepEqual(share.body.snapshot.steps[0], { position: 0, agent_name: 'Writer', status: 'succeeded', output: 'draft ok' })
  assert.ok(!JSON.stringify(share.body).includes('PRIVATE INSTR'), 'step instructions never shared')
  assert.ok(!JSON.stringify(share.body).includes('error_code'))
})

test('browser shares bind to the requested team workspace and only expose the permitted snapshot', async () => {
  const workspace = 'c'.repeat(32)
  const personal = 'd'.repeat(32)
  const share = 'otsr_' + 'A'.repeat(26)
  const view = {id: share, run_ref: RUN.id, title: RUN.title, goal: RUN.goal, status: RUN.status,
    owner: {owner_id: 'issuer', display_name: 'Writer'}, snapshot: {steps: [
      {position: 0, status: 'succeeded', agent_name: 'Writer', output: 'draft ok'},
      {position: 1, status: 'succeeded', agent_name: 'Reviewer', output: 's'.repeat(399) + '🚀' + ' remaining text'},
    ]}}
  const calls = []
  const host = setup([], undefined, {...RUN, workspace_id: workspace})
  const runtime = host.call
  host.call = async (endpoint, payload) => endpoint === 'agents/personal-binding'
    ? {workspace_id: personal} : runtime(endpoint, payload)
  let viewer = 'issuer'
  setSharedBotSocial(createBotSocial({server: SERVER,
    credentialsPath: join(host.dataDir, 'bot', 'flybot-social.json'),
    fetch: async (url, request) => {
      const {pathname, search} = new URL(url)
      calls.push([pathname + search, request.method])
      if (pathname.startsWith('/v1/ot/teams/by-workspace/')) {
        assert.equal(pathname.split('/').at(-1), workspace)
        return Response.json({id: 'ott_a', workspace_id: workspace})
      }
      if (pathname === '/v1/ot/me') return Response.json({owner_id: viewer})
      if (request.method === 'PUT') {
        const data = JSON.parse(request.body)
        assert.equal(data.run_ref, RUN.id)
        assert.equal(data.snapshot.steps[0].output, 'draft ok')
        assert.equal(data.snapshot.steps[0].instruction, undefined)
        return Response.json(view)
      }
      if (search === '?summary=1') return Response.json({runs: [view]})
      if (request.method === 'DELETE') return Response.json({unshared: true})
      assert.equal(pathname.split('/').at(-1), share)
      return Response.json(view)
    },
  }))
  const endpoints = shares(host).endpoints
  const endpoint = endpoints.v1
  const root = '/v1/workspaces/' + workspace
  const denied = await endpoint({method: 'GET', path: '/v1/workspaces/' + personal + '/shared-runs'})
  assert.equal(denied.status, 404)
  assert.equal(calls.length, 0)
  const published = await endpoint({method: 'POST', path: root + '/team-runs/' + RUN.id + '/share',
    body: {team_id: 'untrusted-team', snapshot: {secret: 'browser values are ignored'}}})
  assert.equal(published.status, 200)
  assert.equal(published.body.share.own, true)
  assert.equal(published.body.share.run_id, RUN.id)
  viewer = 'teammate'
  const list = await endpoint({method: 'GET', path: root + '/shared-runs'})
  assert.equal(list.status, 200)
  const [summary] = list.body.items
  assert.equal(summary.own, false)
  assert.equal(summary.run_id, undefined)
  assert.equal(summary.snapshot, undefined)
  assert.equal(summary.goal, undefined)
  assert.equal(summary.source_version, undefined)
  const clicked = await endpoint({method: 'GET', path: root + '/shared-runs/' + share})
  assert.equal(clicked.body.share.goal, RUN.goal)
  assert.deepEqual(clicked.body.share.snapshot, view.snapshot)
  const source = {id: share, version: clicked.body.share.source_version, positions: [1]}
  const payload = {workspace_id: workspace, source}
  await assert.rejects(endpoints.teamRunContext(payload), {status: 404})
  const context = await endpoints.teamRunContext(payload, {internal: true})
  assert.deepEqual(context, {title: RUN.title, outputs: [{position: 2, text: 's'.repeat(399) + '🚀…'}]})
  await assert.rejects(endpoints.teamRunContext({...payload, workspace_id: personal}, {internal: true}), {status: 404})
  view.snapshot.steps[1].output = 'updated by sender'
  await assert.rejects(endpoints.teamRunContext(payload, {internal: true}), {status: 409, code: 'source_changed'})
  viewer = 'issuer'
  const revoked = await endpoint({method: 'POST', path: root + '/shared-runs/' + share + '/revoke'})
  assert.deepEqual(revoked, {status: 200, body: {unshared: true}})
})
