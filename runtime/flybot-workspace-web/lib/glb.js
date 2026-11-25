// Read the self-contained subset of glTF used by generated models. This
// parser also runs in the browser before the renderer receives any bytes.
export const GLB_MIME = 'model/gltf-binary'
export const MAX_GLB_BYTES = 8 * 1024 * 1024
const MAX_JSON_BYTES = 512 * 1024
const GLB_MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942
const EMBEDDED_IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const COMPONENTS = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16}

const indexIn = (value, list) => Number.isInteger(value) && value >= 0 && value < list.length
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function validateScene(document, meshes) {
  const {nodes, scenes, scene = 0} = document
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 1024 ||
      !Array.isArray(scenes) || !indexIn(scene, scenes)) return false
  const children = new Set()
  for (const node of nodes) {
    if (!record(node) || (node.mesh !== undefined && !indexIn(node.mesh, meshes))) return false
    if (node.children === undefined) continue
    if (!Array.isArray(node.children)) return false
    for (const child of node.children) {
      if (!indexIn(child, nodes) || children.has(child)) return false
      children.add(child)
    }
  }
  // glTF nodes form a forest. A cycle would have no independent root.
  const visited = new Set()
  const pending = nodes.flatMap((_node, id) => children.has(id) ? [] : [{id, depth: 0}])
  while (pending.length) {
    const {id, depth} = pending.pop()
    if (depth > 64 || visited.has(id)) return false
    visited.add(id)
    for (const child of nodes[id].children ?? []) pending.push({id: child, depth: depth + 1})
  }
  if (visited.size !== nodes.length) return false
  return scenes.every(item => Array.isArray(item?.nodes) &&
    new Set(item.nodes).size === item.nodes.length &&
    item.nodes.every(id => indexIn(id, nodes) && !children.has(id)))
}

export function parseGlb(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 28 || bytes.byteLength > MAX_GLB_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.byteLength) return null
  const jsonLength = view.getUint32(12, true)
  const binaryHeader = 20 + jsonLength
  if (view.getUint32(16, true) !== JSON_CHUNK || jsonLength > MAX_JSON_BYTES ||
      jsonLength % 4 !== 0 || binaryHeader + 8 > bytes.byteLength ||
      view.getUint32(binaryHeader + 4, true) !== BIN_CHUNK) return null
  const binaryLength = view.getUint32(binaryHeader, true)
  if (binaryLength % 4 !== 0 || binaryHeader + 8 + binaryLength !== bytes.byteLength) return null
  let document
  try {
    document = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(20, binaryHeader)))
  } catch { return null }
  if (document?.asset?.version !== '2.0' ||
      (document.asset.minVersion && document.asset.minVersion !== '2.0')) return null
  const {buffers, bufferViews, accessors, meshes, images = []} = document
  const buffer = buffers?.[0]
  if (!Array.isArray(buffers) || buffers.length !== 1 || !record(buffer) || buffer.uri !== undefined ||
      !Number.isInteger(buffer.byteLength) || buffer.byteLength < 1 ||
      binaryLength < buffer.byteLength || binaryLength - buffer.byteLength > 3) return null
  if (!Array.isArray(bufferViews) || !bufferViews.length || !bufferViews.every(entry => {
    const start = entry?.byteOffset ?? 0
    return entry?.buffer === 0 && Number.isInteger(start) && start >= 0 &&
      Number.isInteger(entry.byteLength) && entry.byteLength > 0 && start + entry.byteLength <= buffer.byteLength
  })) return null
  let components = 0
  if (!Array.isArray(accessors) || !accessors.length || !accessors.every(entry => {
    const count = entry?.count
    const width = Object.hasOwn(COMPONENTS, entry?.type) ? COMPONENTS[entry.type] : 0
    if (!width || !Number.isInteger(count) || count < 1 || count > 500_000) return false
    components += width * count
    return components <= 4_000_000 && (entry.bufferView === undefined || indexIn(entry.bufferView, bufferViews))
  })) return null
  if (!Array.isArray(images) || images.length > 16 || !images.every(image =>
    image?.uri === undefined && indexIn(image?.bufferView, bufferViews) && EMBEDDED_IMAGES.has(image.mimeType)
  )) return null
  if (!Array.isArray(meshes) || !meshes.length || meshes.length > 256 || !meshes.every(mesh =>
    Array.isArray(mesh?.primitives) && mesh.primitives.length && mesh.primitives.length <= 64 &&
    mesh.primitives.every(primitive => indexIn(primitive?.attributes?.POSITION, accessors))
  )) return null
  return validateScene(document, meshes) ? document : null
}

export const validGlb = bytes => parseGlb(bytes) !== null
