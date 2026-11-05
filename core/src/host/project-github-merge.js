// Uses the existing selected GitHub identity/authorization transport only.
// Provider contract: https://docs.github.com/en/graphql/reference/pulls
const stateQuery = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){nameWithOwner pullRequest(number:$number){id number state headRefOid headRefName headRepository{nameWithOwner} baseRefName baseRefOid isDraft mergeable mergeStateStatus reviewDecision isInMergeQueue isMergeQueueEnabled reviewThreads(first:20){nodes{isResolved comments(first:1){nodes{url}}}pageInfo{hasNextPage}} merged mergeCommit{oid} author{login} body labels(first:100){nodes{name}pageInfo{hasNextPage}} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100,after:$cursor){nodes{...on CheckRun{databaseId name status conclusion startedAt checkSuite{app{databaseId}}}...on StatusContext{context state createdAt}}pageInfo{hasNextPage endCursor}}}}}}}}}`
const mutation = (name, inputType, fields) => `mutation($input:${inputType}!){${name}(input:$input){${fields} clientMutationId}}`
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const result = (status, reason, extra = {}) => ({ version: 'project-merge-observation/v1', status, reason, observedAt: Date.now(), ...extra })
export async function reconcileGithubMerge(intent, policy, { graphql, beforeWrite = async () => {} }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(intent.repository) || !Number.isSafeInteger(intent.number) || intent.number < 1 || !sha(intent.candidateSha) || !intent.branch || !intent.publicationMarker) throw new Error('Merge intent has an invalid publication binding')
  const [owner, name] = intent.repository.split('/'), contexts = []
  let cursor = null, row, baseSha
  for (let page = 0; page < 10; ++page) {
    const data = await graphql(stateQuery, { owner, name, number: intent.number, cursor }, false)
    const current = data.repository?.pullRequest
    if (data.repository?.nameWithOwner?.toLowerCase() !== intent.repository.toLowerCase() || !current || current.number !== intent.number || current.headRepository?.nameWithOwner?.toLowerCase() !== intent.repository.toLowerCase() || current.headRefName !== intent.branch || current.headRefOid !== intent.candidateSha || current.baseRefName !== policy.baseBranch || !sha(current.baseRefOid) || current.author?.login?.toLowerCase() !== intent.creatorLogin?.toLowerCase() || !current.body?.includes(intent.publicationMarker)) return result('blocked', 'publication-binding-changed')
    if (baseSha && baseSha !== current.baseRefOid) return result('waiting', 'base-changed-during-check')
    row = current; baseSha = current.baseRefOid
    const commit = row.commits?.nodes?.[0]?.commit
    if (commit?.oid !== intent.candidateSha) return result('blocked', 'candidate-check-scope-changed')
    const connection = commit.statusCheckRollup?.contexts
    if (connection?.nodes) contexts.push(...connection.nodes)
    if (!connection?.pageInfo?.hasNextPage) break
    if (page === 9 || !connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) return result('blocked', 'check-pagination-incomplete')
    cursor = connection.pageInfo.endCursor
  }
  const metadata = { number: intent.number, repository: intent.repository, candidateSha: intent.candidateSha, baseBranch: policy.baseBranch, observedBaseSha: baseSha, method: policy.method, providerState: row.state, isDraft: row.isDraft, mergeable: row.mergeable, mergeStateStatus: row.mergeStateStatus, reviewDecision: row.reviewDecision, inQueue: row.isInMergeQueue, checks: contexts.map(c => ({ id: c.databaseId ?? null, name: c.name ?? c.context, status: c.status ?? c.state, conclusion: c.conclusion ?? null, appId: c.checkSuite?.app?.databaseId ?? null, observedForSha: row.headRefOid })), checkCount: contexts.length, threads: row.reviewThreads ? { unresolved: row.reviewThreads.nodes.filter(t => !t.isResolved).map(t => ({ url: t.comments?.nodes?.[0]?.url ?? null })), complete: !row.reviewThreads.pageInfo?.hasNextPage } : { status: 'unknown' } }
  if (row.merged || row.state === 'MERGED') {
    if (!sha(row.mergeCommit?.oid)) return result('unknown', 'merge-commit-unavailable', metadata)
    return result('merged', 'provider-confirmed', { ...metadata, mergeCommitSha: row.mergeCommit.oid })
  }
  if (row.state !== 'OPEN') return result('blocked', 'pull-request-closed-without-merge', metadata)
  if (row.labels?.pageInfo?.hasNextPage || !Array.isArray(row.labels?.nodes)) return result('blocked', 'label-scope-incomplete', metadata)
  if (row.labels.nodes.some(label => label.name.toLowerCase() === 'hold')) return result('blocked', 'hold', metadata)
  if (row.isInMergeQueue) return result('queued', 'provider-queue-entry', metadata)
  if (row.isDraft) {
    await beforeWrite({ operation: 'ready', ...metadata })
    await graphql(mutation('markPullRequestReadyForReview', 'MarkPullRequestReadyForReviewInput', 'pullRequest{id isDraft}'), { input: { pullRequestId: row.id, clientMutationId: intent.id + ':ready' } }, true)
    return result('waiting', 'draft-marked-ready', metadata)
  }
  for (const required of policy.requiredChecks) {
    const matches = contexts.filter(check => (check.name ?? check.context) === required.name && (!required.appId || check.checkSuite?.app?.databaseId === required.appId))
    const groups = new Map()
    for (const check of matches) {
      const key = check.name ? 'check:' + (check.checkSuite?.app?.databaseId ?? 'unknown') : 'status', rank = check.name ? check.databaseId : Date.parse(check.createdAt)
      if (!Number.isSafeInteger(rank) || rank < 0) return result('blocked', 'check-order-unavailable', metadata)
      const prior = groups.get(key)
      if (!prior || rank >= prior.rank) groups.set(key, { rank, check })
    }
    if (!groups.size) return result('waiting', 'required-check-missing:' + required.name, metadata)
    for (const { check } of groups.values()) {
      if (check.name && check.status !== 'COMPLETED' || !check.name && check.state === 'PENDING') return result('waiting', 'required-check-pending:' + required.name, metadata)
      if ((check.conclusion ?? check.state) !== 'SUCCESS') return result('blocked', 'required-check-failed:' + required.name, metadata)
    }
  }
  if (row.reviewDecision === 'REVIEW_REQUIRED' || row.reviewDecision === 'CHANGES_REQUESTED' || policy.requireGithubReview && row.reviewDecision !== 'APPROVED') return result('blocked', 'github-review-required', metadata)
  if (row.mergeable === 'CONFLICTING' || row.mergeStateStatus === 'DIRTY') return result('blocked', 'merge-conflict', metadata)
  if (row.mergeable !== 'MERGEABLE' || !row.isMergeQueueEnabled && !['CLEAN', 'UNSTABLE'].includes(row.mergeStateStatus)) return result('waiting', 'repository-merge-gate:' + row.mergeStateStatus, metadata)
  // Never request an admin bypass, jump the queue, or manufacture forge approval.
  await beforeWrite({ operation: row.isMergeQueueEnabled ? 'enqueue' : 'merge', ...metadata })
  if (row.isMergeQueueEnabled) {
    await graphql(mutation('enqueuePullRequest', 'EnqueuePullRequestInput', 'mergeQueueEntry{id}'), { input: { pullRequestId: row.id, expectedHeadOid: intent.candidateSha, jump: false, clientMutationId: intent.id + ':enqueue' } }, true)
    return result('queued', 'provider-enqueued', metadata)
  }
  await graphql(mutation('mergePullRequest', 'MergePullRequestInput', 'pullRequest{id merged mergeCommit{oid}}'), { input: { pullRequestId: row.id, expectedHeadOid: intent.candidateSha, mergeMethod: policy.method.toUpperCase(), clientMutationId: intent.id + ':merge' } }, true)
  // A mutation response is not the acceptance receipt. Re-read on the next
  // existing Effect pass, including after a lost/ambiguous write response.
  return result('waiting', 'merge-requested-awaiting-observation', metadata)
}
