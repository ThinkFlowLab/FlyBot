import { HEX32, refuse } from '../../featurekit/http.js'
import { ownsPrivateChatPart, privateChatThread } from '../../lib/native-chat.js'
import { requireMemoryWorkspace } from '../memory/access.js'

const TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/
const states = new Set(['scheduled', 'overdue', 'paused', 'finished'])

function ownedBot(rt, workspace, task) {
  if (typeof task?.id !== 'string' || !TASK_ID.test(task.id) || !states.has(task.state) ||
      task.roomId !== undefined || typeof task.botId !== 'string' || typeof task.sessionId !== 'string' ||
      rt.taskOwners?.has(task.sessionId) || rt.groupOwners?.has(task.sessionId) ||
      !ownsPrivateChatPart(rt, task.botId, task.sessionId)) return null
  const bot = rt.botOf(task.botId)
  if (!bot || bot.hidden || bot.flybotWorkspace?.workspace_id !== workspace) return null
  return bot
}

function view(rt, task, bot) {
  const display = (value, fallback) => typeof value === 'string' && value.trim()
    ? (rt.redactSecrets?.(value) ?? value).slice(0, 120).toWellFormed() : fallback
  const parsedTime = typeof task.scheduledAt === 'string' ? Date.parse(task.scheduledAt) : NaN
  const identity = bot.flybotWorkspace
  const thread = privateChatThread(bot, task.sessionId)
  const prefix = `agent:${identity.agent_id}:`
  const chats = thread ? Object.entries(identity.sessionKeys ?? {}).filter(([key, sid]) =>
    key.startsWith(prefix) && HEX32.test(key.slice(prefix.length)) &&
    privateChatThread(bot, sid)?.sessionId === thread.sessionId) : []
  return {
    id:task.id, title:display(task.title, '定时任务'), bot_name:display(bot.name, 'Bot'),
    state:task.state, kind:typeof task.kind === 'string' ? task.kind.slice(0, 32) : '',
    next_run:Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : null,
    ...(typeof task.timeZone === 'string' ? {time_zone:task.timeZone.slice(0, 80)} : {}),
    ...(typeof task.time === 'string' ? {time:task.time.slice(0, 16)} : {}),
    ...(HEX32.test(identity.agent_id || '') ? {agent_id:identity.agent_id} : {}),
    ...(chats.length === 1 ? {conversation_id:chats[0][0].slice(prefix.length)} : {}),
  }
}

export async function botSchedules(host, {workspace_id:workspace, id, active}) {
  await requireMemoryWorkspace(host, workspace)
  const rt = host.currentRuntime?.()?.rt
  if (typeof rt?.scheduleEndpoint !== 'function') {
    if (id !== undefined) refuse(503, 'unavailable', 'Bot 的定时任务暂时不可用。')
    return {available:false, can_pause:false, items:[]}
  }
  await rt.load()
  let result = await rt.scheduleEndpoint('schedules')
  if (id !== undefined) {
    if (typeof id !== 'string' || !TASK_ID.test(id) || typeof active !== 'boolean') refuse(400, 'invalid', '请选择有效的定时任务。')
    if (result.canPause !== true || rt.readOnly?.() !== undefined) refuse(409, 'unavailable', '暂时无法修改定时任务。')
    const task = result.tasks.find(item => item.id === id && ownedBot(rt, workspace, item))
    if (!task) refuse(404, 'not_found', '找不到这条定时任务。')
    try {
      result = await rt.scheduleEndpoint('schedule-pause', {id, sessionId:task.sessionId, active})
    } catch (error) {
      if (error?.code === 'bot/invalid') refuse(409, 'conflict', '任务状态已变化，请刷新后重试。')
      refuse(503, 'unavailable', '暂时无法修改定时任务，请重试。')
    }
  }
  const items = []
  for (const task of result.tasks) {
    const bot = ownedBot(rt, workspace, task)
    if (bot) items.push(view(rt, task, bot))
  }
  return {available:result.available === true, can_pause:result.canPause === true && rt.readOnly?.() === undefined, items}
}
