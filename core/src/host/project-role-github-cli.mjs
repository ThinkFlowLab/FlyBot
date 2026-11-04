// Runs in the resource, not the host. Only the current role's short-lived grant is requested.
import { requestRoleCredential } from './project-role-github-channel.mjs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
const exec = promisify(execFile)
const failure = (code = 'role-scope') => Object.assign(Error('Role GitHub command refused; inspect current role scope and permissions'), { code })
export const credential = requestRoleCredential
export function apiFields(args) {
  const fields = {}
  for (let i = 0; i < args.length; ++i) {
    if (args[i] === '--input' || args[i].startsWith('--input=')) throw failure()
    let value
    if (['-f', '-F', '--field', '--raw-field'].includes(args[i])) value = args[++i]
    else if (/^-[fF].+/.test(args[i])) value = args[i].slice(2)
    else if (/^--(?:field|raw-field)=/.test(args[i])) value = args[i].slice(args[i].indexOf('=') + 1)
    if (value !== undefined) {
      if (!value.includes('=') || value.includes('=@')) throw failure()
      const key = value.slice(0, value.indexOf('='))
      if (Object.hasOwn(fields, key)) throw failure()
      fields[key] = value.slice(value.indexOf('=') + 1)
    }
  }
  return fields
}
export function validateRoleCommand(scope, tool, args) {
  if (!Array.isArray(args) || args.length > 100 || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw failure()
  if (tool === 'credential-helper' && args.length === 0) return 'credential'
  if (tool === 'git') {
    if (args[0]?.startsWith('-') && !['--version', '--help'].includes(args[0]) || args.some(arg => ['--global', '--system'].includes(arg))) throw failure()
    if (args[0] === 'credential') throw failure()
    if (args[0] === 'push') {
      if (scope.policyRole !== 'developer' || args.length !== 3 || args[1] !== `https://github.com/${scope.repository}.git` || args[2] !== `HEAD:refs/heads/${scope.branch}`) throw failure()
    } else if (args.some(arg => /TOKEN|PASSWORD|extraheader|credential\.|hooksPath|user\.(?:name|email)|https?:\/\/[^/]*@/i.test(arg))) throw failure()
    return 'git'
  }
  if (tool !== 'gh' || args.some(arg => /^(?:--hostname(?:=|$)|--admin(?:=|$)|--repo=|-R.)/.test(arg))) throw failure()
  if (['pr', 'run'].includes(args[0]) && /^https?:/.test(args[2] ?? '') && !args[2].startsWith(`https://github.com/${scope.repository}/`)) throw failure()
  for (const flag of ['--repo', '-R']) { if (args.some((arg, index) => arg === flag && args[index + 1] !== scope.repository)) throw failure() }
  if (args[0] === 'run' && ['view', 'list'].includes(args[1])) return 'gh'
  if (args[0] === 'pr' && ['view', 'diff', 'checks', 'list'].includes(args[1])) return 'gh'
  if (args[0] === 'pr' && scope.policyRole === 'developer' && ['create', 'edit'].includes(args[1])) {
    if (args[1] === 'create' && scope.number) throw failure()
    for (const [flag, expected] of [['--base', scope.baseBranch], ['--head', scope.branch]]) { if (args.some((arg, index) => arg === flag && args[index + 1] !== expected || arg.startsWith(flag + '='))) throw failure() }
    if (args[1] === 'edit' && args[2] && !args[2].startsWith('-') && ![scope.branch, String(scope.number)].includes(args[2])) throw failure()
    return 'gh'
  }
  if (args[0] === 'pr' && scope.policyRole === 'reviewer' && args[1] === 'review' && scope.number && (!args[2] || args[2].startsWith('-') || args[2] === String(scope.number))) return 'gh'
  if (args[0] === 'api') {
    const path = args.find(arg => arg.startsWith('repos/'))
    if (!path?.startsWith(`repos/${scope.repository}/`) || path.includes('..') || path.includes('%') || args.some(arg => /^(?:https?:\/\/|--hostname)/.test(arg))) throw failure()
    const write = args.some(arg => ['POST', 'PATCH', 'PUT', 'DELETE', '-f', '-F', '--field', '--raw-field', '--input'].includes(arg) || /^(?:-[XfF].+|--(?:field|raw-field|input|method)=)/.test(arg))
    if (!write) return 'gh'
    const suffix = path.slice(`repos/${scope.repository}/`.length)
    const fields = apiFields(args)
    if (scope.policyRole === 'developer' && suffix === 'pulls' && !scope.number && fields.head === scope.branch && fields.base === scope.baseBranch && fields.draft === 'true' && fields.body?.includes(scope.publicationMarker)) return 'gh'
    if (scope.policyRole === 'reviewer' && suffix === `pulls/${scope.number}/reviews` && fields.commit_id === scope.candidateSha && ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(fields.event) && fields.body?.includes(scope.reviewMarker)) return 'gh'
    if (scope.policyRole === 'tester' && suffix === 'check-runs' && fields.head_sha === scope.candidateSha && fields.external_id === scope.sha256) return 'gh'
  }
  throw failure()
}
export function githubCommandFailure(error, stage) {
  const text = String(error.stderr ?? error.message ?? '').slice(0, 16000)
  return error.code === 'ENOENT' ? 'tool-unavailable' : /HTTP 401|Bad credentials|authentication required/i.test(text) ? 'authentication-required' : /HTTP 403|Resource not accessible by integration|insufficient permission/i.test(text) ? 'app-permission-denied' : /HTTP 404|repository not found|could not resolve to a/i.test(text) ? 'repository-or-object-unavailable' : /blocked-by-allowlist|could not resolve|network.*unreachable|proxy.*(?:refused|denied)|connection refused|ENETUNREACH|ECONNREFUSED/i.test(text) ? 'network-unavailable' : stage === 'credential' ? 'credential-unavailable' : 'command-failed'
}
export async function main(file, tool, args) {
  let secret, stage = 'scope'
  try {
    const scope = JSON.parse(await readFile(file, 'utf8')), mode = validateRoleCommand(scope, tool, args)
    if (mode === 'credential' || tool === 'gh' || args[0] === 'push') {
      stage = 'credential'
      const value = await credential(scope.authDirectory); secret = value.token
      const stored = { ...scope }; delete stored.authDirectory
      if (value.metadata.sha256 !== scope.sha256 || !isDeepStrictEqual(value.metadata, stored)) throw failure()
    }
    if (mode === 'credential') {
      let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 8192) throw failure() }
      const fields = Object.fromEntries(text.split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
      if (fields.protocol !== 'https' || fields.host !== 'github.com' || ![scope.repository, scope.repository + '.git'].includes(fields.path)) throw failure()
      process.stdout.write(`username=x-access-token\npassword=${secret}\n\n`); return
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|PASSWORD|SECRET|API_KEY|GIT_CONFIG|GIT_TRACE|GIT_ASKPASS|GH_DEBUG|SSH_ASKPASS/.test(key)))
    env.PATH = env.PATH.split(':').filter(path => !path.endsWith('/github-bin')).join(':')
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' })
    if (tool === 'gh') Object.assign(env, { GH_TOKEN: secret, GH_REPO: scope.repository, GH_HOST: 'github.com' })
    const apiCreate = tool === 'gh' && args[0] === 'api' && scope.policyRole === 'developer' && args.includes(`repos/${scope.repository}/pulls`) && apiFields(args).head
    if (tool === 'gh' && args[0] === 'pr' && ['create', 'edit', 'review'].includes(args[1]) || apiCreate) {
      const found = await exec('gh', ['pr', 'list', '--repo', scope.repository, '--head', scope.branch, '--state', 'all', '--limit', '2', '--json', 'number,url,headRefName,headRefOid,baseRefName,author,state'], { env, timeout: 30000, maxBuffer: 65536 })
      const rows = JSON.parse(found.stdout)
      if (!Array.isArray(rows) || rows.length > 1 || rows.some(row => row.state !== 'OPEN' || row.headRefName !== scope.branch || row.baseRefName !== scope.baseBranch || row.number !== scope.number && scope.number !== null)) throw failure()
      if ((args[1] === 'create' || apiCreate) && rows.length) {
        const head = (await exec('git', ['rev-parse', 'HEAD'], { env, timeout: 10000 })).stdout.trim(), row = rows[0]
        if (row.author?.login !== scope.identity.login || row.headRefOid !== head) throw failure()
        const details = JSON.parse((await exec('gh', ['pr', 'view', String(row.number), '--repo', scope.repository, '--json', 'body,url'], { env, timeout: 30000, maxBuffer: 65536 })).stdout)
        if (!details.body?.includes(scope.publicationMarker) || details.url !== `https://github.com/${scope.repository}/pull/${row.number}`) throw failure()
        process.stdout.write((apiCreate ? JSON.stringify({ number: row.number, html_url: details.url }) : details.url) + '\n'); return // Lost create responses reconcile the original remote PR before any write.
      }
      if (args[1] !== 'create' && !apiCreate && rows.length !== 1) throw failure()
      if (args[1] === 'review' && rows[0].headRefOid !== scope.candidateSha) throw failure()
    }
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
    const helper = `!${quote(process.execPath)} ${quote(fileURLToPath(new URL('./project-role-github-cli-entry.mjs', import.meta.url)))} ${quote(file)}`
    const ghArgs = [...args]
    if (tool === 'gh' && args[0] === 'pr' && args[1] === 'create') { if (!args.includes('--draft')) ghArgs.push('--draft'); if (!args.includes('--base')) ghArgs.push('--base', scope.baseBranch); if (!args.includes('--head')) ghArgs.push('--head', scope.branch) }
    if (tool === 'gh' && args[0] === 'pr' && ['edit', 'review'].includes(args[1]) && (!args[2] || args[2].startsWith('-'))) ghArgs.splice(2, 0, args[1] === 'review' ? String(scope.number) : scope.branch)
    if (tool === 'gh' && args[0] === 'pr' && args[1] === 'review') {
      const events = [['--approve', 'APPROVE'], ['--request-changes', 'REQUEST_CHANGES'], ['--comment', 'COMMENT']].filter(([flag]) => args.includes(flag))
      if (events.length !== 1 || !scope.candidateSha || !scope.reviewMarker) throw failure()
      const index = args.indexOf('--body'), bodyFile = args.indexOf('--body-file')
      const body = index >= 0 ? args[index + 1] : bodyFile >= 0 ? await readFile(args[bodyFile + 1], 'utf8') : ''
      if (typeof body !== 'string' || body.length > 16000) throw failure()
      ghArgs.splice(0, ghArgs.length, 'api', `repos/${scope.repository}/pulls/${scope.number}/reviews`, '--method', 'POST', '-f', `commit_id=${scope.candidateSha}`, '-f', `event=${events[0][1]}`, '-f', `body=${body}\n\n${scope.reviewMarker}`)
    }
    if (tool === 'gh' && ghArgs[0] === 'api' && ghArgs.includes(`repos/${scope.repository}/pulls/${scope.number}/reviews`) && apiFields(ghArgs).event) {
      const fields = apiFields(ghArgs)
      const observed = JSON.parse((await exec('gh', ['api', `repos/${scope.repository}/pulls/${scope.number}`], { env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout)
      if (observed.state !== 'open' || observed.head?.sha !== scope.candidateSha || observed.head?.repo?.full_name !== scope.repository || observed.base?.ref !== scope.baseBranch) throw failure()
      let latest
      for (let page = 1; page <= 10; ++page) {
        const rows = JSON.parse((await exec('gh', ['api', `repos/${scope.repository}/pulls/${scope.number}/reviews?per_page=100&page=${page}`], { env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout)
        if (!Array.isArray(rows)) throw failure()
        for (const row of rows) if (row.user?.login === scope.identity.login && row.commit_id === scope.candidateSha && row.body?.includes(scope.reviewMarker) && row.submitted_at && Number.isSafeInteger(row.id) && (!latest || row.id > latest.id)) latest = row
        if (rows.length < 100) break
        if (page === 10) throw failure()
      }
      const expected = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[fields.event]
      if (latest?.state === expected) { process.stdout.write(JSON.stringify({ id: latest.id, state: latest.state, commit_id: latest.commit_id }) + '\n'); return }
    }
    const options = tool === 'git' ? ['-c', 'http.extraHeader=', '-c', 'http.https://github.com/.extraHeader=', '-c', `http.https://github.com/${scope.repository}.git.extraHeader=`, '-c', `http.https://github.com/${scope.repository}.extraHeader=`, '-c', 'credential.helper=', '-c', 'credential.useHttpPath=true', '-c', `credential.helper=${helper}`, '-c', 'core.hooksPath=/dev/null', '-c', `user.name=${scope.author.name}`, '-c', `user.email=${scope.author.email}`, ...args] : ghArgs
    stage = 'execute'
    const result = await exec(tool, options, { env, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })
    process.stdout.write(secret ? result.stdout.split(secret).join('[REDACTED]') : result.stdout); process.stderr.write(secret ? result.stderr.split(secret).join('[REDACTED]') : result.stderr)
  } catch (error) { if (error.code === 'ENOENT') process.stderr.write(`${tool}: command not found; provision the selected resource tool\n`); process.stderr.write(`Role GitHub ${tool} command failed (${githubCommandFailure(error, stage)}/${stage}/${Number.isInteger(error.code) || ['ENOENT', 'EPERM', 'EACCES', 'ECONNREFUSED', 'ENETUNREACH', 'credential-transport', 'credential-denied', 'credential-response', 'role-scope'].includes(error.code) ? error.code : 'refused'}); no credential or private response is logged\n`); process.exitCode = 1 }
}
