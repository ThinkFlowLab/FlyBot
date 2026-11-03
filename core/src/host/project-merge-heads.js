// Git's rev-parse reports only the first MERGE_HEAD in an octopus merge. Inspect
// the bounded registered metadata file so no additional parent escapes admission.
import { constants } from 'node:fs'
import { open, lstat, realpath } from 'node:fs/promises'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
const fail = () => Object.assign(new Error('Pending merge metadata is unavailable or outside the registered Git workspace'), { code: 'bot/integration-metadata' })
const inside = (root, path) => { const value = relative(root, path); return value !== '' && value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value) }
const readScript = `const fs=require('node:fs'),path=require('node:path');
const root=path.join(process.cwd(),'.git');const directory=fs.lstatSync(root);
if(!directory.isDirectory()||directory.isSymbolicLink()||fs.realpathSync(root)!==root)throw Error('Registered clone metadata changed');
const file=path.join(root,'MERGE_HEAD');let info;try{info=fs.lstatSync(file)}catch(e){if(e.code==='ENOENT')process.exit(0);throw e}
if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw Error('Invalid bounded merge metadata');
const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const current=fs.fstatSync(fd);if(current.ino!==info.ino||current.dev!==info.dev)throw Error('Merge metadata changed');const buffer=Buffer.alloc(4097);const size=fs.readSync(fd,buffer,0,buffer.length,0);if(size>4096)throw Error('Merge metadata too large');process.stdout.write(buffer.subarray(0,size))}finally{fs.closeSync(fd)}`

export function parseMergeHeads(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4096) throw fail()
  if (text === '') return []
  const heads = text.replace(/\r?\n$/, '').split(/\r?\n/)
  if (heads.length > 20 || heads.some(value => !/^[a-f0-9]{40}$/.test(value)) || new Set(heads).size !== heads.length) throw fail()
  return heads
}
export async function readMergeHeads(rt, workspace, { workspaceGit, hostGit }) {
  if (workspace.kind === 'resource-clone') {
    rt.projectResources.requireBinding(workspace.projectId, workspace.resourceLease)
    const result = await rt.projectResources.command(workspace.projectId, workspace.resourceId, { cwd: workspace.path, argv: ['node', '-e', readScript] })
    return parseMergeHeads(result.stdout)
  }
  const [top, directory, common] = await Promise.all([
    workspaceGit(workspace, ['rev-parse', '--show-toplevel']), workspaceGit(workspace, ['rev-parse', '--absolute-git-dir']),
    hostGit(workspace.repository, ['rev-parse', '--git-common-dir']),
  ])
  const [actualTop, actualDirectory, actualCommon] = await Promise.all([realpath(top), realpath(directory), realpath(resolve(workspace.repository, common))])
  if (actualTop !== await realpath(workspace.path) || !inside(join(actualCommon, 'worktrees'), actualDirectory)) throw fail()
  const file = join(actualDirectory, 'MERGE_HEAD')
  let info
  try { info = await lstat(file) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw fail()
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await handle.stat()
    if (current.ino !== info.ino || current.dev !== info.dev) throw fail()
    const buffer = Buffer.alloc(4097), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return parseMergeHeads(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally { await handle.close() }
}
