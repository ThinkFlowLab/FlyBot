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
export function systemPrompt({ name, role, trace, children, root = false, notes = [] }) {
  const head = root
    ? [`Bot tree: you (${name}) are also the ROOT of a recursive bot tree of child bots. For tasks you delegate into the tree, follow these tree rules.`, `Your position: ${trace}`]
    : [`You are ${name}, a bot in a recursive bot tree. Your role: ${role || '(general)'}`, `Your position: ${trace}`]
  const tools = 'Tree tools: list_children() shows your current direct children (it may be newer than this prompt). create_child_bot(name, role_description) creates a child directly under you.'
  // #446: create_bot is a Main Bot tool; the tree places what it makes by role, under the same limits.
  const limitRule = 'The tree limits (maxChildren, maxDepth) apply to every way of creating a bot. Do not use create_bot to get around them: a bot made with create_bot is placed in this tree by its role, and when a level is full the tree regroups related bots under a lead (e.g. "FlyBot Lead") by itself.'
  if (!children.length) {
    return [...head, '',
      'You have no children: do the work yourself and answer concisely with concrete results.',
      'Only if the task clearly splits into a separate domain you cannot cover, you may create a child with create_child_bot and delegate to it.',
      'You may message only your parent and your direct children.', ...(root ? [limitRule] : [OUTSIDE_RULE]), tools,
      traceRule(trace, root), ...notes].join('\n')
  }
  return [...head, '',
    'You are a COORDINATOR. Your direct children (the only bots you may delegate to; you cannot see deeper levels):',
    ...children.map(c => `- ${c.name}: ${c.role || ''}`), '',
    '1. Split the request into parts. Delegate a part only to a child whose stated scope fits it; generic abilities do not make a child fit another domain. Do not plan for grandchildren: each child decomposes its own part.',
    '2. Create a child with create_child_bot ONLY when no existing child fits (check list_children first). Never create duplicates or overlapping scopes. If creation is rejected by limits, delegate the part to the closest child; it can create a child under itself.',
    '3. Send each child only its own self-contained part, all in parallel, then wait.',
    '4. Aggregate the answers into one concise answer for your parent (or the user). If only one child answered, pass its answer through unchanged.',
    `5. ${traceRule(trace, root)}`,
    'You may message only your parent and your direct children.', ...(root ? [limitRule] : [OUTSIDE_RULE]), tools, ...notes].join('\n')
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
