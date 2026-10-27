// #1254: an admin's @ in a group is work, not a discussion. When the room's task lead names one
// member with an issue/PR id and an imperative ("@Dev1 #1234 rebase and push"), the host writes
// that member's card and the drive wakes it in its own chat (#1205); no group part opens. A
// question, a remark, a line naming two members or an `@all` keeps the group turn it had — this
// module only answers the shape of one line, the room decides who may dispatch.
import { issueRefPattern } from '../shared/issue-ref.js'

export { cardNamesIssue, issueRefs, namesIssue } from '../shared/issue-ref.js'

const MENTION = /@[^\s@,，。]{1,40}/g
const QUESTION = /[?？]/
// An imperative counts only near the id: "rebase #1234" and "#1234 rebase and push" both dispatch,
// "#1234 looks good to me" stays a remark. The window is characters, not words, so it covers CJK.
const NEAR = 40
const IMPERATIVE = /(?:\b(?:rebase|push|fix|implement|land|merge|open|close|claim|take|add|update|remove|delete|refactor|write|read|investigate|review|run|check|test|debug|split|amend|drive|finish|post|prepare|draft|design|build|move|bump|revert|rename|wire|port|handle|address|verify|reproduce|triage|document|patch|publish|release|deploy|archive|start|continue|make|set|teach|follow)\b|修复|修改|修正|实现|合并|推送|提交|更新|处理|完成|补充|去掉|删掉|删除|检查|验证|复现|整理|重构|拆分|设计|编写|写|改|修|做|跑|查|推|补|删)/i
const oneLine = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)

// "@Dev1" is a call, not part of the instruction: the card says what to do, and the room already
// knows who was named.
const withoutMentions = text => String(text ?? '').replace(MENTION, ' ').replace(/\s+/g, ' ').trim()

// One member, one issue id, one imperative near it. Anything else is not this module's to convert.
export function workDispatch(text, { callees = [] } = {}) {
  if (!Array.isArray(callees) || callees.length !== 1) return undefined
  const callee = callees[0]
  if (!callee?.id) return undefined
  const line = withoutMentions(text)
  if (line === '' || QUESTION.test(line)) return undefined
  for (const match of line.matchAll(issueRefPattern())) {
    const near = line.slice(Math.max(0, match.index - NEAR), match.index + match[0].length + NEAR)
    if (!IMPERATIVE.test(near)) continue
    const issue = `#${match[1] ?? match[2]}`
    const note = oneLine(line)
    return { botId: callee.id, issue, title: note, note }
  }
  return undefined
}
