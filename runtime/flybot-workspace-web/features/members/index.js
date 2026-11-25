// Stream C: team members, roles and suspension (legacy members.py), shared via Bot Social.
import { sharedBotSocial, seg } from '../../lib/c/bot-social.js'
import { membersV1 } from '../../lib/c/legacy-v1.js'

export default function members(host) {
  const bs = () => sharedBotSocial(host)
  const base = (p) => `/v1/ot/teams/${seg(p?.team_id, 'team_id')}/members`
  return {
    pages: ['members'],
    endpoints: {
      v1: membersV1(host),
      // Wizard step 3 (#281): static FlyBot role copy, not a Teamily claim.
      roles: async () => ({ roles: [
        { role: 'owner', title: 'Owner', summary: 'Can delete the team, assign admin/member roles, and transfer ownership before leaving. Cannot be removed or suspended.' },
        { role: 'admin', title: 'Admin', summary: 'Manages members (except the owner), invites and join requests; cannot change roles.' },
        { role: 'member', title: 'Member', summary: 'Works in the team and can leave; cannot manage invites or other members.' },
      ] }),
      list: async (p) => bs().get(base(p)),
      setRole: async (p) => bs().patch(`${base(p)}/${seg(p?.handle, 'handle')}`, { role: p?.role }),
      suspend: async (p) => bs().patch(`${base(p)}/${seg(p?.handle, 'handle')}`, { suspended: p?.suspended !== false }),
      remove: async (p) => bs().del(`${base(p)}/${seg(p?.handle, 'handle')}`),
      leave: async (p) => {
        const me = await bs().get('/v1/ot/me')
        return bs().del(`${base(p)}/${seg(me.handle, 'handle')}`)
      },
    },
  }
}
