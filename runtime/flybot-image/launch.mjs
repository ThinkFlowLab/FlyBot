// Last step of the image entrypoint: validate the operator model API secret,
// then exec dsh. The key is never exported into DSH's environment: DS-Bot reaches
// the model only through the in-plugin loopback proxy (ds-bot-bridge.mjs), which
// reads the secret file itself. The management task loop also runs in-plugin.
import { spawn } from 'node:child_process'
import { applyModelApi, loadModelApi, ModelApiError, redact } from './model-api.js'
import { withSpeechOverlay } from './speech-overlay.mjs'

try {
  const config = loadModelApi(process.env)
  // Validate and log only; a scratch env keeps provider credentials out of dsh.
  if (config) {
    applyModelApi(config, {}, { info: (msg) => console.error(msg) })
    if (config.api_key_env) delete process.env[config.api_key_env]
  }
  else console.error('model API: no secret file; start without a provider key (operator must supply one)')
} catch (error) {
  const message = error instanceof ModelApiError ? error.message : 'model API could not be loaded'
  console.error(`entrypoint: ${message}`)
  if (!(error instanceof ModelApiError) && error?.message) {
    console.error(redact(String(error.message)))
  }
  process.exit(1)
}

const args = withSpeechOverlay(process.argv.slice(2), process.env.DSH_HOME)
const child = spawn('dsh', args, { stdio: 'inherit', env: process.env })
const forward = (signal) => {
  try { child.kill(signal) } catch { /* child already gone */ }
}
process.on('SIGTERM', () => forward('SIGTERM'))
process.on('SIGINT', () => forward('SIGINT'))
child.on('error', (error) => {
  console.error('entrypoint: failed to start dsh:', error.message)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.exit(1)
  process.exit(code ?? 1)
})
