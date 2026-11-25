import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import stickers from '../features/stickers/index.js'
import { createLegacyDispatch, LEGACY_PATH } from '../src/dispatch.js'

const library = '/v1/stickers'
const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII='
const image = {title:'开心.gif',mime:'image/gif',data:gif}

function owner(t, dir) {
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(),'ot-stickers-'))
    t.after(() => rmSync(dir,{recursive:true,force:true}))
  }
  const {endpoints,store} = stickers({featureDir:() => dir})
  const dispatch = createLegacyDispatch({endpoints:{'stickers/v1':endpoints.v1}})
  function request(method, path, {body,key} = {}) {
    const target = new URL(path,'http://dsbot')
    const incoming = new URL(LEGACY_PATH,'http://dsbot')
    incoming.searchParams.set('feature','stickers')
    incoming.searchParams.set('path',target.pathname)
    incoming.searchParams.set('query',target.search.slice(1))
    return dispatch(new Request(incoming,{method,body:body && JSON.stringify(body),
      headers:key ? {'Idempotency-Key':key} : undefined}))
  }
  return {dir,endpoints,request,close:store.close}
}

test('stickers survive restart and remain available only inside the owner volume', async t => {
  const first = owner(t)
  const other = owner(t)
  t.after(other.close)
  const upload = await first.request('POST',library,{body:image,key:'sticker-original-key'})
  assert.equal(upload.status,201)
  const {sticker} = await upload.json()
  assert.deepEqual([sticker.title,sticker.mime,sticker.bytes],[image.title,image.mime,Buffer.from(gif,'base64').length])
  assert.equal(sticker.path,`${library}/${sticker.id}/file`)
  first.close()

  const restarted = owner(t,first.dir)
  t.after(restarted.close)
  assert.deepEqual(await (await restarted.request('GET',library)).json(),{items:[sticker],cursor:null})
  assert.deepEqual(await (await other.request('GET',library)).json(),{items:[],cursor:null})
  assert.equal((await other.request('GET',sticker.path)).status,404)
  assert.equal((await other.request('POST',`${library}/${sticker.id}`,{body:{action:'remove'}})).status,200)
  await assert.rejects(other.endpoints.attachment({id:sticker.id},{internal:true}),{status:404})
  await assert.rejects(restarted.endpoints.attachment({id:sticker.id},{request:new Request('http://dsbot')}),{status:404})
  assert.deepEqual(await restarted.endpoints.attachment({id:sticker.id},{internal:true}),{attachment:image})

  const file = await restarted.request('GET',sticker.path)
  assert.equal(file.headers.get('content-type'),'image/gif')
  assert.equal(file.headers.get('cache-control'),'private, no-store')
  assert.equal(file.headers.get('x-content-type-options'),'nosniff')
  assert.match(file.headers.get('content-disposition'),/^inline;/)
  assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'),gif)
  const head = await restarted.request('HEAD',sticker.path)
  assert.equal(head.status,200)
  assert.equal(head.headers.get('content-length'),String(sticker.bytes))
  assert.equal(await head.text(),'')
})

test('identical uploads share one image and delayed receipts cannot undo removal', async t => {
  const bot = owner(t)
  t.after(bot.close)
  const upload = (body,key) => bot.request('POST',library,{body,key})
  const results = await Promise.all([upload(image,'sticker-original-key'),upload(image,'sticker-duplicate-key')])
  assert.deepEqual(results.map(response=>response.status).sort(),[200,201])
  const copies = await Promise.all(results.map(response=>response.json()))
  const {sticker} = copies[0]
  assert.deepEqual(copies[0],copies[1])
  assert.equal((await upload({...image,title:'Different.gif'},'sticker-original-key')).status,409)
  assert.equal((await upload({...image,title:'Different.gif'})).status,200)
  const remove = () => bot.request('POST',`${library}/${sticker.id}`,{body:{action:'remove'}})
  assert.deepEqual(await (await remove()).json(),{removed:true})
  assert.deepEqual(await (await remove()).json(),{removed:true})
  assert.equal((await bot.request('GET',sticker.path)).status,404)
  assert.equal((await bot.request('HEAD',sticker.path)).status,404)
  assert.equal((await upload(image,'sticker-original-key')).status,410)
  assert.equal((await upload(image,'sticker-duplicate-key')).status,410)
  await assert.rejects(bot.endpoints.attachment({id:sticker.id},{internal:true}),{status:404})
  const next = await upload(image,'sticker-new-import')
  assert.equal(next.status,201)
  assert.notEqual((await next.json()).sticker.id,sticker.id)
})

test('sticker paging uses metadata and accepts the position of an item removed between pages', async t => {
  const bot = owner(t)
  t.after(bot.close)
  const upload = (body) => bot.request('POST',library,{body})
  assert.equal((await upload({...image,data:gif.substring(0,gif.length-1)})).status,400)
  assert.equal((await upload({...image,mime:'image/png'})).status,400)
  assert.equal((await upload({title:'image.svg',mime:'image/svg+xml',data:Buffer.from('<svg></svg>').toString('base64')})).status,400)
  assert.equal((await upload({...image,data:'A'.repeat(12*1024*1024)})).status,413)
  const first = (await (await upload({title:'表情.html.png',mime:'image/png',data:png})).json()).sticker
  assert.equal(first.title,'表情_html.png')
  const second = (await (await upload(image)).json()).sticker
  const current = await (await bot.request('GET',library+'?limit=1')).json()
  const shown = current.items[0]
  const remaining = shown.id === first.id ? second : first
  assert.equal(typeof current.cursor,'string')
  assert.equal(shown.data,undefined)
  await bot.request('POST',`${library}/${shown.id}`,{body:{action:'remove'}})
  assert.deepEqual(await (await bot.request('GET',library+'?limit=1&cursor='+current.cursor)).json(),{items:[remaining],cursor:null})
  assert.equal((await bot.request('GET',library+'?limit=201')).status,400)
  assert.equal((await bot.request('GET',library+'?limit=2&limit=3')).status,400)
})
