import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sizeLabel } from '../src/social.js'

// #1782: just under a MiB the KB branch rounded to "1024.0 KB". The unit is chosen from the
// rounded KB figure, so a size that rounds to 1024 KB is printed as MB instead.
test('#1782: a size that rounds to 1024 KB rolls over to MB', () => {
  assert.equal(sizeLabel(1_048_570), '1.0 MB')
  assert.equal(sizeLabel(1_048_575), '1.0 MB')
})

test('#1782: the MB boundary and ordinary sizes keep their unit', () => {
  assert.equal(sizeLabel(1_048_576), '1.0 MB')
  assert.equal(sizeLabel(1_048_000), '1023.4 KB')
  assert.equal(sizeLabel(1023), '1023 B')
  assert.equal(sizeLabel(3_145_728), '3.0 MB')
})
