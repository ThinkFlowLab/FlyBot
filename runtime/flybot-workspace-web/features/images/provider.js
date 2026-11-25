import { sniffMime } from '../artifacts/render.js'

export const IMAGE_SIZES = {square:'1024x1024', portrait:'1024x1536', landscape:'1536x1024'}
const MAX_BYTES = 8 * 1024 * 1024
const MAX_RESPONSE = Math.ceil(MAX_BYTES / 3) * 4 + 64 * 1024

export async function generateImage(config, job, fetcher = globalThis.fetch) {
  const response = await fetcher(config.base_url + '/images/generations', {
    method:'POST',
    headers:{'Authorization':'Bearer ' + config.api_key,'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify({model:config.model,prompt:job.prompt,size:IMAGE_SIZES[job.shape],n:1,output_format:'png'}),
    redirect:'error',signal:AbortSignal.timeout(180000),
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    if (response.status === 429) throw Object.assign(new Error('Image provider busy'),{code:'busy'})
    if ([401,403].includes(response.status)) throw Object.assign(new Error('Image credentials rejected'),{code:'auth'})
    throw new Error('Image generation did not complete')
  }
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.byteLength
    if (length > MAX_RESPONSE) throw new Error('Image response too large')
    chunks.push(chunk)
  }
  const image = JSON.parse(Buffer.concat(chunks).toString('utf8')).data?.[0]?.b64_json
  if (typeof image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new Error('Missing generated image')
  const data = Buffer.from(image,'base64')
  if (data.length < 24 || data.length > MAX_BYTES || sniffMime(data) !== 'image/png'
      || data.toString('ascii',12,16) !== 'IHDR'
      || ![data.readUInt32BE(16),data.readUInt32BE(20)].every(side => side > 0 && side <= 4096)) {
    throw new Error('Unsupported generated image')
  }
  return data
}
