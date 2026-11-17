// The public face of @flybot/plane (#3113): open one data dir, steer the instances recorded in
// it. The methods carry no authorization — that lives in the HTTP surface (`src/server.mjs`) —
// and no process handling — that lives in the lifecycle backend. `clock` is injectable so a
// later slice can test time without waiting for it. Every method is async so a caller can treat
// the plane uniformly, including the refusals: a backend seam that throws rejects the same way.
import { openStore } from './src/store.mjs'

export function createPlane({ dataDir, backend, clock = () => Date.now() } = {}) {
  if (!dataDir) throw new Error('dataDir is required')
  if (!backend) throw new Error('backend is required')
  const store = openStore(dataDir)

  const apply = async (id, report) => store.updateInstance(id, { ...report, at: clock() })

  return {
    store,
    async createInstance({ workspaceId, name }) {
      const { instance, controlToken } = store.createInstance({ workspaceId, name })
      await apply(instance.id, backend.create(instance, { controlToken }))
      return { instance: store.getInstance(instance.id), controlToken }
    },
    async startInstance(id) { return apply(id, backend.start(store.getInstance(id))) },
    async stopInstance(id) { return apply(id, backend.stop(store.getInstance(id))) },
    async getInstance(id) { return store.getInstance(id) },
    async listInstances({ ownerId } = {}) { return store.listInstances({ ownerId }) },
    // On the contract, not in this slice: they refuse loudly rather than succeed quietly.
    async upgradeInstance(id) { return apply(id, backend.upgrade(store.getInstance(id))) },
    async recycleInstance(id) { return apply(id, backend.recycle(store.getInstance(id))) },
  }
}
