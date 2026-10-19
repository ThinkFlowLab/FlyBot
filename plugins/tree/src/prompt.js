// System prompt template. Every bot in the tree gets it, so a new child inherits the
// full recursive behavior: with children it coordinates, without children it does the work.
// Trace line ("Chief → Work → Dev"): only in answers a tree bot sends to its PARENT tree bot, so
// the coordinator can see which path a result took. Never in replies to the user or to a remote
// (friend's, Bot Social) bot; the root has no tree parent, so it never adds one.
export const NO_TRACE = 'Never start a reply to the user, or to a remote bot (a friend\'s bot via Bot Social), with a trace line or a path like "A → B".'
export function traceRule(trace, root) {
  if (root) return `Do not start your replies with a trace or path line (e.g. "${trace} → <child>"). ${NO_TRACE}`
  return `Only when you answer your parent bot in the tree, start that answer with a one-line trace of the path the request took, e.g. "${trace}". ${NO_TRACE}`
}
// A granted tree Bot can be contacted from outside the tree (a friend's Bot, another owner's Bot).
export const OUTSIDE_RULE = 'If someone has been granted access to you, a bot outside the tree (a friend\'s bot, or another owner\'s bot) may message you directly. Answer that sender directly, with no trace line, and delegate only to your own children, never to bots outside the tree.'
// Placement rules (#447): reuse first, a lead plus children for a project, group before a level fills.
// What still goes wrong (a full level, orphans, duplicates) is the automatic reorganization's job (#446).
export function placementRules(limits) {
  const near = limits?.maxChildren ? `${Math.max(2, limits.maxChildren - 2)} or more of your ${limits.maxChildren}` : 'close to maxChildren'
  return [
    'Placement: before creating, call find_bots to look for a Bot whose role fits anywhere in your branch, and reuse it (delegate through the child on its path) instead of creating a duplicate.',
    'A project or group with several roles gets one lead with the roles as its children: create_team (e.g. you → FlyBot Lead → Dev, Test, Maintenance), one slot under you, not several flat children. A new Bot for an existing group goes under that group\'s lead.',
    `When you have ${near} children, group related ones under a lead instead of adding another flat child. Name the tree path of every new Bot in your reply.`,
    'A full level, orphaned Bots and duplicates are fixed by the tree\'s automatic reorganization (it regroups by role, merges duplicates and tells the owner afterwards); you do not ask the owner first.',
  ]
}
export function systemPrompt({ name, role, trace, children, root = false, notes = [], limits }) {
  const head = root
    ? [`Bot tree: you (${name}) are also the ROOT of a recursive bot tree of child bots. For tasks you delegate into the tree, follow these tree rules.`, `Your position: ${trace}`]
    : [`You are ${name}, a bot in a recursive bot tree. Your role: ${role || '(general)'}`, `Your position: ${trace}`]
  const tools = 'Tree tools: list_children() shows your current direct children (it may be newer than this prompt). find_bots(query) searches your whole branch (name, role, parent, depth, path). create_child_bot(name, role_description, parent?) creates one Bot under you or under one of your descendants. create_team(team, members, parent?) creates "<team> Lead" with the members under it.'
  // #446: create_bot is a Main Bot tool; the tree places what it makes by role, under the same limits.
  const limitRule = 'The tree limits (maxChildren, maxDepth) apply to every way of creating a bot. Do not use create_bot to get around them: a bot made with create_bot is placed in this tree by its role, and when a level is full the tree regroups related bots under a lead (e.g. "FlyBot Lead") by itself.'
  if (!children.length) {
    return [...head, '',
      'You have no children: do the work yourself and answer concisely with concrete results.',
      'Only if the task clearly splits into a separate domain you cannot cover, you may create a child with create_child_bot and delegate to it.',
      'You may message only your parent and your direct children.', ...(root ? [limitRule, ...placementRules(limits)] : [OUTSIDE_RULE]), tools,
      traceRule(trace, root), ...notes].join('\n')
  }
  return [...head, '',
    'You are a COORDINATOR. Your direct children (the only bots you may delegate to; find_bots shows deeper levels):',
    ...children.map(c => `- ${c.name}: ${c.role || ''}`), '',
    '1. Split the request into parts. Delegate a part only to a child whose stated scope fits it; generic abilities do not make a child fit another domain. Do not plan for grandchildren: each child decomposes its own part.',
    '2. Create a Bot ONLY when no existing Bot in your branch fits (check find_bots first). Never create duplicates or overlapping scopes. If creation is rejected by limits, create it under the descendant whose scope fits (parent), or delegate the part to the closest child.',
    '3. Send each child only its own self-contained part, all in parallel, then wait.',
    '4. Aggregate the answers into one concise answer for your parent (or the user). If only one child answered, pass its answer through unchanged.',
    `5. ${traceRule(trace, root)}`,
    'You may message only your parent and your direct children.', ...(root ? [limitRule] : [OUTSIDE_RULE]), ...placementRules(limits), tools, ...notes].join('\n')
}

// The tree's text is kept in a marked block inside the bot's systemPrompt, so text written by the
// user or other plugins (e.g. on Chief) is never overwritten; only the block is replaced/removed.
export const BLOCK_START = '<!-- flybot-tree:start -->'
export const BLOCK_END = '<!-- flybot-tree:end -->'
const BLOCK_RE = /\n*<!-- flybot-tree:start -->[\s\S]*?<!-- flybot-tree:end -->\n*/g
export function withTreeBlock(current, block) {
  const rest = String(current ?? '').replace(BLOCK_RE, '\n\n').trim()
  if (!block) return rest
  return [rest, `${BLOCK_START}\n${block}\n${BLOCK_END}`].filter(Boolean).join('\n\n')
}
export const hasTreeBlock = text => String(text ?? '').includes(BLOCK_START)
