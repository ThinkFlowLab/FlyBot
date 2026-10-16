import { MAX_NAME_LENGTH } from './limits.js' // = ds-bot roster's 40-character name truncation
// Model tools. The caller comes from the tool context ({ botId }), never from arguments,
// so a bot can only create children under itself. Visible to every tree member (#16 Option B:
// not Main/root-only). maxChildren and depth stay in createChild; a new child is not granted.
// tools.register keeps only type/description/enum/items from JSON Schema (minLength/maxLength
// are dropped), so every execute() validates its own arguments with validateArgs().

/** Returns null when args satisfy the schema's required/type/minLength/maxLength, else a reason. */
export function validateArgs(schema, args) {
  const a = args && typeof args === 'object' ? args : {}
  for (const key of schema.required ?? []) if (a[key] === undefined || a[key] === null) return `${key} is required`
  for (const [key, s] of Object.entries(schema.properties ?? {})) {
    const v = a[key]
    if (v === undefined || v === null) continue
    if (s.type === 'string') {
      if (typeof v !== 'string') return `${key} must be a string`
      const n = v.trim().length
      if (Number.isInteger(s.minLength) && n < s.minLength) return `${key} must be at least ${s.minLength} characters`
      if (Number.isInteger(s.maxLength) && n > s.maxLength) return `${key} must be at most ${s.maxLength} characters`
    }
  }
  if (schema.additionalProperties === false) {
    const extra = Object.keys(a).filter(k => !Object.hasOwn(schema.properties ?? {}, k))
    if (extra.length) return `unknown argument: ${extra.join(', ')}`
  }
  return null
}

export const LIST_CHILDREN_SCHEMA = Object.freeze({ type: 'object', properties: {}, additionalProperties: false })
export const CREATE_CHILD_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: MAX_NAME_LENGTH, description: 'Short domain name, e.g. "Cooking"' },
    role_description: { type: 'string', minLength: 1, maxLength: 1000, description: 'What the child is responsible for' },
  },
  required: ['name', 'role_description'],
  additionalProperties: false,
})

export function registerTreeTools(fb, tree) {
  const inTree = botId => tree.isMember(botId) // visibleTo is sync
  const fail = e => ({ error: e instanceof Error ? e.message : String(e) })
  return [
    fb.registerTool({
      name: 'list_children',
      description: 'List your direct child bots (id, name, role). These and your parent are the only bots you can message.',
      parameters: LIST_CHILDREN_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(LIST_CHILDREN_SCHEMA, args ?? {})
        if (bad) return fail(bad)
        const nodes = tree.snapshot()
        if (!nodes[botId]) return fail('this bot is not part of the tree')
        return { children: tree.childrenOf(nodes, botId).map(({ id, name, role }) => ({ id, name, role })), depth: tree.depthOf(nodes, botId), limits: tree.limits }
      },
    }),
    fb.registerTool({
      name: 'create_child_bot',
      description: 'Create a NEW child bot directly under yourself, then delegate to it. Any tree bot may call this (not only the root). Only when none of your children fits; never a duplicate.',
      parameters: CREATE_CHILD_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(CREATE_CHILD_SCHEMA, args)
        if (bad) return fail(bad)
        try { return { created: await tree.createChild(botId, args.name, args.role_description) } } catch (e) { return fail(e) }
      },
    }),
  ]
}
