// Localized notification template catalog inside the owner's own DS-Bot (#491):
// register/disable versioned subject+body text per kind and locale, list the
// catalog and render one kind through the zh-CN → zh → en chain.
// Data in /data/flybot-workspace/features/notifications/notifications.sqlite3.
//
// This shapes text only: it sends nothing, schedules nothing and translates
// nothing. The built-in catalog covers the kinds Bot Social emits today; an
// unknown kind falls back to the caller's text (or is refused).
import { defineFeature } from '../../featurekit/feature.js'
import { BUILTIN, KINDS, SCHEMA, disableTemplate, listTemplates, registerTemplate, render } from './templates.js'

const nowSec = () => Math.floor(Date.now() / 1000)
const body = (payload) => payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}

export default defineFeature({
  name: 'notifications',
  migrations: [SCHEMA],
  endpoints: ({ store, owner }) => ({
    async catalog() {
      return {
        items: KINDS.map((kind) => ({
          kind,
          locales: Object.keys(BUILTIN[kind]).sort(),
          variables: BUILTIN[kind].en.variables,
        })),
      }
    },
    async templates(payload) {
      const input = body(payload)
      return { items: listTemplates(store, owner, input.kind, input.locale) }
    },
    async register(payload) {
      return { template: registerTemplate(store, owner, body(payload), nowSec()) }
    },
    async disable(payload) {
      const input = body(payload)
      return { disabled: disableTemplate(store, owner, input.kind, input.locale, input.version) }
    },
    async render(payload) {
      return render(store, owner, body(payload), nowSec())
    },
  }),
})
