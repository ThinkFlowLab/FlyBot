import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { COMPUTER_PATH, createComputers } from '../../flybot-workspace-web/src/computer.js'

const computers = createComputers('/data')
const agent = 'a'.repeat(32)
const workspace = 'f'.repeat(32)
const a = {id:agent, name:'Fixture A', cwd:'/data/workspace'}
const b = {id:'b'.repeat(32), name:'Fixture B', cwd:'/data/workspace'}
const handle = computers.handler((ws, id) => ws === workspace && id === agent ? a : null)
const control = (method, op) => handle(new Request(
  `http://localhost${COMPUTER_PATH}?workspace=${workspace}&agent=${agent}&op=${op}`,
  {method},
))
const act = (action, fields, target = a) => computers.botAction(target, {action, ...fields})
const windows = async target => JSON.parse(await act('windows', {}, target))

async function eventually(read) {
  for (let attempt = 0; attempt < 35; attempt++) {
    const result = await Promise.resolve().then(read).catch(error => {
      if (error.status !== 404) throw error
    })
    if (result) return result
    await delay(200)
  }
  assert.fail('The expected desktop update did not appear')
}

async function testBrowser() {
  let submitted
  const fixture = createServer((request, response) => {
    const query = new URL(request.url, 'http://localhost').searchParams.get('q')
    if (query !== null) submitted = query
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'})
    response.end('<!doctype html><title>FlyBot Browser Fixture</title>' +
      '<form><label>Search fixture <input name="q"></label><button>Run search</button></form>')
  })
  fixture.listen(0, '127.0.0.1')
  await once(fixture,'listening')
  try {
    await act('open', {app:'browser', url:'http://127.0.0.1:' + fixture.address().port})
    const {window_id, field} = await eventually(async () => {
      const browser = (await windows()).find(item => item.title?.includes('FlyBot Browser Fixture'))
      if (!browser) return
      const {window_id} = browser
      const {elements} = JSON.parse(await act('inspect', {window_id}))
      const field = elements.find(item => item.label === 'Search fixture')
      if (field) return {window_id, field}
    })
    await act('click', {window_id, element_token:field.element_token})
    const query = 'flybot-browser-fixture'
    await act('type', {window_id, text:query})
    await act('key', {key:'Return'})
    await eventually(() => submitted === query)
    console.log('PASS: Firefox submitted text entered through the Bot desktop tool')
  } finally {
    fixture.close()
  }
}

async function testDesktop() {
  await act('open', {app:'editor'})
  const editor = await eventually(async () => (await windows()).find(item => item.title?.includes('Mousepad')))
  const window_id = editor.window_id
  const inspect = async () => JSON.parse(await act('inspect', {window_id}))
  const findNew = async () => (await inspect()).elements.find(item => item.label === 'New')?.element_token
  const element_token = await eventually(findNew)

  const take = await control('POST', 'take')
  assert.equal(take.status, 200)
  const {lease} = await take.json()
  await assert.rejects(act('click', {window_id, element_token}), {status:409})
  assert.equal((await control('DELETE', `control&lease=${lease}`)).status, 200)
  await assert.rejects(act('click', {window_id, element_token}), {status:400})

  await act('click', {window_id, element_token:await eventually(findNew)})
  await eventually(async () => (await windows()).some(item => item.window_id === window_id && item.title?.includes('Untitled 2')))
  const marker = 'FLYBOT-CUA-DESKTOP-INTEGRATION'
  await act('type', {window_id, text:marker})
  await eventually(async () => JSON.stringify(await inspect()).includes(marker))

  assert.ok(!(await windows(b)).some(item => item.title?.includes('Mousepad')))
  await assert.rejects(act('inspect', {window_id}, b), {status:404})
  const image = await act('screenshot')
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  console.log('PASS: Linux AX list, inspect, click, type, screenshot, owner takeover, and Bot isolation')
}

try {
  if (process.argv[2] === 'browser') await testBrowser()
  else await testDesktop()
} finally {
  computers.close()
}
