// Tool definitions as the model sees them. A strict OpenAI-compatible gateway reads an object
// node's missing `properties` or `required` as null and rejects the whole chat request
// ("null is not of type \"object\"" / "null is not of type \"array\""), so one argument-less
// tool would poison every turn. DSH's schema compiler leaves both members out when they are
// empty, and FlyBot cannot change that; it completes the compiled schema on its own side, once,
// for every tool it registers.
import { defineTool as dshDefineTool } from '@deepseek-ai/dsh-tools'

const SCHEMA_MAPS = ['properties', 'patternProperties', 'definitions', '$defs']
const SCHEMA_VALUES = ['items', 'additionalProperties', 'not', 'contains', 'propertyNames']
const SCHEMA_LISTS = ['oneOf', 'anyOf', 'allOf', 'prefixItems']

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Fills `properties: {}` and `required: []` on every object node, through every keyword that can
// hold a schema, and returns a new tree so a caller's definition is never mutated in place.
export function explicitObjectShape(schema) {
  if (!isRecord(schema)) return schema
  const out = { ...schema }
  for (const key of SCHEMA_MAPS) {
    if (!isRecord(schema[key])) continue
    out[key] = Object.fromEntries(Object.entries(schema[key]).map(([name, child]) => [name, explicitObjectShape(child)]))
  }
  for (const key of SCHEMA_VALUES) {
    if (isRecord(schema[key])) out[key] = explicitObjectShape(schema[key])
  }
  for (const key of SCHEMA_LISTS) {
    if (Array.isArray(schema[key])) out[key] = schema[key].map(explicitObjectShape)
  }
  if (out.type === 'object') {
    out.properties ??= {}
    out.required ??= []
  }
  return out
}

// DSH's defineTool, with the parameters completed for the model. Argument validation keeps
// using the schema DSH compiled, so only the wire shape changes.
export function defineTool(options) {
  const tool = dshDefineTool(options)
  tool.parameters = explicitObjectShape(tool.parameters)
  return tool
}
