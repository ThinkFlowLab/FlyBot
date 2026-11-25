import { digest } from '../../featurekit/http.js'

const SHARE_ID = /^otsr_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/
const EXCERPT_LENGTH = 400

export function teamRunWorkKey(runId, position) {
  return digest(`artifact-source:team_run:${runId}:${position}`)
}

export function teamRunSource(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 ||
      typeof value.id !== 'string' || !SHARE_ID.test(value.id) ||
      typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version) ||
      !Array.isArray(value.positions) || value.positions.length < 1 || value.positions.length > 3 ||
      value.positions.some(index => !Number.isInteger(index) || index < 0 || index > 7) ||
      new Set(value.positions).size !== value.positions.length) return null
  return {id: value.id, version: value.version, positions: [...value.positions].sort((a, b) => a - b)}
}

export function snapshotVersion(row) {
  return digest(JSON.stringify([row.title, row.goal, row.status, row.snapshot?.steps?.map(
    step => [step.position, step.agent_name, step.status, step.output]
  )]))
}

export function selectedResults(row, source) {
  const outputs = []
  for (const position of source.positions) {
    const step = row.snapshot?.steps?.find(item => item.position === position)
    if (step?.status !== 'succeeded' || typeof step.output !== 'string' || !step.output.trim()) return null
    const content = [...step.output.trim().toWellFormed()]
    outputs.push({position: position + 1, text: content.length > EXCERPT_LENGTH
      ? content.slice(0, EXCERPT_LENGTH).join('') + '…' : content.join('')})
  }
  return {title: row.title, outputs}
}
