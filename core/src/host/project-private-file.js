// Operator-selected private credential files never become model environment inputs.
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
export async function privateCredentialFile(path, maxBytes = 16384) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('An explicit private credential file is required')
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await file.stat()
    if (!info.isFile() || info.size < 1 || info.size > maxBytes || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error('Unsafe private credential file')
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxBytes) throw new Error('Private credential file changed beyond its budget')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch { throw new Error('Private credential file is unavailable or has unsafe permissions') }
  finally { await file?.close() }
}
