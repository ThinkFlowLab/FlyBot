// Checks that the release tag version is allowed to ship:
// - core/package.json's version equals the tag (normal releases), or
// - the tag is an allowlisted product tag and CHANGELOG.md's section for it
//   documents the current core package version (the product cut pins core).
// Usage: node .github/scripts/check-release-version.mjs <version>   (run from the repo root)
import { readFileSync } from 'node:fs'

const PRODUCT_TAGS = ['0.1.0']

const version = process.argv[2]
if (!version) { console.error('usage: check-release-version.mjs <version>'); process.exit(1) }

const have = JSON.parse(readFileSync('core/package.json', 'utf8')).version
const fail = () => { console.error(`core/package.json is ${have}, tag is v${version}`); process.exit(1) }

if (have === version) process.exit(0)
if (!PRODUCT_TAGS.includes(version)) fail()

const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n')
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`))
if (start < 0) fail()
const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
const section = lines.slice(start, end < 0 ? undefined : end).join('\n')
if (!section.includes(have)) fail()

console.log(`product tag v${version}: CHANGELOG documents core ${have}, core/package.json unchanged`)
