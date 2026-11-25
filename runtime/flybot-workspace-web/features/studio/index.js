import { sharedBotSocial } from '../../lib/c/bot-social.js'
import { compatHandler } from '../../lib/b4/compat.js'
import { bodyOf, Fault } from '../../lib/b4/http.js'

const collection = /^\/v1\/workspaces\/([0-9a-f]{32})\/studio\/documents$/
const document = /^\/v1\/workspaces\/([0-9a-f]{32})\/studio\/documents\/([0-9a-f]{32})$/
const deletion = /^\/v1\/workspaces\/([0-9a-f]{32})\/studio\/documents\/([0-9a-f]{32})\/remove$/
const history = /^\/v1\/workspaces\/([0-9a-f]{32})\/studio\/documents\/([0-9a-f]{32})\/versions(?:\/([1-9][0-9]{0,15}))?$/
const restore = /^\/v1\/workspaces\/([0-9a-f]{32})\/studio\/documents\/([0-9a-f]{32})\/restore$/
const live = /^\/v1\/workspaces\/([0-9a-f]{32})\/studio\/documents\/([0-9a-f]{32})\/live$/
const revisionQuery = /^revision=[1-9][0-9]{0,15}$/
const presenceFields = ['session_id', 'active', 'editing']

export default function studio(host) {
  // The account's own connector carries its identity. Only explicitly shared
  // documents cross this boundary, with membership checked by Bot Social.
  const route = (method, path, upstreamMethod, fields = [], suffix = '') => ({
    method, path,
    async handle({match: [, workspace, id, version], query, body}, call) {
      const watching = path === live && method === 'GET'
      if ((query || watching) && (!(path === document || watching) || !revisionQuery.test(query) ||
          !Number.isSafeInteger(Number(query.slice('revision='.length))))) {
        throw new Fault(400, 'invalid', 'Invalid studio document query')
      }
      const base = `/v1/ot/teams/${workspace}/studio/documents`
      const target = (id ? base + '/' + id : base) + suffix + (version ? '/' + version : '') + (query ? '?' + query : '')
      const payload = fields.length ? bodyOf(body, fields) : undefined
      if (path === live && method === 'POST' &&
          (typeof payload.session_id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(payload.session_id) ||
           typeof payload.active !== 'boolean' || typeof payload.editing !== 'boolean' ||
           (!payload.active && payload.editing))) {
        throw new Fault(400, 'invalid', 'Invalid studio presence')
      }
      try {
        return [200, await sharedBotSocial(host).request(upstreamMethod, target, payload,
          path === live ? {signal:call?.request?.signal} : undefined)]
      } catch (error) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 503
        if (status === 503) throw new Fault(503, 'unavailable', 'Team studio is temporarily unavailable')
        const code = /^social\/([a-z][a-z0-9_]{0,59})$/.exec(error?.code || '')?.[1] || 'invalid'
        throw new Fault(status, code, error.message)
      }
    },
  })
  return { endpoints: { v1: compatHandler([
    route('GET', collection, 'GET'),
    route('POST', collection, 'POST', ['title', 'body', 'client_key']),
    route('GET', document, 'GET'),
    route('POST', document, 'PUT', ['title', 'body', 'revision']),
    route('POST', deletion, 'DELETE', ['revision']),
    route('GET', history, 'GET', [], '/versions'),
    route('POST', restore, 'POST', ['revision', 'to'], '/restore'),
    route('GET', live, 'GET', [], '/live'),
    route('POST', live, 'POST', presenceFields, '/live'),
  ]) } }
}
