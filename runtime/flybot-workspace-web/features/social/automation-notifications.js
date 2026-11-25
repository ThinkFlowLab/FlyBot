import { FeatureError, HEX32 } from '../../featurekit/http.js'
import { Fault } from '../../lib/b4/http.js'

export const automationNoticePrefix = 'automation-run-'
export const automationNoticeKind = 'automation.run_finished'
const terminalStatuses = new Set(['succeeded', 'failed', 'timeout', 'interrupted'])

export const isAutomationNoticeId = id => typeof id === 'string' && id.startsWith(automationNoticePrefix) &&
  HEX32.test(id.slice(automationNoticePrefix.length))

function unavailable() {
  return new Fault(503, 'automation_notifications_unavailable', '暂时无法读取或更新自动化通知。')
}

function noticeItem(row, workspace) {
  const {id, kind, created, read, workspace_id, automation_id, run_id, title, status} = row ?? {}
  if (kind !== automationNoticeKind || workspace_id !== workspace || !isAutomationNoticeId(id) ||
      typeof run_id !== 'string' || id !== automationNoticePrefix + run_id ||
      typeof automation_id !== 'string' || !HEX32.test(automation_id) || typeof title !== 'string' ||
      !Number.isSafeInteger(created) || created < 0 || typeof read !== 'boolean' || !terminalStatuses.has(status)) {
    throw unavailable()
  }
  const query = new URLSearchParams({workspace, automation:automation_id, run:run_id})
  return {id, kind, created, read, workspace_id, automation_id, run_id, title, status, path:'/automations?' + query}
}

async function notificationState(host, endpoint, workspace, payload, allowMissing) {
  let count
  try {
    count = await host.call?.(endpoint, {workspace_id:workspace, ...payload})
  } catch (error) {
    if (error?.code === 'flybot-workspace/not-found' && allowMissing) return null
    if (error instanceof FeatureError && error.status >= 400 && error.status < 500) {
      throw new Fault(error.status, error.code, error.status === 404 ? '找不到此工作区或通知。' : '无法访问此自动化通知。')
    }
    throw unavailable()
  }
  if (allowMissing && !host.call) return null
  if (!Array.isArray(count?.items) || !Number.isSafeInteger(count.unread_count) || count.unread_count < 0) {
    throw unavailable()
  }
  return {items:count.items.map(item => noticeItem(item, workspace)), unread_count:count.unread_count}
}

export function listAutomationNotifications(host, workspace, {limit, unread = false}, allowMissing = true) {
  return notificationState(host, 'automations/notifications', workspace, {limit, unread}, allowMissing)
}

export function readAutomationNotifications(host, workspace, selection) {
  return notificationState(host, 'automations/readNotifications', workspace, selection, false)
}
