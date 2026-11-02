// The chosen server is kept in `flybot-social-server.json`, written through
// `<file>.<pid>.tmp` and renamed into place. That temp name is a leaf like the file
// (temp-name sweep): a link left there would take the choice outside the team folder and the
// rename would put the link where the override belongs.
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServerController } from '../src/server-config.js'

const fly = () => ({
  bot: { list: () => [], get: () => undefined },
  fields: { get: () => undefined, set() {} },
  grants: { of: () => [], set: async () => {} },
  readOnly: () => false,
})

test('a linked server-override temp name does not take the choice; the file stays absent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-social-temp-'))
  const controller = createServerController({
    base: { server: 'https://a.test', credentialsPath: join(home, 'flybot-social.json'), displayName: 'Me' },
    flybot: fly(),
    probe: async server => ({ name: 'Bot Social', features: [], server }),
    start: async () => ({ home: { handle: '@me.home' }, dispose: () => {} }),
    startTimeoutMs: 20,
  })
  try {
    const outside = join(home, 'outside-server.json')
    writeFileSync(outside, 'OUTSIDE\n')
    symlinkSync(outside, join(home, `flybot-social-server.json.${process.pid}.tmp`))
    await assert.rejects(controller.set({ server: 'https://b.test', confirm: true }), /not a plain file/)
    assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE\n', 'the file behind the temp link is not written through')
    const override = join(home, 'flybot-social-server.json')
    assert.equal(existsSync(override) ? lstatSync(override).isSymbolicLink() : false, false, 'the override is not a link')
  } finally {
    controller.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
