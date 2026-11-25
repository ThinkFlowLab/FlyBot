import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentReplier } from '../lib/c/agent-replies.js'

test('distinct agents answer the same message concurrently with an owner limit and ordered follow-up', {timeout: 4000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'flybot-workspace-agent-fanout-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const job = (agent, message) => ({
    job_id: agent + '-' + message,
    attempt: 1,
    conversation_id: 'product-group',
    mode: 'mention',
    agent_ref: agent,
    agent_name: agent,
    message: {id: message, revision: 1, body: '请回复'},
  })
  const jobs = [
    job('product', 'first'), job('engineering', 'first'), job('qa', 'first'),
    job('support', 'first'), job('product', 'second'),
  ]
  const turns = new Map(jobs.map(item => [item.job_id, {started:Promise.withResolvers(), reply:Promise.withResolvers()}]))
  const invoked = []
  const delivered = []
  const bs = {
    async get() { return {cursor:5, jobs} },
    async post(path, data) {
      if (path.endsWith('/agent-messages')) delivered.push([data.agent_ref, data.reply_to, data.body])
      return {}
    },
  }
  const replier = createAgentReplier({
    bs, stateFile:join(root, 'inbox.json'),
    host: {
      currentRuntime: () => ({chatTurn() {}}),
      async call(endpoint, request) {
        assert.equal(endpoint, 'agents/groupTurn')
        const id = request.request_id.split(':')[1]
        const turn = turns.get(id)
        invoked.push(id)
        turn.started.resolve()
        return turn.reply.promise
      },
    },
  })

  const working = replier.once()
  try {
    await Promise.all(jobs.slice(0, 3).map(item => turns.get(item.job_id).started.promise))
    assert.deepEqual(invoked, ['product-first', 'engineering-first', 'qa-first'])
    turns.get('engineering-first').reply.resolve({text: 'Engineering finished first'})
    turns.get('qa-first').reply.resolve({text: 'QA finished second'})
    turns.get('product-first').reply.resolve({text: 'Product finished third'})
    await turns.get('support-first').started.promise
    assert.deepEqual(invoked, ['product-first', 'engineering-first', 'qa-first', 'support-first'])
    turns.get('support-first').reply.resolve({text:'Support first message'})
    await turns.get('product-second').started.promise
    turns.get('product-second').reply.resolve({text:'Product follow-up'})
    assert.deepEqual(await working, {replied:5, cursor:5})
    assert.equal(delivered.length, 5)
    assert.deepEqual(delivered.at(-1), ['product', 'second', 'Product follow-up'])
  } finally {
    for (const turn of turns.values()) turn.reply.resolve({text:'Fixture cleanup'})
    await working
  }
})

test('native DS-Bot agents decide whether to join an ordinary conversation in order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flybot-workspace-discretionary-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const source = {id: 'original', revision: 1, body: 'Any feedback on this plan?'}
  const inbox = {
    cursor: 1,
    jobs: ['product', 'engineering'].map(agent => ({
      job_id: agent, attempt: 1, conversation_id: 'room', mode: 'mention', discretionary: true,
      agent_ref: agent, agent_name: agent, message: source, context: [source],
    })),
  }
  const events = []
  const posted = []
  const bs = {
    async get() { return inbox },
    async post(path, value) {
      if (path.endsWith('/progress')) {
        assert.fail('A native pass token must never appear in progress')
      }
      if (value.action === 'start') {
        assert.equal(value.accept_discretionary_reply, true)
        assert.equal(value.source_revision, source.revision)
        events.push(path)
        return {discretionary:true, prior_replies:posted.map(text => ({name:'product',text}))}
      }
      if (value.action === 'pass') {
        events.push('pass')
        assert.match(value.claim_id,/^[a-f0-9-]{36}$/)
      } else if (path.endsWith('/agent-messages')) {
        events.push('delivered')
        posted.push(value.body)
      } else assert.fail('Unexpected job action')
      return {ok:true}
    },
  }
  const r = createAgentReplier({bs, stateFile:join(root, 'inbox.json'), host:{
    currentRuntime:() => ({chatTurn() {}}),
    async call(endpoint, request) {
      assert.equal(endpoint, 'agents/groupTurn')
      assert.match(request.text, /Reply exactly \[PASS\]/)
      if (request.agent_id === 'product') return {text:'I suggest validating the timeline with the customer.'}
      assert.ok(posted.length, 'Only start the next discretionary turn after the first has settled')
      assert.ok(request.text.includes(posted[0]), 'The next agent sees previously delivered replies in this round')
      request.onProgress(' [P')
      await delay(300)
      request.onProgress(' [PASS]')
      await delay(300)
      return {text:'[PASS]'}
    },
  }})

  assert.deepEqual(await r.once(), {replied:1, cursor:1})
  assert.deepEqual(events, ['/v1/ot/agent-reply-jobs/product','delivered','/v1/ot/agent-reply-jobs/engineering','pass'])
  assert.deepEqual(posted,['I suggest validating the timeline with the customer.'])
})

test('explicit group mentions keep native silence out of progress and history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flybot-workspace-mentioned-pass-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  const source = {id:'original', revision:1, body:'@所有人 请给个意见'}
  const jobs = ['local', 'teammate'].map(agent => ({
    job_id:agent, attempt:1, conversation_id:'room', mode:'mention',
    agent_ref:agent, agent_name:agent, message:source, context:[source],
    ...(agent === 'teammate' ? {group_text_only:true} : {}),
  }))
  const passed = [], posted = []
  const bs = {
    async get() { return {cursor:1, jobs} },
    async post(path, value) {
      if (value.action === 'start') return path.endsWith('/teammate') ? {group_text_only:true} : {}
      if (value.action === 'pass') passed.push(path)
      else if (path.endsWith('/agent-messages')) posted.push(value.body)
      else assert.fail('A native pass marker must not be sent as progress')
      return {ok:true}
    },
  }
  const worker = createAgentReplier({bs, stateFile:join(root, 'inbox.json'), host:{
    currentRuntime:() => ({chatTurn() {}}),
    async call(endpoint, request) {
      assert.match(request.text, /directly requested your reply/)
      if (request.agent_id === 'local') {
        assert.equal(endpoint, 'agents/groupTurn')
        return {text:'I have one suggestion.'}
      }
      assert.equal(endpoint, 'agents/groupTextTurn')
      assert.equal(request.includePersona, false)
      request.onProgress('[P')
      request.onProgress('[PASS]')
      return {text:'[PASS]'}
    },
  }})
  assert.deepEqual(await worker.once(), {replied:1, cursor:1})
  assert.deepEqual(passed, ['/v1/ot/agent-reply-jobs/teammate'])
  assert.deepEqual(posted, ['I have one suggestion.'])
})

test('a finished reply, pass, or failure survives a worker restart without rerunning the native turn', async t => {
  for (const outcome of ['reply', 'pass', 'fail']) {
    await t.test(outcome, {timeout:4000}, async t => {
      const root = await mkdtemp(join(tmpdir(), 'flybot-workspace-pending-reply-'))
      t.after(() => rm(root, {recursive:true, force:true}))
      const stateFile = join(root, 'inbox.json')
      const discretionary = outcome === 'pass'
      const job = {job_id:'pending', attempt:3, conversation_id:'room', mode:'mention', discretionary,
        agent_ref:'local', agent_name:'Local', message:{id:'source', revision:4, body:'Review the proposal'}}
      const startPath = '/v1/ot/agent-reply-jobs/pending'
      const completedPath = outcome === 'reply' ? '/v1/ot/conversations/room/agent-messages' : startPath
      const transfers = [], heartbeats = [], turns = [], reads = [], committed = []
      const firstHeartbeat = Promise.withResolvers()
      let claimed, available = false
      const bs = {
        async get(path) {
          reads.push(path)
          return {cursor:8, jobs:claimed ? [] : [job]}
        },
        async post(path, data) {
          if (data.action === 'start') {
            assert.equal(path,startPath)
            assert.equal(claimed,undefined)
            claimed = data.claim_id
            assert.match(claimed,/^[a-f0-9-]{36}$/)
            assert.equal(data.source_revision,4)
            return {discretionary}
          }
          if (data.action === 'keepalive') {
            assert.equal(path,startPath)
            assert.deepEqual(data,{action:'keepalive',attempt:3,claim_token:claimed})
            heartbeats.push(data)
            firstHeartbeat.resolve()
            return {}
          }
          assert.equal(path,completedPath)
          assert.equal(data.attempt,3)
          assert.equal(data.claim_id,claimed)
          if (outcome !== 'reply') assert.deepEqual(data,{action:outcome,attempt:3,claim_id:claimed})
          else {
            assert.equal(data.job_id,job.job_id)
            assert.equal(data.reply_to,job.message.id)
            assert.match(data.client_key,/^r:[a-f0-9]{64}$/)
            assert.equal(data.body,'Completed native analysis')
          }
          transfers.push({path,payload:structuredClone(data)})
          if (!available) throw Object.assign(new Error('Temporary transport loss'), {status:503})
          committed.push(data)
          return {}
        },
      }
      const host = {
        currentRuntime:() => ({chatTurn() {}}),
        async call(endpoint, request) {
          turns.push([endpoint,request.request_id])
          assert.equal(endpoint,'agents/groupTurn')
          await Promise.all([firstHeartbeat.promise,delay(30)])
          if (outcome === 'fail') throw new Error('Native turn could not complete')
          return {text:discretionary?'[PASS]':'Completed native analysis'}
        },
      }
      const original = createAgentReplier({bs,host,stateFile,keepaliveIntervalMs:10})
      assert.deepEqual(await original.once(),{replied:0,cursor:8})
      assert.ok(heartbeats.length > 0)
      assert.equal(transfers.length,2)
      assert.deepEqual(committed,[])
      const persisted = JSON.parse(await readFile(stateFile,'utf8'))
      assert.equal(persisted.cursor,8)
      const [{path,payload}] = Object.values(persisted.completions)
      assert.deepEqual({path,payload},transfers[0])

      available = true
      const restarted = createAgentReplier({bs,host,stateFile})
      await restarted.once()
      await restarted.once()
      assert.deepEqual(turns,[['agents/groupTurn','ots:pending:3']])
      assert.deepEqual(transfers,Array.from({length:3},()=>({path,payload})))
      assert.deepEqual(committed,[payload])
      assert.deepEqual(reads.map(path=>new URL(path,'http://localhost').searchParams.get('after')),['0','8','8'])
      assert.deepEqual(JSON.parse(await readFile(stateFile,'utf8')).completions,{})
    })
  }
})

test('same-owner group turns use one text-only fallback after a typed empty native reply', async t => {
  for (const discretionary of [false,true]) {
    await t.test(discretionary ? 'ordinary message can still pass' : 'explicit mention returns one reply', async t => {
      const root = await mkdtemp(join(tmpdir(), 'flybot-workspace-empty-reply-'))
      t.after(() => rm(root, {recursive:true, force:true}))
      const body = discretionary ? 'What should we adjust?' : '@Local Please review'
      const message = {id:'source', revision:1, body}
      const job = {job_id:'empty', attempt:1, conversation_id:'room', mode:'mention', discretionary,
        agent_ref:'local', agent_name:'Local', message, context:[message]}
      const turns = [], replies = [], passes = [], previews = []
      const bs = {
        async get() { return {cursor:1,jobs:[job]} },
        async post(path, data) {
          if (data.action === 'start') return {discretionary}
          if (data.action === 'pass') passes.push(data)
          else if (path.endsWith('/agent-messages')) replies.push(data.body)
          else if (path.endsWith('/progress')) previews.push(data.text)
          else assert.fail('The recovered turn must not mark the original job failed')
          return {}
        },
      }
      const host = {
        currentRuntime:() => ({chatTurn() {}}),
        async call(endpoint, request) {
          turns.push(endpoint)
          assert.ok(request.text.includes(body))
          if (endpoint === 'agents/groupTurn') throw Object.assign(new Error('No native message'), {code:'agents/empty-reply'})
          assert.equal(endpoint,'agents/groupTextTurn')
          assert.equal(request.includePersona,true)
          assert.equal(request.discretionary,discretionary)
          assert.equal(request.request_id,undefined)
          assert.match(request.text,/Use only the shared material/)
          if (discretionary) {
            request.onProgress('[P')
            request.onProgress('[PASS]')
            return {text:'[PASS]'}
          }
          return {text:'One change to the release plan.'}
        },
      }
      const worker = createAgentReplier({bs,host,stateFile:join(root,'inbox.json')})
      assert.deepEqual(await worker.once(),{replied:Number(!discretionary),cursor:1})
      assert.deepEqual(turns,['agents/groupTurn','agents/groupTextTurn'])
      assert.deepEqual(replies,discretionary?[]:['One change to the release plan.'])
      assert.equal(passes.length,Number(discretionary))
      assert.ok(previews.every(text=>text===''), 'Fallback may clear the preview, but it must never expose PASS')
    })
  }
})
