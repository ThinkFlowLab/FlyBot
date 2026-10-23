import { MAX_NAME_LENGTH } from './limits.js' // = ds-bot roster's 40-character name truncation
import { MAX_TEAM_LENGTH } from './allocate.js'
import { STALLED_AFTER_MS } from './load.js'
// Model tools. The caller comes from the tool context ({ botId }), never from arguments. A Bot
// creates only in its own downstream: `parent` must be the caller or one of its descendants (#447).
// Visible to every tree member (#16 Option B: not Main/root-only). maxChildren and depth are
// checked at the target parent; a new child is not granted. find_bots is read-only.
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
    if (s.type === 'array' && !Array.isArray(v)) return `${key} must be a list`
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
    parent: { type: 'string', maxLength: 100, description: 'Optional: id or name of the Bot to create it under: you (default) or one of your descendants' },
  },
  required: ['name', 'role_description'],
  additionalProperties: false,
})
export const FIND_BOTS_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', maxLength: 200, description: 'Optional: a name or role to look for, e.g. "tester". Empty lists your whole branch.' },
  },
  additionalProperties: false,
})
export const MOVE_BOT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    bot: { type: 'string', minLength: 1, maxLength: MAX_NAME_LENGTH, description: 'Id or name of the Bot to move (with its subtree)' },
    parent: { type: 'string', minLength: 1, maxLength: MAX_NAME_LENGTH, description: 'Id or name of the Bot that becomes the new parent' },
  },
  required: ['bot', 'parent'],
  additionalProperties: false,
})
export const CREATE_TEAM_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    team: { type: 'string', minLength: 1, maxLength: MAX_TEAM_LENGTH, description: 'Project or group name, e.g. "FlyBot". Its lead is named "<team> Lead".' },
    // The host keeps only type/description/enum/items, and DSH needs an object item to declare its keys, so members are "Name: role" strings.
    members: { type: 'array', items: { type: 'string' }, description: 'The roles, at least 2, each "Name: what it is responsible for", e.g. "Dev: writes and fixes the code"' },
    parent: { type: 'string', maxLength: 100, description: 'Optional: id or name of the Bot to put the lead under: you (default) or one of your descendants' },
  },
  required: ['team', 'members'],
  additionalProperties: false,
})

export function registerTreeTools(fb, tree) {
  const inTree = botId => tree.isMember(botId) // visibleTo is sync
  const fail = e => ({ error: e instanceof Error ? e.message : String(e) })
  return [
    fb.registerTool({
      name: 'list_children',
      description: 'List your direct child bots (id, name, role, and load: how many turns each is running now). A child with an open turn also carries openForMs, the age of its oldest open turn, and stalled: true once that turn has been open past the stall threshold. These and your parent are the only bots you can message; send new work to an idle child first.',
      parameters: LIST_CHILDREN_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(LIST_CHILDREN_SCHEMA, args ?? {})
        if (bad) return fail(bad)
        const nodes = tree.snapshot()
        if (!nodes[botId]) return fail('this bot is not part of the tree')
        return {
          children: tree.childrenOf(nodes, botId).map(({ id, name, role }) => {
            // Idle keeps the old shape: no age, no flag, so a reader that only wants the count sees
            // exactly what it saw before (#624).
            const openForMs = tree.openForOf(id)
            return {
              id,
              name,
              role,
              load: tree.loadOf(id),
              ...(openForMs > 0 ? { openForMs } : {}),
              ...(openForMs >= STALLED_AFTER_MS ? { stalled: true } : {}),
            }
          }),
          depth: tree.depthOf(nodes, botId),
          limits: tree.limits,
        }
      },
    }),
    fb.registerTool({
      name: 'find_bots',
      description: 'Read-only. Search the Bots in your branch (for the root: the whole tree) by name or role, with role, parent, depth and path. Use it before creating a Bot, to reuse one that already fits.',
      parameters: FIND_BOTS_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(FIND_BOTS_SCHEMA, args ?? {})
        if (bad) return fail(bad)
        try { return tree.findBots(botId, args?.query) } catch (e) { return fail(e) }
      },
    }),
    fb.registerTool({
      name: 'create_child_bot',
      description: 'Create ONE new Bot under yourself, or under one of your descendants with parent, then delegate to it. If a Bot with the same role already exists in your branch, it is reused and nothing is created. Without parent, a group lead in your branch that fits the new role (e.g. "FlyBot Lead") takes it. Any tree bot may call this (not only the root).',
      parameters: CREATE_CHILD_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(CREATE_CHILD_SCHEMA, args)
        if (bad) return fail(bad)
        try { return await tree.allocateChild(botId, args.name, args.role_description, args.parent) } catch (e) { return fail(e) }
      },
    }),
    fb.registerTool({
      name: 'create_team',
      description: 'Create a team for one project or group: "<team> Lead" with its members as children, one slot under you (or under parent, one of your descendants). An existing lead of that group and existing Bots with the same roles in your branch are reused.',
      parameters: CREATE_TEAM_SCHEMA,
      visibleTo: inTree,
      async execute(args, { botId }) {
        const bad = validateArgs(CREATE_TEAM_SCHEMA, args)
        if (bad) return fail(bad)
        try { return await tree.createTeam(botId, { team: args.team, members: args.members, parent: args.parent }) } catch (e) { return fail(e) }
      },
    }),
    fb.registerTool({
      name: 'move_bot',
      description: 'Root only. Move an existing Bot with its subtree under another parent. Refused when it would create a cycle, exceed maxChildren or maxDepth, or duplicate a sibling name.',
      parameters: MOVE_BOT_SCHEMA,
      visibleTo: botId => inTree(botId) && tree.isRoot(botId),
      async execute(args) {
        const bad = validateArgs(MOVE_BOT_SCHEMA, args)
        if (bad) return fail(bad)
        try { return tree.moveBot(args.bot, args.parent) } catch (e) { return fail(e) }
      },
    }),
  ]
}
