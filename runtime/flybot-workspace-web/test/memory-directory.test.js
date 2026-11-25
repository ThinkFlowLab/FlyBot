import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { bootMemory as boot, key, WS } from './helpers.js'

const OTHER_WS = 'b'.repeat(32)
const route = (workspace = WS) => `/v1/workspaces/${workspace}/memory`
const read = (bot, query = {}, workspace) => bot.call('memory', 'GET',
  route(workspace) + '?' + new URLSearchParams({ order: 'recent', ...query }))

async function add(bot, page, workspace) {
  const result = await bot.call('memory', 'POST', route(workspace), page, key())
  assert.equal(result.status, 201)
  return result.body.page
}

function setUpdated(bot, pages, time) {
  const database = new DatabaseSync(join(bot.vol.data, 'flybot-workspace', 'features', 'memory', 'memory.sqlite3'))
  try {
    const update = database.prepare('UPDATE memory_pages SET updated=? WHERE id=?')
    for (const page of pages) update.run(time, page.id)
  } finally {
    database.close()
  }
}

test('directory uses stable recent keyset paging across tied timestamps and a deleted boundary', async () => {
  const bot = await boot()
  const pages = []
  for (let i = 0; i < 24; i++) pages.push(await add(bot, {title: '记录 ' + i, body: '案例 '.repeat(90)}))
  setUpdated(bot, pages, 150)
  setUpdated(bot, pages.slice(-3), 200)
  const expected = [...pages.slice(-3)].sort((a, b) => a.id.localeCompare(b.id))
    .concat(pages.slice(0, -3).sort((a, b) => a.id.localeCompare(b.id)))

  const first = await read(bot)
  assert.equal(first.status, 200)
  assert.equal(first.body.total, 24)
  assert.equal(first.body.items.length, 20)
  assert.deepEqual(first.body.items.map(page => page.id), expected.slice(0, 20).map(page => page.id))
  assert.ok(first.body.items.every(page => !('body' in page) && !('match' in page) && page.preview.length <= 161))
  assert.ok(first.body.cursor)
  await bot.call('memory', 'POST', route() + '/' + expected[19].id + '/remove', {})

  const second = await read(bot, {cursor: first.body.cursor})
  assert.equal(second.status, 200)
  assert.equal(second.body.total, 23)
  assert.equal(second.body.cursor, null)
  assert.deepEqual(second.body.items.map(page => page.id), expected.slice(20).map(page => page.id))
  const updated = (await read(bot, {updated_after: 200})).body
  assert.equal(updated.total, 3)
  assert.deepEqual(updated.items.map(page => page.id), expected.slice(0, 3).map(page => page.id))
  assert.equal(updated.cursor, null)
})

test('directory searches titles, topics and full body with bounded highlight offsets and workspace filters', async () => {
  const bot = await boot(undefined, {teams:[OTHER_WS]})
  const title = await add(bot, {title: 'Launch Plan', body: 'Nothing else.'})
  const topic = await add(bot, {title: '发布会议', body: 'Launch plan in body too.', topics: ['Launch Plan', '团队']})
  const long = await add(bot, {
    title: '旧迭代记录',
    body: '😀'.repeat(150) + ' İ 发布正文含 lAuNcH\n plan 和验收信息。' + '😀'.repeat(160),
    topics: ['团队'],
  })
  await add(bot, {title: 'Launch plan 另一工作区', body: 'Launch plan', topics: ['团队']}, OTHER_WS)
  setUpdated(bot, [title], 300)
  setUpdated(bot, [topic], 200)
  setUpdated(bot, [long], 100)

  const first = (await read(bot, {q: ' LAUNCH \t plan ', limit: '2'})).body
  assert.equal(first.total, 3)
  assert.deepEqual(first.items.map(page => [page.id, page.match.kind]), [[title.id, 'title'], [topic.id, 'topic']])
  const second = (await read(bot, {q: 'launch plan', limit: '2', cursor: first.cursor})).body
  assert.equal(second.total, 3)
  assert.equal(second.cursor, null)
  const [hit] = second.items
  assert.equal(hit.id, long.id)
  assert.equal(hit.match.kind, 'body')
  assert.ok(hit.match.text.startsWith('…') && hit.match.text.endsWith('…') && hit.match.text.length <= 160)
  assert.equal(hit.match.text.slice(hit.match.start, hit.match.end), 'lAuNcH plan')
  assert.match(hit.match.text, /验收信息/)
  assert.ok(!hit.preview.toLowerCase().includes('launch'))
  assert.ok(!('body' in hit))
  const special = (await read(bot, {q: 'İ'})).body.items[0]
  assert.equal(special.id, long.id)
  assert.equal(special.match.text.slice(special.match.start, special.match.end), 'İ')
  const filtered = (await read(bot, {q: 'launch plan', topic: '团队', updated_after: 200})).body
  assert.deepEqual(filtered.items.map(page => page.id), [topic.id])
  assert.equal(filtered.total, 1)
  assert.equal((await read(bot, {topic: 'lAUnCh PlAn'})).body.items[0].id, topic.id)

  const legacy = (await bot.call('memory', 'GET', route() + '?q=launch%20plan')).body
  assert.deepEqual(legacy.items.map(page => page.id), [title.id])
  assert.ok(!('total' in legacy) && !('match' in legacy.items[0]))
  const edited = await bot.call('memory', 'POST', route() + '/' + long.id, {
    revision: long.revision, changes: { body: '发布记录已归档。', topics: ['归档'] },
  })
  assert.equal(edited.status, 200)
  assert.equal((await read(bot, {q: 'launch plan'})).body.total, 2)
  assert.equal((await read(bot, {q: '归档', topic: '团队'})).body.total, 0)
  assert.deepEqual((await read(bot, {q: '归档', topic: '归档'})).body.items.map(page => page.id), [long.id])
})

test('recent cursors are bound to their workspace and filters while authorization stays volume-local', async () => {
  const bot = await boot(undefined, {teams:[OTHER_WS]})
  await add(bot, {title: '备忘一', body: '结果', topics: ['工作']})
  await add(bot, {title: '备忘二', body: '结果', topics: ['工作']})
  const query = {q: '结果', topic: '工作', limit: '1'}
  const first = (await read(bot, query)).body
  assert.ok(first.cursor)
  const reused = [
    [{...query, q: '备忘', cursor: first.cursor}, WS],
    [{...query, topic: '', cursor: first.cursor}, WS],
    [{...query, updated_after: 0, cursor: first.cursor}, WS],
    [{...query, cursor: first.cursor}, OTHER_WS],
    [{...query, cursor: 'x'}, WS],
    [{...query, updated_after: '-1'}, WS],
  ]
  for (const [params, workspace] of reused) assert.equal((await read(bot, params, workspace)).status, 400)
  assert.equal((await bot.call('memory', 'GET', route() + '?order=recent&cursor=x&cursor=y')).status, 400)
  assert.equal((await bot.call('memory', 'GET', route() + '?order=recent&limit=101')).status, 400)
  const other = await boot()
  assert.deepEqual((await read(other, query)).body, {items: [], cursor: null, total: 0, unread_total: 0})
  assert.equal((await read(other, {...query, cursor: first.cursor})).body.total, 0)
})

test('memory unread filtering tracks the displayed revision and leaves other workspaces scoped', async () => {
  const bot = await boot(undefined, {teams:[OTHER_WS]})
  const page = await add(bot, {title:'待阅读的笔记', body:'第一版'})
  const peerPage = await add(bot, {title:'另一本笔记'}, OTHER_WS)
  const receipt = (revision, workspace = WS) => bot.call('memory', 'POST', route(workspace) + '/' + page.id + '/read', {revision})
  assert.equal((await read(bot, {unread: '1'})).body.items[0].unread, true)
  assert.equal((await receipt(page.revision, OTHER_WS)).status, 404)
  const first = await receipt(page.revision)
  assert.deepEqual(first.body, {page_id: page.id, read_revision: 1, unread_total: 0})
  assert.equal((await read(bot, {unread: '1'})).body.total, 0)
  assert.equal((await read(bot)).body.items[0].unread, false)
  const newer = await bot.call('memory', 'POST', route() + '/' + page.id, {revision: 1, changes: {body:'第二版'}})
  assert.equal(newer.body.page.revision, 2)
  assert.equal((await receipt(3)).status, 409)
  assert.equal((await receipt(1)).body.unread_total, 1)
  assert.equal((await read(bot, {unread: '1', q: '第二版'})).body.items[0].id, page.id)
  assert.equal((await receipt(2)).body.read_revision, 2)
  assert.equal((await receipt(1)).body.read_revision, 2)
  assert.equal((await read(bot, {unread: '1'}, OTHER_WS)).body.items[0].id, peerPage.id)
  const other = await boot()
  assert.equal((await other.call('memory', 'POST', route() + '/' + page.id + '/read', {revision:2})).status, 404)
})

test('personal memory pins survive restarts and sort and filter before recent keyset paging', async () => {
  const bot = await boot(undefined, {teams:[OTHER_WS]})
  const older = await add(bot, {title:'工作归档', body:'第一版', topics:['项目']})
  const recent = await add(bot, {title:'工作计划', body:'第二版'})
  const middle = await add(bot, {title:'工作进度', body:'第三版'})
  const otherWorkspace = await add(bot, {title:'另一个工作空间的工作计划'}, OTHER_WS)
  setUpdated(bot, [older], 100)
  setUpdated(bot, [middle], 200)
  setUpdated(bot, [recent], 300)
  const details = route() + '/' + older.id
  const before = (await bot.call('memory', 'GET', details)).body.page
  const pin = (page, pinned, workspace = WS, actor = bot) =>
    actor.call('memory', 'POST', route(workspace) + '/' + page.id + '/pin', {pinned})
  assert.equal(before.pinned, false)
  assert.equal((await read(bot)).body.items[0].id, recent.id)
  assert.equal((await pin(older, 'true')).status, 400)
  assert.equal((await pin(older, true, OTHER_WS)).status, 404)
  assert.equal((await pin(middle, true)).status, 200)
  assert.equal((await pin(otherWorkspace, true, OTHER_WS)).status, 200)
  for (const attempt of [await pin(older, true), await pin(older, true)]) {
    assert.equal(attempt.status, 200)
    assert.deepEqual(attempt.body, {page_id:older.id, workspace_id:WS, pinned:true})
  }
  assert.deepEqual((await bot.call('memory', 'GET', details)).body.page, {...before,pinned:true})

  const reopened = await boot(bot.vol, {teams:[OTHER_WS]})
  for (const query of [{}, {q:'工作'}]) {
    const options = {...query,limit:'1'}
    const first = (await read(reopened, options)).body
    assert.deepEqual(first.items.map(page=>[page.id,page.pinned]), [[middle.id,true]])
    assert.equal(first.total, 3)
    const second = (await read(reopened, {...options,cursor:first.cursor})).body
    assert.deepEqual(second.items.map(page=>[page.id,page.pinned]), [[older.id,true]])
    const third = (await read(reopened, {...options,cursor:second.cursor})).body
    assert.deepEqual(third.items.map(page=>[page.id,page.pinned]), [[recent.id,false]])
    assert.equal(third.cursor, null)
    assert.equal((await read(reopened, {...options,cursor:first.cursor,pinned:'1'})).status, 400)
  }
  const pinnedOnly = (await read(reopened, {pinned:'1', limit:'1'})).body
  assert.equal(pinnedOnly.total, 2)
  const remainingPin = (await read(reopened, {pinned:'1',limit:'1',cursor:pinnedOnly.cursor})).body
  assert.deepEqual(remainingPin.items.map(page=>page.id), [older.id])
  assert.equal(remainingPin.cursor, null)
  assert.deepEqual((await read(reopened, {pinned:'1'}, OTHER_WS)).body.items.map(page=>page.id), [otherWorkspace.id])
  assert.equal((await read(reopened, {pinned:'0'})).status, 400)

  const peer = await boot(undefined, {teams:[OTHER_WS]})
  assert.equal((await pin(older, false, WS, peer)).status, 404)
  assert.equal((await read(peer, {pinned:'1'})).body.total, 0)
  assert.equal((await pin(middle, false, WS, reopened)).status, 200)
  assert.equal((await pin(older, false, WS, reopened)).status, 200)
  assert.deepEqual((await read(reopened, {pinned:'1'})).body.items, [])
  assert.equal((await read(reopened)).body.items[0].id, recent.id)
  assert.deepEqual((await reopened.call('memory', 'GET', details)).body.page, before)
})
