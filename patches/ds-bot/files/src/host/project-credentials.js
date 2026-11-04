// Personal GitHub writes are selected by authenticated human AND Project, never by a
// caller-supplied credential reference or by falling back to Project automation.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { EffectDeferred, EffectCancelled } from './project-effects.js'
import { ownEntry, setEntry } from './store.js'
import { resolveGithubIdentity } from './project-github.js'
import { createGithubConnections, projectGithubStatus } from './project-github-connections.js'
const refused = message => Object.assign(new Error(message), { code: 'bot/forbidden' })

export function createProjectCredentials(rt, { identity = resolveGithubIdentity, request = fetch } = {}) {
  const personal = (actor, projectId) => ownEntry(ownEntry(rt.config.personalGithub ?? {}, actor.memberId) ?? {}, projectId)
  const hash = text => createHash('sha256').update(text).digest('hex')
  const effectActor = actor => ({ memberId: actor.memberId, ...(actor.watchGrantId ? { watchGrantId: actor.watchGrantId, watchGeneration: actor.watchGeneration, agentId: actor.agentId } : {}) })
  async function validateEffect(effect, context) {
    const actor = context.actor?.memberId === effect.payload.actor.memberId ? context.actor : effect.payload.actor
    const member = ownEntry(rt.state.members ?? {}, actor.memberId)
    if (!member || member.status === 'disabled') throw new EffectCancelled('Comment initiator is unavailable')
    if (effect.payload.actor.watchGrantId) {
      try { rt.projectDelegations.validateGrant(effect.payload.actor) }
      catch { throw new EffectCancelled('Comment watch grant was revoked') }
    }
    try {
      if (effect.payload.actor.watchGrantId) await rt.projectDelegations.validateActor(effect.payload.actor)
      else if (context.inline && context.actor) {
        if (rt.platformIdentityEnabled && !await rt.validateHumanActor(context.actor)) throw new EffectCancelled('Human session was revoked')
      } else await rt.projectDelegations.background(actor.memberId)
    } catch (error) { if (error instanceof EffectCancelled) throw error; throw new EffectDeferred('Current comment principal proof is unavailable', { waitingFor: 'authority' }) }
    let project
    try { project = rt.requireProjectAccess(actor, effect.projectId, 'create') }
    catch { throw new EffectCancelled('Comment Project authority was revoked') }
    const settings = personal(actor, effect.projectId)
    if (settings?.credential === 'github-app') throw new EffectCancelled('Personal operations require independent user credentials')
    if (project.repository !== effect.payload.repository || settings?.login?.toLowerCase() !== effect.payload.login.toLowerCase()) throw new EffectCancelled('Comment repository or personal identity changed')
    context.assertCurrent()
    return { actor, project, settings }
  }
  rt.projectEffects?.register('github.comment', {
    validate: validateEffect,
    async run(effect, context) {
      let { actor, project, settings } = await validateEffect(effect, context)
      const text = await readFile(effect.payload.bodyRef, 'utf8')
      if (hash(text) !== effect.payload.bodySha256) throw new EffectCancelled('Immutable comment body changed')
      const selected = await identity(settings)
      if (selected.login.toLowerCase() !== effect.payload.login.toLowerCase()) throw new EffectCancelled('Personal GitHub identity mismatch')
      const marker = '<!-- flybot-outbox:' + effect.id + ' -->', content = text + '\n\n' + marker
      const headers = { authorization: `Bearer ${selected.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' }
      const url = `https://api.github.com/repos/${project.repository}/issues/${effect.payload.issueNumber}/comments`
      let comment
      for (let page = 1; page <= 10; page++) {
        const response = await request(url + `?per_page=100&page=${page}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000), headers })
        if (!response.ok) throw Error('GitHub comment reconciliation failed')
        const rows = await response.json()
        if (!Array.isArray(rows)) throw Error('GitHub comment reconciliation returned invalid data')
        comment = rows.find(row => row.user?.login?.toLowerCase() === selected.login.toLowerCase() && row.body?.includes(marker))
        if (comment) { if (comment.body !== content) throw new EffectCancelled('Existing outbox comment content changed'); break }
        if (!response.headers.get('link')?.includes('rel="next"')) break
        if (page === 10) throw new EffectDeferred('Comment history is not fully reconciled; no write attempted', { waitingFor: 'external' })
      }
      ;({ actor, project, settings } = await validateEffect(effect, context))
      if (!comment) {
        const response = await request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers, body: JSON.stringify({ body: content }) })
        if (!response.ok) throw Error('GitHub comment failed')
        comment = await response.json()
      }
      const audit = { id: `github-write-${hash(effect.id).slice(0, 32)}`, projectId: effect.projectId, initiatedBy: actor.memberId, executorLogin: comment.user?.login ?? selected.login, selectedLogin: selected.login,
        scope: 'personal', agentId: effect.payload.actor.agentId ?? null, grantId: effect.payload.actor.watchGrantId ?? null, operation: 'issue-comment', identityVerified: comment.user?.login?.toLowerCase() === selected.login.toLowerCase(), url: comment.html_url, at: Date.now(), bodySha256: effect.payload.bodySha256, effectId: effect.id }
      rt.state.projectGithubWrites ??= {}; setEntry(rt.state.projectGithubWrites, audit.id, audit)
      if (!audit.identityVerified) throw new EffectCancelled('GitHub response identity mismatch; reconcile the existing write')
      return { audit }
    },
  }, { replace: true })
  return {
    async endpoint(endpoint, body, actor) {
      const projectId = String(body.projectId ?? '')
      const project = rt.requireProjectAccess(actor, projectId, endpoint === 'project-credential-status' ? 'read' : 'create')
      const settings = personal(actor, projectId)
      if (endpoint === 'project-credential-status') return {
        personal: { configured: Boolean(settings?.credential && settings.configDir && settings.login), login: settings?.login ?? null },
        automation: projectGithubStatus(rt, project),
      }
      if (settings?.credential === 'github-app') throw refused('Personal operations require independent user credentials')
      if (body.scope !== undefined && body.scope !== 'personal') throw refused('This endpoint only uses your own personal GitHub identity')
      if (!settings?.login) throw refused('Personal GitHub credential is not configured for this human and Project')
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.repository ?? '')) throw refused('Project repository is unavailable')
      if (!Number.isSafeInteger(body.issueNumber) || body.issueNumber < 1 || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10_000) throw refused('A GitHub comment needs an issue number and bounded text')
      if (rt.projectEffects) {
        if (rt.platformIdentityEnabled && !(await (rt.validateHumanActor ? rt.validateHumanActor(actor) : rt.validatePlatformActor(actor)))) throw refused('Human platform session was revoked')
        const requestId = body.requestId ?? randomUUID()
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw refused('Comment needs a stable requestId')
        const directory = join(rt.home, 'project-outbox'), text = body.text.trim()
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const file = join(directory, hash(JSON.stringify([projectId, actor.memberId, requestId])) + '.txt')
        const temporary = file + '.' + randomUUID() + '.tmp'
        await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
        try {
          try { await link(temporary, file) }
          catch (error) { if (error.code !== 'EEXIST') throw error; if (await readFile(file, 'utf8') !== text) throw refused('Comment requestId was reused with different content') }
        } finally { await unlink(temporary) }
        rt.requireProjectAccess(actor, projectId, 'create')
        return rt.projectEffects.perform({ kind: 'github.comment', key: actor.memberId + ':' + requestId, projectId,
          payload: { actor: effectActor(actor), repository: project.repository, login: settings.login, issueNumber: body.issueNumber, bodyRef: file, bodySha256: hash(text) } }, { actor })
      }
      const selected = await identity(settings)
      if (selected.login.toLowerCase() !== settings.login.toLowerCase()) throw refused('Personal GitHub identity mismatch')
      if (rt.platformIdentityEnabled && !(await (rt.validateHumanActor ? rt.validateHumanActor(actor) : rt.validatePlatformActor(actor)))) throw refused('Human platform session was revoked')
      rt.requireProjectAccess(actor, projectId, 'create')
      const response = await request(`https://api.github.com/repos/${project.repository}/issues/${body.issueNumber}/comments`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: {
          authorization: `Bearer ${selected.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28',
        }, body: JSON.stringify({ body: body.text.trim() }),
      })
      if (!response.ok) throw new Error(`GitHub comment failed (${response.status})`)
      const comment = await response.json()
      const audit = { id: `github-write-${randomUUID()}`, projectId, initiatedBy: actor.memberId, executorLogin: comment.user?.login ?? selected.login, selectedLogin: selected.login,
        scope: 'personal', agentId: actor.agentId ?? null, grantId: actor.watchGrantId ?? null, operation: 'issue-comment', identityVerified: comment.user?.login?.toLowerCase() === selected.login.toLowerCase(), url: comment.html_url, at: Date.now(),
        bodySha256: createHash('sha256').update(body.text.trim()).digest('hex') }
      rt.state.projectGithubWrites ??= {}
      setEntry(rt.state.projectGithubWrites, audit.id, audit)
      await rt.save()
      if (!audit.identityVerified) throw refused('GitHub response identity mismatch; the write requires reconciliation')
      return { audit }
    },
  }
}
export function install(rt) { rt.projectCredentials = createProjectCredentials(rt); rt.projectGithubConnections = createGithubConnections(rt) }
