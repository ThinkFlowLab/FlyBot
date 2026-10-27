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

// The same mentions as ISSUE_REF, with the repository when the text writes one beside the number
// (`owner/repo#12`, or a github.com issues/pull URL). A bare `#12` carries no repository. The
// number is the same one `issueRefs` returns; the repository is not a second decision.
const MENTION = /(?:github\.com\/)?([\w.-]+)\/([\w.-]+)#(\d{1,7})(?![0-9])|github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d{1,7})(?![0-9])|#(\d{1,7})(?![0-9])/gi

const mentionOf = (match) => {
  if (match[3]) return { repo: `${match[1]}/${match[2]}`, number: match[3] }
  if (match[6]) return { repo: `${match[4]}/${match[5]}`, number: match[6] }
  if (match[7]) return { repo: null, number: match[7] }
  return null
}

// Mentions in the text `cardNamesIssue` consults: title and `target.href`, and the note only
// when those name no issue. A note cannot attach a repository to a number the title already named.
export function cardMentions(task) {
  const own = `${task?.title ?? ''} ${task?.target?.href ?? ''}`
  const text = issueRefs(own).length > 0 ? own : `${own} ${task?.note ?? ''}`
  const mentions = []
  const seen = new Set()
  for (const match of text.matchAll(new RegExp(MENTION.source, 'gi'))) {
    const mention = mentionOf(match)
    if (!mention) continue
    const key = `${mention.repo ?? ''}#${mention.number}`
    if (seen.has(key)) continue
    seen.add(key)
    mentions.push(mention)
  }
  return mentions
}

const asNumber = (value) => (value == null || value === '' ? null : String(value))

// The one issue card this task hangs under, or null when `cardNamesIssue` names none or names
// more than one. `issues` are `{ repo, number, linked }` or `{ repo, card: { number, linked } }`.
// A repository written next to the number selects that card; a bare number selects the only
// card with that number (or the only card whose linked pull request has it).
export function issueCardForTask(task, issues) {
  const mentions = cardMentions(task)
  if (mentions.length === 0) return null
  const list = (issues ?? []).filter((issue) => asNumber(issue?.card?.number ?? issue?.number) != null)
  const numberOf = (issue) => asNumber(issue?.card?.number ?? issue?.number)
  const linkedOf = (issue) => asNumber(issue?.card?.linked ?? issue?.linked)
  const repoOf = (issue) => (typeof issue?.repo === 'string' ? issue.repo : '')
  const qualified = list.filter((issue) => mentions.some((mention) =>
    mention.repo != null && mention.repo === repoOf(issue)
    && (mention.number === numberOf(issue) || mention.number === linkedOf(issue))))
  if (qualified.length === 1) return qualified[0]
  if (qualified.length > 1) {
    const byNumber = qualified.filter((issue) => mentions.some((mention) =>
      mention.repo === repoOf(issue) && mention.number === numberOf(issue)))
    return byNumber.length === 1 ? byNumber[0] : null
  }
  const bare = new Set(mentions.filter((mention) => mention.repo == null).map((mention) => mention.number))
  if (bare.size === 0) return null
  const bareHits = list.filter((issue) => bare.has(numberOf(issue)) || (linkedOf(issue) != null && bare.has(linkedOf(issue))))
  if (bareHits.length === 1) return bareHits[0]
  const byNumber = bareHits.filter((issue) => bare.has(numberOf(issue)))
  return byNumber.length === 1 ? byNumber[0] : null
}
