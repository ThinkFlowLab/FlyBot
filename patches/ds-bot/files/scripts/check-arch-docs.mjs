import { execFileSync } from 'node:child_process';
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
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`cannot diff against ${ref}`);
  }
}

function changedFiles(ref) {
  const out = execFileSync('git', ['diff', '--name-only', `${ref}...HEAD`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out.split(/\r?\n/).filter(Boolean);
}

function fileChangedIn(ref, file) {
  const out = execFileSync('git', ['diff', '--name-only', `${ref}...HEAD`, '--', file], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  return out.length > 0;
}

const TRAILER = /Docs-not-needed:/i;

function gitLog(ref) {
  return execFileSync('git', ['log', `${ref}..HEAD`, '--pretty=%B'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

export function hasDocsNotNeededTrailer(ref = baseRef(), logText = null) {
  assertBaseRef(ref);
  return TRAILER.test(logText ?? gitLog(ref));
}

// The pull request this run belongs to (#3322): the merge queue squashes its title and body into the
// commit it judges, so on a `pull_request` run the trailer has to be in that text as well as in the
// branch commits. `GITHUB_EVENT_PATH` is the runner's own copy of the event; a `pull_request` run
// whose event cannot be read counts as a body without the trailer, so the gate stays red rather
// than passing on a text it could not see.
export function pullRequestEvent() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return undefined;
  const empty = { name: 'pull_request', title: '', body: '' };
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return empty;
  try {
    const event = JSON.parse(readFileSync(path, 'utf8'));
    return {
      name: 'pull_request',
      title: String(event?.pull_request?.title ?? ''),
      body: String(event?.pull_request?.body ?? ''),
    };
  } catch {
    return empty;
  }
}

export function filesNeedDocs({
  ref = baseRef(),
  map = null,
  event = pullRequestEvent(),
  logText = null,
  files = null,
  changed = null,
} = {}) {
  assertBaseRef(ref);
  const subsystemMap = map || loadSubsystemMap();
  const touched = files ?? changedFiles(ref);
  const inLog = hasDocsNotNeededTrailer(ref, logText);
  // Only a pull request has a second place; a merge-queue entry and a local run judge the log alone.
  const inBody = event?.name === 'pull_request'
    ? TRAILER.test(`${event.title ?? ''}\n${event.body ?? ''}`)
    : true;
  const trailer = { log: inLog, body: inBody, event: event?.name ?? 'local' };
  if (touched.length === 0) return { ok: true, missing: [], files: [], trailer };
  if (inLog && inBody) return { ok: true, missing: [], files: touched, trailer };
  const isChanged = changed ?? (file => fileChangedIn(ref, file));
  const missing = [];
  for (const file of touched) {
    const match = longestMatch(file, subsystemMap);
    if (!match) continue;
    if (isChanged(match.docPath)) continue;
    missing.push({ file, subsystem: match.subsystem, doc: match.docPath });
  }
  return { ok: missing.length === 0, missing, files: touched, trailer };
}

// #1076: the trailer this gate looks for is read from `git log <base>..HEAD`, and on a merge-queue
// entry that range holds the squash of the pull request title and body — the branch commits are not in
// it. So "add a trailer" sent people to the commit they had just pushed, and the entry went red again.
// The refusal names both places, and says why the body counts. Since #3322 a `pull_request` run reads
// both, and names the one that is missing rather than leaving it to the queue.
export function failureLines(missing, root = ROOT, trailer = null) {
  const lines = ['arch-docs: FAIL — owned file(s) changed without subsystem doc update:'];
  for (const m of missing) lines.push(`  ${m.file}  →  ${m.subsystem} (${relative(root, m.doc)})`);
  if (trailer?.event === 'pull_request' && trailer.log !== trailer.body) {
    lines.push(trailer.body
      ? 'arch-docs: the pull request body has `Docs-not-needed:`, but the branch commits do not.'
      : 'arch-docs: the branch commits have `Docs-not-needed:`, but the pull request title and body do not.');
    lines.push('  The merge queue squashes the title and body into the commit it judges, so a trailer');
    lines.push('  that lives only in a branch commit is gone exactly when main is judged. Add it to both.');
  }
  lines.push('Fix it one of two ways:');
  lines.push('  - update the subsystem doc in docs/subsystems/ in this pull request, or');
  lines.push('  - add a line `Docs-not-needed: <why>` to the pull request body AND to the branch commit.');
  lines.push('    The merge queue squashes the title and body into the commit it judges, so a trailer');
  lines.push('    that lives only in a branch commit is gone exactly when main is judged');
  lines.push('    (AGENTS.md → Docs-not-needed: why both places).');
  return lines;
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
  for (const line of failureLines(missing, ROOT, result.trailer)) console.error(line);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
