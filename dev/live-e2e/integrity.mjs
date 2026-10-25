// Grader integrity (#398). The Bot under test holds the workspace it is given, and the
// runner cannot take that workspace away: a bench home inside this checkout would let the
// Bot write the grader, the fixtures and the evidence the run is judged on. So the run
// hashes its own grader before the first turn and again before it writes the report, and
// a difference fails the whole run — invalid evidence, not a warning.
//
// What this cannot do is stop a read. DSH's confining sandbox modes restrict file
// *effects* (`@deepseek-ai/dsh-sandbox`: `read-only` permits only required sinks such as
// /dev/null, `workspace-write` adds the workspace and a temp area; neither denies a read),
// so a path a bot should not see has to be moved out of its reach by the deployment. The
// split is written down in README.md, and the read-only half is DSH's, not this file's.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// Every regular file under each directory, as `dir-relative-to-root -> sha256`, sorted so two
// manifests of the same tree print the same thing. Symlinks are followed only to be hashed by
// their target's path, never to walk out of the tree twice.
export function treeManifest(root, dirs) {
  const manifest = {}
  const walk = (relative) => {
    const absolute = join(root, relative)
    let entry
    try {
      entry = lstatSync(absolute)
    } catch {
      return
    }
    if (entry.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) walk(join(relative, name))
      return
    }
    if (!entry.isFile()) return
    manifest[relative.split(sep).join('/')] = sha256(readFileSync(absolute))
  }
  for (const dir of dirs) walk(dir)
  return manifest
}

// The paths whose bytes differ between two manifests of the same tree: changed, added, removed.
export function changedPaths(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...names].filter(name => before[name] !== after[name]).sort()
}

// An absolute path whose deepest existing ancestor was resolved through its real location. The
// guards compare paths a caller typed — a relative `--home`, a `$HOME` that is a symlink on macOS —
// so a lexical comparison can read a directory as outside the tree it actually sits in. A path that
// does not exist yet keeps its own name and resolves the ancestor that does.
export function canonicalPath(value, cwd = process.cwd()) {
  let current = resolve(cwd, value)
  const missing = []
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(cwd, value)
      missing.push(basename(current))
      current = parent
    }
  }
}

// `child` inside `parent` (or the same directory), compared as canonical paths: a relative value is
// resolved against `cwd`, and a symlinked or differently-cased existing segment cannot make a
// directory read as outside its parent.
export function isInside(child, parent, cwd = process.cwd()) {
  const clean = (value) => value.replace(/\/+$/, '')
  const a = clean(canonicalPath(child, cwd))
  const b = clean(canonicalPath(parent, cwd))
  return a === b || a.startsWith(`${b}${sep}`)
}

// Where a bench keeps its data (#398). A bench home inside this checkout hands the Bot under test
// the grader, the fixtures and the evidence the run is judged on, and the runner cannot take that
// workspace back once the bench starts — so the default is outside both the repository and `~/.dsh`,
// and a `LIVE_E2E_HOME` inside the checkout is refused rather than used. `LIVE_E2E_HOME` names the
// directory itself, so the same value goes to bench.mjs and run.mjs.
export function benchHome({ name, env = process.env, userHome = homedir(), root, cwd = process.cwd() }) {
  const home = canonicalPath(env.LIVE_E2E_HOME || join(userHome, '.cache', 'flybot-live-e2e', name), cwd)
  const problem = isInside(home, join(userHome, '.dsh'), cwd)
    ? `refusing to use ${home}: the bench never touches the user's own DSH data`
    : isInside(home, root, cwd)
      ? `the bench home ${home} is inside the checkout ${root}: the Bot under test would hold the grader (set LIVE_E2E_HOME outside the repository)`
      : undefined
  return { home, problem }
}
