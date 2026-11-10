import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/store.js'

function patch(method, replace) {
  const original = fsp[method]
  fsp[method] = replace(original)
  syncBuiltinESMExports()
  return () => {
    fsp[method] = original
    syncBuiltinESMExports()
  }
}

function patchSync(method, replace) {
  const original = fs[method]
  fs[method] = replace(original)
  syncBuiltinESMExports()
  return () => {
    fs[method] = original
    syncBuiltinESMExports()
  }
}

function runtime(t, saved, { home: at, config } = {}) {
  const home = at ?? fs.mkdtempSync(join(tmpdir(), 'ds-bot-store-'))
  const statePath = join(home, 'state.json')
  if (saved !== undefined) fs.writeFileSync(statePath, typeof saved === 'string' ? saved : JSON.stringify(saved))
  const warnings = []
  const disposers = []
  let disposed
  const ctx = {
    logger: { warn: (...args) => warnings.push(args) },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  const rt = {
    ctx,
    home,
    statePath,
    config,
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    warn: (...args) => warnings.push(args),
  }
  install(rt)
  const dispose = () => {
    disposed ??= Promise.all(disposers.splice(0).map(cleanup => cleanup()))
    return disposed
  }
  t.after(async () => {
    await dispose()
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, home, statePath, warnings, dispose }
}

// P-556 (Chief's ruling: no write-through): the store never writes through a link. The rename
// replaces the name, link included, so the target keeps every byte and its last write time, and the
// path a person opened is a regular file of this home's own from that save on.
test('a save over a linked state.json replaces the link and leaves its target alone', async (t) => {
  const elsewhere = fs.mkdtempSync(join(tmpdir(), 'ds-bot-store-target-'))
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  const target = join(elsewhere, 'shared-team.json')

  // A team file this host wrote itself: a hand-written `state.json` is refused at load (member
  // records missing), and a store in `stuck` never saves, so the link would survive untouched.
  const { rt, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  fs.renameSync(statePath, target)
  const kept = fs.readFileSync(target)
  const before = fs.lstatSync(target)
  fs.symlinkSync(target, statePath)
  await rt.save()

  assert.equal(fs.lstatSync(statePath).isSymbolicLink(), false, 'the save replaced the link with a regular file')
  const after = fs.lstatSync(target)
  assert.deepEqual(fs.readFileSync(target), kept, 'not one byte was written through the link')
  assert.equal(after.mtimeMs, before.mtimeMs, 'the target was not touched')
  assert.equal(fs.existsSync(`${statePath}.${process.pid}.tmp`), false, 'no temp name is left behind')
  assert.match(fs.readFileSync(statePath, 'utf8'), /"version": 2/, 'the regular file is the team the save wrote')
})

// P-556: the window can only say "saved as a file of its own, the link's target unchanged" if the
// host counts that save, so the count is the state face's token: it starts at 0, goes up by one for
// the save that replaced a link, and stays put for the saves over the regular file that followed.
// The count is answered with the generation of the process that made it (Chief, on review): a
// restarted host starts counting at 0 again, and a bare 0 would read to a window as an older, smaller
// count, so the save that came with the restart would never be said.
test('a save that replaced a link is counted once, with the generation it belongs to', async (t) => {
  const elsewhere = fs.mkdtempSync(join(tmpdir(), 'ds-bot-store-target-'))
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
  const target = join(elsewhere, 'shared-team.json')
  fs.writeFileSync(target, '{"version":2,"bots":{}}\n')

  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-store-'))
  const statePath = join(home, 'state.json')
  const first = runtime(t, undefined, { home })
  await first.rt.load()
  await first.rt.save()
  const start = first.rt.stateLinkReplaced()
  assert.equal(start.count, 0, 'a save that replaced no link counts nothing')
  assert.equal(typeof start.gen, 'string', 'the count names the process that made it')
  assert.ok(start.gen.length >= 8, 'the generation is a stamp of this process, not an empty string')

  fs.renameSync(statePath, target)
  fs.rmSync(target, { force: true })
  fs.writeFileSync(target, '{"version":2,"bots":{}}\n')
  fs.symlinkSync(target, statePath)
  await first.rt.save()
  const counted = first.rt.stateLinkReplaced()
  assert.equal(counted.count, 1, 'the save that replaced a link is counted')
  assert.equal(counted.gen, start.gen, 'the same process keeps the generation it started with')
  await first.rt.save()
  assert.equal(first.rt.stateLinkReplaced().count, 1, 'a later save over the regular file is not counted again')

  // Another install is another process: its count starts over at 0 under a generation of its own,
  // which is what lets a window tell "this host has replaced nothing yet" from "an older count".
  const other = runtime(t)
  await other.rt.load()
  const restarted = other.rt.stateLinkReplaced()
  assert.equal(restarted.count, 0)
  assert.notEqual(restarted.gen, start.gen, 'each host process answers its own generation')
})

test('a failed state write rejects and leaves the saved file unchanged', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  const original = fs.readFileSync(statePath)
  fs.mkdirSync(`${statePath}.${process.pid}.tmp`)
  rt.state.prefs.marker = 'not saved'
  await assert.rejects(rt.save())
  assert.deepEqual(fs.readFileSync(statePath), original)
})

test('a failed migration write warns but load() still resolves', async (t) => {
  const { rt, statePath, warnings } = runtime(t, { version: 1, mainBotId: 'chief', bots: { chief: { id: 'chief', name: 'Chief' } } })
  // The migrated team's first write fails: a directory takes the temp file's path.
  fs.mkdirSync(`${statePath}.${process.pid}.tmp`)
  await rt.load()
  assert.equal(rt.readOnly(), undefined)
  assert.ok(warnings.some(args => /saving the migrated Bot team failed/.test(String(args))))
  // Once the disk is free the next save() writes the migrated state.
  fs.rmSync(`${statePath}.${process.pid}.tmp`, { recursive: true })
  await rt.save()
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(saved.mainBotId, undefined)
  assert.ok(saved.mainBotIds.includes('chief'))
})

test('a failed state rename rejects and preserves the saved file', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  const original = fs.readFileSync(statePath)
  const restore = patch('rename', originalRename => async (from, to) => {
    if (to === statePath) throw Object.assign(new Error('synthetic rename failure'), { code: 'ENOSPC' })
    return originalRename(from, to)
  })
  try {
    rt.state.prefs.marker = 'not saved'
    await assert.rejects(rt.save(), { code: 'ENOSPC' })
    assert.deepEqual(fs.readFileSync(statePath), original)
  } finally {
    restore()
  }
})

test('malformed state is backed up before a later save', async (t) => {
  const original = '{"version":1,'
  const { rt, statePath } = runtime(t, original)
  await rt.load()
  const backups = fs.readdirSync(rt.home).filter(name => name.startsWith('state.json.broken-'))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(join(rt.home, backups[0]), 'utf8'), original)
  rt.state.prefs.marker = 'recovered'
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'recovered')
})

test('malformed state stays read-only when its backup cannot be copied', async (t) => {
  const original = '{"version":1,'
  const { rt, statePath } = runtime(t, original)
  const restore = patch('copyFile', () => async () => {
    throw Object.assign(new Error('synthetic copy failure'), { code: 'EACCES' })
  })
  try {
    await rt.load()
    assert.match(rt.readOnly(), /could not be read/)
    rt.state.prefs.marker = 'not saved'
    await rt.save()
    assert.equal(fs.readFileSync(statePath, 'utf8'), original)
    assert.deepEqual(fs.readdirSync(rt.home).filter(name => name.startsWith('state.json.broken-')), [])
  } finally {
    restore()
  }
})

test('a state from a newer version remains untouched', async (t) => {
  const original = JSON.stringify({ version: 999, revision: 77, recoveryMarker: 'keep' })
  const { rt, statePath } = runtime(t, original)
  await rt.load()
  assert.match(rt.readOnly(), /saved by a newer FlyBot; update FlyBot/)
  rt.state.prefs.marker = 'not saved'
  await rt.save()
  assert.equal(fs.readFileSync(statePath, 'utf8'), original)
})

test('a read error keeps the existing state read-only', async (t) => {
  const original = JSON.stringify({ version: 1, revision: 77, recoveryMarker: 'keep' })
  const { rt, statePath } = runtime(t, original)
  const restore = patch('readFile', originalRead => async (path, ...args) => {
    if (path === statePath) throw Object.assign(new Error('synthetic read failure'), { code: 'EACCES' })
    return originalRead(path, ...args)
  })
  try {
    await rt.load()
  } finally {
    restore()
  }
  assert.match(rt.readOnly(), /could not be read \(EACCES\)/)
  await rt.save()
  assert.equal(fs.readFileSync(statePath, 'utf8'), original)
})

test('refresh adopts a fixed state file and clears read-only mode', async (t) => {
  const { rt, statePath } = runtime(t, { version: 999, revision: 77 })
  await rt.load()
  assert.match(rt.readOnly(), /could not be read/)
  const fixed = { version: 1, revision: 78, recoveryMarker: 'fixed file' }
  fs.writeFileSync(statePath, JSON.stringify(fixed))
  await rt.refresh()
  assert.equal(rt.readOnly(), undefined)
  assert.equal(rt.state.recoveryMarker, 'fixed file')
  rt.state.prefs.marker = 'saved after repair'
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'saved after repair')
})

test('an unusable state lock warns and keeps the team saving', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t)
  const lockPath = join(home, 'state.lock')
  const restore = patchSync('writeFileSync', originalWrite => (path, ...args) => {
    if (path === lockPath) throw Object.assign(new Error('synthetic lock failure'), { code: 'EACCES' })
    return originalWrite(path, ...args)
  })
  try {
    await rt.load()
    assert.equal(rt.readOnly(), undefined)
    assert.equal(warnings.filter(([template]) => template.includes('cannot lock')).length, 1)
    rt.state.prefs.marker = 'saved without a lock'
    await rt.save()
    await rt.refresh()
    assert.equal(rt.state.prefs.marker, 'saved without a lock')
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'saved without a lock')
  } finally {
    restore()
  }
})

test('a queued save rejects after another host takes the lock', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  let entered
  let unblock
  const atMkdir = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  let paused = false
  const restore = patch('mkdir', originalMkdir => async (path, ...args) => {
    if (path === home && !paused) {
      paused = true
      entered()
      await gate
    }
    return originalMkdir(path, ...args)
  })
  try {
    rt.state.prefs.marker = 'old owner'
    const active = rt.save()
    await atMkdir
    const queued = rt.save()
    fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'new-owner' }))
    const ownerState = JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'new owner' } })
    fs.writeFileSync(statePath, ownerState)
    unblock()
    await assert.rejects(active, { code: 'ELOCKLOST' })
    await assert.rejects(queued, { code: 'ELOCKLOST' })
    assert.equal(fs.readFileSync(statePath, 'utf8'), ownerState)
    assert.equal(JSON.parse(fs.readFileSync(join(home, 'state.lock'), 'utf8')).token, 'new-owner')
  } finally {
    unblock()
    restore()
  }
})

test('a read-only host resolves awaited saves without writing', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'new-owner' }))
  const ownerState = JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'new owner' } })
  fs.writeFileSync(statePath, ownerState)
  await rt.refresh()
  assert.match(rt.readOnly(), /another dsh/)
  rt.state.prefs.marker = 'not saved'
  await rt.save()
  assert.equal(fs.readFileSync(statePath, 'utf8'), ownerState)
})

// Opening the state journal is itself a write: it creates `journal/` (0700) and repairs a
// half-written last line by replacing the file with its complete prefix. A window another dsh
// keeps read-only never gets to record, so opening it there leaves the folder behind and rewrites
// the holder's own journal — a window that may not change the team changed the team's home.
test('a read-only window neither creates nor rewrites the state journal', async (t) => {
  // Someone else's home: this window may not write, so no `journal/` may appear at all.
  const held = fs.mkdtempSync(join(tmpdir(), 'ds-bot-store-'))
  t.after(() => fs.rmSync(held, { recursive: true, force: true, maxRetries: 5 }))
  fs.writeFileSync(join(held, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const reader = runtime(t, undefined, { home: held, config: { stateJournal: true } })
  assert.equal(fs.existsSync(join(held, 'journal')), false, 'a window that may not write creates no journal folder')
  await reader.rt.load()
  assert.match(reader.rt.readOnly(), /another dsh/)
  reader.rt.state.prefs.marker = 'not saved'
  await reader.rt.save()
  assert.equal(fs.existsSync(join(held, 'journal')), false, 'a refused save opens no journal')

  // The holder's journal keeps its bytes, half-written last line included: repairing it is a
  // write, and this window may not write.
  const shared = fs.mkdtempSync(join(tmpdir(), 'ds-bot-store-'))
  t.after(() => fs.rmSync(shared, { recursive: true, force: true, maxRetries: 5 }))
  const writer = runtime(t, undefined, { home: shared, config: { stateJournal: true } })
  await writer.rt.load()
  await writer.rt.save()
  const path = join(shared, 'journal', 'state.jsonl')
  fs.appendFileSync(path, '{"seq":2,"t":1,"op":se')
  // Another process, so this one is a reader: a same-pid lock file would be a lock it can take.
  fs.writeFileSync(join(shared, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const before = fs.readFileSync(path)
  const second = runtime(t, undefined, { home: shared, config: { stateJournal: true } })
  await second.rt.load()
  assert.match(second.rt.readOnly(), /another dsh/)
  assert.deepEqual(fs.readFileSync(path), before, 'opening a journal this window may not write leaves its bytes alone')
  second.rt.state.prefs.marker = 'not saved'
  await second.rt.save()
  assert.deepEqual(fs.readFileSync(path), before, 'a refused save leaves the journal bytes alone')
})

// A home that already holds a saved team, so loading a fresh host is only a read: with no
// state.json, load() saves the file itself and that first save would open the writer.
async function savedHome(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-store-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const first = runtime(t, undefined, { home })
  await first.rt.load()
  await first.rt.save()
  await first.dispose()
  return home
}

// The writer opens on the first save, so until then nothing was read, folded or repaired:
// `recording: true` alone promises lines the file was never asked for. `opened` says which of
// the two states a reader is looking at, and reading it never opens the writer — that is the
// write the lazy open exists to avoid.
test('the state journal says it has not started until the first save opens it (#2373)', async (t) => {
  const home = await savedHome(t)
  const { rt, warnings } = runtime(t, undefined, { home, config: { stateJournal: true } })
  assert.deepEqual(rt.journal.status(), { recording: true, opened: false })
  await rt.load()
  assert.deepEqual(rt.journal.status(), { recording: true, opened: false }, 'loading a saved team opens nothing')
  assert.equal(fs.existsSync(join(home, 'journal')), false, 'a host that never saved creates no journal folder')
  await rt.save()
  assert.deepEqual(rt.journal.status(), { recording: true, opened: true }, 'the first save opens the writer')
  assert.equal(fs.existsSync(join(home, 'journal', 'state.jsonl')), true)
  assert.equal(warnings.length, 0, 'a journal that opened cleanly warns about nothing')
})

// A journal that refuses is only found out by the first save, which is the first read of the
// file: before it, the honest answer is still "not started", not a stop that never happened.
test('a journal that refuses on the first save has only then stopped (#2373)', async (t) => {
  const home = await savedHome(t)
  const target = join(home, 'neighbour.txt')
  fs.writeFileSync(target, 'PRIVATE LINE\n')
  fs.mkdirSync(join(home, 'journal'), { recursive: true })
  fs.symlinkSync(target, join(home, 'journal', 'state.jsonl'))
  const { rt, warnings } = runtime(t, undefined, { home, config: { stateJournal: true } })
  await rt.load()
  assert.deepEqual(rt.journal.status(), { recording: true, opened: false }, 'loading the host reads no journal')
  await rt.save()
  const status = rt.journal.status()
  assert.equal(status.opened, true, 'the first save opens the writer')
  assert.equal(status.recording, false, 'a journal that refuses does not record')
  assert.match(status.because, /not a plain file/)
  assert.equal(warnings.length, 1, 'a refused start-up is warned once')
})

test('dispose waits for a pending save and prevents later writes', async (t) => {
  const { rt, home, statePath, dispose } = runtime(t)
  await rt.load()
  await rt.save()
  let entered
  let unblock
  const atRename = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const restore = patch('rename', originalRename => async (from, to) => {
    if (to === statePath) {
      entered()
      await gate
    }
    return originalRename(from, to)
  })
  try {
    rt.state.prefs.marker = 'pending save'
    const pending = rt.save()
    await atRename
    const disposing = dispose()
    assert.equal(fs.existsSync(join(home, 'state.lock')), true)
    const revision = rt.state.revision
    const afterDispose = rt.save()
    assert.equal(rt.state.revision, revision)
    unblock()
    await pending
    await disposing
    await afterDispose
    assert.equal(fs.existsSync(join(home, 'state.lock')), false)
    const saved = fs.readFileSync(statePath, 'utf8')
    await rt.save()
    assert.equal(rt.state.revision, revision)
    assert.equal(fs.readFileSync(statePath, 'utf8'), saved)
  } finally {
    unblock()
    restore()
  }
})

test('a member that loses its seat closes its external process (#198)', async (t) => {
  const { rt } = runtime(t)
  await rt.load()
  const calls = []
  rt.closeExternalParticipant = (roomId, botId) => { calls.push([roomId, botId]); return true }
  ctxRegistry(rt)
  const room = { id: 'ops', name: 'Ops', sessions: { ext: 'external:ops:ext' } }
  rt.dropGroupSession(room, 'ext')
  assert.deepEqual(calls, [['ops', 'ext']])
  assert.equal(room.sessions.ext, undefined)
})

// dropGroupSession archives the Session it drops; this fixture's host has no registry of its own.
function ctxRegistry(rt) {
  rt.ctx.workspaceRegistry = { archiveSession: async () => {} }
}

// #1704: a roster id that is not an own key of its table is not a member either.
test('a roster id that is not an own key finds no Bot and no group (#1704)', async (t) => {
  const { rt } = runtime(t, {
    version: 2,
    revision: 1,
    mainBotIds: ['a'],
    members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
    bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' } },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} } },
    agents: {}, exchanges: [],
  })
  await rt.load()
  assert.equal(rt.findBot('__proto__'), undefined, 'findBot(__proto__) answered Object.prototype')
  assert.deepEqual(rt.findRooms('__proto__'), [], 'findRooms(__proto__) answered Object.prototype')
  assert.equal(rt.findBot('a').name, 'Chief')
  assert.equal(rt.findRooms('Ops')[0].id, 'r1')
})

// The state write lands through `<state>.json.<pid>.tmp` and then renames it into place. The temp
// name is a leaf like the state file (temp-name sweep): `writeFile` would follow a link there, put
// the team outside the home and then rename the link over the state file. Only the target is
// replaced by `rename`, link included, never written through.
test('a linked state temp name does not take the save; the state file stays a plain file', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t)
  await rt.load()
  const outside = join(home, 'outside-state.json')
  fs.writeFileSync(outside, 'OUTSIDE\n')
  fs.symlinkSync(outside, `${statePath}.${process.pid}.tmp`)
  rt.state.prefs.sweep = 'not saved'
  await assert.rejects(rt.save())
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE\n', 'the file behind the temp link is not written through')
  assert.equal(fs.lstatSync(statePath).isSymbolicLink(), false, 'the state file is still a plain file')
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.sweep, undefined, 'the refused save did not land')
  assert.ok(warnings.some(line => /not a plain file/.test(line.join(' '))), 'the refusal is named')
})

// The other half of the same shape: a link at the destination itself is replaced by the rename, so
// it never needs the temp check. This is why the sweep only adds the temp name.
test('a link at the state file itself is replaced, not written through', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  const outside = join(home, 'outside-state.json')
  fs.writeFileSync(outside, 'OUTSIDE\n')
  fs.rmSync(statePath)
  fs.symlinkSync(outside, statePath)
  rt.state.prefs.sweep = 'kept'
  await rt.save()
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE\n', 'the rename never follows the target link')
  assert.equal(fs.lstatSync(statePath).isSymbolicLink(), false, 'the link is replaced by the saved file')
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.sweep, 'kept')
})

// The temp name can also be a hard link: `lstat` reports a plain file, so a link-only check lets it
// through and the save lands in the inode the other name holds (`nlink 2`). A name that is a file
// but not only this one is refused the same way; the leftover plain temp of a crashed host (one
// name, `nlink 1`) stays replaceable, which the next test keeps.
test('a hard link at the state temp name is refused; the save never reaches the shared file', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t)
  await rt.load()
  await rt.save()
  const before = fs.readFileSync(statePath, 'utf8')
  const outside = join(home, 'outside-state.json')
  fs.writeFileSync(outside, 'OUTSIDE\n')
  fs.linkSync(outside, `${statePath}.${process.pid}.tmp`)
  rt.state.prefs.sweep = 'not saved'
  await assert.rejects(rt.save())
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE\n', 'the shared inode keeps its bytes')
  assert.equal(fs.lstatSync(outside).nlink, 2, 'the outside file still carries the temp name')
  assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'the state file kept what it had')
  assert.ok(warnings.some(line => /not a plain file/.test(line.join(' '))), 'the refusal is named')
  assert.ok(warnings.some(line => line.join(' ').includes(`${statePath}.${process.pid}.tmp`)), 'the warning names the temp path')
})

// #2714: a room record that carries no `members` list (a hand edit, a restore from another
// machine, a half-written state, or a version-1 room from before the field existed) made
// adopt() throw inside load(); `loaded ??=` then cached the rejection, so every later load()
// rejected too, with no warning and no repair path. The room is kept and the list is repaired.
const team = (rooms) => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' } },
  rooms,
  agents: {},
  exchanges: [],
})

test('a version-2 room record with no members keeps load() resolving and the room (#2714)', async (t) => {
  const { rt, statePath } = runtime(t, team({
    broken: { id: 'broken', name: 'Ops', mode: 'everyone', sessions: {} },
    kept: { id: 'kept', name: 'Lab', members: ['a'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} },
  }))
  await rt.load()
  assert.equal(rt.readOnly(), undefined, 'the file is not refused read-only')
  assert.deepEqual(Object.keys(rt.state.rooms).sort(), ['broken', 'kept'], 'the room with no members is kept')
  assert.deepEqual(rt.state.rooms.broken.members, [], 'the room list is repaired to an empty one')
  assert.equal(rt.state.rooms.kept.name, 'Lab', 'the other room is untouched')
  await rt.load()
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.deepEqual(saved.rooms.broken.members, [], 'the repair is saved, so the next start reads it whole')
  assert.deepEqual(saved.rooms.kept.members, ['a'])
})

test('a version-2 room record whose members is null keeps load() resolving and the room (#2714)', async (t) => {
  const { rt } = runtime(t, team({
    // `admin` and a valid mode keep the first adopt() loop off the field, so this fixture reaches
    // the autoRoomName call that maps it — the second of the two throwing lines.
    broken: { id: 'broken', name: '', members: null, mode: 'admin', admin: 'a', named: false, sessions: {} },
  }))
  rt.autoRoomName = members => members.map(id => id).join(', ') || 'Room'
  await rt.load()
  assert.equal(rt.readOnly(), undefined)
  assert.deepEqual(rt.state.rooms.broken.members, [])
  assert.equal(rt.state.rooms.broken.name, 'Room', 'the unnamed room is named from its repaired list')
  await rt.load()
  assert.deepEqual(rt.state.rooms.broken.members, [])
})

test('a version-1 home with a room that has no members keeps load() resolving (#2714)', async (t) => {
  const { rt, statePath } = runtime(t, {
    version: 1,
    mainBotId: 'chief',
    bots: { chief: { id: 'chief', name: 'Chief' } },
    rooms: { legacy: { id: 'legacy', name: '', mode: 'everyone', sessions: {} } },
  })
  await rt.load()
  assert.equal(rt.readOnly(), undefined, 'the home is not left half-migrated and read-only')
  assert.ok(rt.state.rooms.legacy, 'the legacy room survives the migration')
  assert.deepEqual(rt.state.rooms.legacy.members, [])
  assert.equal(fs.existsSync(`${statePath}.v1`), true, 'the version-1 backup is still taken')
  await rt.load()
})

// #2715: `exchanges` was the one table `adopt()` never looked at — `Object.assign` copied a
// `null` in as it was, so `load()` resolved and `readOnly()` answered null (writable) while
// `save()` threw on `state.exchanges.slice(-MAX_EXCHANGES)` every time. Every write goes through
// save(): a Bot, a room name, a group message, a memory write, a delivery.
const teamWith = (extra) => ({ ...team({}), ...extra })

test('a team file whose exchanges is null loads writable and saves (#2715)', async (t) => {
  const { rt, statePath, warnings } = runtime(t, teamWith({ exchanges: null }))
  await rt.load()
  assert.equal(rt.readOnly(), undefined, 'the window is told it may write the team')
  assert.deepEqual(rt.state.exchanges, [], 'the null list is repaired before the first write reads it')
  assert.equal(warnings.some(line => /saving the migrated Bot team failed/.test(line.join(' '))), false, 'the load-time migration save does not fail')
  await rt.save()
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).exchanges, [], 'the repaired list is saved')
})

for (const [label, value] of [['an object', { old: 'entry' }], ['a string', 'exchanges'], ['a number', 3]]) {
  test(`a team file whose exchanges is ${label} is repaired to an empty list (#2715)`, async (t) => {
    const { rt, statePath } = runtime(t, teamWith({ exchanges: value }))
    await rt.load()
    assert.equal(rt.readOnly(), undefined)
    assert.deepEqual(rt.state.exchanges, [])
    await rt.save()
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).exchanges, [])
  })
}

// The repair must not touch a list that is already one: the shipped shape keeps its entries and
// `save()` trims it to the newest MAX_EXCHANGES, which is the only trimming that ever applied.
test('a valid exchanges list keeps its newest MAX_EXCHANGES entries (#2715)', async (t) => {
  const { MAX_EXCHANGES } = await import('../src/host/constants.js')
  const entries = Array.from({ length: MAX_EXCHANGES + 3 }, (_, i) => ({ id: `e${i}`, from: 'a', to: 'b', text: `line ${i}` }))
  const { rt, statePath } = runtime(t, teamWith({ exchanges: entries }))
  await rt.load()
  assert.equal(rt.readOnly(), undefined)
  assert.equal(rt.state.exchanges.at(-1).text, `line ${MAX_EXCHANGES + 2}`, 'load() keeps a saved list as it is')
  await rt.save()
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8')).exchanges
  assert.equal(saved.length, MAX_EXCHANGES, 'the save trims the list to the newest entries')
  assert.equal(saved[0].text, 'line 3', 'the oldest entries are the ones dropped')
  assert.equal(saved.at(-1).text, `line ${MAX_EXCHANGES + 2}`, 'the newest entry survives the trim')
})

// The same class one field over: a table the schema expects as a record arrived as `null` or a
// scalar. `save()` itself survived those, but the first write that indexed the table threw — the
// turn record in turns.js, the group question in tools.js, a Bot or a room lookup — so the team
// was loaded, writable and unusable, with the same stack instead of the file being named.
for (const [field, shape, value] of [['exchangeTurns', 'null', null], ['questions', 'null', null], ['questions', 'a string', 'lost'], ['rooms', 'null', null], ['rooms', 'a list', []]]) {
  test(`a team file whose ${field} is ${shape} is repaired instead of failing every write (#2715)`, async (t) => {
    const { rt, statePath } = runtime(t, teamWith({ [field]: value }))
    await rt.load()
    assert.equal(rt.readOnly(), undefined, `${field}: the window is told it may write the team`)
    assert.deepEqual(rt.state[field], {}, `${field}: the corrupt table is repaired to an empty one`)
    await rt.save()
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8'))[field], {}, `${field}: the repair is saved`)
  })
}

test('a team file whose prefs is not a record is repaired instead of refusing the team (#2715)', async (t) => {
  const { rt, statePath } = runtime(t, teamWith({ prefs: 'quiet' }))
  await rt.load()
  assert.equal(rt.readOnly(), undefined, 'a prefs scalar does not make the file unreadable')
  assert.equal(typeof rt.state.prefs, 'object')
  assert.equal(rt.state.prefs.turnBudget, 0, 'the default turn budget is written to the repaired record')
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.turnBudget, 0)
})

// The roster is the last table `Object.assign` copies in raw. A version-2 file that carries `bots`
// as `null` is refused read-only before adopt() sees it (`ownershipProblem`), so only a version-1
// home can reach the copy with no roster — and there it threw out of load().
test('a version-1 home whose roster is null loads instead of throwing (#2715)', async (t) => {
  const { rt, statePath } = runtime(t, { version: 1, bots: null, revision: 1 })
  await rt.load()
  assert.equal(rt.readOnly(), undefined, 'the team is not refused read-only')
  assert.deepEqual(rt.state.bots, {}, 'a roster that carried no record is repaired to an empty one')
  await rt.save()
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).bots, {})
})

test('a team file with no version is reported as incomplete, not as a newer FlyBot', async (t) => {
  const shapes = [
    ['an empty object', '{}'],
    ['null', 'null'],
    ['an empty array', '[]'],
    ['an empty string', '""'],
  ]
  for (const [label, original] of shapes) {
    const { rt, home, statePath } = runtime(t, original)
    await rt.load()
    assert.match(rt.readOnly(), /the team file has no version — it is incomplete \(an empty or half-written file\)/, label)
    assert.doesNotMatch(rt.readOnly(), /newer FlyBot/, label)
    rt.state.prefs.marker = 'not saved'
    await rt.save()
    assert.equal(fs.readFileSync(statePath, 'utf8'), original, label)
    assert.deepEqual(fs.readdirSync(home).filter(name => name.startsWith('state.json.broken-')), [], label)
  }
})

test('a zero-byte or truncated team file is backed up and loads fresh, never refused as newer', async (t) => {
  for (const [label, original] of [['zero bytes', ''], ['truncated json', '{"version":2,"bots":{']]) {
    const { rt, home } = runtime(t, original)
    await rt.load()
    assert.equal(rt.readOnly(), undefined, label)
    assert.equal(fs.readdirSync(home).filter(name => name.startsWith('state.json.broken-')).length, 1, label)
  }
})

// #2755: a saved record that is null (a truncated write, a hand edit, an older build) used to throw
// out of adopt(), and `loaded ??=` cached the rejection: the team never appeared, `readOnly()` had no
// answer and nothing named state.json. The record is evidence-backed up and folded instead.
test('a room record that is null is backed up and folded, and the team still appears (#2755)', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t, team({ r1: null }))
  await rt.load()
  assert.equal(rt.readOnly(), undefined, 'the file loads as a writable team instead of a null answer')
  assert.deepEqual(rt.state.rooms.r1.members, [], 'the room is kept and folded to an empty member list')

  const backups = fs.readdirSync(home).filter(name => name.startsWith('state.json.broken-'))
  assert.equal(backups.length, 1, 'the pre-repair file is kept as one .broken copy')
  const kept = JSON.parse(fs.readFileSync(join(home, backups[0]), 'utf8'))
  assert.equal(kept.rooms.r1, null, 'the dropped value is preserved verbatim in the evidence copy')

  const written = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(written.version, 2, 'the repair is written back as version 2')
  assert.deepEqual(written.rooms.r1.members, [], 'the saved room carries the repaired list')
  assert.equal(warnings.some(line => line.join(' ').includes('state.json')), true, 'a warning names state.json')
})

test('a version-1 Bot record that is null migrates, keeps .v1 and drops only that record (#2755)', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t, {
    version: 1,
    revision: 1,
    bots: { chief: null, kept: { id: 'kept', name: 'Keeper', createdAt: 1 } },
  })
  await rt.load()
  assert.equal(rt.readOnly(), undefined, 'the team is not refused read-only')
  assert.equal(rt.state.version, 2, 'the version-1 team is migrated')
  assert.deepEqual(Object.keys(rt.state.bots), ['kept'], 'only the broken record is dropped')

  const v1 = JSON.parse(fs.readFileSync(`${statePath}.v1`, 'utf8'))
  assert.equal(v1.version, 1, 'the version-1 backup is kept')
  assert.equal(v1.bots.chief, null, 'the backup is the file as it was, broken record included')
  const backups = fs.readdirSync(home).filter(name => name.startsWith('state.json.broken-'))
  assert.equal(backups.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(join(home, backups[0]), 'utf8')).bots.chief, null)

  const written = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(written.version, 2)
  assert.equal(Object.hasOwn(written.bots, 'chief'), false, 'the repaired file carries no null Bot record')
  assert.equal(warnings.some(line => line.join(' ').includes('state.json')), true, 'a warning names state.json')
})

test('a version-1 team with a null record is not written back in a read-only pass (#2755)', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-store-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const original = JSON.stringify({ version: 1, revision: 1, bots: { chief: null, kept: { id: 'kept', name: 'Keeper', createdAt: 1 } } })
  fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  fs.writeFileSync(join(home, 'state.json'), original)

  const { rt } = runtime(t, undefined, { home })
  await rt.load()
  assert.match(rt.readOnly(), /another dsh/, 'the window is told why it may not write')
  assert.equal(fs.readFileSync(join(home, 'state.json'), 'utf8'), original, 'a read-only pass writes no state.json')
  assert.equal(JSON.parse(fs.readFileSync(join(home, 'state.json.v1'), 'utf8')).version, 1, '.v1 is still kept')
})

test('a healthy team loads with no broken-record warning and no .broken copy (#2755)', async (t) => {
  const { rt, home, warnings } = runtime(t, team({ r1: { id: 'r1', name: 'Ops', members: ['a'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} } }))
  await rt.load()
  assert.equal(rt.readOnly(), undefined)
  assert.deepEqual(fs.readdirSync(home).filter(name => name.startsWith('state.json.broken-')), [], 'no evidence copy for a healthy file')
  assert.equal(warnings.some(line => line.join(' ').includes('broken record')), false, 'no warning for a healthy file')
})
