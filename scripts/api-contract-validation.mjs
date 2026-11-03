// Dependency-free test validator for the intentionally limited JSON Schema vocabulary
// emitted here. Independent full OpenAPI/2020-12 validation is also documented.
// This helper is not a runtime authorization/input-validation middleware.
import { readFileSync } from 'node:fs'
import { artifactPath } from './openapi.mjs'
export const readSpec = () => JSON.parse(readFileSync(artifactPath, 'utf8'))
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export function validate(schema, value, spec, path = '$') {
  const fail = message => { throw new Error(`${path}: ${message}`) }
  if (schema === true) return
  if (schema === false) return fail('forbidden schema')
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/components/schemas/')) return fail('unsupported reference')
    const target = spec.components.schemas[schema.$ref.split('/').at(-1)]
    if (!target) return fail('unresolved schema')
    return validate(target, value, spec, path)
  }
  const matches = row => { try { validate(row, value, spec, path); return true } catch { return false } }
  if (schema.anyOf && !schema.anyOf.some(matches)) {
    const reasons = schema.anyOf.map(row => { try { validate(row, value, spec, path); return 'matched' } catch (error) { return error.message } })
    return fail(`no anyOf branch matched (${reasons.join('; ')})`)
  }
  if (schema.oneOf && schema.oneOf.filter(matches).length !== 1) return fail('expected exactly one oneOf branch')
  for (const row of schema.allOf ?? []) validate(row, value, spec, path)
  if (schema.if) validate(matches(schema.if) ? schema.then ?? true : schema.else ?? true, value, spec, path)
  if (schema.not && matches(schema.not)) return fail('matched excluded schema')
  if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) return fail('const differs')
  if (schema.enum && !schema.enum.some(item => equal(value, item))) return fail('enum differs')
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (schema.type && ![schema.type].flat().some(t => t === type || t === 'integer' && Number.isSafeInteger(value))) return fail(`expected ${schema.type}, received ${type}`)
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength || schema.maxLength !== undefined && [...value].length > schema.maxLength) return fail('string length out of bounds')
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return fail('pattern differs')
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum || schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return fail('number out of bounds')
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return fail('array length out of bounds')
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return fail('duplicate items')
    value.forEach((item, index) => schema.items && validate(schema.items, item, spec, `${path}[${index}]`))
  }
  if (type === 'object') {
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) return fail(`missing required ${name}`)
    for (const [name, item] of Object.entries(value)) {
      const declared = schema.properties?.[name]
      if (declared) validate(declared, item, spec, `${path}.${name}`)
      else if (schema.additionalProperties === false) return fail(`unknown property ${name}`)
      else if (typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, item, spec, `${path}.${name}`)
    }
  }
}
export function operationFor(spec, endpoint, payload = {}) {
  const id = endpoint === 'project-development' ? `development.${payload.kind}.${payload.name}` : ['personal-space', 'project-workflow'].includes(endpoint) ? `${endpoint}.${payload.operation ?? (endpoint === 'personal-space' ? 'list' : 'state')}` : endpoint
  const operation = spec['x-flybot-operations'].find(row => row.operationId === id)
  if (!operation) throw new Error(`Unspecified public operation ${id}`)
  return operation
}
export function validateExchange(spec, endpoint, payload, envelope) {
  const operation = operationFor(spec, endpoint, payload)
  // Canonical clients spell out the two native default operation selectors.
  const canonical = ['personal-space', 'project-workflow'].includes(endpoint) && payload.operation === undefined ? { ...payload, operation: endpoint === 'personal-space' ? 'list' : 'state' } : payload
  validate(operation.requestSchema, { endpoint, payload: canonical }, spec, `${operation.operationId}.request`)
  validate(envelope.ok ? operation.successSchema : operation.errorSchema, envelope, spec, `${operation.operationId}.response`)
}
