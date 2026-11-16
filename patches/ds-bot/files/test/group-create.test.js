import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canCreateGroup, groupMemberMatches, groupMemberQuery } from '../src/shared/group-create.js'

const chief = { id: 'chief', name: 'Chief', role: 'Coordinator' }
const scout = { id: 'scout', name: 'Scout', role: 'Researcher' }
const remote = { id: 'pat', name: 'Pat', remote: { handle: '@pat.home', ownerName: 'Pat' } }

test('create stays off until an admin and at least one member are picked', () => {
  assert.equal(canCreateGroup(null, []), false)
  assert.equal(canCreateGroup('chief', []), false)
  assert.equal(canCreateGroup(null, ['scout']), false)
  assert.equal(canCreateGroup('', ['scout']), false)
  assert.equal(canCreateGroup('chief', ['scout']), true)
  assert.equal(canCreateGroup('chief', ['scout', 'pat']), true)
})

test('member search matches name, role, or the picker label, and ignores case', () => {
  assert.equal(groupMemberQuery('  Scout '), 'scout')
  assert.equal(groupMemberMatches(chief, ''), true)
  assert.equal(groupMemberMatches(chief, '   '), true)
  assert.equal(groupMemberMatches(chief, 'chief'), true)
  assert.equal(groupMemberMatches(scout, 'COORD'), false)
  assert.equal(groupMemberMatches(scout, 'research'), true)
  assert.equal(groupMemberMatches(remote, 'pat'), true)
  assert.equal(groupMemberMatches(chief, 'scout'), false)
  assert.equal(groupMemberMatches(undefined, 'chief'), false)
})
