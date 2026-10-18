// Automation tasks on by default. DSH 0.2 ships the schedule service as an optional bundle
// (`@deepseek-ai/dsh-experimental-schedule-bundle`) that its plugin manager offers switched off,
// and without it Settings → Scheduled tasks has no service to talk to (see schedules.js).
// DSH keeps that choice in the profile, which FlyBot must not edit by hand, so the first time a
// profile runs FlyBot, FlyBot asks the plugin manager to switch the bundle on and writes the
// offer down in `dsh-defaults.json` next to the team. From then on the profile decides: a person
// who switches Automation tasks off on the Plugins page keeps it off across restarts and updates.
// A DSH that does not offer the bundle is left alone, and so is a second dsh on the same data.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const SCHEDULE_BUNDLE = '@deepseek-ai/dsh-experimental-schedule-bundle'
const MARKER = 'dsh-defaults.json'
// DSH is still composing its tree in the first seconds; the manager reloads it live afterwards.
const STARTUP_DELAY_MS = 20_000

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// The offers made so far, `{ [bundle]: { [profile]: ISO time } }`. A file that exists but cannot
// be read is an unknown history, which must never read as "not offered yet".
export async function readOffers(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
  const parsed = JSON.parse(text)
  if (!isRecord(parsed) || (parsed.offers !== undefined && !isRecord(parsed.offers))) throw new Error(`${file} is not a FlyBot defaults file`)
  return parsed.offers ?? {}
}

async function writeOffers(file, offers) {
  await mkdir(join(file, '..'), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify({ version: 1, offers }, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => { /* never written: the write error is the one to report */ })
    throw error
  }
}

// Switches the bundle on once per profile. Returns what happened, for the log and the tests:
//   'decided'     already offered here; the profile is the person's now
//   'unavailable' this DSH does not offer the bundle (or has no plugin manager); tried again at the next start
//   'already-on'  on already (switched on by hand); noted, so a later "off" is respected
//   'unrecorded'  the offer could not be written down, so nothing was changed
//   'enabled'     switched on
//   'failed'      the manager refused; the note is withdrawn so the next start tries again
export async function offerBundle({ manager, bundle = SCHEDULE_BUNDLE, profile, file, now = () => new Date() }) {
  let offers
  try {
    offers = await readOffers(file)
  } catch {
    return 'unrecorded'
  }
  if (offers[bundle]?.[profile] !== undefined) return 'decided'
  if (typeof manager?.listBundles !== 'function' || typeof manager.setBundleEnabled !== 'function') return 'unavailable'
  const listed = await manager.listBundles()
  const entry = Array.isArray(listed) ? listed.find(item => item?.name === bundle) : undefined
  if (entry === undefined || entry.error !== undefined) return 'unavailable'
  const note = async (value) => {
    const next = { ...offers, [bundle]: { ...offers[bundle] } }
    if (value === undefined) delete next[bundle][profile]
    else next[bundle][profile] = value
    await writeOffers(file, next)
  }
  try {
    await note(now().toISOString())
  } catch {
    return 'unrecorded'
  }
  if (entry.enabled === true) return 'already-on'
  const result = await manager.setBundleEnabled(bundle, true).catch(error => ({ error: { code: 'operation-error', diagnostic: String(error?.message ?? error) } }))
  if (result?.error !== undefined || result?.application === 'failed') {
    await note(undefined).catch(() => { /* best effort: a note that stays only means this profile is not asked again */ })
    return 'failed'
  }
  return 'enabled'
}

export function install(rt) {
  const { ctx, config, home } = rt
  if (config.automationTasks === false) return

  async function run() {
    await rt.load()
    // The window that shows the team without owning it leaves the profile to the other one.
    if (rt.readOnly() !== undefined) return
    const profile = ctx.get?.('profileContext')?.name ?? 'default'
    const outcome = await offerBundle({ manager: ctx.get?.('pluginManager'), profile, file: join(home, MARKER) })
    if (outcome === 'failed') rt.warn('ds-bot: could not switch on Automation tasks; switch them on from the Plugins page')
  }

  ctx.effect(() => {
    const timer = setTimeout(() => { run().catch(error => rt.warn('ds-bot: Automation tasks default: %s', error?.message ?? error)) }, STARTUP_DELAY_MS)
    // A pending first offer never keeps the process alive.
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'ds-bot: automation tasks default')

  rt.offerAutomationTasks = run
}
