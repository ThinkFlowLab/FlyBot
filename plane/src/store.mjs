// The plane's own record: one JSON file under the data dir holding accounts, workspaces and
// instance metadata. The management plane owns this file alone — an instance's own data stays on
// its volume (#3113): what lives here is what the plane needs to find and to steer an instance.
//
// The write path is the one `core/src/host/private-files.js` uses: a temp file next to the
// target, renamed over, with the mode named in the code (0600 file, 0700 dir) instead of
// inherited from whoever started the process. `version` sits at the top so a later migration can
// tell what it is reading before it reads it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { hash, mintControlToken } from './credentials.mjs'

export const PRIVATE_FILE_MODE = 0o600
export const PRIVATE_DIR_MODE = 0o700
const STORE_VERSION = 1

// A name is unique inside one workspace, not on the whole plane: two owners may each have a
// "main" (#3113). The store is the only place this rule lives, so the HTTP route cannot widen it.
export class DuplicateInstanceError extends Error {
  constructor(workspaceId, name) {
    super(`an instance named ${JSON.stringify(name)} already exists in workspace ${workspaceId}`)
    this.name = 'DuplicateInstanceError'
    this.workspaceId = workspaceId
    this.instanceName = name
  }
}

export class UnknownInstanceError extends Error {
  constructor(id) {
    super(`no instance ${id}`)
    this.name = 'UnknownInstanceError'
    this.instanceId = id
  }
}

const emptyStore = () => ({ version: STORE_VERSION, accounts: [], workspaces: [], instances: [] })

const byId = (list, id) => list.find(entry => entry.id === id)

function readStoreFile(path) {
  if (!existsSync(path)) return emptyStore()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed.version !== STORE_VERSION) {
      throw new Error(`plane.json version ${parsed.version} is not ${STORE_VERSION} — migrations are not written yet`)
    }
    return parsed
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`plane.json at ${path} is not valid JSON: ${err.message}`)
    throw err
  }
}

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: PRIVATE_DIR_MODE })
  try { chmodSync(dataDir, PRIVATE_DIR_MODE) } catch { /* the file modes below still hold */ }
  const path = join(dataDir, 'plane.json')
  let data = readStoreFile(path)

  const persist = () => {
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : PRIVATE_FILE_MODE
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode })
    chmodSync(temp, mode)
    renameSync(temp, path)
  }

  const store = {
    get path() { return path },
    persist,
    createAccount({ name }) {
      const account = { id: `ac_${randomUUID().replaceAll('-', '')}`, name, operatorTokenHashes: [], createdAt: Date.now() }
      data.accounts.push(account)
      persist()
      return account
    },
    findAccount(id) { return byId(data.accounts, id) ?? null },
    accounts() { return data.accounts.slice() },
    createWorkspace({ accountId, name }) {
      if (!byId(data.accounts, accountId)) throw new Error(`no account ${accountId}`)
      const workspace = { id: `ws_${randomUUID().replaceAll('-', '')}`, accountId, name, createdAt: Date.now() }
      data.workspaces.push(workspace)
      persist()
      return workspace
    },
    findWorkspace(id) { return byId(data.workspaces, id) ?? null },
    // The control token is minted here and returned once: only its sha256 is kept, so the record
    // can verify a caller but cannot re-tell the secret (#3113).
    createInstance({ workspaceId, name }) {
      const workspace = byId(data.workspaces, workspaceId)
      if (!workspace) throw new Error(`no workspace ${workspaceId}`)
      if (data.instances.some(i => i.workspaceId === workspaceId && i.name === name)) {
        throw new DuplicateInstanceError(workspaceId, name)
      }
      const { token, digest } = mintControlToken()
      const instance = {
        id: `in_${randomUUID().replaceAll('-', '')}`,
        workspaceId,
        ownerId: workspace.accountId,
        name,
        state: 'stopped',
        health: 'unknown',
        port: 3090 + (data.instances.length % 900),
        controlTokenHash: digest,
        createdAt: Date.now(),
      }
      data.instances.push(instance)
      persist()
      return { instance, controlToken: token }
    },
    getInstance(id) {
      const instance = byId(data.instances, id)
      if (!instance) throw new UnknownInstanceError(id)
      return instance
    },
    findInstance(id) { return byId(data.instances, id) ?? null },
    listInstances({ ownerId } = {}) {
      return data.instances.filter(i => ownerId === undefined || i.ownerId === ownerId)
    },
    updateInstance(id, patch) {
      const instance = store.getInstance(id)
      Object.assign(instance, patch)
      persist()
      return instance
    },
  }
  return store
}
