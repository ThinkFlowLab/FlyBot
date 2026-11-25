import { createHash } from 'node:crypto'
import { FeatureError } from '../../featurekit/http.js'
import { MEDIA_MIMES } from '../artifacts/model.js'

export const PRIVATE_FILE_BYTES = 8 * 1024 * 1024
export const PRIVATE_FILE_COUNT = 4
const MEDIA = {
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif',
  txt:'text/plain', md:'text/markdown', csv:'text/csv', tsv:'text/tab-separated-values', json:'application/json',
  pdf:'application/pdf', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
const fail = (status, code, message) => { throw new FeatureError(status, code, message) }

export function privateFiles(descriptors, {savedWork = false} = {}) {
  if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > PRIVATE_FILE_COUNT) {
    fail(400, 'invalid', 'Select one to four files')
  }
  let total = 0
  return descriptors.map(item => {
    const title = (typeof item?.title === 'string' ? item.title : '').replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 200)
    const ext = title.toLowerCase().split('.').at(-1)
    const resource = savedWork ? item?.resource : null
    const storedMime = savedWork && typeof item?.mime === 'string' ? item.mime.split(';')[0] : ''
    const mime = Object.hasOwn(MEDIA, ext) ? MEDIA[ext] : MEDIA_MIMES.has(storedMime) ? storedMime : ''
    if (!title || !mime) fail(400, 'attachment_type_blocked', 'Unsupported file type')
    if (typeof item.data !== 'string' || !item.data.length) fail(400, 'invalid', 'Provide a nonempty file')
    if (item.data.length > Math.ceil(PRIVATE_FILE_BYTES / 3) * 4) fail(413, 'attachment_too_large', 'Files must total 8 MiB or less')
    const data = Buffer.from(item.data, 'base64')
    if (!data.length || data.toString('base64') !== item.data) fail(400, 'invalid', 'Invalid file data')
    total += data.length
    if (total > PRIVATE_FILE_BYTES) fail(413, 'attachment_too_large', 'Files must total 8 MiB or less')
    if ((mime.startsWith('text/') || ext === 'json') && (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data))) {
      fail(400, 'attachment_type_blocked', 'Text files must use UTF-8')
    }
    if (ext === 'pdf' && data.subarray(0,5).toString() !== '%PDF-') fail(400, 'attachment_type_blocked', 'The file is not a PDF')
    if (['docx','xlsx','pptx'].includes(ext) && data.subarray(0,4).toString('hex') !== '504b0304') {
      fail(400, 'attachment_type_blocked', 'The file is not an Office document')
    }
    return {title, mime, data, ...(resource ? {resource} : {})}
  })
}

export function fingerprintAttachments(text, language, files) {
  const rows = files.map(file => [file.title, file.mime, createHash('sha256').update(file.data).digest('hex')])
  return createHash('sha256').update(JSON.stringify([text, language || '', rows])).digest('hex')
}
