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
