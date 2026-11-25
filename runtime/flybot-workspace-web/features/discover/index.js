// Stream C: Discover (legacy discover.py): this DS-Bot publishes the owner's chosen agents and works
// to the shared catalog on Bot Social, and browses, likes, collects and follows creators there.
// What is published is only the projection the owner passes here (title, summary, category, kind,
// optional public snapshot) — never instructions, memory or credentials.
import { sharedBotSocial, seg, qs } from '../../lib/c/bot-social.js'
import { discoverV1 } from '../../lib/c/legacy-v1.js'

export default function discover(host) {
  const bs = () => sharedBotSocial(host)
  return {
    pages: ['discover'],
    endpoints: {
      v1: discoverV1(host),
      publish: async (p) => bs().put('/v1/ot/listings', {
        kind: p?.kind, ref: p?.ref, slug: p?.slug, title: p?.title, summary: p?.summary,
        category: p?.category, work_kind: p?.work_kind, snapshot: p?.snapshot,
      }),
      unpublish: async (p) => bs().del(`/v1/ot/listings/${seg(p?.listing_id, 'listing_id')}`),
      mine: async () => bs().get('/v1/ot/listings/mine'),
      feed: async (p) => bs().get('/v1/ot/discover' + qs({ kind: p?.kind, tab: p?.tab, q: p?.q, category: p?.category, work_kind: p?.work_kind, creator: p?.creator, before: p?.before, limit: p?.limit })),
      get: async (p) => bs().get(`/v1/ot/discover/${seg(p?.slug, 'slug')}`),
      like: async (p) => bs().post(`/v1/ot/listings/${seg(p?.listing_id, 'listing_id')}/like`, { on: p?.on !== false }),
      collect: async (p) => bs().post(`/v1/ot/listings/${seg(p?.listing_id, 'listing_id')}/collect`, { on: p?.on !== false }),
      follow: async (p) => bs().post('/v1/ot/follows', { handle: p?.handle, on: p?.on !== false }),
      follows: async (p) => bs().get('/v1/ot/follows' + qs({ handle: p?.handle })),
      profile: async (p) => bs().get(`/v1/ot/profiles/${seg(p?.handle, 'handle')}`),
    },
  }
}
