// Minimal persistent store for the management plane.
//
// One JSON document (`<dataDir>/plane.json`) with a `version` so a later slice can
// migrate it. Writes go through a temporary file in the same directory and a rename,
// so a crash leaves the previous document intact. The file is 0600 and the directory
// 0700 — the same private-file discipline as core/src/host/private-files.js.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { seedMembers } from './workspace-roles.mjs'

export const STORE_VERSION = 1

export class DuplicateInstanceError extends Error {
  constructor(workspaceId, name) {
    super(`instance "${name}" already exists in workspace "${workspaceId}"`)
    this.name = 'DuplicateInstanceError'
    this.code = 'DUPLICATE_INSTANCE'
    this.workspaceId = workspaceId
    this.instanceName = name
  }
}

export class InstanceNotFoundError extends Error {
  constructor(id) {
    super(`no instance ${id}`)
    this.name = 'InstanceNotFoundError'
    this.code = 'INSTANCE_NOT_FOUND'
    this.instanceId = id
  }
}

function emptyData() {
  return { version: STORE_VERSION, accounts: [], workspaces: [], instances: [] }
}

export class Store {
  #dataDir
  #file
  #data

  constructor(dataDir) {
    if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('openStore needs a data directory')
    this.#dataDir = dataDir
    this.#file = join(dataDir, 'plane.json')
    this.#data = this.#read()
  }

  get file() {
    return this.#file
  }

  get dataDir() {
    return this.#dataDir
  }

  #read() {
    if (!existsSync(this.#file)) return emptyData()
    const parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
    if (parsed.version !== STORE_VERSION) {
      throw new Error(`unsupported plane.json version ${parsed.version}; expected ${STORE_VERSION}`)
    }
    parsed.accounts ??= []
    parsed.workspaces ??= []
    parsed.instances ??= []
    for (const workspace of parsed.workspaces) seedMembers(workspace)
    return parsed
  }

  save() {
    const existed = existsSync(this.#dataDir)
    mkdirSync(this.#dataDir, { recursive: true, mode: 0o700 })
    if (!existed) chmodSync(this.#dataDir, 0o700)
    const body = `${JSON.stringify(this.#data, null, 2)}\n`
    const tmp = `${this.#file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, this.#file)
    chmodSync(this.#file, 0o600)
  }

  listAccounts() {
    return this.#data.accounts
  }

  getAccount(id) {
    return this.#data.accounts.find((account) => account.id === id) ?? null
  }

  upsertAccount(account) {
    const index = this.#data.accounts.findIndex((existing) => existing.id === account.id)
    if (index >= 0) this.#data.accounts[index] = account
    else this.#data.accounts.push(account)
    this.save()
    return account
  }

  ensureWorkspace({ id, ownerId, createdAt }) {
    let workspace = this.getWorkspace(id, ownerId)
    if (!workspace) {
      workspace = seedMembers({ id, ownerId, createdAt })
      this.#data.workspaces.push(workspace)
      this.save()
    }
    return workspace
  }

  // Workspace ids are owner-scoped: two owners may each name a workspace "ws-1".
  getWorkspace(id, ownerId) {
    return (
      this.#data.workspaces.find(
        (workspace) => workspace.id === id && (ownerId === undefined || workspace.ownerId === ownerId),
      ) ?? null
    )
  }

  // The candidates for a bare workspace id: two owners may each own a "ws-1", so a caller picks
  // the one it has a role in instead of taking the first.
  workspacesWithId(id) {
    return this.#data.workspaces.filter((workspace) => workspace.id === id)
  }

  updateWorkspaceMembers(workspace, members) {
    const stored = this.#data.workspaces.find(
      (candidate) => candidate.id === workspace.id && candidate.ownerId === workspace.ownerId,
    )
    if (!stored) throw new Error(`no workspace ${workspace.id} owned by ${workspace.ownerId}`)
    stored.members = members
    this.save()
    return stored
  }

  listInstances(ownerId) {
    return ownerId ? this.#data.instances.filter((instance) => instance.ownerId === ownerId) : this.#data.instances
  }

  getInstance(id) {
    return this.#data.instances.find((instance) => instance.id === id) ?? null
  }

  insertInstance(instance) {
    // Unique within an owner's workspace, not globally: two owners keep their own "main".
    const clash = this.#data.instances.some(
      (existing) =>
        existing.ownerId === instance.ownerId &&
        existing.workspaceId === instance.workspaceId &&
        existing.name === instance.name,
    )
    if (clash) throw new DuplicateInstanceError(instance.workspaceId, instance.name)
    this.#data.instances.push(instance)
    this.save()
    return instance
  }

  updateInstance(id, patch) {
    const instance = this.getInstance(id)
    if (!instance) throw new InstanceNotFoundError(id)
    Object.assign(instance, patch)
    this.save()
    return instance
  }
}

export function openStore(dataDir) {
  return new Store(dataDir)
}

