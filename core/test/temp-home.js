import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'

// A test's temp home is removed once, and only after the writers that fill it have been stopped
// and awaited: the Feishu dial closes and the diagnostics log's last append drains inside
// `ctx.dispose()` (#1983), so the removal that follows it has nothing left to race.
//
// No retries on purpose. A retry loop that gives up quietly turns `ENOTEMPTY` — the one signal
// that a writer was still live — into a green test, and a loop that keeps retrying only moves the
// same failure to a busier machine. The assertion after the removal makes "the directory is gone"
// the contract: a remover that returns without freeing the path fails the test rather than being
// taken on trust.
export function cleanHome(home, { remove = rmSync, exists = existsSync } = {}) {
  remove(home, { recursive: true, force: true })
  assert.equal(exists(home), false, `the test home ${home} was still there after teardown`)
}
