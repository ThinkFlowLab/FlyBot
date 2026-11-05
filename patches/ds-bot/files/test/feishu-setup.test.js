import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(import.meta.dirname, '../dev/harness'), 'package.json'))('jsdom')

async function setup(t, saved = [], language) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true })
  dom.window.eval(await readFile(join(import.meta.dirname, '../workbench-native.js'), 'utf8'))
  const apps = saved, calls = []
  const api = async body => {
    calls.push(body)
    if (body.operation === 'save') {
      let app = apps.find(a => a.id === body.appId)
      if (!app) { app = { id: body.appId, name: 'Feishu', allowed: [], identities: [], grants: {} }; apps.push(app) }
      Object.assign(app, { mode: body.mode, step: body.step, publicUrl: body.publicUrl, connection: 'connecting' })
      return { apps: structuredClone(apps), test: { ok: false, error: 'Publish the app first' } }
    }
    if (body.operation === 'configure') Object.assign(apps.find(a => a.id === body.appId), body)
    return { apps: structuredClone(apps), members: [{ id: 'owner-1', name: 'Owner' }] }
  }
  const root = dom.window.document.getElementById('root')
  let unmount = dom.window.FlyBotNativeConversation.mountNativeFeishu(root, { actions: { feishu: api }, roster: { bots: [{ id: 'b1', name: 'Chief' }] }, language, onClose() {} })
  t.after(() => { unmount?.(); dom.window.close() })
  for (let i = 0; i < 100; i++) { if (calls.length && (!saved.length || root.querySelector('select')?.value === saved[0].id)) break; await delay(10) }
  await delay(20)
  const button = title => [...root.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === title)
  const click = async title => { const b = button(title); assert.ok(b, title); assert.equal(b.disabled, false, title); b.click(); await delay(30) }
  const input = async (name, value) => {
    const target = root.querySelector(`input[aria-label="${name}"]`)
    assert.ok(target, name)
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(target, value)
    target.dispatchEvent(new dom.window.Event('input', { bubbles: true })); target.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await delay(10)
  }
  return { dom, root, apps, calls, button, click, input, unmount: () => { unmount(); unmount = undefined } }
}

test('mounted guide defaults to six steps and validates credentials before saving', async t => {
  const ui = await setup(t)
  assert.equal(ui.root.querySelectorAll('ol > li').length, 6)
  assert.match(ui.root.textContent, /im:message.reactions:write_only/)
  await ui.click('Next')
  await ui.input('App ID', 'cli_invalid')
  await ui.input('App Secret', 'fixture-secret')
  assert.equal(ui.button('Save and test connection').disabled, true)
  await ui.input('App ID', 'cli_0123456789abcdef')
  await ui.click('Save and test connection')
  assert.match(ui.root.textContent, /Wait until connected/)
  assert.ok(!ui.root.textContent.includes('Now set Events and callbacks'))
  assert.ok(!ui.root.textContent.includes('fixture-secret'))
  assert.ok(ui.calls.some(c => c.operation === 'save' && c.mode === 'socket'))
})

test('standalone guide reuses Chinese setup copy and keeps credential errors readable', async t => {
  const ui = await setup(t, [], 'zh-CN')
  assert.match(ui.root.textContent, /在飞书开放平台创建应用/)
  assert.equal(ui.root.querySelector('button[aria-label="长连接（推荐，不需要公网地址）"]').getAttribute('aria-pressed'), 'true')
  await ui.click('下一步')
  await ui.input('App ID', 'cli_invalid')
  assert.match(ui.root.textContent, /App ID 必须是 cli_ 加 16 位十六进制字符/)
  assert.equal(ui.button('保存并测试连接').disabled, true)
  assert.ok(!ui.root.textContent.includes('Enter credentials and test connection'))
})

test('mounted HTTP guide requires a public address, resumes saved progress and switches the same app', async t => {
  const id = 'cli_0123456789abcdef'
  const ui = await setup(t, [{ id, mode: 'socket', step: 2, botId: 'b1', connection: 'ready', allowed: [], grants: {}, identities: [] }])
  assert.match(ui.root.querySelector('h4').textContent, /Subscribe to message/)
  assert.match(ui.root.textContent, /Now set Events and callbacks/)
  await ui.click('Event address (HTTP, needs a public address)')
  assert.equal(ui.root.querySelectorAll('ol > li').length, 7)
  assert.equal(ui.button('Next').disabled, true)
  await ui.input('Public HTTPS event origin', 'http://localhost')
  assert.equal(ui.button('Next').disabled, true)
  await ui.input('Public HTTPS event origin', 'https://events.example.com')
  await ui.click('Next'); await ui.click('Next')
  assert.equal(ui.root.querySelector('input[aria-label="App ID"]').disabled, true)
  await ui.input('Verification Token', 'fixture-token')
  await ui.click('Save and test connection')
  assert.equal(ui.apps.length, 1)
  assert.equal(ui.apps[0].id, id)
  assert.equal(ui.apps[0].mode, 'http')
  assert.match(ui.root.textContent, new RegExp(`/api/feishu/events/${id}`))
  assert.ok(!ui.root.textContent.includes('fixture-token'))
})
