// One way to read an issue or pull-request number out of text (#1254, #1331, #1360).
// The dispatch, the task store and the board all call these. A second pattern would
// hang a record the host does not treat as that issue's card.

const ISSUE_REF = /#(\d{1,7})(?![0-9])|github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d{1,7})(?![0-9])/gi

// The issue/PR numbers a line names, normalised to `#1234`, in the order they appear.
export function issueRefs(text) {
  const keys = []
  for (const match of String(text ?? '').matchAll(new RegExp(ISSUE_REF.source, 'gi'))) {
    const key = `#${match[1] ?? match[2]}`
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

export function namesIssue(text, issue) {
  const number = String(issue ?? '').replace(/^#/, '')
  if (!/^\d+$/.test(number)) return false
  return issueRefs(text).includes(`#${number}`)
}

// A card belongs to the issue its own fields name. `title` and `target` name it; a note
// that merely mentions the id does not, unless the card names no issue anywhere else.
export function cardNamesIssue(task, wanted) {
  const own = `${task?.title ?? ''} ${task?.target?.href ?? ''}`
  if (namesIssue(own, wanted)) return true
  return issueRefs(own).length === 0 && namesIssue(task?.note ?? '', wanted)
}

export const issueRefPattern = () => new RegExp(ISSUE_REF.source, 'gi')
