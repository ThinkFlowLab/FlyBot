// Bounded, repository-scoped GitHub reads. Never hand credentials or arbitrary URLs to models.
import { createHash } from 'node:crypto'
import { ownEntry } from './store.js'
import { resolveGithubIdentity } from './project-github.js'
import { projectGithubSettings } from './project-github-connections.js'
import { invalidateGithubApp, githubCredentialBinding, githubIdentityMetadata } from './project-github-app.js'
const refuse = message => Object.assign(new Error(message), { code: 'bot/forbidden' })
const bounded = value => typeof value === 'string' ? value.slice(0, 1200) : null
export function createProjectGithubRead(rt, { identity = resolveGithubIdentity, request = fetch } = {}) {
  const backgroundActors = new WeakMap()
  async function validActor(actor, project) {
    const binding = backgroundActors.get(actor)
    if (!binding) return rt.validateHumanActor ? rt.validateHumanActor(actor) : rt.validatePlatformActor(actor)
    if (binding.projectId !== project.id || binding.memberId !== actor.memberId || !rt.projectDelegations?.background) throw refuse('Background Project principal proof is unavailable')
    rt.requireProjectAccess(actor, project.id, 'configure')
    await rt.projectDelegations.background(actor.memberId, actor.sessionId)
    rt.requireProjectAccess(actor, project.id, 'configure')
    return true
  }
  async function read(body, actor) {
    const project = { ...rt.requireProjectAccess(actor, String(body.projectId ?? '')) }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.repository ?? '')) throw refuse('Project repository is unavailable')
    if (body.page !== undefined && (!Number.isSafeInteger(body.page) || body.page < 1 || body.page > 1000000)) throw refuse('Invalid GitHub evidence page')
    if (body.scope !== undefined && !['personal', 'project'].includes(body.scope)) throw refuse('Unknown GitHub read scope')
    if ((rt.platformIdentityEnabled || backgroundActors.has(actor)) && !await validActor(actor, project)) throw refuse('Human platform session was revoked')
    const operation = body.operation ?? 'issues'
    const number = body.number
    if (!['issues', 'pulls', 'pull', 'reviews', 'checks', 'thread-events'].includes(operation) || ['pull', 'reviews', 'checks', 'thread-events'].includes(operation) && (!Number.isSafeInteger(number) || number < 1)) throw refuse('Unsupported bounded GitHub read')
    if (operation === 'thread-events' && (!['issue', 'pull'].includes(body.threadKind) || body.pages !== undefined && (typeof body.pages !== 'object' || body.pages === null || Array.isArray(body.pages) || Object.entries(body.pages).some(([key, page]) => !['comments', 'reviews', 'inline', 'checks'].includes(key) || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000)))) throw refuse('Invalid GitHub thread cursor')
    // Explicit automation identity is appropriate for shared Project reads. Personal reads
    // require an explicit personal selection; there is no ambient-token fallback.
    const scope = body.scope === 'personal' ? 'personal' : 'project'
    const settings = scope === 'personal' ? ownEntry(ownEntry(rt.config.personalGithub ?? {}, actor.memberId) ?? {}, project.id) : projectGithubSettings(rt, project)
    if (scope === 'personal' && settings?.credential === 'github-app') throw refuse('Personal reads require independent user credentials')
    if (!settings?.login && settings?.credential !== 'github-app') throw refuse('Selected scoped GitHub read identity is not configured')
    const permissions = operation === 'issues' || operation === 'thread-events' && body.threadKind === 'issue' ? { issues: 'read' } : operation === 'checks' || operation === 'thread-events' ? operation === 'checks' ? { pull_requests: 'read', checks: 'read' } : { pull_requests: 'read', issues: 'read', checks: 'read' } : { pull_requests: 'read' }
    const binding = githubCredentialBinding(settings, project.repository)
    const selected = await identity(settings, { request, repository: project.repository, permissions })
    if (settings.login && selected.login.toLowerCase() !== settings.login.toLowerCase()) throw refuse('Scoped GitHub read identity mismatch')
    const validate = async () => {
      if ((rt.platformIdentityEnabled || backgroundActors.has(actor)) && !await validActor(actor, project)) throw refuse('Human platform session was revoked')
      if (rt.requireProjectAccess(actor, project.id).repository !== project.repository) throw refuse('Project repository changed during the read')
      if (scope === 'project' && githubCredentialBinding(projectGithubSettings(rt, rt.requireProjectAccess(actor, project.id)), project.repository) !== binding) throw refuse('GitHub connection changed during read')
    }
    await validate()
    const get = async suffix => {
      await validate()
      const current = settings.credential === 'github-app' ? await identity(settings, { request, repository: project.repository, permissions }) : selected
      await validate()
      const response = await request(`https://api.github.com/repos/${project.repository}${suffix}`, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${current.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } })
      if ([401, 403].includes(response.status)) invalidateGithubApp(settings, project.repository, request)
      if (!response.ok) throw new Error(`Scoped GitHub read failed (${response.status})`)
      const text = await response.text()
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Scoped GitHub response exceeds its byte budget')
      await validate()
      return JSON.parse(text)
    }
    let data, pagination = 'bounded-first-page', pageInfo
    const page = body.page ?? 1
    const pageResult = (rows, source) => {
      if (!Array.isArray(rows) || rows.length > 20) throw refuse('GitHub evidence page is invalid')
      pagination = 'bounded-page'; pageInfo ??= {}; pageInfo[source] = { page, hasMore: rows.length === 20, nextPage: rows.length === 20 ? page + 1 : null, complete: page === 1 && rows.length < 20, authority: 'one page is not a complete CI or Review verdict' }
      return rows
    }
    const summary = row => ({ number: row.number, title: bounded(row.title), state: row.state, url: row.html_url, updatedAt: row.updated_at, isPullRequest: Boolean(row.pull_request) })
    if (operation === 'thread-events') {
      const pull = body.threadKind === 'pull', root = await get(`/${pull ? 'pulls' : 'issues'}/${number}`)
      if (root.number !== number || !pull && root.pull_request || pull && (root.base?.repo?.full_name !== project.repository || !/^[a-f0-9]{40}$/.test(root.head?.sha ?? ''))) throw refuse('GitHub thread repository or kind mismatch')
      const canonical = `https://github.com/${project.repository}/${pull ? 'pull' : 'issues'}/${number}`
      if (root.html_url !== canonical) throw refuse('GitHub thread URL mismatch')
      const events = [{ id: `thread:${number}`, type: 'thread', modifiedAt: root.updated_at ?? root.created_at, url: canonical, state: root.state, merged: Boolean(root.merged), sha: pull ? root.head.sha : null, text: JSON.stringify({ title: root.title, state: root.state, merged: Boolean(root.merged), head: root.head?.sha ?? null }) }], pages = {}
      const page = async (kind, path, projectRow) => {
        const n = kind === 'checks' && body.headSha !== root.head.sha ? 1 : body.pages?.[kind] ?? 1, response = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=20&page=${n}`)
        const rows = kind === 'checks' ? response.check_runs : response
        if (!Array.isArray(rows) || rows.length > 20) throw refuse('GitHub event page is invalid')
        pages[kind] = rows.length === 20 ? n + 1 : 1
        for (const row of rows) {
          if (kind === 'reviews' && (row.state === 'PENDING' || !row.submitted_at)) continue
          if (!Number.isSafeInteger(row.id) || row.id < 1) throw refuse('GitHub event identity is invalid')
          events.push({ id: `${kind}:${row.id}`, type: kind, ...projectRow(row) })
        }
      }
      const comment = row => ({ modifiedAt: row.updated_at ?? row.created_at, author: row.user?.login ?? null, url: row.html_url, sha: row.commit_id ?? null, text: String(row.body ?? ''), ...(row.path ? { path: row.path, line: row.line ?? null, replyTo: row.in_reply_to_id ?? null } : {}) })
      await page('comments', `/issues/${number}/comments`, comment)
      if (pull) {
        await page('reviews', `/pulls/${number}/reviews`, row => ({ ...comment(row), modifiedAt: row.submitted_at ?? null, state: row.state }))
        await page('inline', `/pulls/${number}/comments`, comment)
        await page('checks', `/commits/${root.head.sha}/check-runs`, row => ({ modifiedAt: row.completed_at ?? row.started_at, sha: row.head_sha, state: row.status, conclusion: row.conclusion, url: row.html_url, text: JSON.stringify({ name: row.name, current: row.head_sha === root.head.sha, status: row.status, conclusion: row.conclusion, output: row.output }) }))
        if ((await get(`/pulls/${number}`)).head?.sha !== root.head.sha) throw refuse('GitHub PR head moved during source polling')
      }
      data = { threadKind: body.threadKind, number, events, pages, headSha: pull ? root.head.sha : null, observation: 'bounded-rotating-pages; intermediate unseen edits are not recoverable' }
    } else if (operation === 'issues' || operation === 'pulls') data = (await get(`/${operation}?state=open&per_page=20&sort=updated&direction=desc`)).slice(0, 20).map(summary)
    else if (operation === 'reviews') data = pageResult(await get(`/pulls/${number}/reviews?per_page=20&page=${page}`), 'reviews').filter(row => row.state !== 'PENDING' && row.submitted_at).map(row => ({ id: row.id, state: row.state, commit: row.commit_id, author: row.user?.login, url: row.html_url, body: bounded(row.body), submittedAt: row.submitted_at }))
    else {
      const pr = await get(`/pulls/${number}`)
      if (!/^[a-f0-9]{40}$/.test(pr.head?.sha ?? '')) throw refuse('GitHub did not return a full candidate SHA')
      data = { ...summary(pr), sha: pr.head.sha, base: pr.base?.ref, draft: pr.draft, merged: pr.merged, hold: (pr.labels ?? []).some(label => label.name === 'hold') }
      if (operation === 'checks') {
        const checks = await get(`/commits/${pr.head.sha}/check-runs?per_page=20&page=${page}`)
        data.checks = pageResult(checks.check_runs ?? [], 'checks').map(row => ({ id: row.id, sha: row.head_sha, name: row.name, current: row.head_sha === pr.head.sha, status: row.status, conclusion: row.conclusion, url: row.html_url, appId: row.app?.id ?? null }))
        data.statuses = []; data.statusesFetched = false
        if (body.includeStatuses === true) {
          data.statuses = pageResult(await get(`/commits/${pr.head.sha}/statuses?per_page=20&page=${page}`), 'statuses').map(row => ({ id: row.id, sha: row.sha, context: row.context, state: row.state, url: row.target_url, createdAt: row.created_at, creator: row.creator?.login ?? null }))
          data.statusesFetched = true
        }
        data.evidenceComplete = false // Agent must reconcile pages, check sources and current policy; absence is never success.
        if ((await get(`/pulls/${number}`)).head?.sha !== pr.head.sha) throw refuse('GitHub PR head moved during evidence query')
      }
    }
    return { repository: project.repository, operation, scope, executorLogin: selected.login, identity: githubIdentityMetadata(selected), at: Date.now(), limit: 20, pagination, ...(pageInfo ? { page: pageInfo, sourceSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') } : {}), data }
  }
  read.background = async (body, actor) => {
    if (body.scope === 'personal') throw refuse('Background Source reads require Project automation credentials')
    const project = rt.requireProjectAccess(actor, String(body.projectId ?? ''), 'configure'), scoped = { ...actor }
    backgroundActors.set(scoped, { projectId: project.id, memberId: actor.memberId })
    try { return await read({ ...body, scope: 'project' }, scoped) } finally { backgroundActors.delete(scoped) }
  }
  return read
}
export function install(rt) { rt.projectGithubRead = createProjectGithubRead(rt) }
