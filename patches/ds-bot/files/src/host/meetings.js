// Meetings (#1731, Stage 4.1): an unresolved architecture conflict needs a record, not a chat.
// A meeting is a record with a lifecycle — `open → deliberating → decided | blocked` — bound to
// one question (and, when it has one, the issue that triggered it), carrying every invited
// participant's position. A `decided` meeting passes a governance check written as code here and
// writes one archived decision in the Stage 1 shape (`decisions/<date>-<slug>.md`); a `blocked`
// meeting writes no file and produces no task. Decisions stay on the existing store
// (`state.meetings`), so there is no second store.
import { createHash, randomBytes } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from './tool-schema.js'
import { output } from './tools.js'
import { workDirFor } from './project-state.js'
import { ASSISTANT_ROLE } from './project-assistant.js'

// The Project Assistant takes a position like anyone else, but it does not write the decision
// file and does not close the meeting (the Chief or the owner does).
const CLASSES = ['ordinary', 'major', 'severe']
const STANCES = ['agree', 'dissent', 'abstain']
const QUESTION_MAX = 600
const TEXT_MAX = 600
const NAME_MAX = 80
const PARTICIPANTS_MAX = 32
const OPEN_STATES = new Set(['open', 'deliberating'])

const oneLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
// A slug keeps letters and digits of every script, so two different Chinese questions do not both
// fall back to `meeting` and collide on one day's file.
const slugOf = value => oneLine(value, 80).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80)
const dateOf = now => new Date(now).toISOString().slice(0, 10)

const refuse = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code: `meeting/${code}` })

// Two meetings on one question are one too many. Compared on the question with casing and
// whitespace flattened, so "Is X good?" and "is x   good?" are the same question.
const keyOf = question => oneLine(question, QUESTION_MAX).toLowerCase()

export const decisionsPath = (now, slug) => `decisions/${dateOf(now)}-${slug}.md`

function readParticipants(value) {
  if (!Array.isArray(value) || value.length === 0) throw refuse('invalid', 'a meeting needs at least one invited participant')
  if (value.length > PARTICIPANTS_MAX) throw refuse('invalid', `a meeting invites at most ${PARTICIPANTS_MAX} participants`)
  const names = []
  for (const item of value) {
    const name = oneLine(typeof item === 'string' ? item : item?.name, NAME_MAX)
    if (name === '') throw refuse('invalid', 'a participant needs a name')
    if (!names.includes(name)) names.push(name)
  }
  return names.map(name => ({ name, position: undefined, silent: false }))
}

function readOptions(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw refuse('invalid', 'options must be a list of one-line options')
  const options = value.map(item => oneLine(item, TEXT_MAX)).filter(Boolean)
  if (options.length > 12) throw refuse('invalid', 'a meeting carries at most 12 options')
  return options
}

// The governance check, as code (#1731 §2). It answers why the meeting may not close `decided`,
// or undefined when it may: every invited participant recorded a position (or is recorded as not
// answering), the decision names its owner, and a dissent carries its own owner. `blocked` is not
// checked here — a blocked meeting is a legitimate outcome with its own one-sentence question.
export function governanceRefusal(meeting) {
  if (!OPEN_STATES.has(meeting.status)) return `the meeting is ${meeting.status}, not open or deliberating`
  const missing = (meeting.participants ?? []).filter(p => p.position === undefined && p.silent !== true).map(p => p.name)
  if (missing.length > 0) return `no position recorded for: ${missing.join(', ')}`
  if (oneLine(meeting.owner, NAME_MAX) === '') return 'the decision names no owner'
  if (meeting.dissent !== undefined && oneLine(meeting.dissent.owner, NAME_MAX) === '') {
    return 'the dissent is written down without its owner'
  }
  if (oneLine(meeting.decision, TEXT_MAX) === '') return 'the decision states nothing'
  return undefined
}

const decisionBody = (meeting, file, at) => {
  const lines = [
    `# ${oneLine(meeting.title ?? meeting.question, 200)}`,
    '',
    '## Date',
    '',
    `${dateOf(at)} (UTC).`,
    '',
    '## Decision',
    '',
    oneLine(meeting.decision, TEXT_MAX),
    '',
    '## Class',
    '',
    `${meeting.class} — recorded by ${oneLine(meeting.owner, NAME_MAX)} through meeting \`${meeting.id}\`.`,
    '',
    '## Evidence',
    '',
  ]
  for (const entry of meeting.evidence ?? []) {
    const parts = []
    if (entry.sha) parts.push(`sha:${entry.sha}`)
    if (entry.pr !== undefined) parts.push(`pr:#${entry.pr}`)
    if (entry.check) parts.push(`check:${entry.check}`)
    if (parts.length > 0) lines.push(`- ${parts.join(' ')}`)
  }
  lines.push(`- Meeting \`${meeting.id}\` on: ${oneLine(meeting.question, QUESTION_MAX)}`, '')
  if ((meeting.options ?? []).length > 0) {
    lines.push('## Options', '')
    for (const option of meeting.options) lines.push(`- ${option}`)
    lines.push('')
  }
  lines.push('## Participants', '')
  for (const participant of meeting.participants) {
    const position = participant.position
    const said = position === undefined
      ? 'invited; recorded no position (silent)'
      : `${position.stance}${position.text ? ` — ${position.text}` : ''}`
    lines.push(`- **${participant.name}** — ${said}`)
  }
  lines.push('', '## Dissent', '')
  lines.push(meeting.dissent === undefined
    ? 'none recorded'
    : `${oneLine(meeting.dissent.text, TEXT_MAX)} — **${oneLine(meeting.dissent.owner, NAME_MAX)}**`)
  lines.push('', '## Status', '', 'accepted', '')
  lines.push('## Links', '', `- Decision file: ${file}`)
  if (meeting.issue !== undefined) lines.push(`- Issue: #${meeting.issue}`)
  if (meeting.project !== undefined) lines.push(`- Project: ${meeting.project}`)
  if ((meeting.taskIds ?? []).length > 0) lines.push(`- Tasks: ${meeting.taskIds.join(', ')}`)
  lines.push('', `Written-by: ${oneLine(meeting.closedBy ?? meeting.owner, NAME_MAX)}`, '')
  return lines.join('\n')
}

export function install(rt) {
  rt.state.meetings ??= {}
  const store = () => {
    rt.state.meetings ??= {}
    return rt.state.meetings
  }
  // The meeting this id names, or a refusal naming the id: a tool caller never gets `undefined`.
  const find = id => {
    const meeting = store()[String(id ?? '')]
    if (meeting === undefined) throw refuse('not-found', `no meeting ${String(id ?? '')}`)
    return meeting
  }
  const stamp = () => Date.now()

  const newMeeting = ({ question, participants, options, issue, project, title }, now) => {
    const text = oneLine(question, QUESTION_MAX)
    if (text === '') throw refuse('invalid', 'a meeting needs the question it answers')
    const same = Object.values(store()).find(other => OPEN_STATES.has(other.status) && keyOf(other.question) === keyOf(text))
    if (same !== undefined) throw refuse('duplicate', `a meeting on that question is already ${same.status}: ${same.id}`)
    const id = `meeting-${randomBytes(5).toString('hex')}`
    const meeting = {
      id,
      status: 'open',
      question: text,
      ...(oneLine(title, 200) ? { title: oneLine(title, 200) } : {}),
      slug: '',
      participants: readParticipants(participants),
      options: readOptions(options),
      ...(issue === undefined || issue === null ? {} : { issue }),
      ...(project === undefined || project === null ? {} : { project: oneLine(project, NAME_MAX) }),
      evidence: [],
      taskIds: [],
      createdAt: now,
      updatedAt: now,
    }
    meeting.slug = slugOf(meeting.question) || 'meeting'
    store()[id] = meeting
    return meeting
  }

  const position = (meeting, { as, stance, text, silent }, now) => {
    if (!OPEN_STATES.has(meeting.status)) throw refuse('closed', `the meeting is ${meeting.status}`)
    const name = oneLine(as, NAME_MAX)
    const participant = meeting.participants.find(p => p.name === name)
    if (participant === undefined) throw refuse('not-invited', `${name === '' ? 'the caller' : name} was not invited to this meeting`)
    if (silent === true) {
      // An invited participant who did not answer is recorded as silent, so `decided` can say so
      // instead of waiting for a position that will not come.
      participant.silent = true
      if (meeting.status === 'open') meeting.status = 'deliberating'
      meeting.updatedAt = now
      return meeting
    }
    participant.silent = false
    const chosen = String(stance ?? 'agree')
    if (!STANCES.includes(chosen)) throw refuse('invalid', 'stance must be agree, dissent or abstain')
    participant.position = { stance: chosen, text: oneLine(text, TEXT_MAX), at: now }
    if (chosen === 'dissent' && oneLine(text, TEXT_MAX) !== '') {
      meeting.dissent = { text: oneLine(text, TEXT_MAX), owner: name }
    }
    if (meeting.status === 'open') meeting.status = 'deliberating'
    meeting.updatedAt = now
    return meeting
  }

  // P-196: the second decision of one day takes the next free name — `…-2.md`, `…-3.md` — instead
  // of rewriting an earlier conclusion. The probe only reads the folder, so a decide that wrote
  // nothing leaves the name free for its retry.
  const nextFreeFile = async (root, now, slug) => {
    const base = decisionsPath(now, slug)
    for (let n = 1; n <= 999; n += 1) {
      const file = n === 1 ? base : base.replace(/\.md$/, `-${n}.md`)
      try {
        await readFile(join(root, file))
      } catch (error) {
        if (error?.code === 'ENOENT') return file
        throw error
      }
    }
    throw refuse('exists', `no free decision file name left for ${base}`)
  }

  // P-191: every produced task is read and gated here, before a card exists — its title, the Bot it
  // names, and the answer `task-create` itself would give this actor (`rt.taskCanCreate` is that
  // gate, read-only). The body built here is the body the create sends, so the two cannot disagree.
  // A host without that gate refuses the task; it never falls back to creating it ungated.
  const planTasks = (tasks, { actor, file, now }) => {
    if (tasks === undefined || tasks === null) return []
    if (!Array.isArray(tasks)) throw refuse('invalid', 'tasks must be a list of { botId or assignee, title }')
    return tasks.map((item) => {
      const title = oneLine(item?.title, 300)
      if (title === '') throw refuse('invalid', 'a produced task needs a title')
      const wanted = oneLine(item?.botId ?? item?.assignee, NAME_MAX)
      const bot = rt.state.bots?.[wanted]
      const named = bot ?? Object.values(rt.state.bots ?? {}).find(candidate => candidate?.name === wanted)
      if (named === undefined) throw refuse('no-bot', `no Bot named ${wanted === '' ? '(nobody)' : wanted} to own the produced task`)
      const body = {
        botId: named.id,
        title,
        taskClass: 'work',
        ...(typeof item?.criteria === 'string' && item.criteria.trim() !== '' ? { criteria: item.criteria } : {}),
        evidence: [{ check: file, at: now }],
      }
      // Fail closed: a host that carries no tasks library refuses the produced task, rather than
      // creating it with no authorization check at all.
      if (typeof rt.taskCanCreate !== 'function') throw refuse('forbidden', 'You cannot assign a task to that Bot')
      rt.taskCanCreate(body, actor)
      return body
    })
  }

  const decide = async (meeting, args, { now, actor }) => {
    if (!OPEN_STATES.has(meeting.status)) throw refuse('closed', `the meeting is ${meeting.status}`)
    if (actor?.role === ASSISTANT_ROLE) throw refuse('forbidden', 'a Project Assistant takes a position; it does not close the meeting')
    // The candidate is a copy: a refused decision leaves the stored meeting exactly as it was.
    const candidate = {
      ...meeting,
      owner: oneLine(args.owner, NAME_MAX),
      decision: oneLine(args.decision ?? args.text, TEXT_MAX),
      class: String(args.class ?? 'ordinary'),
      evidence: readEvidence(args.evidence),
    }
    if (!CLASSES.includes(candidate.class)) throw refuse('invalid', `class must be one of ${CLASSES.join(', ')}`)
    if (args.dissent !== undefined) {
      const text = oneLine(args.dissent?.text, TEXT_MAX)
      const ownerName = oneLine(args.dissent?.owner, NAME_MAX)
      if (text === '') throw refuse('invalid', 'a dissent needs the objection it records')
      candidate.dissent = { text, owner: ownerName }
    }
    const reason = governanceRefusal(candidate)
    if (reason !== undefined) throw refuse('governance', reason)

    const dir = args.dir ?? workDirFor(rt, args.exec)
    if (typeof dir !== 'string' || dir === '') throw refuse('no-folder', 'the Session has no working folder to archive the decision in')
    const decisions = join(dir, 'decisions')
    // P-191/P-196: the name and every produced task are settled before anything is written, so a
    // refusal leaves no card, no file and no temp behind, and a retry picks the same name again.
    const file = await nextFreeFile(dir, now, candidate.slug)
    const planned = planTasks(args.tasks, { actor, file, now })

    await mkdir(decisions, { recursive: true })
    const closed = {
      ...candidate,
      status: 'decided',
      decidedAt: now,
      updatedAt: now,
      closedBy: actor?.name ?? candidate.owner,
      decisionFile: file,
    }
    // The cards come first: the decision file appears only once every produced task exists.
    closed.taskIds = await produceTasks(planned, { actor })

    // One render, and the bytes hashed are the bytes archived. `link` claims the name without
    // rewriting an existing file; a name lost to a concurrent writer takes the next one, and the
    // cards follow it so their evidence pointer and the file cannot disagree.
    let bytes
    let name = file
    for (let attempt = 0; ; attempt += 1) {
      if (attempt === 8) throw refuse('exists', `no free decision file name left for ${file}`)
      closed.decisionFile = name
      bytes = Buffer.from(decisionBody(closed, name, now), 'utf8')
      const temp = `${join(dir, name)}.tmp-${randomBytes(4).toString('hex')}`
      await writeFile(temp, bytes)
      try {
        await link(temp, join(dir, name))
      } catch (error) {
        await rm(temp, { force: true })
        if (error?.code !== 'EEXIST') throw error
        name = await nextFreeFile(dir, now, candidate.slug)
        await repointTasks(closed.taskIds, name, { now, actor })
        continue
      }
      await rm(temp, { force: true })
      break
    }
    closed.decisionSha256 = createHash('sha256').update(bytes).digest('hex')
    store()[meeting.id] = closed
    return closed
  }

  // A card's evidence names the decision file, so a name taken at publish time moves the cards with
  // it — through the same task write path that created them.
  const repointTasks = async (ids, file, { now, actor }) => {
    for (const id of ids) await rt.taskEndpoint('task-update', { id, evidence: [{ check: file, at: now }] }, actor)
  }

  // Follow-up work goes through the one task write path (`tasks.js`), each card carrying the
  // decision file as its evidence pointer. A meeting does not keep tasks of its own.
  const produceTasks = async (bodies, { actor }) => {
    const ids = []
    for (const body of bodies) ids.push((await rt.taskEndpoint('task-create', body, actor)).id)
    return ids
  }

  const block = (meeting, { blocking }, now) => {
    if (!OPEN_STATES.has(meeting.status)) throw refuse('closed', `the meeting is ${meeting.status}`)
    const question = oneLine(blocking, QUESTION_MAX)
    if (question === '') throw refuse('invalid', 'a blocked meeting states the blocking question in one sentence')
    meeting.status = 'blocked'
    meeting.blockingQuestion = question
    meeting.blockedAt = now
    meeting.updatedAt = now
    return meeting
  }

  // P-192: `blocked` records a question, not a dead end — the answer reopens the meeting with its
  // positions, options and evidence intact. `decided` stays terminal.
  const resume = (meeting, { answer }, now) => {
    if (meeting.status === 'decided') throw refuse('closed', 'the meeting is decided')
    if (meeting.status !== 'blocked') throw refuse('invalid', `the meeting is ${meeting.status}, not blocked`)
    const text = oneLine(answer, QUESTION_MAX)
    if (text === '') throw refuse('invalid', 'resuming a blocked meeting states the answer to its blocking question')
    meeting.status = 'deliberating'
    meeting.blockingAnswer = text
    delete meeting.blockedAt
    meeting.updatedAt = now
    return meeting
  }

  const summary = meeting => {
    const positions = meeting.participants.filter(p => p.position !== undefined).length
    const head = `${meeting.id} [${meeting.status}] ${meeting.question}`
    const lines = [head, `positions ${positions}/${meeting.participants.length}${meeting.owner ? ` | owner ${meeting.owner}` : ''}`]
    if (meeting.dissent !== undefined) lines.push(`dissent: ${meeting.dissent.text} — ${meeting.dissent.owner}`)
    if (meeting.blockingQuestion !== undefined) lines.push(`blocking: ${meeting.blockingQuestion}`)
    if (meeting.blockingAnswer !== undefined) lines.push(`answer: ${meeting.blockingAnswer}`)
    if (meeting.decisionFile !== undefined) lines.push(`decision file: ${meeting.decisionFile}`, `tasks: ${meeting.taskIds.join(', ') || 'none'}`)
    for (const participant of meeting.participants) {
      lines.push(`- ${participant.name}: ${participant.position === undefined ? 'silent' : `${participant.position.stance}${participant.position.text ? ` — ${participant.position.text}` : ''}`}`)
    }
    return lines.join('\n')
  }

  rt.meetingEndpoint = async function meetingEndpoint(action, body = {}, actor) {
    await rt.load()
    const now = Number.isFinite(Number(body.now)) && body.now !== undefined ? Number(body.now) : stamp()
    switch (action) {
      case 'open':
        return summary(newMeeting(body, now))
      case 'position':
        return summary(position(find(body.meeting), { as: body.as ?? actor?.name, stance: body.stance, text: body.text, silent: body.silent }, now))
      case 'decide':
        return summary(await decide(find(body.meeting), { ...body, exec: body.exec }, { now, actor }))
      case 'block':
        return summary(block(find(body.meeting), body, now))
      case 'resume':
        return summary(resume(find(body.meeting), body, now))
      case 'read':
        return summary(find(body.meeting))
      case 'list':
        return Object.values(store()).map(summary).join('\n\n') || 'no meetings'
      default:
        throw refuse('invalid', `unknown meeting action ${String(action)}`)
    }
  }

  rt.ctx.tools.register(defineTool({
    name: 'meeting',
    description: 'Open and run a meeting so an unresolved conflict has a record instead of a chat. A meeting moves open → deliberating → decided | blocked, bound to one question and the issue that triggered it. Record every invited participant\'s position, then close it: `decided` needs a position from every participant (or one recorded as silent), a named owner and a dissent with its own owner, writes one decisions/<date>-<slug>.md (the next free `-2` name when the day already has one) and creates follow-up tasks; `blocked` states one blocking sentence and writes nothing, and `resume` reopens it with the answer. At most one open meeting per question.',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'position', 'decide', 'block', 'resume', 'read', 'list'], description: 'What to do with the meeting' },
      meeting: { type: 'string', description: 'The meeting id, from open' },
      question: { type: 'string', description: 'The question the meeting answers (open)' },
      title: { type: 'string', description: 'Optional short title for the decision record (open)' },
      issue: { type: 'integer', description: 'The issue number that triggered the meeting (open)' },
      project: { type: 'string', description: 'The Project the meeting belongs to (open)' },
      participants: { type: 'array', items: { type: 'string' }, description: 'Every invited participant name (open)' },
      options: { type: 'array', items: { type: 'string' }, description: 'Options the meeting weighed (open)' },
      as: { type: 'string', description: 'The participant the position belongs to (position); defaults to the calling Bot\'s name' },
      silent: { type: 'boolean', description: 'Record that the participant did not answer (position); counts as a recorded position for `decided`' },
      stance: { type: 'string', enum: ['agree', 'dissent', 'abstain'], description: 'The position taken (position)' },
      text: { type: 'string', description: 'What the participant said (position)' },
      owner: { type: 'string', description: 'Who owns the decision (decide)' },
      decision: { type: 'string', description: 'What was decided, one paragraph (decide)' },
      class: { type: 'string', enum: ['ordinary', 'major', 'severe'], description: 'The decision class (decide), ordinary by default' },
      dissent: {
        type: 'object',
        description: 'The dissent that still stands, with its owner (decide). Omit when none stands.',
        properties: {
          text: { type: 'string' },
          owner: { type: 'string' },
        },
        additionalProperties: false,
      },
      evidence: {
        type: 'array',
        description: 'What the decision rests on: shas, pull requests and facts (decide)',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sha: { type: 'string' },
            pr: { type: 'integer' },
            check: { type: 'string' },
          },
        },
      },
      tasks: {
        type: 'array',
        description: 'Follow-up tasks a decided meeting produces, each created with the decision file as evidence',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            botId: { type: 'string' },
            assignee: { type: 'string' },
            title: { type: 'string' },
            criteria: { type: 'string' },
          },
        },
      },
      blocking: { type: 'string', description: 'The blocking question in one sentence (block)' },
      answer: { type: 'string', description: 'The answer to the blocking question (resume); the meeting moves back to deliberating' },
      dir: { type: 'string', description: 'Optional folder to archive the decision in; defaults to the Session working folder' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf?.(exec?.agent?.id) ?? exec?.agent?.id
      const bot = rt.botOf?.(self)
      const actor = { name: bot?.name ?? self, role: bot?.role }
      const action = String(args?.action ?? '')
      return rt.meetingEndpoint(action, { ...args, exec }, actor)
    },
  }))
}

function readEvidence(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw refuse('invalid', 'evidence must be a list of { sha, pr, check }')
  if (value.length > 8) throw refuse('invalid', 'evidence carries at most 8 entries')
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw refuse('invalid', 'each evidence entry is an object of { sha, pr, check }')
    const sha = oneLine(entry.sha, 64)
    const check = oneLine(entry.check, 200)
    let pr
    if (entry.pr !== undefined && entry.pr !== null && entry.pr !== '') {
      pr = typeof entry.pr === 'number' ? entry.pr : Number(entry.pr)
      if (!Number.isInteger(pr) || pr < 1) throw refuse('invalid', 'evidence.pr must be a pull request number')
    }
    if (sha === '' && pr === undefined && check === '') throw refuse('invalid', 'an evidence entry needs a sha, a pr or a check')
    return { ...(sha ? { sha } : {}), ...(pr === undefined ? {} : { pr }), ...(check ? { check } : {}) }
  })
}
