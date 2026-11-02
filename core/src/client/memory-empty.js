// The empty state of the memory panel has two causes the view used to spell the same way (#2101): a
// folder with nothing in it yet, and a folder the host refused to read. `entries` is `[]` in both,
// so the view carries `blocked` — one `{ scope, path }` per refused scope — and this turns it into
// one line above the empty title, or `null` for the ordinary empty view. Pure, so it is tested
// without a renderer, like `bot-row-title` and the board rows.
import { t } from './i18n.js'

export function memoryEmptyNotice(view) {
  if ((view?.entries?.length ?? 0) > 0) return null
  const paths = [...new Set((view?.blocked ?? [])
    .map(item => (typeof item?.path === 'string' ? item.path : ''))
    .filter(path => path !== ''))]
  if (paths.length === 0) return null
  return t('The memory folder {path} is not a plain directory, so it cannot be read.', { path: paths.join(', ') })
}
