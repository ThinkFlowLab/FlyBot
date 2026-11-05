// P-556 follow-up: the store recognises a symbolic link at `state.json` and says so once, but a
// *hard* link is the same event for the person who opened the name — the save renames a regular file
// over it, the other name keeps the bytes it had, and the window that asked for the save is told
// nothing. `lstat().isSymbolicLink()` is false for a hard link, so the count never moves.
//
// The store's own rule for "a plain file of this host's own" is `nlink === 1` (`plainLeaf`,
// core/src/host/real-dir.js), and the diagnostics report already describes a hard-linked team file as
// a link (`LINKED_STATE`, core/src/host/diagnostics.js); this case asks the count to agree with them.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { announceStateLink, LINK_REPLACED_NOTICE, stateLinkNotice } from '../src/client/state-link-notice.js'
import { install } from '../src/host/store.js'

function runtime(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-store-'))
  const statePath = join(home, 'state.json')
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
    config: undefined,
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
  return { rt, home, statePath, warnings }
}

// The whole chain the person sees: a team file this host wrote, a second name for the same inode, a
// save that replaces the state name, the count that save leaves behind, and the one line the window
// draws from it.
test('a save over a hard-linked state.json is counted, and the window says it once', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  assert.equal(rt.stateLinkReplaced().count, 0, 'a save over this host\'s own file counts nothing')

  const team = join(home, 'team.json')
  fs.renameSync(statePath, team)
  fs.linkSync(team, statePath)
  const shared = fs.lstatSync(statePath)
  assert.equal(shared.isSymbolicLink(), false, 'the state name is a hard link, not a symbolic one')
  assert.equal(shared.nlink, 2, 'two names share the inode the team was saved in')
  const kept = fs.readFileSync(team)
  const before = fs.lstatSync(team)

  const memory = rt.stateLinkReplaced()
  assert.deepEqual(memory, { gen: memory.gen, count: 0 })
  await rt.save()

  const counted = rt.stateLinkReplaced()
  assert.equal(counted.count, 1, 'the save that replaced a hard link is counted')
  assert.equal(counted.gen, memory.gen, 'the same process keeps its generation')

  // The state name, after the save: a different inode, this host's own name alone.
  const stateNow = fs.lstatSync(statePath)
  assert.notEqual(stateNow.ino, shared.ino, 'the save put a regular file of this home at the state name')
  assert.equal(stateNow.nlink, 1, 'the state name no longer shares an inode')

  // The other name, after the save: the same inode it had, one link fewer, every byte and every
  // attribute it had — the inode is what the save left behind, not a copy of it.
  const after = fs.lstatSync(team)
  assert.equal(after.ino, before.ino, 'the other name still points at the inode it always did')
  assert.equal(after.nlink, before.nlink - 1, 'the state name is the one link the save took away')
  assert.equal(after.nlink, 1, 'the other name now carries the shared inode alone')
  assert.equal(after.size, before.size, 'the other name kept its size')
  assert.equal(after.mtimeMs, before.mtimeMs, 'the other name was not touched')
  assert.equal(after.mode, before.mode, 'the other name kept its mode')
  assert.deepEqual(fs.readFileSync(team), kept, 'not one byte was written through the other name')
  assert.equal(fs.existsSync(`${statePath}.${process.pid}.tmp`), false, 'no temp name is left behind')

  // And the count is this one save, not a counter that drifts: a second save lands on the regular
  // file the first one left and moves nothing, so the window is not told again.
  await rt.save()
  const twice = rt.stateLinkReplaced()
  assert.equal(twice.count, 1, 'a save over the regular file that followed is not counted')
  assert.equal(twice.gen, counted.gen, 'the process that counted is still the same one')

  // What a window that polled at 0 does with that answer: one line, once.
  const said = []
  const seen = announceStateLink({ stateFileLinkReplaced: counted }, { gen: counted.gen, count: 0 }, text => said.push(text))
  assert.deepEqual(said, [LINK_REPLACED_NOTICE], 'the window says the save replaced a link')
  assert.deepEqual(stateLinkNotice({ stateFileLinkReplaced: counted }, seen).announce, false,
    'the next poll with the same count says nothing again')
})

// The other half of the predicate: an ordinary save over this host's own file is not a link, and the
// count must stay put — otherwise every save would announce a replacement that never happened.
test('a save over a plain state file, twice, counts nothing', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  await rt.save()
  const after = rt.stateLinkReplaced()
  assert.equal(after.count, 0, 'a plain file of this host\'s own is never counted')
  assert.equal(fs.lstatSync(statePath).nlink, 1)
})

// The symbolic-link case the first tip fixed must keep counting the same way (no regression).
test('a save over a symbolic link is still counted, and still leaves its target alone', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  const target = join(home, 'target.json')
  fs.renameSync(statePath, target)
  const kept = fs.readFileSync(target)
  fs.symlinkSync(target, statePath)
  await rt.save()
  assert.equal(rt.stateLinkReplaced().count, 1, 'a symbolic link is still counted')
  assert.equal(fs.lstatSync(statePath).isSymbolicLink(), false, 'the save replaced the link')
  assert.deepEqual(fs.readFileSync(target), kept, 'the target kept its bytes')
})
