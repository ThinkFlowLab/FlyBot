import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import test from 'node:test'
import artifactsFeature from '../features/artifacts/index.js'
import { key, volume, WS } from './helpers.js'

const TEAM = 'b'.repeat(32)
const FOREIGN = 'c'.repeat(32)
const base = (workspace = WS) => `/v1/workspaces/${workspace}/artifacts`
const slideDraft = workspace => base(workspace) + '/slides/draft'
const modelDeck = {
  title: '  欢迎新团队  ',
  slides: [
    { title: ' 欢迎加入 ', bullets: [' 周五开始 ', ''] },
    { title: '接下来的安排', bullets: ['周一查看资料'] },
  ],
}

function bootDrafts(t, currentRuntime, messenger) {
  const { root, data } = volume()
  const host = {
    dataDir: data,
    featureDir: () => data,
    currentRuntime,
    async call(name, payload) {
      if (name === 'agents/personal-binding') return { workspace_id: WS }
      if (name === 'teams/activeWorkspaces') return [{ id: TEAM }]
      if (name === 'messenger/v1') return messenger(payload)
      throw new Error('Unexpected feature endpoint')
    },
  }
  const feature = artifactsFeature(host)
  t.after(() => {
    feature.store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    request: (method, path, body, idempotency_key) => feature.endpoints.v1({ method, path, body, idempotency_key }),
    attachment: payload => feature.endpoints.chatAttachment(payload, { internal: true }),
  }
}

test('a document draft returns bounded Markdown from the authorized native workspace without saving', async t => {
  const markdown = '# 入门指南\n\n| 环节 | 下一步 |\n| --- | --- |\n| 资料 | 阅读交付说明 |'
  const prompts = []
  const {request} = bootDrafts(t, () => ({
    async backgroundTextOnly(prompt) {
      prompts.push(prompt)
      return JSON.stringify({title:'  入门指南  ', markdown})
    },
  }))
  const path = workspace => base(workspace) + '/document/draft'
  assert.equal((await request('POST', path(FOREIGN), {prompt:'整理入门指南'})).status, 404)
  assert.deepEqual(prompts, [])
  const next = await request('POST', path(TEAM), {prompt:'整理入门指南'})
  assert.equal(next.status, 200)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /^Draft an editable Markdown document/)
  assert.deepEqual(next.body, {title:'入门指南', document:markdown})
  assert.deepEqual((await request('GET', base(TEAM))).body.items, [])
})

test('a native slide draft is workspace-gated, editable and explicitly saved before PPTX export', async t => {
  const prompts = []
  const { request, attachment } = bootDrafts(t, () => ({
    async backgroundTextOnly(prompt) {
      prompts.push(prompt)
      return '```json\n' + JSON.stringify(modelDeck) + '\n```'
    },
  }))
  const input = { prompt: '  用中文欢迎新团队。周五开始，周一查看资料。  ' }
  assert.equal((await request('POST', slideDraft(FOREIGN), input)).status, 404)
  assert.equal((await request('GET', slideDraft())).status, 405)
  assert.equal((await request('POST', slideDraft(), { prompt: ' '.repeat(1601) })).status, 400)
  assert.equal((await request('POST', slideDraft(), { ...input, workspace: FOREIGN })).status, 400)
  assert.equal(prompts.length, 0)
  const generated = await request('POST', slideDraft(TEAM), input)
  assert.equal(generated.status, 200)
  assert.match(prompts[0], /^Draft an editable presentation/)
  assert.match(prompts[0], /Use only the facts supplied/)
  assert.equal(JSON.parse(prompts[0].split('\n').at(-1).slice('Description: '.length)), input.prompt.trim())
  assert.deepEqual(generated.body, {
    title: '欢迎新团队',
    slides: {
      schema: 'flybot-workspace.slides.v1',
      slides: [
        { title: '欢迎加入', bullets: ['周五开始'] },
        { title: '接下来的安排', bullets: ['周一查看资料'] },
      ],
    },
  })
  assert.deepEqual((await request('GET', base(TEAM))).body.items, [])
  generated.body.slides.slides[0].bullets.push('欢迎向团队提问')
  const saved = await request('POST', base(TEAM), { kind: 'slides', ...generated.body }, key())
  assert.equal(saved.status, 201, JSON.stringify(saved.body))
  const { artifact } = saved.body
  assert.deepEqual(artifact.slides, generated.body.slides)
  const exported = await request('GET', base(TEAM) + `/${artifact.id}/versions/1/export?format=pptx`)
  assert.match(exported.download.content_type, /presentationml/)
  assert.equal(Buffer.from(exported.download.data, 'base64').readUInt32LE(), 0x04034b50)
  const shared = await attachment({ workspace_id: TEAM, artifact_id: artifact.id, revision: 1 })
  assert.equal(shared.attachment.data, exported.download.data)
  assert.equal(shared.attachment.title, '欢迎新团队-v1.pptx')
})

test('a slide draft includes recent authorized text only after the user supplies a conversation', async t => {
  const prompts = []
  let reads = 0
  const items = [
    { body: 'Too old to include' },
    ...Array.from({ length: 6 }, (_, index) => ({ body: index + ': ' + 'Abcd'.repeat(300) })),
    { body: 'Withdrawn', retracted: true },
    { body: 'Redacted', redacted: true },
    { body: 'Audio', voice: {} },
    { body: 'Attachment', attachment: {} },
    { body: ' ' },
    { body: '  Latest decision: finish Friday.  ' },
  ]
  const conversation = 'otc_test-conversation'
  const prefix = 'Conversation reference (text only): '
  const { request } = bootDrafts(t, () => ({
    async backgroundTextOnly(prompt) {
      prompts.push(prompt)
      return JSON.stringify(modelDeck)
    },
  }), async payload => {
    reads++
    assert.equal(payload.method, 'GET')
    assert.equal(payload.path, `/v1/workspaces/${TEAM}/social/conversations/${conversation}/messages?limit=12&scope=workspace`)
    return { status: 200, body: { items } }
  })
  const input = { prompt: '概括项目决定' }
  await request('POST', slideDraft(TEAM), input)
  assert.equal(reads, 0)
  assert.doesNotMatch(prompts[0], /Latest decision/)
  assert.equal((await request('POST', slideDraft(TEAM), { ...input, conversation_id: '../foreign' })).status, 400)
  const contextual = await request('POST', slideDraft(TEAM), { ...input, conversation_id: conversation })
  assert.equal(contextual.status, 200)
  assert.equal(reads, 1)
  const reference = prompts[1].split('\n').find(line => line.startsWith(prefix)).slice(prefix.length)
  assert.ok(reference.length <= 5000)
  assert.equal(JSON.parse(reference).at(-1), 'Latest decision: finish Friday.')
  assert.doesNotMatch(reference, /Too old|Withdrawn|Redacted|Audio|Attachment/)

  const denied = bootDrafts(t, () => ({
    async backgroundTextOnly() {
      assert.fail('The model should not receive an unauthorized conversation')
    },
  }), async () => ({ status: 404 }))
  const missing = await denied.request('POST', slideDraft(TEAM), { ...input, conversation_id: conversation })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'conversation_unavailable')
})

test('parallel artifact drafts share one runtime slot per user and invalid model output releases it', async t => {
  const started = Promise.withResolvers()
  const result = Promise.withResolvers()
  let runtime = {
    backgroundTextOnly() {
      started.resolve()
      return result.promise
    },
  }
  const { request } = bootDrafts(t, () => runtime)
  const input = { prompt: '请生成草稿' }
  const pending = request('POST', slideDraft(), input)
  await started.promise
  assert.equal((await request('POST', base() + '/spreadsheet/draft', input)).status, 429)
  const workbookModel = { title: '成本', sheets: [{ name: '估算', rows: [['物料', '12']] }] }
  const other = bootDrafts(t, () => ({ backgroundTextOnly: async () => JSON.stringify(workbookModel) }))
  assert.equal((await other.request('POST', base() + '/spreadsheet/draft', input)).status, 200)

  result.resolve(JSON.stringify({ slides: [{ title: 'x', bullets: ['x'.repeat(201)] }] }))
  assert.equal((await pending).body.error.code, 'draft_failed')
  runtime = { backgroundTextOnly: async () => JSON.stringify(modelDeck) }
  assert.equal((await request('POST', slideDraft(), input)).status, 200)
  runtime = null
  assert.equal((await request('POST', slideDraft(), input)).status, 503)
})
