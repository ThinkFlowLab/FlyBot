import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle'
const PATCH = fileURLToPath(new URL('./meeting-speech.patch.yml', import.meta.url))

export function withSpeechOverlay(args, home) {
  const flag = args.indexOf('--profile')
  if (!home || flag < 0 || args[flag + 1] !== 'web') return args
  const filename = join(home, 'profiles', 'web', 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(filename, 'utf8'))
  } catch {
    // Profile handling belongs to DSH. Do not change how an unreadable profile boots.
    return args
  }
  const bundles = manifest?.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(BUNDLE)) return args
  return [...args.slice(0, flag + 2), '--patch', PATCH, ...args.slice(flag + 2)]
}
