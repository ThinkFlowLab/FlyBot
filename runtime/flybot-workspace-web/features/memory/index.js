// Memory feature (stream B3): memory pages, revisions/restore, export, 做梦,
// actions, links, graph, profile and preferences run inside this user's DS-Bot;
// data in /data/flybot-workspace/features/memory.
// memory/pages serves chat recall (#378) in-process via host.call;
// memory/personal gives the owner's preferences and profile for DS-Bot turns.
import { defineFeature } from '../../featurekit/feature.js'
import { IMPORT_TABLES, MIGRATIONS } from './schema.js'
import { allPages, recallAcrossWorkspaces, routes as pageRoutes, search } from './pages.js'
import { personal, routes as extraRoutes } from './extras.js'
import { actor, recallWorkspace } from './common.js'
import { captureRoutes, captureWorker } from './capture.js'
import { actionDraftRoutes } from './action-drafts.js'
import { requireMemoryWorkspace } from './access.js'
import { saveMeetingNote } from './meeting-notes.js'
import { saveSharedMeetingAction, sharedMeetingActions } from './shared-meeting-actions.js'
import { chatActionRoutes } from './chat-action.js'
import { ownedMeetingActionRoutes } from './owned-meeting-actions.js'

const routes = [...extraRoutes, ...pageRoutes, ...captureRoutes].map(route => ({
  pattern: route.pattern,
  async handle(req, workspace, ...args) {
    await requireMemoryWorkspace(req.host, workspace)
    return route.handle(req, workspace, ...args)
  },
}))

export default defineFeature({
  name: 'memory',
  pages: ['memory'],
  migrations: MIGRATIONS,
  importTables: IMPORT_TABLES,
  routes: [...actionDraftRoutes, ...chatActionRoutes, ...ownedMeetingActionRoutes, ...routes],
  endpoints: ({ store, owner, host }) => ({
    ...captureWorker({store,host}),
    saveMeetingNote: (payload, call) => saveMeetingNote({store, owner, host}, payload, call),
    saveSharedMeetingAction: (payload, call) => saveSharedMeetingAction({store, owner, host}, payload, call),
    sharedMeetingActions: (payload, call) => sharedMeetingActions({store, host}, payload, call),
    async pages(payload) {
      await requireMemoryWorkspace(host, recallWorkspace(payload))
      return allPages(store, payload)
    },
    async recallAcrossWorkspaces(payload,call) {
      if (!call?.internal) throw Object.assign(new Error('Internal endpoint'),{code:'memory/not-found'})
      return recallAcrossWorkspaces(store,host,payload)
    },
    async personal(payload) {
      await requireMemoryWorkspace(host, recallWorkspace(payload))
      return personal(store, actor({ store, owner }), payload)
    },
    async search(payload) {
      const needle = String(payload?.q ?? '').trim()
      const limit = Math.min(Math.max(Number(payload?.limit) || 20, 1), 50)
      if (!needle || needle.length > 80) return {items: []}
      return {items: await search(store, host, needle, limit)}
    },
  }),
})
