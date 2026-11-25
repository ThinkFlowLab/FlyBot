// Apply the FlyBot integration to an image's copy of the pinned Apache-2.0
// DS-Bot source. Keep the upstream tree and pin in Git independently verifiable.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceDir = fileURLToPath(new URL('../ds-bot-upstream/ds-bot/', import.meta.url))
const patch = fileURLToPath(new URL('./native-ds-bot.patch', import.meta.url))
const files = {
  'src/host/connectors/index.js': [
    '1b5da94a41a8bb5f849e7f54eaab23f9da3aaa1ee27111e1c33f79f5ef9a2b24',
    'aae09738660a91ebdf8a64645bc6f16174bea715989e7638c170c6cc2d080bd8',
  ],
  'src/host/tools.js': [
    'a5c743b7c75c96498775808f029a5f15c7e08dbe6eaf33089d29b3c2a9ffb382',
    '852dafff886dd8625d98152afe85432b8a22648d3627df5b61eddba4cea8c510',
  ],
  'src/host/roster.js': [
    '20461d2d4aeae6ca373e3431a5802317d1130468e1940d22032189134429f984',
    '31c4ec4f68067b79ef2d4fc967e254e15b5854cbc1928eed831c725030dd77aa',
  ],
  'src/host/prompt.js': [
    'b15fd1dd8b046589533540b45388e6573e84fdf51bb09aa48a97e694c1e83c21',
    'ebf5a93da2ef5941e0417f4018635350cb251212c9eb9384671f2ef9a7bbc2b8',
  ],
  'client.js': [
    '98713d86c6cbf85adab1d0a2d303140778d9ed85fb2220abdadfab377a5f539f',
    '8e97d8e25cc1e04ec36f8b7449dc644e1d2d31ec5d6a8fe4071df35701806308',
  ],
  'src/client/at-menu.js': [
    'a0feee8fdb684324e7160f422c7930ec4ae032ef214d5d4651a7f6ede3c82124',
    'c140f61764159ffc74cd7a17f613b390411342d6cbd1f7cb692bf597f335ebe1',
  ],
  'src/client/group-settings.js': [
    '4f4aa19f4972f734c6fe8d71553a6c17386d9418bd84e56106ed4e48b9b7fdca',
    'fc8f1eb6ce8e3c7ad7f394acf4ebd9f03eb2d52bed4a6124ec5df455e08813cd',
  ],
  'src/client/i18n.js': [
    '6b9e5157267f10cf8cdb554a770c3672ae5dcfef722d4a3730c65ea8a18ab83c',
    'd5f4aefd4f6d957772cdb20b506dda63863607cb68718cab5225ed97e044d937',
  ],
  'src/client/new-chat.js': [
    '3f98f6db4cf84f6a9ad9aaef9228a6332970e0ce5bfa1533cda100faf570bf06',
    '2e6d3e0a338060187d3192de46d93174fe66178f7c017188f5ed406055d1744c',
  ],
  'src/client/team-actions.js': [
    '90f2dd67f80cea35d08c0a8553891b03e44cab5929130d364bbff87c9a1389dd',
    '34f13ac9fd88cec1dc7cdf198ae6c8ba0016535a320260b4e8e125f7d03aa23f',
  ],
  'src/host/groups.js': [
    '06c261868b55ee7cdc53dc3b98759779c1d0e5cd60ad6f39beeca24458e7a91c',
    'a5efc51b8918346177a3058dc7613b99198ebdc99fed1b72036b7de36d2e1032',
  ],
  'src/host/capabilities.js': [
    '656fcc0b0fb7fd597dfd0f62bd49522d92becd4ed1c77dd53ba016f045614c89',
    'bff22001141ec0ea02714a2e440575adf7d863a036eb91f487f3f7725046349c',
  ],
  'src/host/channel.js': [
    '34b2a23af48a7c90984cca4050d3187816a9873fd513005cfb4663a6b8a33cb8',
    'c0a55a31890b8fbf7d6b003a65ec4b02b62a16d8c7ce70f591472c454771559e',
  ],
  'src/host/bot-tasks.js': [
    '07701ae804298f68aa54f6fb8d69c7b98b4b99afd059d81d107d320bdc593e7e',
    '14699f0e118a262125719294af57913e9f1e19a6ac16c454eb517abbe426bb62',
  ],
  'src/host/parts.js': [
    'd0c762e46a00d053220eda242efaf503d24e15dbcff65ea6ac39c42f3d5234a6',
    'ea7ca0a5bd1b60db291c4a555dc0694d089b4a3a4fb04a916b63ee0c480af924',
  ],
  'src/host/store.js': [
    '6494f21fe71c208d246d56947680fdcbe55b77546c12bdf1da240854e0d5a504',
    'f8f9577be60330c904b446ec7491c03ac542b97ed6fb11f52d424d2b05c03d79',
  ],
  'src/host/threads.js': [
    'e93710eacf98a2e86c74bd768f55590f1ac9af98748e4dc74148e5bc5b6e90e0',
    '478a5ce3ae57d30c3e7af48c05c719ba7c9d3b779edac3f5723db84a9f156e35',
  ],
}

const digest = (root, path) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex')

export function applyNativeOverlay(root) {
  const observed = Object.entries(files).map(([path, [upstream, deployed]]) => ({
    path, upstream, deployed, bytes: digest(root, path),
  }))
  if (observed.every(file => file.bytes === file.deployed)) return
  const invalid = observed.find(file => file.bytes !== file.upstream)
  if (invalid) throw new Error(`Unexpected pinned DS-Bot source: ${invalid.path}`)
  execFileSync('git', ['apply', '--check', patch], { cwd: root, stdio: 'inherit' })
  execFileSync('git', ['apply', patch], { cwd: root, stdio: 'inherit' })
  for (const { path, deployed } of observed) {
    if (digest(root, path) !== deployed) throw new Error(`Unexpected DS-Bot overlay result: ${path}`)
  }
}

export function assertNativeConsentOverlay(root = sourceDir) {
  const path = 'src/host/capabilities.js'
  if (digest(root, path) !== files[path][1]) {
    throw new Error('Build the FlyBot image to load the FlyBot native skill consent integration')
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error('Pass the image build copy of the DS-Bot source directory')
  applyNativeOverlay(resolve(process.argv[2]))
}
