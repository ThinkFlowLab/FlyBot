// Stream C: invite links and join requests (legacy invites.py), shared via Bot Social.
// The invite code is shown once to the creator and travels only inside the link they share.
import { sharedBotSocial, seg, qs } from '../../lib/c/bot-social.js'
import { invitesV1 } from '../../lib/c/legacy-v1.js'

export default function invites(host) {
  const bs = () => sharedBotSocial(host)
  const team = (p) => `/v1/ot/teams/${seg(p?.team_id, 'team_id')}`
  return {
    endpoints: {
      v1: invitesV1(host),
      create: async (p) => bs().post(`${team(p)}/invites`, { role: p?.role, ttl_days: p?.ttl_days, max_uses: p?.max_uses, requires_approval: p?.requires_approval === true }),
      // Wizard step 3 (#281): each row is one invite (role + optional approval), codes returned once.
      async createMany(p) {
        const rows = Array.isArray(p?.rows) ? p.rows.slice(0, 20) : []
        if (!rows.length) throw Object.assign(new Error('rows must be a list of invites'), { code: 'invites/invalid' })
        const invites = []
        for (const row of rows) {
          invites.push(await bs().post(`${team(p)}/invites`, { role: row?.role, ttl_days: row?.ttl_days ?? p?.ttl_days, max_uses: row?.max_uses ?? 1, requires_approval: row?.requires_approval === true }))
        }
        return { invites }
      },
      list: async (p) => bs().get(`${team(p)}/invites`),
      freeze: async (p) => bs().patch(`${team(p)}/invites/${seg(p?.invite_id, 'invite_id')}`, { frozen: p?.frozen !== false }),
      revoke: async (p) => bs().patch(`${team(p)}/invites/${seg(p?.invite_id, 'invite_id')}`, { revoked: true }),
      preview: async (p) => bs().post('/v1/ot/invites/preview', { code: p?.code }),
      accept: async (p) => bs().post('/v1/ot/invites/accept', { code: p?.code }),
      requests: async (p) => bs().get(`${team(p)}/join-requests` + qs({ status: p?.status })),
      decide: async (p) => bs().post(`${team(p)}/join-requests/${seg(p?.request_id, 'request_id')}`, { decision: p?.decision }),
      mine: async () => bs().get('/v1/ot/join-requests/mine'),
    },
  }
}
