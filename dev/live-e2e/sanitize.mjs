// The evidence gate: everything uploaded from a live run passes scanTree first. CI
// logs and artifacts of a public repository are world-readable, so this fails closed —
// a finding means the evidence is not uploaded and the run is infra_failed, never a pass.
// It looks for the web app's `?token=` login URLs, cookie material, and the secret's own
// value wherever it appears. Findings name the file and the kind of hit only: the matched
// text itself is what the scan exists to keep out, so it never enters a report.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_URL = /\?token=[^"'\s]+/
const COOKIE = /\b(set-cookie|x-flybot-member-session)\b.{0,80}/i

export function scanText(text, secret) {
  const findings = []
  if (TOKEN_URL.test(text)) findings.push('login token URL')
  if (COOKIE.test(text)) findings.push('cookie material')
  if (secret && secret.length >= 8 && text.includes(secret)) findings.push('the API key value appears verbatim')
  return findings
}

export function scanTree(root, secret) {
  const findings = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'sanitized.txt') continue
      const path = join(dir, entry)
      const info = statSync(path)
      if (info.isDirectory()) { walk(path); continue }
      // Binary evidence (PNGs) is skipped: only text can hide a secret.
      if (/\.(png|jpg|jpeg|webp|gif)$/i.test(entry)) continue
      const text = readFileSync(path, 'utf8').replaceAll('\u0000', '')
      for (const finding of scanText(text, secret)) findings.push(`${path}: ${finding}`)
    }
  }
  walk(root)
  return findings
}
