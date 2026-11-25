import { createHash } from 'node:crypto'
import { defineFeature } from '../../featurekit/feature.js'
import { digest, HEX32, idempotencyKey, newId, refuse, requireBodyKeys } from '../../featurekit/http.js'
import { PRIVATE_FILE_BYTES } from '../agents/files.js'
import { IMAGE_MIMES } from '../artifacts/model.js'
import { sniffMime } from '../artifacts/render.js'

const ROOT = '/v1/stickers'
const ID = '([0-9a-f]{32})'
const EXTENSIONS = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp'}
const ENCODED_LIMIT = Math.ceil(PRIVATE_FILE_BYTES / 3) * 4
const METADATA = 'id,title,mime,bytes,created'
const SCHEMA = `
CREATE TABLE stickers (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, title TEXT NOT NULL, mime TEXT NOT NULL,
  bytes INTEGER NOT NULL, created INTEGER NOT NULL, content BLOB NOT NULL
);
CREATE INDEX stickers_newest ON stickers(created DESC,id DESC);
CREATE TABLE sticker_add_receipts (
  key_hash TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
  sticker_id TEXT REFERENCES stickers(id) ON DELETE SET NULL
);
CREATE INDEX sticker_receipts_by_item ON sticker_add_receipts(sticker_id) WHERE sticker_id IS NOT NULL;
`

function view(row) {
  const {id,title,mime,bytes,created} = row
  return {id,title,mime,bytes,created,path:`${ROOT}/${id}/file`}
}

function read(store, id) {
  const row = typeof id === 'string' && HEX32.test(id) &&
    store.get('SELECT title,mime,content FROM stickers WHERE id=?',id)
  if (!row) refuse(404,'not_found','找不到这个表情。')
  return row
}

function list(req) {
  for (const name of req.query.keys()) {
    if (!['cursor','limit'].includes(name) || req.query.getAll(name).length !== 1) {
      refuse(400,'invalid','无效的表情分页参数。')
    }
  }
  const limit = req.query.get('limit') ?? '50'
  const cursor = req.query.get('cursor') ?? ''
  const position = /^(\d{1,15})\.([0-9a-f]{32})$/.exec(cursor)
  if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || (cursor && !position)) {
    refuse(400,'invalid','无效的表情分页参数。')
  }
  const count = Number(limit)
  const page = req.store.all(`SELECT ${METADATA} FROM stickers
    ${position ? 'WHERE (created,id)<(?,?)' : ''} ORDER BY created DESC,id DESC LIMIT ?`,
  ...(position ? [Number(position[1]),position[2]] : []),count+1)
  const items = page.slice(0,count).map(view)
  const last = items.at(-1)
  return {body:{items,cursor:page.length > count ? `${last.created}.${last.id}` : null}}
}

function stickerFile(body) {
  if (typeof body.title !== 'string' || !body.title.trim() || typeof body.data !== 'string' || !body.data) {
    refuse(400,'invalid','请选择一个图片文件。')
  }
  if (body.data.length > ENCODED_LIMIT) refuse(413,'attachment_too_large','表情图片不能超过 8 MiB。')
  const content = Buffer.from(body.data,'base64')
  if (!content.length || content.toString('base64') !== body.data) refuse(400,'invalid','无效的图片数据。')
  if (content.length > PRIVATE_FILE_BYTES) refuse(413,'attachment_too_large','表情图片不能超过 8 MiB。')
  const mime = sniffMime(content)
  if (!IMAGE_MIMES.has(mime) || (body.mime !== undefined && body.mime !== '' && body.mime !== mime)) {
    refuse(400,'attachment_type_blocked','表情须为 PNG、JPEG、GIF 或 WebP 图片。')
  }

  // Keep the native private file and group attachment validators in agreement
  // about the file type even when the original upload was pasted or renamed.
  const suffix = '.' + EXTENSIONS[mime]
  const stem = body.title.toWellFormed().replace(/[\u0000-\u001f\u007f/\\]/g,'_')
    .trim().replace(/\.(?:png|jpe?g|gif|webp)$/i,'').replaceAll('.','_')
  const title = ((stem.trim() || 'sticker').slice(0,200-suffix.length).toWellFormed()) + suffix
  const sha = createHash('sha256').update(content).digest('hex')
  return {title,mime,content,sha}
}

async function libraryRoute(req) {
  if (req.method === 'GET') return list(req)
  if (req.method !== 'POST') refuse(405,'method','该操作不可用。')
  if (req.queryString) refuse(400,'invalid','无效的表情请求。')
  const keyHash = req.headers.has('idempotency-key') ? digest(idempotencyKey(req.headers)) : null
  const body = requireBodyKeys(await req.json(ENCODED_LIMIT+2048),['title','mime','data'])
  const {title,mime,content,sha} = stickerFile(body)
  const requestHash = keyHash && digest(JSON.stringify([title,mime,sha]))
  return req.store.transaction(store => {
    if (keyHash) {
      const prior = store.get(`SELECT r.request_hash,s.id,s.title,s.mime,s.bytes,s.created FROM sticker_add_receipts r
        LEFT JOIN stickers s ON s.id=r.sticker_id WHERE r.key_hash=?`,keyHash)
      if (prior) {
        if (prior.request_hash !== requestHash) refuse(409,'conflict','这个请求标识已用于另一张图片。')
        if (!prior.id) refuse(410,'sticker_removed','这个表情已移除。')
        return {status:200,body:{sticker:view(prior)}}
      }
    }
    let row = store.get(`SELECT ${METADATA} FROM stickers WHERE sha256=?`,sha)
    const status = row ? 200 : 201
    if (!row) {
      row = {id:newId(),title,mime,bytes:content.length,created:req.now}
      store.run('INSERT INTO stickers (id,sha256,title,mime,bytes,created,content) VALUES (?,?,?,?,?,?,?)',
        row.id,sha,title,mime,row.bytes,row.created,content)
    }
    if (keyHash) {
      store.run('INSERT INTO sticker_add_receipts (key_hash,request_hash,sticker_id) VALUES (?,?,?)',
        keyHash,requestHash,row.id)
    }
    return {status,body:{sticker:view(row)}}
  })
}

async function removeRoute(req, id) {
  if (req.method !== 'POST') refuse(405,'method','该操作不可用。')
  if (req.queryString || requireBodyKeys(await req.json(1024),['action']).action !== 'remove') {
    refuse(400,'invalid','无效的表情请求。')
  }
  req.store.run('DELETE FROM stickers WHERE id=?',id)
  return {body:{removed:true}}
}

function fileRoute(req, id) {
  if (req.method !== 'GET') refuse(405,'method','该操作不可用。')
  if (req.queryString) refuse(400,'invalid','无效的表情文件请求。')
  const row = read(req.store,id)
  return {raw:row.content,filename:row.title,inline:true,headers:{'content-type':row.mime}}
}

export default defineFeature({
  name:'stickers', migrations:[SCHEMA], routes:[
    {pattern:/^\/v1\/stickers$/,handle:libraryRoute},
    {pattern:new RegExp(`^${ROOT}/${ID}$`),handle:removeRoute},
    {pattern:new RegExp(`^${ROOT}/${ID}/file$`),handle:fileRoute},
  ],
  endpoints:({store}) => ({
    async attachment(payload, call) {
      if (!call?.internal) refuse(404,'not_found','找不到这个表情。')
      const row = read(store,payload?.id)
      return {attachment:{title:row.title,mime:row.mime,data:Buffer.from(row.content).toString('base64')}}
    },
  }),
})
