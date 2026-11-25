// B4 model-api feature: the account model settings drive this user's DS-Bot
// through the #379 loopback model proxy (in-process override, no key in
// DS-Bot settings, env or responses). Endpoints: model-api/get, model-api/save,
// model-api/v1 (legacy /v1/model-api compat). Workspace-scope model settings
// stay on the platform with teams (phase C).
import { join } from 'node:path'
import { compatHandler } from '../../lib/b4/compat.js'
import { loadSealKey, loadImportSealKey } from '../../lib/b4/seal.js'
import { importJsonBundles } from '../../lib/b4/importer.js'
import { createModelApi, importApplier, IMPORT_TABLES, OVERRIDE } from './model-api.js'

export default function modelApi(host) {
  const dir = host.featureDir()
  const sealKey = loadSealKey({ fallbackFile: join(dir, 'seal.key'), preferFallback: true })
  const api = createModelApi({ dir, sealKey })
  const imported = importJsonBundles({ host, feature: { name: 'model-api', importTables: IMPORT_TABLES }, store: api.store, sealKey: loadImportSealKey(), apply: importApplier(sealKey), log: host.log })
  globalThis[OVERRIDE] = () => api.resolveForProxy()
  return {
    imported,
    pages: ['settings'],
    endpoints: {
      get: async () => api.get(),
      save: async payload => api.save(payload),
      imageProvider: async (_payload,call) => {
        if (!call?.internal) throw Object.assign(new Error('Internal endpoint'),{code:'model-api/not-found'})
        return api.resolveImage()
      },
      videoProvider: async (_payload, call) => {
        if (!call?.internal) throw Object.assign(new Error('Internal endpoint'), {code: 'model-api/not-found'})
        return api.resolveVideo()
      },
      musicProvider: async (_payload, call) => {
        if (!call?.internal) throw Object.assign(new Error('Internal endpoint'), {code: 'model-api/not-found'})
        return api.resolveMusic()
      },
      model3dProvider: async (_payload, call) => {
        if (!call?.internal) throw Object.assign(new Error('Internal endpoint'), {code: 'model-api/not-found'})
        return api.resolveModel3d()
      },
      v1: compatHandler(api.legacy),
    },
  }
}
