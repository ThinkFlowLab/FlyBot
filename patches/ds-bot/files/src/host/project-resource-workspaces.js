// SHA-scoped Git objects cross resources; SDK profiles, private chat and git config do not.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
export async function fileDigest(path) {
  const hash = createHash('sha256')
  for await (const part of createReadStream(path)) hash.update(part)
  return hash.digest('hex')
}
const gitOptions = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=FlyBot project automation', '-c', 'user.email=flybot-project@localhost']
export function createResourceWorkspaces(rt, { hostGit, artifacts }) {
  const resourceOf = workspace => rt.projectResources.requireBinding(workspace.projectId, workspace.resourceLease)
  async function git(workspace, args) {
    resourceOf(workspace)
    const result = await rt.projectResources.command(workspace.projectId, workspace.resourceId, { cwd: workspace.path, argv: ['git', ...gitOptions, ...args] })
    return result.stdout.trim()
  }
  async function bundle(repository, commit, directory) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Bundle needs a full commit SHA')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `transfer-${randomUUID()}.bundle`), ref = `refs/flybot-transfer/${randomUUID()}`
    await hostGit(repository, ['update-ref', ref, commit])
    try { await hostGit(repository, ['bundle', 'create', path, ref]) }
    finally { await hostGit(repository, ['update-ref', '-d', ref]) }
    if ((await stat(path)).size > 128 * 1024 * 1024) { await rm(path); throw new Error('Git bundle exceeds 128 MiB transfer bound') }
    return { path, ref, sha256: await fileDigest(path), commit }
  }
  async function putBundle(workspace, artifact) {
    resourceOf(workspace)
    const target = join(workspace.path, '.git', `flybot-transfer-${randomUUID()}.bundle`)
    await rt.projectResources.uploadFile(workspace.projectId, workspace.resourceId, artifact.path, target)
    const result = await rt.projectResources.command(workspace.projectId, workspace.resourceId, { cwd: workspace.path, argv: ['node', '-e', 'const fs=require("fs"),crypto=require("crypto");const h=crypto.createHash("sha256");const stream=fs.createReadStream(process.argv[1]);stream.on("data",x=>h.update(x));stream.on("end",()=>console.log(h.digest("hex")));stream.on("error",()=>process.exit(1))', target] })
    if (result.stdout.trim() !== artifact.sha256) throw new Error('Transferred Git bundle hash mismatch')
    await git(workspace, ['bundle', 'verify', target])
    await git(workspace, ['fetch', '--no-tags', target, artifact.ref])
    if (await git(workspace, ['cat-file', '-t', artifact.commit]) !== 'commit') throw new Error('Transferred candidate commit is missing')
    await rt.projectResources.command(workspace.projectId, workspace.resourceId, { cwd: workspace.path, argv: ['rm', '-f', '--', target] })
    workspace.transfers ??= []
    workspace.transfers.push({ sha256: artifact.sha256, commit: artifact.commit, resourceId: workspace.resourceId, projectId: workspace.projectId, attemptId: workspace.attemptId, at: Date.now() })
  }
  async function ensureCommits(workspace, attempt, commits) {
    for (const commit of [...new Set(commits.filter(Boolean))]) {
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Workspace input needs an exact commit SHA')
      await hostGit(workspace.repository, ['cat-file', '-e', `${commit}^{commit}`])
      try { await git(workspace, ['cat-file', '-e', `${commit}^{commit}`]); continue }
      catch { /* Import only the explicitly selected host object, never ambient refs/configuration. */ }
      const artifact = await bundle(workspace.repository, commit, join(artifacts, attempt.id))
      try { await putBundle(workspace, artifact) } finally { await rm(artifact.path, { force: true }) }
    }
  }
  async function allocate(workspace, attempt) {
    const resource = resourceOf(workspace)
    await rt.projectResources.command(workspace.projectId, workspace.resourceId, { cwd: resource.root, argv: ['mkdir', '-p', workspace.path] })
    await git(workspace, ['init', '-q'])
    const artifact = await bundle(workspace.repository, attempt.baseSha, join(artifacts, attempt.id))
    try { await putBundle(workspace, artifact) } finally { await rm(artifact.path, { force: true }) }
    await git(workspace, ['checkout', '--detach', attempt.baseSha])
    if (await git(workspace, ['rev-parse', 'HEAD']) !== attempt.baseSha) throw new Error('Remote Workspace base SHA mismatch')
  }
  async function importCandidate(workspace, attempt) {
    resourceOf(workspace)
    const remote = join(workspace.path, '.git', `flybot-candidate-${randomUUID()}.bundle`)
    await git(workspace, ['bundle', 'create', remote, 'HEAD'])
    const output = await rt.projectResources.command(workspace.projectId, workspace.resourceId, { cwd: workspace.path, argv: ['node', '-e', 'const fs=require("fs"),c=require("crypto");console.log(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))', remote] })
    const path = join(artifacts, attempt.id, `candidate-${randomUUID()}.bundle`)
    await rt.projectResources.downloadFile(workspace.projectId, workspace.resourceId, remote, path)
    if (await fileDigest(path) !== output.stdout.trim()) throw new Error('Returned candidate bundle hash mismatch')
    await hostGit(workspace.repository, ['bundle', 'verify', path])
    await hostGit(workspace.repository, ['fetch', '--no-tags', path, 'HEAD'])
    if (await hostGit(workspace.repository, ['cat-file', '-t', attempt.candidateSha]) !== 'commit') throw new Error('Returned candidate SHA is missing')
    await hostGit(workspace.repository, ['update-ref', `refs/heads/${attempt.branch}`, attempt.candidateSha])
    attempt.publicationRepository = workspace.repository
    attempt.candidateTransfer = { sha256: await fileDigest(path), resourceId: workspace.resourceId, commit: attempt.candidateSha, at: Date.now() }
    await rm(path, { force: true })
    await rt.projectResources.command(workspace.projectId, workspace.resourceId, { cwd: workspace.path, argv: ['rm', '-f', '--', remote] })
  }
  async function checkout(workspace, attempt) {
    const artifact = await bundle(workspace.repository, attempt.candidateSha, join(artifacts, attempt.id))
    try { await putBundle(workspace, artifact) } finally { await rm(artifact.path, { force: true }) }
    await git(workspace, ['reset', '--hard', attempt.candidateSha]); await git(workspace, ['clean', '-ffdx'])
    if (await git(workspace, ['rev-parse', 'HEAD']) !== attempt.candidateSha) throw new Error('Remote checkout does not match sealed candidate')
  }
  async function cleanup(workspace) {
    const resource = resourceOf(workspace)
    if (!workspace.path.startsWith(resource.root + '/delivery/') || workspace.path !== join(resource.root, 'delivery', workspace.storageAttemptId ?? workspace.attemptId, workspace.role)) throw new Error('Unregistered remote cleanup target')
    await rt.projectResources.command(workspace.projectId, workspace.resourceId, { cwd: resource.root, argv: ['rm', '-rf', '--', workspace.path] })
  }
  return { allocate, ensureCommits, git, importCandidate, checkout, cleanup, bundle, putBundle }
}
