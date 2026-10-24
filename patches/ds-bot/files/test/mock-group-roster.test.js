import assert from 'node:assert/strict'
import test from 'node:test'
import { decide } from '../dev/mock-llm.mjs'

// #894 put the members line in the system-prompt section. A group turn's own
// text no longer says who leads, which is what "admin calls everyone" reads.
const standing = [
  'You are Chief, a Bot on the user\'s team.',
  'You are the Main Bot.',
  '',
  '# This group chat',
  'Members: the user, Writer, Coder and you (admin). Members speak one at a time; each message is posted before the next speaker starts.',
].join('\n')

const turn = [
  '[Group chat "研发群" · your turn]',
  '',
  'This round so far, starting with the new message (oldest first):',
  'User: 讨论',
].join('\n')

function groupTurn(system) {
  return decide({
    system,
    tools: [{ name: 'update_group' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: turn }] }],
  })
}

test('the mock treats the caller as admin from the system section, not the turn (#917)', () => {
  const out = groupTurn(standing)
  assert.equal(out[0].text, '@all 大家各说一句。')
  // A member's section names someone else as admin, so the same turn is not an @all.
  const member = standing.replace('and you (admin).', 'and you.').replace('Writer, Coder', 'Writer (admin), Coder')
  assert.equal(groupTurn(member)[0].text, '我觉得可以。')
  // The turn itself carries no members line; without the section the caller is not the admin.
  assert.equal(groupTurn('You are Chief, a Bot on the user\'s team.')[0].text, '我觉得可以。')
})
