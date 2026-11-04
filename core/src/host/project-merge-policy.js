// Operator authorization is distinct from a model's candidate recommendation.
import { createHash } from 'node:crypto'
export const mergeDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const branch = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/\s|\.\.|[~^:?*\[\\]|^\/|\/$|\.lock$/.test(value)
export function projectMergePolicy(settings, baseBranch) {
  const value = settings?.mergePolicy
  if (value === undefined || value?.enabled === false) return null
  if (!value || value.enabled !== true || Object.keys(value).some(key => !['enabled', 'branches', 'method', 'requiredChecks', 'pollIntervalMs', 'maxWaitMs', 'requireGithubReview'].includes(key))) throw new Error('Invalid Project merge policy')
  if (!Array.isArray(value.branches) || !value.branches.length || value.branches.length > 20 || !value.branches.every(branch) || !value.branches.includes(baseBranch)) throw new Error('Project merge target is not explicitly authorized')
  if (!['squash', 'merge', 'rebase'].includes(value.method)) throw new Error('Project merge method must be explicit')
  const checks = value.requiredChecks ?? []
  if (!Array.isArray(checks) || checks.length > 50 || checks.some(row => typeof row === 'string' ? !row.trim() || row.length > 200 : !row || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || !Number.isSafeInteger(row.appId) || row.appId < 1 || Object.keys(row).some(key => !['name', 'appId'].includes(key)))) throw new Error('Project merge checks are invalid')
  const result = { version: 'project-merge-policy/v1', baseBranch, method: value.method, requiredChecks: checks.map(row => typeof row === 'string' ? { name: row } : { ...row }), requireGithubReview: value.requireGithubReview === true, pollIntervalMs: value.pollIntervalMs ?? 30000, maxWaitMs: value.maxWaitMs ?? 86400000 }
  if (!Number.isSafeInteger(result.pollIntervalMs) || result.pollIntervalMs < 5000 || result.pollIntervalMs > 3600000 || !Number.isSafeInteger(result.maxWaitMs) || result.maxWaitMs < result.pollIntervalMs || result.maxWaitMs > 604800000 || value.requireGithubReview !== undefined && typeof value.requireGithubReview !== 'boolean') throw new Error('Project merge timing/review policy is invalid')
  return result
}
