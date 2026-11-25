import {groupBotIdentity} from './group-identity.mjs';

const all = ['所有智能体', '所有人', '全体', 'everyone', 'all'];
const literal = /(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)|`[^`\n]*`|\[[^\]\n]*\]\([^\n)]*\)|https?:\/\/[^\s<>"']+/gu;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function groupMentionPainter(agents, members, identities) {
  const names = new Map();
  for (const agent of agents || []) {
    if (!agent.name || agent.archived || agent.name.length > 80) continue;
    const key = agent.name.toLowerCase();
    const identity = groupBotIdentity(identities, agent);
    names.set(key, names.has(key) ? null : identity);
  }
  for (const member of members || []) {
    if (member.handle) names.set(member.handle.toLowerCase(), null);
  }
  for (const name of all) names.set(name, null);
  const labels = [...names.keys()].sort((a,b) => b.length - a.length).map(escape).join('|');
  const pattern = new RegExp(
    `(^|[\\s(（\\[，。！？、,:：;；])[@＠](${labels})(?=$|[\\s)）\\]，。！？、,:：;；!?]|\\.(?=$|\\s))`, 'giu');

  return function paint(root) {
    const doc = root.ownerDocument;
    if (!doc?.createTreeWalker || !root.textContent.includes('@') && !root.textContent.includes('＠')) return;
    const walker = doc.createTreeWalker(root, 4);
    const changes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('a, code, pre, button, summary, textarea, .group-message-mention')) continue;
      const value = node.nodeValue;
      const searchable = value.replace(literal, match => ' '.repeat(match.length));
      const matches = [...searchable.matchAll(pattern)];
      if (matches.length) changes.push({node,value,matches});
    }
    for (const {node,value,matches} of changes) {
      const fragment = doc.createDocumentFragment();
      let cursor = 0;
      for (const match of matches) {
        const start = match.index + match[1].length;
        const end = match.index + match[0].length;
        if (start > cursor) fragment.append(value.slice(cursor, start));
        const span = doc.createElement('span');
        span.className = 'group-message-mention';
        span.textContent = value.slice(start, end);
        const name = match[2].toLowerCase();
        const identity = names.get(name);
        if (identity) span.dataset.groupBotTone = identity.tone;
        else if (all.includes(name)) span.dataset.groupMentionKind = 'everyone';
        fragment.append(span);
        cursor = end;
      }
      fragment.append(value.slice(cursor));
      node.replaceWith(fragment);
    }
  };
}
