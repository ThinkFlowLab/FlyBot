// The memory panel has two causes it used to spell the same way (#2101): a folder with nothing in it
// yet, and a folder the host refused to read. The empty state is answered by `memoryEmptyNotice`;
// the list itself cannot be, because `entries` is own and team merged and one scope's entries would
// silence the other scope's refusal — `memoryBlockedNotice` answers there, reading only `blocked`
// (one `{ scope, path }` per refused scope). Both share the path collection, so the two lines cannot
// drift. Pure, so they are tested without a renderer, like `bot-row-title` and the board rows.
import { t } from './i18n.js'

const blockedPaths = (view) => [...new Set((view?.blocked ?? [])
  .map(item => (typeof item?.path === 'string' ? item.path : ''))
  .filter(path => path !== ''))]

const blockedSentence = (paths) => t('The memory folder {path} is not a plain directory, so it cannot be read.', { path: paths.join(', ') })

export function memoryEmptyNotice(view) {
  if ((view?.entries?.length ?? 0) > 0) return null
  return memoryBlockedNotice(view)
}

export function memoryBlockedNotice(view) {
  const paths = blockedPaths(view)
  if (paths.length === 0) return null
  return blockedSentence(paths)
}
