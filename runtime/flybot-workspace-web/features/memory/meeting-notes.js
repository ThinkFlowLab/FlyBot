import { HEX32, newId, refuse } from '../../featurekit/http.js'
import { requireMemoryWorkspace } from './access.js'
import { BODY_MAX, TITLE_MAX, loadPage, titleHash } from './common.js'
import { insertPage, writePage } from './pages.js'

function clip(text, length) {
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '').trimEnd()
}

function pageTitle(store, workspace, title, pageId) {
  for (let copy = 1; ; copy += 1) {
    const suffix = copy === 1 ? '' : ' · ' + copy
    const candidate = '会议纪要 · ' + clip(title, TITLE_MAX - '会议纪要 · '.length - suffix.length) + suffix
    const match = store.get('SELECT id FROM memory_pages WHERE workspace_id=? AND title_hash=?', workspace, titleHash(candidate))
    if (!match || match.id === pageId) return candidate
  }
}

function notesBody(summary, actions) {
  const summaryHeading = '## 摘要\n\n'
  const actionsHeading = '\n\n## 行动项\n\n'
  const notice = '\n\n内容较长，完整纪要请从来源链接查看。'
  const summaryText = summary || '（未填写）'
  const actionText = actions.join('\n') || '（没有行动项）'
  const full = summaryHeading + summaryText + actionsHeading + actionText
  if (full.length <= BODY_MAX) return {body:full, truncated:false}

  const budget = BODY_MAX - summaryHeading.length - actionsHeading.length - notice.length
  const summaryLimit = actions.length ? Math.min(summaryText.length, 5000) : budget - actionText.length
  const excerpt = clip(summaryText, summaryLimit)
  const actionBudget = budget - excerpt.length
  const lineLimit = Math.floor((actionBudget - actions.length + 1) / (actions.length || 1))
  const excerpts = actions.map(line => line.length > lineLimit ? clip(line, lineLimit - 1) + '…' : line)
  return {body:summaryHeading + excerpt + actionsHeading + (excerpts.join('\n') || actionText) + notice, truncated:true}
}

export async function saveMeetingNote(context, input, call) {
  if (!call?.internal) refuse(404, 'not_found', 'Internal endpoint')
  const {workspace_id: workspace, meeting_id: meeting, revision, title, summary, actions} = input
  if (!HEX32.test(workspace) || !HEX32.test(meeting) || !Number.isSafeInteger(revision) || revision < 1) {
    refuse(400, 'invalid', '请选择已保存的纪要版本。')
  }
  await requireMemoryWorkspace(context.host, workspace)
  const {store} = context
  const req = {...context, now:Math.floor(Date.now() / 1000)}
  const {body, truncated} = notesBody(summary, actions)
  return store.transaction(() => {
    const source = store.get('SELECT * FROM memory_meeting_sources WHERE workspace_id=? AND meeting_id=?', workspace, meeting)
    const page = source && loadPage(store, workspace, source.page_id)
    const receipt = (id, state) => ({
      status:state === 'created' ? 201 : 200,
      body:{memory:{id, workspace_id:workspace}, state, truncated},
    })
    if (source && source.meeting_revision > revision) refuse(409, 'conflict', '记忆里已有更新的纪要。')
    if (page && source.meeting_revision === revision) return receipt(page.id, 'saved')
    if (page && page.revision !== source.page_revision) return receipt(page.id, 'edited')
    const name = pageTitle(store, workspace, title, page?.id)
    if (page) {
      const updated = writePage(req, page, {title:name, body})
      store.run('UPDATE memory_meeting_sources SET meeting_revision=?,page_revision=? WHERE workspace_id=? AND meeting_id=?',
        revision, updated.revision, workspace, meeting)
      return receipt(page.id, 'updated')
    }
    const created = insertPage(req, workspace, {title:name, body, topics:['会议纪要']}, newId()).body.page
    store.run('INSERT INTO memory_meeting_sources VALUES(?,?,?,?,?)', workspace, meeting, created.id, revision, created.revision)
    return receipt(created.id, 'created')
  })
}
