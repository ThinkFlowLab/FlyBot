// Prepares the DSH `web` profile inside the FlyBot container (#352). The profile lives on the
// data volume ($DSH_HOME/profiles/web), so your settings (cordis.patch.yml) and any plugin you
// added yourself survive an image upgrade. The FlyBot packages are not copied into it: each
// start links them to the code baked into the image, so a new image is a new FlyBot.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// What `dsh plugin --profile web add` writes for a new web profile.
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const WORKSPACE_YAML = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

/** The FlyBot packages unpacked in the image: [{ name, dir }], sorted by name. */
export function imagePackages(packagesDir) {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json')))
    .map((entry) => ({ name: JSON.parse(readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8')).name, dir: join(packagesDir, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The profile manifest with every image package linked and listed as a bundle. Other
 * dependencies and bundles are kept as they are; a FlyBot package that is already a bundle
 * keeps its place.
 * @param manifest - the current profile package.json, or undefined for a new profile.
 * @param packages - from imagePackages().
 */
export function linkPackages(manifest, packages) {
  const next = structuredClone(manifest ?? { name: 'dsh-profile-web', private: true })
  next.dependencies = { ...next.dependencies }
  for (const { name, dir } of packages) next.dependencies[name] = `link:${dir}`
  next.dsh = { ...next.dsh, profile: { ...next.dsh?.profile } }
  const bundles = [...(next.dsh.profile.bundles ?? BASE_BUNDLES)]
  for (const { name } of packages) if (!bundles.includes(name)) bundles.push(name)
  next.dsh.profile.bundles = bundles
  return next
}

/** Writes the profile files; returns the profile directory. */
export function prepareProfile(dshHome, packagesDir) {
  const dir = join(dshHome, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  const current = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined
  writeFileSync(manifestPath, JSON.stringify(linkPackages(current, imagePackages(packagesDir)), null, 2) + '\n')
  const workspace = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspace)) writeFileSync(workspace, WORKSPACE_YAML)
  return dir
}
