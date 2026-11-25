const DOCUMENT_ID = /^[a-f0-9]{32}$/
const EXCERPT_LIMIT = 2400

export function studioReference(value) {
  const { document_id, revision } = value || {}
  return typeof document_id === 'string' && DOCUMENT_ID.test(document_id) &&
    Number.isSafeInteger(revision) && revision > 0 ? { document_id, revision } : null
}

export function claimedStudioReference(item, claim) {
  const selected = studioReference(item.message?.studio_reference)
  const receipt = studioReference(claim?.studio_reference)
  if (!selected || !receipt || item.mode !== 'mention' ||
      receipt.document_id !== selected.document_id || receipt.revision !== selected.revision) return null
  const { title, excerpt, truncated } = claim.studio_reference
  if (typeof title !== 'string' || !title || title.length > 120 ||
      typeof excerpt !== 'string' || excerpt.length > EXCERPT_LIMIT * 2 ||
      [...excerpt].length > EXCERPT_LIMIT || !excerpt.isWellFormed() || typeof truncated !== 'boolean') return null
  return { ...receipt, title, excerpt, truncated }
}
