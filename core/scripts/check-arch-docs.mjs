import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS_DIR = join(ROOT, 'docs', 'subsystems');

export function parseOwnedPaths(docPath) {
  const text = readFileSync(docPath, 'utf8');
  const lines = text.split(/\r?\n/);
  let inFm = false;
  let inOwned = false;
  const owned = [];
  let subsystem = null;
  for (const line of lines) {
    if (line.trim() === '---') {
      if (!inFm) { inFm = true; continue; }
      break;
    }
    if (!inFm) continue;
    const sub = line.match(/^subsystem:\s*(\S+)\s*$/);
    if (sub) subsystem = sub[1];
    if (/^owned_paths:\s*$/.test(line)) { inOwned = true; continue; }
    if (inOwned) {
      const item = line.match(/^\s+-\s+(\S+)\s*$/);
      if (item) { owned.push(item[1]); continue; }
      inOwned = false;
    }
  }
  return { subsystem, ownedPaths: owned };
}

export function pathMatchesOwned(filePath, ownedPrefix) {
  const norm = filePath.split(sep).join('/');
  const pref = ownedPrefix.split(sep).join('/').replace(/\/+$/, '');
  if (norm === pref) return true;
  if (pref.endsWith('/')) return norm.startsWith(pref);
  return norm === pref || norm.startsWith(pref + '/');
}

export function loadSubsystemMap(docsDir = DOCS_DIR) {
  const map = new Map();
  if (!existsSync(docsDir)) return map;
  for (const name of readdirSync(docsDir)) {
    if (!name.endsWith('.md') || name === 'README.md') continue;
    const path = join(docsDir, name);
    const { subsystem, ownedPaths } = parseOwnedPaths(path);
    if (!subsystem) continue;
    map.set(subsystem, { path, ownedPaths });
  }
  return map;
}

function longestMatch(file, map) {
  let best = null;
  let bestLen = -1;
  for (const [subsystem, info] of map) {
    for (const owned of info.ownedPaths) {
      if (pathMatchesOwned(file, owned) && owned.length > bestLen) {
        bestLen = owned.length;
        best = { subsystem, owned, docPath: info.path };
      }
    }
  }
  return best;
}

function baseRef() {
  return process.env.ARCH_DOCS_BASE || 'origin/main';
}

function assertBaseRef(ref) {
  try {
    execSync(`git rev-parse --verify ${ref}^{commit}`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`cannot diff against ${ref}`);
  }
}

function changedFiles(ref) {
  const out = execSync(`git diff --name-only ${ref}...HEAD`, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out.split(/\r?\n/).filter(Boolean);
}

function fileChangedIn(ref, file) {
  const out = execSync(`git diff --name-only ${ref}...HEAD -- ${file}`, {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  return out.length > 0;
}

export function hasDocsNotNeededTrailer(ref = baseRef()) {
  assertBaseRef(ref);
  const out = execSync(`git log ${ref}..HEAD --pretty=%B`, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return /Docs-not-needed:/i.test(out);
}

export function filesNeedDocs({ ref = baseRef(), map = null } = {}) {
  assertBaseRef(ref);
  const subsystemMap = map || loadSubsystemMap();
  const files = changedFiles(ref);
  if (files.length === 0) return { ok: true, missing: [], files: [] };
  if (hasDocsNotNeededTrailer(ref)) return { ok: true, missing: [], files };
  const missing = [];
  for (const file of files) {
    const match = longestMatch(file, subsystemMap);
    if (!match) continue;
    if (fileChangedIn(ref, match.docPath)) continue;
    missing.push({ file, subsystem: match.subsystem, doc: match.docPath });
  }
  return { ok: missing.length === 0, missing, files };
}

function main() {
  let result;
  try {
    result = filesNeedDocs();
  } catch (err) {
    console.error(`arch-docs: FAIL — ${err.message}`);
    process.exit(1);
  }
  const { ok, missing, files } = result;
  if (ok) {
    console.log(`arch-docs: OK (${files.length} changed file(s))`);
    process.exit(0);
  }
  console.error('arch-docs: FAIL — owned file(s) changed without subsystem doc update:');
  for (const m of missing) {
    console.error(`  ${m.file}  →  ${m.subsystem} (${relative(ROOT, m.doc)})`);
  }
  console.error('Update the subsystem doc in docs/subsystems/ or add a "Docs-not-needed:" trailer.');
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
