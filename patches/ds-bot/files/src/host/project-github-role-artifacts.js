import { roleGithubSelection } from './project-role-github.js'
// SDK output is a hint. Only independently observed Git/GitHub metadata is evidence.
import { githubIdentityMetadata } from './project-github-app.js'
import { projectGithubSettings } from './project-github-connections.js'
import { resolveGithubIdentity } from './project-github.js'
const refuse = message => Object.assign(new Error(message), { code: 'bot/github-artifact' })
export function createGithubRoleArtifacts(rt, { request = fetch, roleGithub = rt.projectRoleGithub, identity = resolveGithubIdentity } = {}) {
  async function reader(attempt, role) {
    const session = attempt.roleSessions[role]
    if (!session) throw refuse('App artifact has no original role Session')
    const selected = await roleGithub.resolve(session)
    const worker = rt.state.projectHarnessWorkers?.[session.botId] ?? rt.state.projectNativeWorkers?.[session.botId]
    if (!selected || selected.metadata.sha256 !== worker?.githubAccess?.sha256) throw refuse('App artifact identity or original execution binding changed')
    const get = async path => {
      const current = await roleGithub.resolve(session)
      if (current?.metadata.sha256 !== selected.metadata.sha256) throw refuse('Role App identity changed during observation')
      const response = await request(`https://api.github.com/repos/${selected.metadata.repository}${path}`, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${current.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } })
      if (!response.ok) throw refuse('Role artifact read failed; retain existing PR and reconcile')
      const text = await response.text()
      if (text.length > 2 * 1024 * 1024) throw refuse('Role artifact response exceeds read budget')
      const project = { ...rt.readProject(attempt.projectId), repository: selected.metadata.repository, defaultBranch: selected.metadata.baseBranch }
      const selection = roleGithubSelection(rt, project, role, session.policyRole ?? session.role)
      if (selection?.metadata.binding !== selected.metadata.binding || selection.metadata.revision !== selected.metadata.revision) throw refuse('Role App configuration changed during observation')
      return JSON.parse(text)
    }
    return { session, selected, get }
  }
  async function publication(attempt, { sha, role, git }) {
    const { selected, get } = await reader(attempt, role), scope = selected.metadata
    if (await git(['status', '--porcelain'])) throw refuse('SDK candidate must be committed and clean before adoption')
    await git(['merge-base', '--is-ancestor', attempt.seedSha ?? attempt.baseSha, sha])
    const rows = (await git(['log', '--first-parent', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce', `${attempt.seedSha ?? attempt.baseSha}..${sha}`])).split('\n').filter(Boolean)
    if (!rows.length || rows.length > 1000 || rows.some(line => { const [commit, author, email, committer, committerEmail] = line.split('\0'); return !/^[a-f0-9]{40}$/.test(commit) || author !== scope.author.name || email !== scope.author.email || committer !== author || committerEmail !== email })) throw refuse('SDK candidate author/committer is not the verified Dev App Bot')
    const pulls = await get(`/pulls?state=all&head=${encodeURIComponent(scope.repository.split('/')[0] + ':' + scope.branch)}&per_page=100`)
    if (!Array.isArray(pulls) || pulls.length !== 1) throw refuse('Delivery branch has missing or ambiguous PRs; reconcile without creating another')
    const pr = await get(`/pulls/${pulls[0].number}`)
    if (!Number.isSafeInteger(pr.number) || pr.state !== 'open' || pr.head?.repo?.full_name !== scope.repository || pr.head.ref !== scope.branch || pr.head.sha !== sha || pr.base?.repo?.full_name !== scope.repository || pr.base.ref !== scope.baseBranch || pr.user?.login?.toLowerCase() !== scope.identity.login.toLowerCase() || !pr.body?.includes(scope.publicationMarker) || pr.html_url !== `https://github.com/${scope.repository}/pull/${pr.number}` || attempt.publicationBinding && pr.number !== attempt.publicationBinding.number || attempt.pr && pr.number !== attempt.pr.number) throw refuse('SDK PR does not match current repository/head/base/creator/publication binding')
    const project = { ...rt.readProject(attempt.projectId), repository: scope.repository, defaultBranch: scope.baseBranch }
    const mergeSettings = projectGithubSettings(rt, project)
    if (mergeSettings?.credential !== 'github-app') throw refuse('App delivery requires an explicit App host merge connection; no personal fallback')
    const merger = await identity(mergeSettings, { repository: scope.repository, permissions: { contents: 'read', pull_requests: 'read' }, request })
    return { number: pr.number, url: pr.html_url, sha, candidateSha: sha, repository: scope.repository, branch: scope.branch, publicationMarker: scope.publicationMarker, creatorLogin: scope.identity.login, executorLogin: scope.identity.login, identity: scope.identity, mergeIdentity: githubIdentityMetadata(merger), initiatedBy: attempt.initiatedBy, taskId: attempt.taskId, attemptId: attempt.id, operation: 'sdk-observed-publication', executionRole: 'developer', credentialScope: 'role-app', roleScopeSha256: scope.sha256, observedAt: Date.now() }
  }
  async function review(attempt, role, verdict) {
    const { selected, get } = await reader(attempt, role), scope = selected.metadata
    if (!attempt.pr || attempt.pr.sha !== attempt.candidateSha || scope.number !== attempt.pr.number || scope.candidateSha !== attempt.candidateSha) throw refuse('Review needs the original current App PR and exact candidate')
    const pr = await get(`/pulls/${attempt.pr.number}`)
    if (pr.head?.sha !== attempt.candidateSha || pr.head?.repo?.full_name !== scope.repository || pr.base?.ref !== scope.baseBranch) throw refuse('PR changed before Review observation')
    let observed
    for (let page = 1; page <= 10; ++page) {
      const rows = await get(`/pulls/${attempt.pr.number}/reviews?per_page=100&page=${page}`)
      if (!Array.isArray(rows)) throw refuse('Review response is invalid')
      for (const row of rows) if (Number.isSafeInteger(row.id) && row.id > 0 && row.user?.login?.toLowerCase() === scope.identity.login.toLowerCase() && row.commit_id === attempt.candidateSha && row.body?.includes(scope.reviewMarker) && row.submitted_at && row.state !== 'PENDING' && (!observed || row.id > observed.id)) observed = row
      if (rows.length < 100) break
      if (page === 10) throw refuse('Review pagination incomplete')
    }
    const independent = scope.identity.appId !== attempt.pr.identity.appId
    if (!observed || observed.state !== (verdict === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED') || verdict === 'approve' && !independent) throw refuse('Exact-SHA Review by the configured independent App is missing; no forge approval is inferred')
    return { id: observed.id, sha: observed.commit_id, state: observed.state, submittedAt: observed.submitted_at, identity: scope.identity, independent, scopeSha256: scope.sha256, observedAt: Date.now() }
  }
  async function check(attempt, role, number) {
    if (number === undefined) return null
    if (!Number.isSafeInteger(number) || number < 1) throw refuse('Check hint needs an integer check-run ID')
    const { selected, get } = await reader(attempt, role), row = await get(`/check-runs/${number}`)
    if (row.id !== number || row.head_sha !== attempt.candidateSha || row.app?.id !== selected.metadata.identity.appId || row.external_id !== selected.metadata.sha256) throw refuse('Check does not match the current Tester App/candidate')
    return { id: row.id, sha: row.head_sha, status: row.status, conclusion: row.conclusion ?? null, identity: selected.metadata.identity, observedAt: Date.now(), scope: 'remote-check-observation-not-host-test-pass' }
  }
  return { publication, review, check }
}
