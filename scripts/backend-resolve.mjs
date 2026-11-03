// Linked source packages use the installed production profile's pinned DSH peers.
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = pathToFileURL(resolve(import.meta.dirname, '..')).href + '/'
const anchor = pathToFileURL(resolve(process.env.DSH_HOME, 'profiles/web/package.json')).href
registerHooks({ resolve(specifier, context, next) {
  return next(specifier, specifier.startsWith('@deepseek-ai/') && (context.parentURL?.startsWith(root + 'core/') || context.parentURL?.startsWith(root + 'plugins/'))
    ? { ...context, parentURL: anchor } : context)
} })
