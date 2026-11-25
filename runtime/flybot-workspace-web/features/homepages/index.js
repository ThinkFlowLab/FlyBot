// Stream C: public agent homepages. The agent's record lives in this user's DS-Bot (features/agents);
// the public projection (name, summary, category, quick starts — never instructions) is published to
// the Bot Social Discover catalog so other users can find it.
import { sharedBotSocial, seg } from '../../lib/c/bot-social.js'

const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/

function publicProjection(agent) {
  return {
    name: String(agent.name ?? '').slice(0, 80),
    summary: String(agent.summary ?? '').slice(0, 500),
    category: agent.category ?? null,
    quick_starts: Array.isArray(agent.quick_starts) ? agent.quick_starts.slice(0, 5).map((t) => String(t).slice(0, 80)) : [],
  }
}

export default function homepages(host) {
  const bs = () => sharedBotSocial(host)
  return {
    endpoints: {
      async publish(p, call) {
        const slug = String(p?.slug ?? '')
        if (!SLUG.test(slug)) throw Object.assign(new Error('slug must be 3-30 lowercase letters, digits or dashes'), { code: 'homepages/invalid' })
        const caller = call?.host ?? host
        const { agent } = await caller.call('agents/get', { id: p?.agent_id, workspace_id: p?.workspace_id })
        const pub = publicProjection(agent)
        return bs().put('/v1/ot/listings', {
          kind: 'agent', ref: agent.id, slug, title: pub.name, summary: pub.summary,
          category: pub.category, snapshot: JSON.stringify(pub),
        })
      },
      unpublish: async (p) => bs().del(`/v1/ot/listings/${seg(p?.listing_id, 'listing_id')}`),
      get: async (p) => {
        const listing = await bs().get(`/v1/ot/discover/${seg(p?.slug, 'slug')}`)
        if (listing.kind !== 'agent') throw Object.assign(new Error('no such public agent homepage'), { code: 'homepages/not-found' })
        let page = null
        try { page = listing.snapshot ? JSON.parse(listing.snapshot) : null } catch { page = null }
        return { slug: listing.slug, creator: listing.creator, listed: listing.listed, updated_at: listing.updated_at, listing_id: listing.id, page, following: listing.following }
      },
      mine: async () => {
        const { listings } = await bs().get('/v1/ot/listings/mine')
        return { homepages: (listings ?? []).filter((l) => l.kind === 'agent') }
      },
    },
  }
}
