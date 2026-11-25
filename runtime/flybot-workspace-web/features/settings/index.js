// B4 settings feature: preferences, notification prefs (#284), onboarding and
// the Personal Agent look, executed and stored in this user's own DS-Bot.
// Endpoints: settings/<op> and settings/v1 (legacy /v1 compat, see lib/b4/compat.js).
import { compatHandler } from '../../lib/b4/compat.js'
import { importJsonBundles } from '../../lib/b4/importer.js'
import { createSettingsFeature, applyImport, IMPORT_TABLES } from './settings.js'

export const LEGACY_PATHS = ['/v1/settings', '/v1/notification-prefs', '/v1/onboarding', '/v1/onboarding/recommendations', '/v1/onboarding/picks', '/v1/onboarding/look', '/v1/onboarding/progress']

export default function settings(host) {
  const feature = createSettingsFeature({ dir: host.featureDir() })
  const spec = { name: 'settings', importTables: IMPORT_TABLES }
  const imported = importJsonBundles({ host, feature: spec, store: feature.store, apply: applyImport, log: host.log })
  return {
    imported,
    pages: ['settings', 'onboarding', 'look'],
    endpoints: { ...feature.endpoints, v1: compatHandler(feature.legacy) },
  }
}
