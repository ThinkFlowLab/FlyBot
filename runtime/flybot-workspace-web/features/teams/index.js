// Stream C: teams and the team directory (legacy teams.py / team_directory.py), shared via Bot Social.
import { sharedBotSocial, seg, qs } from '../../lib/c/bot-social.js'
import { teamsV1 } from '../../lib/c/legacy-v1.js'

export default function teams(host) {
  const bs = () => sharedBotSocial(host)
  return {
    pages: ['team'],
    endpoints: {
      v1: teamsV1(host),
      activeWorkspaces: async (_payload,call) => {
        if (!call?.internal) throw Object.assign(new Error('Internal endpoint'),{code:'teams/not-found'})
        const data = await bs().get('/v1/ot/workspaces',{signal:AbortSignal.timeout(2000)})
        return (data.workspaces ?? []).map(({workspace_id,name,role}) => ({id:workspace_id,name,role}))
      },
      list: async () => bs().get('/v1/ot/teams'),
      create: async (p) => bs().post('/v1/ot/teams', { name: p?.name, slug: p?.slug, summary: p?.summary }),
      get: async (p) => bs().get(`/v1/ot/teams/${seg(p?.team_id, 'team_id')}`),
      update: async (p) => bs().patch(`/v1/ot/teams/${seg(p?.team_id, 'team_id')}`, { name: p?.name, summary: p?.summary }),
      remove: async (p) => bs().del(`/v1/ot/teams/${seg(p?.team_id, 'team_id')}`),
      setListing: async (p) => bs().put(`/v1/ot/teams/${seg(p?.team_id, 'team_id')}/listing`, { listed: p?.listed, summary: p?.summary }),
      directory: async (p) => bs().get('/v1/ot/directory' + qs({ q: p?.q, limit: p?.limit, cursor: p?.cursor })),
      joinListed: async (p) => bs().post(`/v1/ot/directory/${seg(p?.team_id, 'team_id')}/join`),
    },
  }
}
