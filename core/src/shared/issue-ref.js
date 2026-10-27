// One way to read an issue or pull-request number out of text (#1254, #1331, #1360).
// The dispatch, the task store and the board all call these. A second pattern would
// hang a record the host does not treat as that issue's card.

// A bare `#12` counts only when the number stands alone: a word character, `.`, `-` or `/` in
// front makes it part of an identifier, a version, a hex colour or a URL fragment (`C#7`, `1.2#3`,
// `#3366ff`, `help/#123`), and a word character behind means the number keeps going (`#1360abc`).
// `owner/repo#12` is its own shape, tried separately, so this separation cannot swallow it: there
// the `#` follows a repo name rather than a space.
const ISSUE_REF = /(?<![\w./-])#(\d{1,7})(?![\w])|(?:github\.com\/)?([\w.-]+)\/([\w.-]+)#(\d{1,7})(?![\w])|github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d{1,7})(?![\w])/gi

// The id a match of `ISSUE_REF` names, normalised to `#1234`. The three shapes carry their number in
// different groups (1, 4, 7); every reader takes it from here, so no caller can pick the wrong one.
export const refOf = (match) => `#${match[1] ?? match[4] ?? match[7]}`

// The issue/PR numbers a line names, normalised to `#1234`, in the order they appear.
export function issueRefs(text) {
  const keys = []
  for (const match of String(text ?? '').matchAll(new RegExp(ISSUE_REF.source, 'gi'))) {
    const key = refOf(match)
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
