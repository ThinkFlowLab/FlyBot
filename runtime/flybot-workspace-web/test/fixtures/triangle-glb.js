export function triangleGlb({byteLength = 36, customize = () => {}} = {}) {
  const model = {
    asset: {version: '2.0'}, scene: 0, scenes: [{nodes: [0]}], nodes: [{mesh: 0}],
    meshes: [{primitives: [{attributes: {POSITION: 0}}]}],
    buffers: [{byteLength}], bufferViews: [{buffer: 0, byteLength: 36, target: 34962}],
    accessors: [{bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0]}],
  }
  customize(model)
  const document = JSON.stringify(model)
  const jsonLength = Math.ceil(Buffer.byteLength(document) / 4) * 4
  const buffer = Buffer.alloc(28 + jsonLength + byteLength)
  buffer.write('glTF')
  buffer.writeUInt32LE(2, 4)
  buffer.writeUInt32LE(buffer.length, 8)
  buffer.writeUInt32LE(jsonLength, 12)
  buffer.write('JSON', 16)
  buffer.fill(0x20, 20, 20 + jsonLength)
  buffer.write(document, 20)
  buffer.writeUInt32LE(byteLength, 20 + jsonLength)
  buffer.write('BIN\x00', 24 + jsonLength)
  for (const [index, component] of [-1, -1, 0, 1, -1, 0, 0, 1, 0].entries()) buffer.writeFloatLE(component, 28 + jsonLength + index * 4)
  return buffer
}
