import assert from 'node:assert/strict'
import {test} from 'node:test'
import {roleContext,contextHash,ROLE_CONTEXT_LIMIT,readContextArchive} from '../src/host/project-role-context.js'
import {assembleRolePolicy,roleExecutionPrompt} from '../src/host/project-role-policy.js'

test('complete pinned policy replaces duplicate previews without losing rules or knowledge', () => {
  const text='Complete public repository rules.\n'.repeat(2000),commit='a'.repeat(40)
  const policy=assembleRolePolicy({role:'developer',commit,sources:[{name:'AGENTS.md',commit,text}],requiredFiles:['AGENTS.md']})
  const repository=[{name:'AGENTS.md',commit,sha256:contextHash(text.trim()),text:text.trim().slice(0,6000),truncated:true}]
  const knowledge=[{id:'fact',text:'Current public facts. '.repeat(2000)}]
  const input={projectId:'p',role:'developer',revision:1,definition:{instructions:'Use the scoped role'},policy,repository,knowledge}
  const result=roleContext(input),data=JSON.parse(result.text.split('<untrusted-role-context>\n')[1].split('\n</untrusted-role-context>')[0])
  assert.equal(data.repository[0].representation,'complete-policy-reference')
  assert.equal(data.repository[0].text,undefined)
  assert.deepEqual(data.knowledge,knowledge)
  assert(result.text.length<=ROLE_CONTEXT_LIMIT)
  const prompt=roleExecutionPrompt('Work',{policy,context:result})
  assert(prompt.includes(policy.text))
  assert.equal(JSON.parse(policy.text.split('<untrusted-repository-policy>\n')[1].split('\n</untrusted-repository-policy>')[0]).sources[0].text,text)
  assert(prompt.includes('Current public facts.'))
  assert.equal(policy.text,assembleRolePolicy({role:'developer',commit,sources:[{name:'AGENTS.md',commit,text}],requiredFiles:['AGENTS.md']}).text)
  assert.throws(()=>roleContext({...input,repository:[{...repository[0],sha256:'wrong'}]}),/exceeds/)
  assert.throws(()=>roleContext({...input,repository:[{...repository[0],commit:'b'.repeat(40)}]}),/exceeds/)
  assert.throws(()=>roleContext({...input,policy:{...policy,text:policy.text+'tampered'}}),/exceeds/)
})

test('explicit verified knowledge checkpoints retain history provenance and newer facts under the same cap', () => {
  const history = Array.from({length: 12}, (_, i) => ({id: `fact-${i}`, text: 'Old verified facts '.repeat(350), createdBy: 'owner', at: i}))
  const checkpoint = {id: 'current', text: 'Current decision: preserve native UI and all permissions.', checkpoint: {version: 'project-knowledge-checkpoint/v1', supersedes: history.map(row => ({id: row.id, sha256: contextHash(JSON.stringify(row))}))}}
  const knowledge = [...history, checkpoint, {id: 'delta', text: 'New frontend failure requires repair.'}]
  const before = structuredClone(knowledge)
  for (const role of ['developer', 'chief']) {
    const input = {projectId: 'p', role, definition: {instructions: 'Keep the role contract'}, knowledge, requirement: {criteria: 'All original acceptance criteria'}}
    const result = roleContext(input)
    const data = JSON.parse(result.text.split('<untrusted-role-context>\n')[1].split('\n</untrusted-role-context>')[0])
    assert.equal(data.knowledge.length, 2)
    assert.equal(data.knowledge[0].text, checkpoint.text)
    assert.equal(data.knowledge[0].checkpoint.sourceCount, 12)
    assert.equal(data.knowledge[0].checkpoint.sourceSha256, contextHash(JSON.stringify(checkpoint.checkpoint.supersedes)))
    assert.deepEqual(data.knowledge[1], knowledge.at(-1))
    assert.equal(data.knowledgeHistory.count, 12)
    assert.equal(data.knowledgeHistory.retained, true)
    assert.equal(data.requirement.criteria, input.requirement.criteria)
    assert.equal(result.sources.knowledge.length, 14)
    assert.ok(result.text.length < ROLE_CONTEXT_LIMIT)
    const tampered = structuredClone(knowledge); tampered[0].text += 'changed'
    assert.throws(() => roleContext({...input, knowledge: tampered}), /exceeds/)
  }
  assert.deepEqual(knowledge, before)
})

test('unknown, duplicate or forward checkpoint references never hide knowledge', () => {
  const old = {id: 'old', text: 'Must remain visible'}
  const ref = {id: old.id, sha256: contextHash(JSON.stringify(old))}
  for (const supersedes of [[{...ref, id: 'foreign'}], [ref, ref], [{...ref, sha256: 'wrong'}], [null], [], 'invalid']) {
    const checkpoint = {id: 'summary', text: 'Summary', checkpoint: {version: 'project-knowledge-checkpoint/v1', supersedes}}
    const result = roleContext({projectId: 'p', role: 'chief', definition: {instructions: ''}, knowledge: [old, checkpoint]})
    assert.ok(result.text.includes('Must remain visible'))
  }
  const forward = {id: 'forward', checkpoint: {version: 'project-knowledge-checkpoint/v1', supersedes: [ref]}}
  assert.ok(roleContext({projectId: 'p', role: 'chief', definition: {instructions: ''}, knowledge: [forward, old]}).text.includes('Must remain visible'))
})


test('SDK context keeps an exact retrievable archive instead of overflowing on growing shared history', () => {
  const knowledge = Array.from({length: 50}, (_, i) => ({id: `note-${i}`, kind: i % 5 ? 'fact' : 'decision', text: '公开项目记录'.repeat(650), at: i}))
  const result = roleContext({projectId: 'p', role: 'developer', definition: {instructions: 'Keep scoped access'}, requirement: {criteria: 'All original requirements'}, knowledge, retrieval: true})
  assert.ok(result.text.length < ROLE_CONTEXT_LIMIT)
  assert.deepEqual(result.archive.knowledge, knowledge)
  assert.equal(result.archive.projectId, 'p')
  assert.equal(result.archiveSha256, contextHash(JSON.stringify(result.archive)))
  assert.ok(result.text.includes('All original requirements'))
  assert.equal(result.sources.knowledge.length, knowledge.length)
  assert.deepEqual(knowledge, result.archive.knowledge)
})


test('retrieval pages bind immutable source hashes and refuse unknown sources', () => {
  const result = roleContext({projectId: 'p', role: 'chief', definition: {}, knowledge: [{id: 'one', text: 'a'.repeat(14000)}], retrieval: true})
  const [first] = readContextArchive(result, [{kind: 'knowledge', id: 'one'}])
  assert.equal(first.nextOffset, 6000)
  assert.equal(first.text.length, 6000)
  assert.equal(readContextArchive(result, [{kind:'index',id:'knowledge'}])[0].text.includes('one'),true)
  assert.equal(readContextArchive(result, [{kind:'knowledge',id:'one',offset:12000}])[0].nextOffset,null)
  for (const requests of [[], Array(5).fill({}), [{kind:'private',id:'one'}], [{kind:'memory',id:'foreign'}], [{kind:'knowledge',id:'one',offset:-1}]]) assert.throws(()=>readContextArchive(result,requests))
  result.archive.knowledge[0].text='tampered'
  assert.throws(()=>readContextArchive(result,[{kind:'knowledge',id:'one'}]),/changed/)
})

test('configured budgets retrieve relevant memory without growing indexes or discarding mandatory constraints', async () => {
  const { createContextBudget, countContextTokens } = await import('../src/host/project-context-budget.js')
  const budget = createContextBudget({ defaults: { windowTokens: 14000, outputTokens: 1000, toolTokens: 1000, protocolTokens: 500, memoryTokens: 900, knowledgeTokens: 1500 } })
  const memory = Array.from({ length: 1000 }, (_, i) => ({ id: `m-${i}`, text: `Past unrelated experience ${i}`.repeat(20), at: i }))
  memory[0].text = 'SQLite migration must retain previous transaction evidence'
  const knowledge = Array.from({ length: 100 }, (_, i) => ({ id: `k-${i}`, text: 'Unrelated historical note '.repeat(20), at: i }))
  knowledge.push({ id: 'relevant', text: 'SQLite migration uses one authoritative store', at: 0 })
  const result = roleContext({ projectId: 'p', role: 'developer', definition: { instructions: 'Keep all role permissions' }, requirement: { title: 'SQLite migration', criteria: 'Retain the original rollback evidence' }, memory, knowledge, retrieval: true, budget })
  assert.ok(countContextTokens(result.text, budget) <= budget.inputTokens)
  assert.ok(result.text.includes('Keep all role permissions'))
  assert.ok(result.text.includes('Retain the original rollback evidence'))
  assert.ok(result.text.includes('SQLite migration must retain'))
  assert.ok(result.text.includes('one authoritative store'))
  assert.equal(result.archive.memory.length, 1000)
  assert.equal(result.budget.windowTokens, 14000)
  assert.equal(result.usage.withinBudget, true)
  assert.ok(result.usage.layers.memory <= 900)
  assert.ok(result.usage.layers.knowledge <= 1500)
  assert.equal(result.usage.retrieval.omittedMemory > 0, true)
  assert.throws(() => roleContext({ projectId: 'p', role: 'developer', definition: { instructions: 'MANDATORY'.repeat(2000) }, retrieval: true, budget }), { code: 'bot/context-budget' })
})

test('fixed policy consumes the same budget and bounded archive reads share the reserved tool result space', async () => {
  const { createContextBudget, countContextTokens } = await import('../src/host/project-context-budget.js')
  const budget = createContextBudget({ defaults: { windowTokens: 7000, outputTokens: 500, toolTokens: 1000, protocolTokens: 500, readChars: 3000 } })
  const policy = assembleRolePolicy({ role: 'developer', sources: [], requiredFiles: [] })
  const input = { projectId: 'p', role: 'developer', definition: { instructions: 'Read exact evidence' }, knowledge: [{ id: 'long', text: 'Long public source'.repeat(1000) }], retrieval: true, budget }
  const result = roleContext(input)
  const pages = readContextArchive(result, [{ kind: 'knowledge', id: 'long' }, { kind: 'index', id: 'knowledge' }], { projectId: 'p', role: 'developer' })
  assert.ok(countContextTokens(JSON.stringify(pages), budget) <= budget.reserved.toolTokens)
  assert.ok(pages[0].nextOffset < 3000)
  assert.throws(() => readContextArchive(result, [{ kind: 'knowledge', id: 'long' }], { projectId: 'other', role: 'developer' }), /scope/)
  assert.throws(() => roleContext({ ...input, policy: { ...policy, text: policy.text.repeat(3) } }), { code: 'bot/context-budget' })
})
