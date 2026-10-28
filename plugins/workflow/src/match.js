// Which open board task should start a Workflow or land on a Bot (#1318).
// First hit wins. Anything that does not hit stays unassigned for the manual picker.
//
// 1. A `workflow:<id or name>` token in the title, note, criteria or tags.
// 2. `workflowId` / `workflow` naming a workflow.
// 3. `assignee` naming a workflow (id or exact name).
// 4. A `bot:<id or name>` token.
// 5. `assignee` naming a local Bot (id or exact name). A remote Bot never matches.
// 6. A workflow trigger keyword in the title, note, criteria or tags.
//    The longest trigger wins. A tie keeps the earlier workflow. An ASCII
//    trigger must be a whole word (`notice` does not match `noticeable`, `pr`
//    does not match `Improve`); a non-ASCII trigger matches inside a longer
//    text, because a script such as CJK has no word boundary.
//
// Only an `open` task is considered. Claimed, working and finished cards are left alone.

function text(value) {
  let out = ''
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0)
    out += code <= 0x1f || code === 0x7f ? ' ' : ch
  }
  return out.replace(/\s+/g, ' ').trim()
}

function haystack(task) {
  const tags = Array.isArray(task.tags) ? task.tags.map(text) : []
  return [task.title, task.note, task.criteria, ...tags].map(text).filter(Boolean).join('\n')
}

// #1559: an ASCII trigger is a word, not a fragment. `notice` must not fire
// on `noticeable` and `pr` must not fire on `Improve`. A trigger that is not
// plain ASCII keeps substring matching, since CJK has no word boundary. The
// two-character minimum is a separate guard and stays where it is.
function containsTrigger(lower, word) {
  if (!/^[\x00-\x7f]+$/.test(word)) return lower.includes(word)
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`).test(lower)
}

function findWorkflow(workflows, raw) {
  const wanted = text(raw).toLowerCase()
  if (!wanted) return undefined
  return workflows.find(item => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted)
}

function findBot(bots, raw) {
  const wanted = text(raw).toLowerCase()
  if (!wanted) return undefined
  return bots.find(bot => bot.id.toLowerCase() === wanted || bot.name.toLowerCase() === wanted)
}

function token(hay, kind) {
  const match = new RegExp(`(?:^|[\\s#])${kind}:([^\\s#]+)`, 'i').exec(hay)
  return match ? match[1] : ''
}

export function matchTask(task, { workflows = [], bots = [] } = {}) {
  if (!task || typeof task !== 'object') return null
  if (task.status !== 'open') return null
  const graphs = workflows.filter(item => item && item.id && item.name)
  const locals = bots.filter(bot => bot && bot.remote !== true && bot.id && bot.name)
  const hay = haystack(task)
  const lower = hay.toLowerCase()

  const workflowToken = findWorkflow(graphs, token(lower, 'workflow'))
  if (workflowToken) return { kind: 'workflow', id: workflowToken.id }

  const named = findWorkflow(graphs, task.workflowId || task.workflow || '')
  if (named) return { kind: 'workflow', id: named.id }

  const assignee = text(task.assignee)
  const assignedWorkflow = assignee ? findWorkflow(graphs, assignee) : undefined
  if (assignedWorkflow) return { kind: 'workflow', id: assignedWorkflow.id }

  const botToken = findBot(locals, token(lower, 'bot'))
  if (botToken) return { kind: 'bot', id: botToken.id }

  const assignedBot = assignee ? findBot(locals, assignee) : undefined
  if (assignedBot) return { kind: 'bot', id: assignedBot.id }

  let best = null
  let bestLength = 0
  for (const item of graphs) {
    for (const trigger of item.triggers ?? []) {
      const word = text(trigger).toLowerCase()
      if (word.length < 2 || !containsTrigger(lower, word)) continue
      if (word.length > bestLength) {
        best = item
        bestLength = word.length
      }
    }
  }
  if (best) return { kind: 'workflow', id: best.id }
  return null
}
