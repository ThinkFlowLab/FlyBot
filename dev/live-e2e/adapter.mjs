// The FlyBot web adapter for the #204 scenarios: the only file in this suite that knows
// FlyBot's UI (docs/interop/live-e2e-adapter.md is the contract it implements; Orbit
// implements its own). Tasks go through the browser — the composer input for uploads,
// typing for messages, clicks for previews — while observation uses the app's own state
// API from inside the page and the run's storage on disk. Picking the Main Bot's model
// before the first task is environment setup, not a task step, and goes through the same
// in-page API like dev/memory-e2e.mjs does.
//
// playwright-core comes from the deepseek-harness checkout through the existing helper in
// core/dev/desktop-linux/lib.mjs (this repo installs no browser tooling). Chrome:
// CHROME_BIN, else google-chrome / chromium / chromium-browser on PATH, else playwright's
// own download. The login URL in web.log is used once and never printed.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { playwright, waitTeam } from '../../core/dev/desktop-linux/lib.mjs'

export class AdapterError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AdapterError'
  }
}

const findChrome = () => {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() } catch {}
  }
  return undefined
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

// The run's storage lookup: the newest file with the name under the bench home, outside
// the profile, caches and screenshots. Uploads and artifacts both land there.
function findInHome(home, name) {
  let best
  const skip = new Set(['profiles', 'node_modules', 'cache', 'logs', 'shots'])
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path, depth + 1); continue }
      if (entry.name !== name) continue
      const mtime = statSync(path).mtimeMs
      if (!best || mtime > best.mtime) best = { path, mtime }
    }
  }
  walk(home, 0)
  return best?.path
}

export async function openFlyBotWeb({ harness, home, port, model, outDir, quietMs, checkMs }) {
  if (!existsSync(join(home, 'web.log'))) throw new AdapterError(`no web.log in ${home}; is the bench running?`)
  const login = readFileSync(join(home, 'web.log'), 'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
  if (!login) throw new AdapterError(`no login URL in ${home}/web.log`)

  const { chromium } = playwright(harness)
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true }).catch(error => { throw new AdapterError(`Chrome did not launch (${error.message}); set CHROME_BIN`) })
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } })
  await page.goto(login)
  // dsh shows a preview notice once per profile; clear it before any click.
  const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue' })
  await page.addLocatorHandler(notice, () => notice.click())
  await waitTeam(page)

  const api = async (endpoint, payload = {}) => {
    const result = await page.evaluate(([e, p]) => fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: e, payload: p }) }).then(r => r.json()), [endpoint, payload])
    if (!result.ok) throw new AdapterError(`${endpoint}: ${result.error?.message ?? JSON.stringify(result)}`)
    return result.value
  }

  // Setup: put the Main Bot on the asked model. A fresh team holds its greeting until
  // then; the model card flow stays covered by the mock suites.
  const view = await api('state')
  const chief = view.bots.find(bot => bot.id === (view.mainBotId ?? view.mainBotIds?.[0]))
  if (!chief) throw new AdapterError(`no Main Bot in a fresh team (${view.bots?.length ?? 0} bots)`)
  const models = (await api('models')).models ?? view.models ?? []
  const ref = models.find(candidate => candidate.ref === model || candidate.ref.endsWith(`/${model}`))?.ref
    ?? models.find(candidate => candidate.ref?.includes(model))?.ref
  if (!ref) throw new AdapterError(`model ${model} is not offered; available: ${models.map(candidate => candidate.ref).join(', ') || 'none'}`)
  if (chief.model !== ref) await api('update-bot', { id: chief.id, model: ref })
  await page.locator(`.bt-tile[data-bot-id="${chief.id}"]`).first().click()
  await page.waitForTimeout(800)
  const sent = []

  const screenshot = async name => { await page.screenshot({ path: join(outDir, `${String(screenshot.index = (screenshot.index ?? 0) + 1).padStart(2, '0')}-${name}.png`) }) }

  // Quiet: no Bot busy and no memory review running, for quietMs, within checkMs.
  async function settle(timeoutMs = checkMs) {
    const deadline = Date.now() + timeoutMs
    let since = Date.now()
    for (;;) {
      await sleep(800)
      const current = await api('state')
      const busy = Object.keys(current.activity ?? {}).length > 0 || (current.memoryReviews ?? 0) > 0
      if (busy) since = Date.now()
      else if (Date.now() - since >= quietMs) return
      if (Date.now() >= deadline) throw new AdapterError(`the team did not settle within ${timeoutMs} ms`)
    }
  }

  return {
    modelId: ref,
    page,
    async uploadFile(name, bytes) {
      const input = page.locator('[data-composer-card] input[type=file]').last()
      await input.setInputFiles({ name, mimeType: 'text/csv', buffer: bytes })
      await page.waitForTimeout(600)
    },
    async sendTask(text) {
      sent.push(text)
      const box = page.locator('[contenteditable="true"], textarea').last()
      await box.click()
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
    },
    settle,
    async deliveredFileNames() {
      return page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-presented-files-row]')].map(node => node.textContent)
        const chips = [...document.querySelectorAll('code')].map(node => node.textContent ?? '').filter(text => /\.json$/i.test(text.trim()))
        return [...rows, ...chips.map(text => text.trim())]
      })
    },
    async readFile(name) {
      const path = findInHome(home, name)
      return path === undefined ? undefined : readFileSync(path)
    },
    async openPreview(name) {
      const target = page.locator(`[data-presented-files-row]`).filter({ hasText: name }).last()
      const chip = page.locator('code').filter({ hasText: name }).last()
      const clickable = (await target.count()) > 0 ? target : chip
      if ((await clickable.count()) === 0) throw new AdapterError(`nothing in the chat opens ${name}`)
      await clickable.click()
      await page.waitForTimeout(1500)
      const text = await page.evaluate(() => document.querySelector('[data-slot="sidebar.right"]')?.innerText
        ?? [...document.querySelectorAll('aside')].map(node => node.innerText).sort((a, b) => b.length - a.length)[0]
        ?? '')
      if (!text.trim()) throw new AdapterError(`clicking ${name} opened no preview`)
      return text
    },
    async reload() {
      await page.reload({ waitUntil: 'load' })
      await waitTeam(page)
      await page.locator(`.bt-tile[data-bot-id="${chief.id}"]`).first().click()
      await page.waitForTimeout(1200)
    },
    // Who said what is app-specific to render; for the scenarios it is enough that the
    // task texts are still visible and that some reply beside them is.
    async conversationLines() {
      const text = await page.evaluate(() => document.body.innerText)
      const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
      return lines.map(line => ({ who: sent.some(task => task.slice(0, 24) && line.includes(task.slice(0, 24))) ? 'user' : 'app', text: line }))
    },
    screenshot,
    async close() { await browser.close().catch(() => {}) },
  }
}
