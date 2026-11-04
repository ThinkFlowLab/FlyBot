// A bounded protocol correction uses the original claim and frozen business proposal.
// This is feedback transport through project-effects, never another role scheduler.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export const receiptDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function protocolCorrection(previous, { version, limit, feedback, priorExecution = null }) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 4) throw new Error('Protocol correction budget must be an integer from0 to4')
  const round = (previous?.round ?? 0) + 1
  return { version, round, limit, status: round <= limit ? 'pending' : 'exhausted', feedback: [...(previous?.feedback ?? []), feedback].slice(-5), priorExecution: structuredClone(priorExecution) }
}
export async function freezeReceiptProposal(rt, task, claim, decision) {
  const text = JSON.stringify(decision), sha256 = receiptDigest(decision)
  if (Buffer.byteLength(text) > 65536 || !rt.home) throw new Error('Receipt proposal exceeds its private recovery budget or archive is unavailable')
  const directory = join(rt.home, 'project-artifacts', 'input-corrections', receiptDigest([task.projectId, task.id, claim.id, claim.generation]))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, sha256 + '.json')
  try { await writeFile(file, text, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST' || await readFile(file, 'utf8') !== text) throw error }
  return { sha256, bytes: Buffer.byteLength(text) }
}
export async function readReceiptProposal(rt, task, claim, reference) {
  const file = join(rt.home, 'project-artifacts', 'input-corrections', receiptDigest([task.projectId, task.id, claim.id, claim.generation]), reference.sha256 + '.json')
  const text = await readFile(file, 'utf8')
  if (Buffer.byteLength(text) !== reference.bytes || reference.bytes > 65536) throw new Error('Receipt proposal archive changed')
  const decision = JSON.parse(text)
  if (receiptDigest(decision) !== reference.sha256) throw new Error('Receipt proposal archive hash changed')
  return decision
}
