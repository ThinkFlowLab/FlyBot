// Typed GitHub release adapter; credentials stay in the existing selected profile.
import { resolveGithubIdentity } from './project-github.js'
import { invalidateGithubApp, githubIdentityMetadata } from './project-github-app.js'
export function githubReleaseProvider(settings, { request = fetch, identity = resolveGithubIdentity } = {}) {
  async function api(spec, path, body, authorize) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec.repository)) throw new Error('Invalid release repository')
    const selected = await identity(settings, { request, repository: spec.repository, permissions: { contents: body ? 'write' : 'read' } })
    if (authorize) await authorize()
    let response
    try { response = await request(`https://api.github.com/repos/${spec.repository}${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${selected.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }) } catch { throw new Error('Release outcome is unavailable; reconcile before any retry') }
    if ([401, 403].includes(response.status)) invalidateGithubApp(settings, spec.repository, request)
    if (response.status === 404 && !body) return null
    if (!response.ok) throw Object.assign(new Error(`Release provider refused (${response.status})`), { code: body && response.status >= 400 && response.status < 500 ? 'release/rejected' : 'release/unknown' })
    return { value: await response.json(), executorLogin: selected.login, identity: githubIdentityMetadata(selected) }
  }
  return {
    async inspect(spec, authorize) {
      const result = await api(spec, `/releases/tags/${encodeURIComponent(spec.tag)}`, undefined, authorize)
      if (!result) return null
      const row = result.value
      let ref = (await api(spec, `/git/ref/tags/${encodeURIComponent(spec.tag)}`, undefined, authorize))?.value?.object
      for (let depth = 0; ref?.type === 'tag' && depth < 4; depth++) {
        if (!/^[a-f0-9]{40}$/.test(ref.sha ?? '')) throw new Error('Release tag object is invalid')
        ref = (await api(spec, `/git/tags/${ref.sha}`, undefined, authorize))?.value?.object
      }
      if (ref?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(ref.sha ?? '') || !Number.isSafeInteger(row.id) || row.id < 1 || row.tag_name !== spec.tag || row.draft || typeof row.published_at !== 'string') throw new Error('Release is not a verifiable published commit')
      return { provider: 'github', repository: spec.repository, tag: row.tag_name, sha: ref.sha, releaseId: row.id, publishedAt: row.published_at,
        url: `https://github.com/${spec.repository}/releases/tag/${encodeURIComponent(spec.tag)}`, executorLogin: result.executorLogin, identity: result.identity, marker: typeof row.body === 'string' && row.body.includes(spec.marker) }
    },
    async publish(spec, authorize) {
      const existing = (await api(spec, `/git/ref/tags/${encodeURIComponent(spec.tag)}`, undefined, authorize))?.value?.object
      // Existing annotated tags need an exact inspect/adoption; never publish on an
      // unchecked tag because target_commitish is ignored when the tag exists.
      if (existing && (existing.type !== 'commit' || existing.sha !== spec.sha)) throw Object.assign(new Error('Existing release tag is not the authorized commit'), { code: 'release/rejected' })
      return api(spec, '/releases', { tag_name: spec.tag, target_commitish: spec.sha, name: spec.name, body: `${spec.notes}\n\n${spec.marker}`, draft: false, prerelease: false }, authorize)
    },
  }
}
