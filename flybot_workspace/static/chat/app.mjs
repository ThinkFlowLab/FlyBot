import { decodeVoice, mountVoiceRecorder } from './voice.mjs';
import { countMentionedGroupMembers, hasEveryoneMention, hasGroupAllMention, mountAgentMentions } from './mentions.mjs';
import { AGENT_FILE_ACCEPT, chatFileDownload, chatUploadProgress, deferModule, localChatFile, mountChatFiles,
  ownSocialReceipt, renderChatFile, sendPrivateAttachmentMessage, sendSocialAttachmentMessage, unclearSocialDelivery } from './files.mjs';
import { mountGroupTranslation } from './translation.mjs';
import { mountChatActivity, mountChatApprovalNotice } from './activity.mjs';
import { meetingCodeFromHash, meetingDraftFromCallHref, stageMeetingFromChat } from '../shell/meeting-link.mjs';
import { workNotificationSummary, workNotificationTarget } from '../shell/work-notification.mjs';
import { mountPublicDraft } from './public-draft.mjs';
import { consumePublicAgentOpening, publicAgentIntentFromHash, publicAgentContinuation, publicAgentOpening } from '../shell/public-agent-link.mjs';
import { mountMessageUtilities, renderMessageText } from './utilities.mjs';
import {mountWorkspaceInvite} from './workspace-invite.mjs';
import { studioDocumentHref, studioDocumentHrefInMessage } from '../shell/studio-link.mjs';
import { chatStartFromHash, historyPageSize as HISTORY_PAGE_SIZE, ownedChatStartup,
  startChatReads, startupTranscriptAge, takeChatReads } from './startup.mjs';
import { confirmSignupSession, personalDraftScope, readPendingChatText, savePendingChatText,
  signupDraftScope, signupSessionError, takeColdDraftHandoff } from '../home/runtime-readiness.mjs';
import { mountActionMenus } from '../shell/action-menu.mjs';
export const SEARCH_JUMP_HIGHLIGHT_MS = 2400;
const loadGroupInviteModule = deferModule('./group-invite-link.mjs');
const loadRichContent = deferModule('./rich-content.mjs');
let richContent;
const pendingMessageMarkdown = [];
import { csrfCookie, canManage, idempotencyKey, statusLabel, conversationLabel, memberChoices, validMessage,
  agentDirectoryHref, chatPathId, socialMessageHref, socialMessageFromHash, directAgentAccessFromHash } from '../shell/chat-utils.mjs';
import { agentPortraitLook, createLookAvatar } from '../look/app.mjs';
import { dsbotServed } from './dsbot.mjs';
import { agentSavePath, artifactKindLabel, artifactVersionLabel, defaultSaveTitle, saveableAgentMessage, saveableSocialMessage, socialSavePath, spaceHref } from '../shell/thumb.mjs';

export const SEARCH_TABS = [
  ['all', '全部'],
  ['artifacts', '作品'],
  ['memory', '记忆'],
  ['contacts', '联系人'],
  ['groups', '群组'],
  ['agents', '智能体'],
  ['messages', '消息'],
  ['files', '文件'],
  ['documents', '云文档'],
  ['media', '媒体'],
  ['links', '链接'],
];

export function sessionPreview(row, fallback) {
  const text = typeof row.preview === 'string' ? row.preview.trim() : '';
  return text || fallback || '';
}

const PRIVATE_THREAD_ID = /^[a-f0-9]{32}$/;
const STUDIO_EXCERPT_LIMIT = 2400;
const GROUP_AGENT_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const GROUP_AGENT_OWNER_ID = /^[A-Za-z0-9._-]{1,80}$/;

function groupAgentKey(id, owner) {
  if (typeof id !== 'string' || !GROUP_AGENT_ID.test(id)) return '';
  if (owner === undefined || owner === '') return id;
  return typeof owner === 'string' && GROUP_AGENT_OWNER_ID.test(owner) ? owner + '/' + id : '';
}

function groupAgentTarget(key) {
  if (typeof key !== 'string') return null;
  const separator = key.indexOf('/');
  if (separator < 0) return GROUP_AGENT_ID.test(key) ? {agent_id: key} : null;
  const owner_id = key.slice(0, separator), agent_id = key.slice(separator + 1);
  return groupAgentKey(agent_id, owner_id) === key ? {owner_id, agent_id} : null;
}

function groupAgentKeys(keys) {
  return Array.isArray(keys) && keys.length <= 50 && keys.every(groupAgentTarget) ? [...new Set(keys)].sort() : null;
}

function studioRevisionReference(value) {
  if (typeof value?.document_id !== 'string' || !PRIVATE_THREAD_ID.test(value.document_id)
    || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
  return {document_id: value.document_id, revision: value.revision};
}

const sameStudioReference = (left, right) => left?.document_id === right?.document_id && left?.revision === right?.revision;

function privateThreadTitle(conversation, agent) {
  return (conversation?.title_edited === true && conversation.title) || agent?.name || conversation?.title || '对话';
}

export function mergeSessions(agentRows, socialRows, currentUserId) {
  const sessions = [];
  for (const row of agentRows || []) {
    if (row.archived === true) continue;
    const title = privateThreadTitle(row, row.agent);
    const renamed = row.title_edited === true;
    const agentName = row.agent?.name !== title ? row.agent?.name : '';
    const preview = sessionPreview(row, renamed ? agentName : row.title || '');
    sessions.push({
      source: 'agent',
      id: row.id,
      agent_id: row.agent_id || (row.agent && row.agent.id),
      agent: row.agent,
      kind: 'agent',
      title,
      preview: renamed && preview === title ? agentName || '' : preview,
      unread_count: Number(row.unread_count) || 0,
      updated: row.updated || 0,
    });
  }
  for (const row of socialRows || []) {
    sessions.push({
      source: 'social',
      id: row.id,
      unread_count: Number(row.unread_count) || 0,
      pinned: Boolean(row.pinned),
      muted: Boolean(row.muted),
      kind: row.public_agent ? 'public' : row.kind,
      members: row.members,
      title: conversationLabel(row, currentUserId),
      preview: sessionPreview(row, row.public_agent ? '公开智能体' : row.kind === 'group'
        ? '群聊 · ' + ((row.members || []).length) + ' 人'
        : '单聊 · ' + ((row.members || []).length) + ' 人'),
      updated: row.updated || 0,
    });
  }
  return sortSessions(sessions);
}


function sortSessions(sessions) {
  return sessions.sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || (right.updated || 0) - (left.updated || 0));
}

export function shouldSendOnShortcut(event, sendShortcut = 'enter') {
  if (!event || event.key !== 'Enter') return false;
  if (event.isComposing || event.keyCode === 229) return false;
  const modifier = Boolean(event.ctrlKey || event.metaKey);
  if (sendShortcut === 'mod_enter') return modifier && !event.shiftKey && !event.altKey;
  return !modifier && !event.shiftKey && !event.altKey;
}

// The chat language is stored per account by /settings; it only reaches the
// model if the message request carries it. 'auto' means "no opinion", so the
// field has to be absent rather than a value the server has to interpret.
export function messagePayload(text, chatLanguage = 'auto') {
  const payload = {body: text};
  if (typeof chatLanguage === 'string' && chatLanguage && chatLanguage !== 'auto') {
    payload.chat_language = chatLanguage;
  }
  return payload;
}

export function messageSearchQuery(query, conversationId = '', cursor = '') {
  const params = new URLSearchParams({q: query, limit: '20'});
  if (conversationId) params.set('conversation_id', conversationId);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

function searchHitKey(hit) {
  return [hit.kind || '', hit.conversationId || '', hit.messageId || hit.id || '', hit.preview || '']
    .join('\u0000');
}

export function searchHitFromItem(item) {
  return {
    type: item.kind === 'social' ? 'social' : 'agent-message',
    id: item.conversation_id,
    messageId: item.message_id || '',
    title: item.title || '消息',
    preview: item.snippet || '',
    conversationId: item.conversation_id,
    agentId: item.agent_id || '',
    kind: item.kind,
    ...(Number.isFinite(item.created) && {created: item.created}),
    ...(typeof item.author === 'string' && item.author && {author: item.author}),
    ...(item.role && {role: item.role}),
    ...(item.agent_name && {agentName: item.agent_name}),
  };
}

export function mergeSearchHits(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const hit of [...(existing || []), ...(incoming || [])]) {
    const key = searchHitKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  return merged;
}

// The server pages message hits by keyset cursor. This controller keeps the
// rows already shown and appends the next page, so a failed or repeated page
// never drops what the user is already reading.
export function createMessageSearch(loadPage) {
  const state = {hits: [], cursor: '', loading: false, error: '', warning: ''};
  let generation = 0;
  let pending = null;
  let activeKey = '';
  async function load(query, conversationId = '', {append = false, signal} = {}) {
    const text = String(query || '').trim();
    const key = JSON.stringify([text, conversationId]);
    if (!text) {
      generation += 1;
      activeKey = '';
      pending = null;
      Object.assign(state, {hits: [], cursor: '', error: '', warning: '', loading: false});
      return state;
    }
    // A tab switch during the same search must await the existing request,
    // not render its temporary empty state and invalidate the completing view.
    if (state.loading && key === activeKey) return pending;
    if (append && state.loading) return state;
    const token = ++generation;
    activeKey = key;
    if (!append) {
      state.hits = [];
      state.cursor = '';
      state.warning = '';
    }
    state.loading = true;
    pending = (async () => {
      try {
        const page = await loadPage(text, conversationId, append ? state.cursor : '', signal);
        if (token !== generation) return state;
        const incoming = ((page && page.items) || []).map(searchHitFromItem);
        state.hits = mergeSearchHits(append ? state.hits : [], incoming);
        state.cursor = (page && page.cursor) || '';
        state.error = '';
        state.warning = (page && page.warning) || '';
      } catch (failure) {
        if (token !== generation) return state;
        state.error = (failure && failure.message) || '无法搜索消息。';
        if (!append) {
          state.hits = [];
          state.cursor = '';
        }
      } finally {
        if (token === generation) state.loading = false;
      }
      return state;
    })();
    return pending;
  }
  return {state, load};
}

export function searchMoreVisible(state) {
  return Boolean(state && state.cursor && !state.loading);
}

export function applySearchMore(node, state) {
  if (!node) return;
  node.hidden = !searchMoreVisible(state);
  node.disabled = Boolean(state && state.loading);
}

export const GROUP_CREATE_INTRO = '选择联系人或智能体加入群组。';
export const GROUP_CREATE_MODES = [
  ['custom', '自定义群组'],
  ['team', 'AI 智能体团队'],
];

export function composeSelectedLabel(count) {
  return '已选 ' + Number(count || 0);
}

export function filterMemberChoices(members, currentUserId, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  const list = memberChoices(members, currentUserId);
  if (!needle) return list;
  return list.filter(member => String(member.username || '').toLocaleLowerCase().includes(needle));
}

export function groupPickerChoices(members, currentUserId, agents = []) {
  return [
    ...memberChoices(members, currentUserId).map(member => ({
      id: member.user_id, kind: 'human', label: member.username + (member.contact ? ' · 联系人' : ' · 成员'),
    })),
    ...agents.filter(agent => !agent.archived).map(agent => ({
      id: agent.id, kind: 'agent', label: agent.name + ' · AI 智能体',
    })),
  ];
}

export function leadGlyph(text, fallback = '?') {
  const cleaned = String(text || '').replace(/^\s*\[[^\]]*\]\s*/, '');
  const match = cleaned.match(/[\p{L}\p{N}]/u) || String(text || '').match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : fallback;
}

export function inlineBold(text) {
  const value = typeof text === 'string' ? text : '';
  const parts = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(value))) {
    if (match.index > last) parts.push({text: value.slice(last, match.index), bold: false});
    parts.push({text: match[1], bold: true});
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push({text: value.slice(last), bold: false});
  return parts;
}

export function wrapBold(text, start, end) {
  const value = typeof text === 'string' ? text : '';
  const from = Number.isFinite(start) ? Math.max(0, Math.min(value.length, start)) : value.length;
  const to = Number.isFinite(end) ? Math.max(from, Math.min(value.length, end)) : from;
  return {
    text: value.slice(0, from) + '**' + value.slice(from, to) + '**' + value.slice(to),
    start: from + 2,
    end: to + 2,
  };
}

function fillBold(doc, node, text) {
  const parts = inlineBold(text);
  node.textContent = '';
  if (!parts.some(part => part.bold)) {
    node.textContent = parts.map(part => part.text).join('');
    return;
  }
  for (const part of parts) {
    if (part.bold && typeof doc.createElement === 'function') {
      const strong = doc.createElement('strong');
      strong.textContent = part.text;
      node.append(strong);
    } else if (typeof doc.createTextNode === 'function') {
      node.append(doc.createTextNode(part.text));
    } else {
      node.textContent += part.text;
    }
  }
}

export function meetingCallHrefInMessage(text, origin) {
  if (!origin || typeof text !== 'string' || !text.includes('from-call=')) return '';
  for (const match of text.matchAll(/(?:^|\s)(https?:\/\/[^\s<>"']+|\/meetings#[^\s<>"']+)/gu)) {
    let url;
    try { url = new URL(match[1].replace(/[.,;!?)。，；！）]+$/u, ''), origin); } catch { continue; }
    if (url.origin !== origin || url.username || url.password || url.pathname !== '/meetings' || url.search) continue;
    const params = new URLSearchParams(url.hash.slice(1));
    const workspace = params.get('workspace');
    if (params.size !== (workspace === null ? 1 : 2) || (workspace !== null && !/^[a-f0-9]{32}$/.test(workspace))) continue;
    const href = meetingDraftFromCallHref(params.get('from-call'), workspace);
    if (href) return href;
  }
  return '';
}

function mayContainChatMarkdown(text, assistantReply) {
  if (/^[ \t]*(?:```|~~~)/m.test(text) ||
      (text.includes('|') && text.includes('\n') && /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\||$)/m.test(text))) return true;
  return assistantReply && (/[\\`*_~]/.test(text) || /\]\(|\n[ \t]*\n/.test(text) ||
    /^(?:#{1,6}\s|[ \t]*(?:>|[-+]\s|\d+[.)]\s|-{3,}$))/m.test(text));
}

function appendMessageMarkdown(doc, parent, source, assistantReply, updatePreview) {
  const node = doc.createElement('div');
  node.textContent = source;
  parent.append(node);
  const format = module => {
    if (!assistantReply && !module.hasExplicitRichContent(source)) return;
    module.renderChatMarkdown(doc, node, source);
    updatePreview?.();
  };
  if (richContent) {
    format(richContent);
    return;
  }
  pendingMessageMarkdown.push({node, format});
  if (pendingMessageMarkdown.length > 1) return;
  void loadRichContent().then(module => {
    richContent = module;
    const pending = pendingMessageMarkdown.splice(0).filter(({node}) => node.isConnected !== false);
    const scrollers = new Set(pending.map(({node}) => node.closest?.('#message-scroller')).filter(Boolean));
    // Measure before replacing any message bodies, then restore live scroll once.
    const following = [...scrollers].filter(scroller => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32);
    for (const {format} of pending) {
      try { format(module); }
      catch { /* Keep the message readable if its formatting fails. */ }
    }
    for (const scroller of following) scroller.scrollTop = scroller.scrollHeight;
  }).catch(() => {
    pendingMessageMarkdown.length = 0;
  });
}

const streamingReplies = new WeakMap();
const streamingReplySource = node => streamingReplies.get(node)?.source || '';

function paintStreamingReply(doc, node, source) {
  const view = streamingReplies.get(node) || {};
  view.source = source;
  streamingReplies.set(node, view);
  node.hidden = !source;
  if (!source || (!view.markdown && !mayContainChatMarkdown(source, true))) {
    view.markdown = null;
    node.textContent = source;
    return;
  }

  const format = module => {
    if (!view.markdown) {
      view.markdown = doc.createElement('div');
      view.markdown.className = 'chat-markdown';
      node.replaceChildren(view.markdown);
    }
    module.renderStreamingMarkdown(doc, view.markdown, view.source);
  };
  if (richContent) {
    format(richContent);
    return;
  }

  node.textContent = source;
  view.loading ??= loadRichContent().then(module => {
    richContent = module;
    if (node.isConnected === false || !mayContainChatMarkdown(view.source, true)) return;
    const scroller = node.closest?.('#message-scroller');
    const following = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
    format(module);
    if (following) scroller.scrollTop = scroller.scrollHeight;
  }).catch(() => {}).finally(() => { view.loading = null; });
}

function renderMessageBody(doc, node, text, prefs, assistantReply = false, preview) {
  const source = String(text || '');
  const rich = mayContainChatMarkdown(source, assistantReply) &&
    (!richContent || assistantReply || richContent.hasExplicitRichContent(source));
  if (rich) {
    renderMessageText(doc, node, source, prefs.message_folding, prefs.link_previews, (parent, value, updatePreview) => {
      const streamed = assistantReply && streamingReplies.get(preview);
      if (!streamed?.markdown || !value.startsWith(streamed.source.trimEnd())) {
        appendMessageMarkdown(doc, parent, value, assistantReply, updatePreview);
        return;
      }
      richContent.renderStreamingMarkdown(doc, streamed.markdown, value, {complete:true});
      parent.append(streamed.markdown);
      if (parent.tagName === 'DETAILS') parent.open = true;
    });
  } else if (inlineBold(source).some(part => part.bold)) fillBold(doc, node, source);
  else renderMessageText(doc, node, source, prefs.message_folding, prefs.link_previews);
  const origin = doc.defaultView?.location?.origin;
  const references = [
    [meetingCallHrefInMessage, '整理会议纪要'],
    [studioDocumentHrefInMessage, doc.documentElement?.lang === 'en' ? 'Open team document' : '打开团队文档'],
  ];
  for (const [reference, label] of references) {
    const href = reference(source, origin);
    if (!href) continue;
    const existing = Array.from(node.children).find(child => child.tagName === 'A' && reference(child.href, origin) === href);
    const link = existing || doc.createElement('a');
    link.className = 'chat-link-card';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    link.title = '';
    if (!existing) node.append(link);
  }
  return rich || node.children[0]?.tagName === 'DETAILS';
}

export function highlightParts(text, query) {
  const source = String(text || '');
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [{text: source, match: false}];
  const parts = [];
  const lower = source.toLowerCase();
  let at = 0;
  for (let index = lower.indexOf(needle); index !== -1; index = lower.indexOf(needle, at)) {
    if (index > at) parts.push({text: source.slice(at, index), match: false});
    parts.push({text: source.slice(index, index + needle.length), match: true});
    at = index + needle.length;
  }
  if (at < source.length) parts.push({text: source.slice(at), match: false});
  return parts.length ? parts : [{text: source, match: false}];
}

export function groupInfoCounts(conversation) {
  const people = (conversation && conversation.members || []).length;
  const agents = (conversation && conversation.agent_members || []).length;
  return {people, agents, text: `${people + agents} 位成员 · ${people} 位真人 · ${agents} 位智能体`};
}

export function groupAgentSummary(conversation) {
  const list = conversation && conversation.agent_members || [];
  return list.length ? '群内智能体：' + list.map(agent => agent.name).join('、')
    + '。用 @ 指定智能体，或用 @所有人请群内智能体回复。' : '';
}

function activeGroupAgent(conversation, target) {
  return target && (conversation?.agent_members || []).find(agent => !agent.archived && !agent.native_deleted &&
    agent.owner_id === target.owner_id && (agent.id || agent.agent_id) === target.agent_id);
}

// Personal-runtime states from server-side auto-provisioning (operator opt-in).
export const RUNTIME_WAIT_ERRORS = {
  runtime_starting: '你的专属运行时正在创建或启动，就绪后会自动回复',
  runtime_capacity: '平台专属运行时名额已满，请联系管理员扩容，或连接你自己的运行时',
  runtime_unavailable: '你的专属运行时创建或启动失败，请联系管理员处理',
};

export function sendNotice(reply) {
  const code = reply && reply.error_code;
  if (code === 'model-unconfigured') return {kind: 'error', text: '消息已保存，当前没有可用的模型。'};
  if (code === 'no_agent') return {kind: 'error', text: '消息已保存，正在等待已连接的运行时。'};
  if (code === 'runtime_starting') return {kind: 'ok', text: '消息已保存。' + RUNTIME_WAIT_ERRORS[code] + '。'};
  if (RUNTIME_WAIT_ERRORS[code]) return {kind: 'error', text: '消息已保存。' + RUNTIME_WAIT_ERRORS[code] + '。'};
  if (reply?.status === 'failed') return {kind: 'error', text: '消息已保存，智能体回复失败。'};
  return {kind: 'ok', text: '已发送。', announceOnly: true};
}

export function groupReplyStatus(reply) {
  const labels = {queued: '等待执行', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消'};
  const errors = {no_agent: '没有可用运行时连接', quota: '运行时任务容量已满', timeout: '执行超时',
    runtime_failed: '运行时执行失败', empty_reply: '运行时未返回正文', task_missing: '运行时任务丢失', cancelled: '已取消',
    ...RUNTIME_WAIT_ERRORS};
  return (labels[reply.status] || '未知状态') + (reply.error_code ? '：' + (errors[reply.error_code] || '请求失败') : '');
}

const directAgentRoom = conversation => conversation?.kind === 'dm' && conversation.direct_agent_requests === true &&
  conversation.direct?.open !== false && !conversation.public_agent;

export function composeCreateEnabled(options) {
  const mode = options && options.composeMode;
  const groupMode = (options && options.groupMode) || 'custom';
  const selectedCount = Number((options && options.selectedCount) || 0);
  if (mode === 'contact') return selectedCount === 1;
  if (mode === 'group' && groupMode === 'team') return options.templateSelected === true;
  if (mode === 'group') return groupMode === 'custom'
    && selectedCount <= 49 && Number(options.selectedAgentCount || 0) <= 10
    && (options.personal ? selectedCount > 0 : Number(options.selectedHumanCount ?? selectedCount) >= 1);
  return false;
}

export function composeGroupPayload(memberIds, title, agentIds = []) {
  const body = {kind: 'group', member_ids: memberIds};
  const name = String(title || '').trim();
  if (name) body.title = name;
  if (agentIds.length) body.agent_ids = agentIds;
  return body;
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function writeHash(values, {push = false} = {}) {
  const params = new URLSearchParams();
  if (values.workspace) params.set('workspace', values.workspace);
  if (values.agent) params.set('agent', values.agent);
  if (values.social) params.set('social', values.social);
  if (values.conversation) params.set('conversation', values.conversation);
  if (values.message) params.set('message', values.message);
  const next = params.toString();
  const hash = next ? '#' + next : '';
  if (location.hash === hash) return;
  const path = location.pathname + hash;
  if (push) history.pushState(null, '', path);
  else history.replaceState(null, '', path);
}

let messageTimeFormatter;
let sessionTodayFormatter;
let sessionWeekdayFormatter;
let sessionDateFormatter;

function formatTime(value) {
  if (!value) return '';
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  messageTimeFormatter ??= new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return messageTimeFormatter.format(date);
}

export function sessionDisplayGroup(item) {
  return item.pinned ? '置顶' : item.kind === 'public' ? '公开智能体' : item.kind === 'group' ? '群聊' : '直聊';
}

export function groupSessionsForDisplay(items) {
  return ['置顶', '直聊', '公开智能体', '群聊'].flatMap(group => items.filter(item => sessionDisplayGroup(item) === group));
}

export function formatSessionTime(value, now = Date.now()) {
  const timestamp = Number(value) * 1000;
  if (!value || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const day = ms => Math.floor((ms + 8 * 3600000) / 86400000);
  const days = day(now) - day(timestamp);
  if (days === 0) {
    sessionTodayFormatter ??= new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    return sessionTodayFormatter.format(date);
  }
  if (days === 1) return '昨天';
  if (days > 1 && days < 7) {
    sessionWeekdayFormatter ??= new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Hong_Kong', weekday: 'short'});
    return sessionWeekdayFormatter.format(date);
  }
  sessionDateFormatter ??= new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: 'numeric', day: 'numeric',
  });
  return sessionDateFormatter.format(date);
}

// Six original pastel tones so neighbouring avatars are distinguishable; stable per name.
export function avatarTone(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return String((hash % 6) + 1);
}

export function initial(name) {
  const text = (name || '').trim();
  const match = text.match(/\p{L}|\p{N}/u);
  return match ? match[0].toUpperCase() : '?';
}

export function chatIdentity(name) {
  const title = (name || '').trim() || '聊天';
  const placeholder = title === '聊天';
  return {title, initial: placeholder ? '' : initial(title), showAvatar: !placeholder};
}

export function applyChatAvatarStack(document, conversation) {
  const stack = document.getElementById('chat-avatar-stack');
  const avatar = document.getElementById('chat-avatar');
  if (!stack) return false;
  stack.replaceChildren();
  const faces = [];
  for (const member of (conversation && conversation.members) || []) {
    faces.push(member.username || member.name || '');
  }
  for (const agent of (conversation && conversation.agent_members) || []) {
    faces.push(agent.name || '');
  }
  const names = faces.filter(Boolean).slice(0, 4);
  const grouped = Boolean(conversation && conversation.kind === 'group' && names.length);
  stack.hidden = !grouped;
  if (grouped) {
    if (avatar) avatar.hidden = true;
    for (const name of names) {
      const face = document.createElement('span');
      face.className = 'avatar stack-face';
      face.textContent = initial(name);
      if (face.dataset) face.dataset.tone = avatarTone(name);
      stack.appendChild(face);
    }
  }
  return grouped;
}

export function applyChatIdentity(document, name, conversation, look) {
  const identity = chatIdentity(name);
  const title = document.getElementById('chat-title');
  const avatar = document.getElementById('chat-avatar');
  if (title) title.textContent = identity.title;
  const subtitle = document.getElementById('chat-subtitle');
  if (subtitle) { subtitle.textContent = ''; subtitle.hidden = true; }
  const lookAvatar = createLookAvatar(look, document);
  const canRenderLook = Boolean(lookAvatar && avatar && avatar.replaceChildren && avatar.append);
  if (avatar) {
    if (avatar.replaceChildren) avatar.replaceChildren();
    if (canRenderLook) {
      avatar.append(lookAvatar);
      avatar.hidden = false;
    } else {
      avatar.textContent = identity.initial;
      avatar.hidden = !identity.showAvatar;
      if (avatar.dataset) avatar.dataset.tone = avatarTone(identity.title);
    }
  }
  const stacked = applyChatAvatarStack(document, conversation);
  if (stacked && avatar) avatar.hidden = true;
  if (!stacked && avatar && (identity.showAvatar || canRenderLook)) avatar.hidden = false;
  return identity;
}

function matchesQuery(item, query) {
  if (!query) return true;
  const hay = ((item.title || '') + ' ' + (item.preview || '') + ' ' + (item.snippet || '')).toLowerCase();
  return hay.includes(query.toLowerCase());
}

// Must match social.REACTIONS on the server.
export const MESSAGE_REACTIONS = ['👍', '❤️', '😄', '🎉', '👀', '✅'];

export function reactionToggle(reactions, emoji) {
  const current = (reactions || []).find(item => item.emoji === emoji);
  return {emoji, active: !(current && current.mine)};
}

function applyReaction(reactions, {emoji,active}) {
  const old = reactions.find(item=>item.emoji===emoji);
  if (Boolean(old?.mine) === active) return reactions;
  const count = (old?.count ?? 0) + (active ? 1 : -1);
  if (!old) return [...reactions,{emoji,count,mine:active}];
  return count > 0 ? reactions.map(item=>item===old ? {...item,count,mine:active} : item)
    : reactions.filter(item=>item!==old);
}

export function forwardTargets(conversations, currentId, userId) {
  return (conversations || []).filter(item => item.id !== currentId && !item.public_agent && item.direct?.open !== false)
    .map(item => ({id: item.id, label: (item.kind === 'dm' ? '单聊 · ' : '群聊 · ') + conversationLabel(item, userId)}));
}

export function forwardCountLabel(count) {
  return `已选 ${Number(count) || 0} 条`;
}

export function notificationBadgeText(count) {
  const value = Number(count) || 0;
  if (value <= 0) return '';
  return value > 99 ? '99+' : String(value);
}

const AUTOMATION_RUN_FINISHED = 'automation.run_finished';

export function notificationSummary(item, label = zh => zh) {
  if (item.kind === AUTOMATION_RUN_FINISHED) {
    const status = {
      succeeded: label('已完成', 'completed'), failed: label('失败', 'failed'),
      timeout: label('已超时', 'timed out'), interrupted: label('已中断', 'was interrupted'),
    }[item.status] || label('已结束', 'ended');
    const title = item.title || label('自动化', 'Automation');
    return label(`「${title}」运行${status}`, `“${title}” ${status}`);
  }
  const workSummary = workNotificationSummary(item);
  if (workSummary) return workSummary;
  if (item.kind === 'discover.published') {
    const author = item.actor_username || '你关注的作者';
    const type = item.listing_kind === 'agent' ? '智能体' : '作品';
    return `${author} 发布了新${type}` + (item.title ? `「${item.title}」` : '');
  }
  if (item.kind === 'meeting.shared') {
    const organizer = item.organizer || '会议组织者';
    return `${organizer} 分享了纪要` + (item.title ? `「${item.title}」` : '');
  }
  if (item.kind === 'team.owner_transferred') return `你已成为「${item.team_name || '工作区'}」的所有者`;
  if (item.kind === 'team.run_shared') {
    return `${item.actor_username || '成员'} 分享了协作结果` + (item.title ? `「${item.title}」` : '');
  }
  if (item.kind === 'messenger.mention') {
    const author = item.by?.display_name || item.by?.handle || '成员';
    return `${author} 提及了你`;
  }
  if (item.kind === 'messenger.added') {
    const author = item.by?.display_name || item.by?.handle || '成员';
    return `${author} 将你加入「${item.title || '群聊'}」`;
  }
  if (item.kind === 'messenger.call') {
    const author = item.by?.display_name || item.by?.handle || '成员';
    const kind = item.call_kind === 'video' ? '视频通话' : '语音通话';
    return item.title ? `${author} 在「${item.title}」发起了${kind}` : `${author} 发起了${kind}`;
  }
  const where = item.conversation_kind === 'dm' ? '单聊' : (item.conversation_title || '群聊');
  if (item.kind === 'automation_reminder') {
    return `提醒到点：${item.title || '回看一条消息'}`;
  }
  if (item.kind === 'agent_reply') {
    const outcome = {succeeded: '已完成', failed: '未能完成', cancelled: '已取消'}[item.status] || '已结束';
    return `${item.actor_username || '智能体'} 在「${where}」${outcome}你的请求`;
  }
  return `${item.actor_username || '成员'} 在「${where}」提及了你`;
}

// A reminder is not a separate store: it is a one-shot automation created from the
// message, and its due time is listed as a derived notification.

function zoneClock(ts, zone) {
  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = {};
    for (const part of format.formatToParts(new Date(ts))) {
      if (part.type !== 'literal') parts[part.type] = Number(part.value);
    }
    if (!Number.isFinite(parts.year)) return null;
    return {...parts, hour: parts.hour % 24};
  } catch {
    return null;
  }
}

export function zonedInstant(dateText, timeText, zone) {
  const [year, month, day] = String(dateText || '').split('-').map(Number);
  const [hour, minute] = String(timeText || '').split(':').map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = zoneClock(guess, zone);
  if (!first) return null;
  const offset = Date.UTC(first.year, first.month - 1, first.day, first.hour, first.minute, first.second) - guess;
  const settled = zoneClock(guess - offset, zone);
  const finalOffset = settled
    ? Date.UTC(settled.year, settled.month - 1, settled.day, settled.hour, settled.minute, settled.second) - (guess - offset)
    : offset;
  return guess - finalOffset;
}

export function zoneDayKey(ts, zone) {
  const clock = zoneClock(ts, zone);
  if (!clock) return '';
  return `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`;
}

// One-shot automations that already came due, shown in the chat sidebar.
// Participants may be {user_id, username} (legacy) or {username} (DS-Bot plugin).
export function dueReminders(items, user, now = Date.now()) {
  const userId = user && typeof user === 'object' ? user.id : user;
  const username = user && typeof user === 'object' ? user.username : undefined;
  const today = [];
  const older = [];
  for (const item of items || []) {
    if (!item || item.enabled === false || item.enabled === 0) continue;
    const schedule = item.schedule || {};
    if (schedule.kind !== 'once' || !schedule.date || !schedule.time || !schedule.time_zone) continue;
    const mine = (item.participants || []).some(person => person && (
      (userId && person.user_id === userId)
      || (username && person.username === username)
      || (!person.user_id && person.username && (person.username === userId || person.username === username))
    ));
    if (!mine) continue;
    const due = zonedInstant(schedule.date, schedule.time, schedule.time_zone);
    if (due === null || due > now) continue;
    const row = {id: item.id, title: item.title || '', due, schedule};
    if (zoneDayKey(due, schedule.time_zone) === zoneDayKey(now, schedule.time_zone)) today.push(row);
    else older.push(row);
  }
  today.sort((left, right) => right.due - left.due);
  older.sort((left, right) => right.due - left.due);
  return {today, older};
}

export function reminderDueLabel(item, now = Date.now()) {
  const zone = (item.schedule && item.schedule.time_zone) || 'UTC';
  const clock = zoneClock(item.due, zone);
  const time = clock ? `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}` : (item.schedule && item.schedule.time) || '';
  if (zoneDayKey(item.due, zone) === zoneDayKey(now, zone)) return `今天 ${time} 到点`;
  return `${String((item.schedule && item.schedule.date) || '').slice(5)} ${time} 到点`;
}

export const REMINDER_CHOICES = [['remind-1h', 'later'], ['remind-tomorrow', 'tomorrow']];

function zonedParts(moment, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(moment);
  const pick = (type) => {
    const found = parts.find((part) => part.type === type);
    return found ? found.value : '';
  };
  return {date: `${pick('year')}-${pick('month')}-${pick('day')}`, time: `${pick('hour')}:${pick('minute')}`};
}

export function readableTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function reminderSchedule(choice, now = new Date(), timeZone = readableTimeZone()) {
  if (choice === 'tomorrow') {
    const today = zonedParts(now, timeZone).date.split('-').map(Number);
    const next = new Date(Date.UTC(today[0], today[1] - 1, today[2] + 1));
    return {kind: 'once', date: next.toISOString().slice(0, 10), time: '09:00', time_zone: timeZone};
  }
  const later = zonedParts(new Date(now.getTime() + 3600000), timeZone);
  return {kind: 'once', date: later.date, time: later.time, time_zone: timeZone};
}

export function reminderTitle(text) {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '提醒：回看一条消息';
  return '提醒：' + (collapsed.length > 40 ? `${collapsed.slice(0, 39)}…` : collapsed);
}

export function reminderPayload(item, choice, now, timeZone, username) {
  const excerpt = String((item && item.body) || '').replace(/\s+/g, ' ').trim();
  return {
    title: reminderTitle(item && item.body),
    prompt: excerpt ? `提醒我回看这条消息：${excerpt.slice(0, 600)}` : '提醒我回看一条消息。',
    template_id: 'reminder',
    schedule: reminderSchedule(choice, now, timeZone),
    participants: [username],
    scope: 'once',
    intent: '',
    agents: [],
  };
}

export function reminderKey(messageId) {
  return 'remind-' + String(messageId || '');
}

export function reminderNotice(status, body = {}) {
  const schedule = body && body.automation && body.automation.schedule;
  const when = schedule && schedule.date && schedule.time ? `${schedule.date} ${schedule.time}` : '';
  if (status === 201) return when ? `已设提醒：${when}。` : '已设提醒。';
  if (status === 200) return when ? `这条消息已经设过提醒：${when}。` : '这条消息已经设过提醒。';
  if (status === 403) return '只有工作区所有者或管理员可以设提醒。';
  if (status === 429) return '这个工作区的自动化数量已达上限，先删掉一条再设提醒。';
  if (status === 409) return '这个工作区已经有同名提醒，请到自动化页调整。';
  return '没能设成提醒，请稍后再试。';
}

const NOTIFICATION_ID = /^[0-9a-f]{32}$/;
const NOTIFICATION_SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const MEETING_NOTIFICATION_PATH = /^\/meetings#workspace=([0-9a-f]{32})&shared=([0-9a-f]{32})$/;
const TEAM_RUN_SHARE = /^otsr_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const LINKED_NOTIFICATION_KINDS = new Set(['meeting.shared', 'discover.published', 'follow_work', 'artifact.shared', 'automation_reminder', 'team.owner_transferred', AUTOMATION_RUN_FINISHED]);

export function notificationTarget(item, workspace) {
  if (item?.kind === 'automation_reminder') return '/automations';
  if (item?.kind === AUTOMATION_RUN_FINISHED) {
    const {workspace_id, automation_id:automation, run_id:run} = item;
    if (workspace_id !== workspace || ![workspace, automation, run].every(id => typeof id === 'string' && NOTIFICATION_ID.test(id))) return null;
    const target = '/automations?' + new URLSearchParams({workspace, automation, run});
    return item.path == null || item.path === target ? target : null;
  }
  if (item?.kind === 'team.owner_transferred') {
    if (!NOTIFICATION_ID.test(workspace || '') || item.workspace_id !== workspace) return null;
    return '/members#' + new URLSearchParams({workspace});
  }
  if (item?.kind === 'team.run_shared') {
    if (!NOTIFICATION_ID.test(workspace || '') || item.workspace_id !== workspace || !TEAM_RUN_SHARE.test(item.share_id || '')) return null;
    const target = '/team-runs#' + new URLSearchParams({workspace, shared: item.share_id});
    return item.path == null || item.path === target ? target : null;
  }
  if (item?.kind === 'meeting.shared') {
    const path = typeof item.path === 'string' ? MEETING_NOTIFICATION_PATH.exec(item.path) : null;
    const share = item.share_id ?? path?.[2];
    if (!NOTIFICATION_ID.test(workspace || '') || !NOTIFICATION_ID.test(share || '')
      || (item.workspace_id != null && item.workspace_id !== workspace)) return null;
    const target = '/meetings#' + new URLSearchParams({workspace, shared: share});
    return item.path == null || item.path === target ? target : null;
  }
  if (item?.kind !== 'discover.published' || item.listing_kind !== 'agent') {
    return workNotificationTarget(item, workspace);
  }
  const prefix = '/a/';
  const slug = item.slug ?? (typeof item.path === 'string' && item.path.startsWith(prefix) ? item.path.slice(prefix.length) : '');
  if (typeof slug !== 'string' || !NOTIFICATION_SLUG.test(slug)) return null;
  const target = prefix + slug;
  return item.path == null || item.path === target ? target : null;
}

async function waitForLinkedNotificationRead(read) {
  let timer;
  const timeout = new Promise(resolve => { timer = globalThis.setTimeout(resolve, 500); });
  try { return await Promise.race([read, timeout]); }
  finally { globalThis.clearTimeout(timer); }
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const uiLabel = (zh, en) => document.documentElement?.lang === 'en' ? en : zh;
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  let currentUser = null;
  let workspaces = [];
  let agents = [];
  let members = [];
  let socialConversations = [];
  let sessions = [];
  let currentAgent = null;
  let personalAgentId = '';
  let personalWorkspaceId = '';
  const servedByDsbot = dsbotServed(document);
  let personalLook = null;
  let currentConversation = null;
  const pinButton = document.getElementById('pin-conversation');
  const groupPin = document.getElementById('group-info-pin');
  const conversationPins = new Map();
  const reactionWrites = new Map();
  let pinReceipt = 0;
  let sessionTransition = null;
  let currentSource = 'agent';
  const workspaceInvite = mountWorkspaceInvite(document, {
    request,
    context() {
      if (!servedByDsbot || !currentUser || !currentConversation || currentConversation.public_agent) return null;
      const space = workspaces.find(item => item.id === workspaceId());
      if (!space || space.kind === 'personal' || !canManage(space.role)) return null;
      if (currentConversation.workspace_id && currentConversation.workspace_id !== space.id) return null;
      return {workspace:space.id,scope:sendScope()};
    },
  });
  const loadGroupManagement = deferModule('./group-management.mjs');
  let groupManagement;
  let lastGroupInfo = '';
  let groupInfoOpener;
  const groupManagementReceipts = new Map();
  const loadStickers = deferModule('./stickers.mjs');
  let stickerPicker;
  const stickerSaves = new Map();
  const messageUtilities = mountMessageUtilities(document, {
    request, notify: show, formatAnnouncementTime: value => formatTime(value / 1000),
    composerContext: () => {
      if (!currentConversation && !(currentSource === 'agent' && currentAgent)) return null;
      const wid = workspaceId();
      return {wid, cid:currentConversation?.id, source:currentSource, scope:sendScope(),
        studio:servedByDsbot && workspaces.some(item => item.id === wid && item.kind === 'team')};
    },
    context: () => currentSource === 'social' && currentConversation && !currentConversation.public_agent
      ? {wid: workspaceId(), cid: currentConversation.id, kind: currentConversation.kind} : null,
    stickersAvailable: () => Boolean(stickerContext()),
    async activateStickers() {
      const target = stickerContext();
      if (!target) return;
      const {mountChatStickers} = await loadStickers();
      if (target.scope !== stickerContext()?.scope) return;
      stickerPicker ||= mountChatStickers(document, {request, context:stickerContext, send:sendSticker});
      return stickerPicker.open();
    },
    closeStickers: () => stickerPicker?.close(),
  });
  const autoTranslation = mountGroupTranslation(document,{request});
  const callContext = () => {
    if (!servedByDsbot || currentSource !== 'social' || !currentConversation || currentConversation.public_agent || currentConversation.direct?.open === false) return null;
    return {wid: workspaceId(), cid: currentConversation.id, title: conversationLabel(currentConversation, currentUser?.id)};
  };
  const loadCalls = deferModule('./calls.mjs');
  let calls;
  let meetingOpening = 0;
  async function initializeCalls() {
    if (calls) return calls;
    const {mountChatCalls} = await loadCalls();
    if (!calls) {
      calls = mountChatCalls(document, {request, context: callContext, account: () => currentUser?.id ?? null});
      calls.sync();
    }
    return calls;
  }
  const chatCalls = {
    sync() {
      if (calls) calls.sync();
      else if (callContext()) void initializeCalls().catch(() => {});
    },
    async resumeMeeting() {
      const hash = location.hash;
      const owner = currentUser;
      try {
        const controller = calls ?? await initializeCalls();
        if (owner === currentUser && hash === location.hash) controller.resumeMeeting();
      } catch {
        if (owner === currentUser && hash === location.hash) {
          show('error', uiLabel('暂时无法打开会议，请刷新后重试。', 'Couldn’t open the meeting. Reload and try again.'));
        }
      }
    },
    async openMeeting(action) {
      const opening = ++meetingOpening;
      if (calls) return calls.openMeeting(action);
      const owner = currentUser;
      if (!owner) return;
      const loading = uiLabel('正在打开会议…', 'Opening meeting…');
      show('loading', loading);
      try {
        const controller = await initializeCalls();
        if (owner !== currentUser || opening !== meetingOpening) return;
        if (status.textContent === loading) show('', '');
        controller.openMeeting(action);
      } catch {
        if (owner === currentUser && opening === meetingOpening && status.textContent === loading) {
          show('error', uiLabel('暂时无法打开会议，请再试一次。', 'Couldn’t open the meeting. Try again.'));
        }
      }
    },
  };
  let groupMentions = null;
  const agentMentions = mountAgentMentions(document, () => {
    const direct = directAgentRoom(currentConversation);
    if (!currentUser || currentSource !== 'social' || !currentConversation || currentConversation.public_agent ||
        (currentConversation.kind !== 'group' && !direct)) return null;
    return {scope:sendScope(), agents:currentConversation.agent_members || [],
      members:currentConversation.members || [], viewerId:currentUser.id, direct};
  }, (targets, stale) => {
    groupMentions = {scope:sendScope(), targets, stale};
    renderGroupComposerRouting();
  });
  function voiceContext() {
    if (!currentUser || currentSource !== 'social' || !currentConversation ||
        currentConversation.public_agent || currentConversation.direct?.open === false) return null;
    return {owner:currentUser.id, wid:workspaceId(), cid:currentConversation.id, scope:sendScope()};
  }
  const voiceRecorder = mountVoiceRecorder(document, {
    context: voiceContext,
    createKey: () => idempotencyKey('voice-'),
    async send(destination, voice, key) {
      const {owner, wid, cid, scope} = destination;
      const stillHere = () => voiceContext()?.scope === scope;
      if (!stillHere()) return;
      const reply = replyDrafts.get(scope);
      if (reply?.available === false) throw new Error(uiLabel('请先确认或取消引用。', 'Check or remove the quote before sending.'));
      const target = {owner, wid, conversationId:cid};
      const isVoice = message => Boolean(message?.voice);
      const result = await request('POST', `/v1/workspaces/${wid}/social/conversations/${cid}/messages`,
        {voice, ...(reply ? {reply_to: reply.message_id} : {})}, {'Idempotency-Key': key}, AbortSignal.timeout(15000))
        .catch(() => ({status:0,body:{}}));
      const saved = result.body?.message;
      let message = [200,201].includes(result.status) && isVoice(saved) &&
        (!servedByDsbot || ownSocialReceipt(saved,target,key)) ? saved : null;
      if (!message && servedByDsbot && unclearSocialDelivery(result.status)) {
        message = await socialSendReceipt(target,key,stillHere,isVoice);
      }
      if (!message) {
        throw new Error(messageFor(result.body?.error, uiLabel('语音发送失败，请重试。', 'Could not send the voice message. Try again.')));
      }
      consumeReplyDraft(scope, reply);
      if (stillHere()) {
        const olderWindow = socialHistory?.readingHistory && message.seq > (lastSocialItems.at(-1)?.seq ?? 0) + 1;
        renderDeliveredSocialMessage(scope, message);
        show('ok', uiLabel('语音已发送。', 'Voice message sent.'), {announceOnly: !olderWindow});
        if (olderWindow && viewingSocialMessages()) void openSocialLatest();
      } else if (owner === currentUser?.id && wid === workspaceId()) {
        void loadSessions();
      }
    },
  });
  const voiceUrls = new Set();
  function clearVoicePlayers() {
    for (const url of voiceUrls) URL.revokeObjectURL(url);
    voiceUrls.clear();
  }
  globalThis.addEventListener?.('pagehide', clearVoicePlayers);

  function voicePlayer(item) {
    const player = document.createElement('section');
    player.className = 'voice-message';
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = '播放语音';
    const destination = voiceContext();
    if (!destination) return player;
    play.addEventListener('click', async () => {
      if (play.disabled || voiceContext()?.scope !== destination.scope) return;
      play.disabled = true;
      play.textContent = '正在加载…';
      try {
        const path = `/v1/workspaces/${destination.wid}/social/conversations/${destination.cid}/messages/${item.id}/voice`;
        const result = await request('GET', path);
        if (result.status !== 200) throw new Error('Voice unavailable');
        if (voiceContext()?.scope !== destination.scope || player.isConnected === false) return;
        const url = URL.createObjectURL(decodeVoice(result.body));
        voiceUrls.add(url);
        const audio = document.createElement('audio');
        audio.src = url;
        audio.controls = true;
        audio.preload = 'metadata';
        audio.setAttribute('aria-label', '语音消息');
        player.replaceChildren(audio);
        audio.focus();
        audio.play().catch(() => {});
      } catch {
        play.textContent = '重试播放语音';
        play.disabled = false;
        show('error', '无法播放语音，请重试。');
      }
    });
    player.append(play);
    return player;
  }

  let pollTimer = 0;
  let searchTab = 'all';
  let searchConversation = '';
  let searchConversationTitle = '';
  let searchFromSessionList = true;
  let composeMode = 'group';
  let groupMode = 'custom';
  const groupReplyDrafts = new Map();
  const groupReplyBusy = new Set();
  let groupReplyFormScope = '';
  let agentRosterView;
  const agentRosterSheet = document.getElementById('conversation-agents-sheet');
  let searchSeq = 0;
  let resourceCursor = '';
  let resourceItems = [];
  let sendShortcut = 'enter';
  let chatLanguage = 'auto';
  const defaultChatPreferences = {message_folding:'standard', document_cards:false, link_previews:true};
  let chatPreferences = defaultChatPreferences;
  let chatSettings = null;
  let attachmentSender;
  const pendingSends = new Map();
  const privateReplyRetries = new Map();
  const stoppingPrivateReplies = new Set();
  const replyStopButton = document.getElementById('chat-reply-stop');
  const privateThreadWrites = new Map();
  const privateThreadReceipts = new Map();
  let privateThreadReceipt = 0;
  const agentReplyViews = new Map();
  let replyWatch = null;
  const approvalNotice = mountChatApprovalNotice(document, {request});
  const sendScope = (conversation = currentConversation?.id) =>
    JSON.stringify([currentUser?.id, workspaceId(), currentSource, currentAgent?.id, conversation]);
  const readingPositions = new Map();
  const sessionRows = new Map();
  const publicDraft = mountPublicDraft(document, {onChange: sessionDraftChanged});
  const starterPanel = document.getElementById('agent-quick-starts');
  const starterList = document.getElementById('agent-quick-starts-list');
  const starterStatus = document.getElementById('agent-quick-starts-status');
  const starterComposer = document.getElementById('chat-body');
  let starterView = null;
  let starterRefresh = null;
  starterComposer.addEventListener('input', () => setAgentStarterStatus(''));

  const memoryRecall = document.getElementById('agent-memory-recall');
  const memoryDrafts = new Map();
  const memoryWrites = new Map();
  const recallMode = scope => currentConversation?.memory_scope ?? memoryDrafts.get(scope)
    ?? ((currentConversation?.memory_recall ?? currentAgent?.memory_recall_default ?? true) ? 'workspace' : 'off');

  function syncMemoryRecall(scope = sendScope()) {
    if (!memoryRecall) return;
    const visible = servedByDsbot && currentSource === 'agent' && Boolean(currentAgent) && !currentConversation?.deferred;
    memoryRecall.hidden = !visible;
    if (!visible) return;
    memoryRecall.value = memoryWrites.get(scope) ?? recallMode(scope);
    memoryRecall.disabled = memoryWrites.has(scope) || Boolean(pendingSends.get(scope)?.jobs.some(job => !job.failed));
  }

  memoryRecall?.addEventListener('change', async () => {
    if (memoryRecall.hidden || memoryRecall.disabled) return;
    const scope = sendScope();
    const mode = memoryRecall.value;
    if (!currentConversation) {
      memoryDrafts.set(scope,mode);
      syncMemoryRecall(scope);
      return;
    }
    const path = `${agentBase()}/conversations/${currentConversation.id}`;
    memoryWrites.set(scope,mode);
    renderPendingSend();
    try {
      const result = await request('POST',path,{memory_scope:mode});
      if (sendScope() !== scope) return;
      if (result.status !== 200 || result.body.memory_scope !== mode) throw new Error();
      currentConversation.memory_scope = mode;
      currentConversation.memory_recall = result.body.memory_recall;
      show('ok', mode === 'off' ? '已关闭后续消息的记忆检索。' : mode === 'workspace'
        ? '后续消息将参考本工作区的记忆。' : '后续消息将参考可访问工作区里的记忆和行动项。', {announceOnly:true});
    } catch {
      if (sendScope() === scope) show('error','记忆范围未保存，请重试。');
    } finally {
      memoryWrites.delete(scope);
      if (sendScope() === scope) renderPendingSend();
    }
  });

  const replyDrafts = new Map();
  const replyPanel = document.getElementById('chat-reply-preview');
  const replyDraftTitle = document.getElementById('chat-reply-author');
  const replyDraftBody = document.getElementById('chat-reply-excerpt');
  const replyDraftRetry = document.getElementById('chat-reply-retry');
  const replyDraftKey = scope => 'flybot-workspace.chat-quote:' + scope;
  const quoteBlocksSend = scope => replyDrafts.get(scope)?.available === false;
  document.getElementById('chat-body').addEventListener('input', renderGroupComposerRouting);

  function groupUsesLegacyAutoReplies(conversation) {
    const routing = conversation?.group_agent_routing;
    const mode = routing?.policy?.mode ?? 'default';
    return conversation?.kind === 'group' && !conversation.public_agent && !routing?.native_group_host && mode === 'default';
  }

  function renderGroupComposerRouting() {
    const node = document.getElementById('group-composer-routing');
    const conversation = currentSource === 'social' && currentConversation?.kind === 'group' &&
      !currentConversation.public_agent ? currentConversation : null;
    const scope = sendScope();
    const mentions = groupMentions?.scope === scope ? groupMentions : null;
    const agents = (conversation?.agent_members || []).filter(agent => !agent.archived && !agent.native_deleted);
    const routing = conversation?.group_agent_routing;
    const policy = routing?.policy;
    const body = document.getElementById('chat-body').value;
    const everyone = conversation && hasEveryoneMention(body);
    node.hidden = !conversation || quoteBlocksSend(scope);
    if (node.hidden) return;
    const people = countMentionedGroupMembers(body, {members:conversation.members, viewerId:currentUser?.id});
    const hasFiles = Boolean(attachmentSender?.draftFiles(scope).length);
    const quote = routing && activeGroupAgent(conversation, replyDrafts.get(scope)?.agentTarget);
    const auto = groupUsesLegacyAutoReplies(conversation) && agents.some(agent => agent.auto_reply);
    let text, kind = 'default';
    let asksAgents = false;
    if (everyone) {
      kind = 'targeted';
      asksAgents = agents.length > 0;
      text = asksAgents ? uiLabel('将提及所有人，并请群内智能体回复', 'Everyone in the group will be mentioned and its agents asked to reply')
        : uiLabel('将提及群内所有成员', 'Everyone in the group will be mentioned');
    } else if (hasGroupAllMention(body)) {
      kind = 'targeted';
      asksAgents = agents.length > 0;
      text = asksAgents ? uiLabel('将请所有群内智能体回复', 'All group agents will be asked to reply')
        : uiLabel('群里暂无可回复的智能体', 'There are no group agents available to reply');
    } else if (mentions?.stale) {
      kind = 'attention';
      text = uiLabel('请移除不可用的智能体后再发送。', 'Remove unavailable agents before sending.');
    } else if (mentions?.targets.length) {
      kind = 'targeted';
      asksAgents = true;
      const count = mentions.targets.length;
      text = people
        ? uiLabel(`将提及 ${people} 位成员，并请 ${count} 位智能体回复`,
          `Mention ${people} ${people === 1 ? 'member' : 'members'} and ask ${count} ${count === 1 ? 'agent' : 'agents'} to reply`)
        : uiLabel(`已指定 ${count} 位智能体回复`, `${count} ${count === 1 ? 'agent' : 'agents'} selected to reply`);
    } else if (people) {
      kind = 'targeted';
      text = uiLabel(`将提及 ${people} 位群成员`, `${people} group ${people === 1 ? 'member' : 'members'} will be mentioned`);
    } else if (hasFiles) {
      text = agents.length
        ? uiLabel('用 @ 请智能体根据附言回复', 'Use @ to ask agents to reply to the caption')
        : uiLabel('附件将发送给群成员', 'The files will be shared with the group');
    } else if (policy?.mode === 'mentions' && agents.length) {
      text = uiLabel('仅在被 @ 时回复 · 可用 @所有人', 'Agents reply only when mentioned · Use @all to ask them all');
    } else if (quote) {
      kind = 'targeted';
      text = uiLabel(`将请 ${quote.name} 回复这条引用`, `${quote.name} will be asked to reply to this quote`);
    } else if (policy?.mode === 'everyone') {
      text = uiLabel('由群内智能体按内容决定是否回复 · 可用 @所有人', 'Group agents decide whether to reply · Use @all to ask them all');
    } else if (policy?.mode === 'lead') {
      const lead = !policy.lead_unavailable && activeGroupAgent(conversation, policy.lead);
      if (lead) text = uiLabel(`${lead.name} 优先判断是否回复 · 可用 @所有人`, `${lead.name} decides whether to reply first · Use @all to ask them all`);
      else {
        kind = 'attention';
        text = agents.length
          ? uiLabel('优先智能体不可用 · 由其他智能体判断是否回复', 'Preferred agent unavailable · Other agents decide whether to reply')
          : uiLabel('群里暂无可回复的智能体', 'There are no group agents available to reply');
      }
    } else if (!agents.length) text = uiLabel('用 @所有人提及群内所有成员', 'Use @all to mention everyone in the group');
    else if (auto) text = uiLabel('开启自动回复的智能体判断是否回复 · 可用 @所有人',
      'Agents with auto-reply enabled decide whether to reply · Use @all to ask all agents');
    else text = uiLabel('由群内智能体按内容决定是否回复 · 可用 @所有人', 'Group agents decide whether to reply · Use @all to ask them all');
    if (hasFiles && asksAgents) {
      if (!body.trim()) {
        kind = 'attention';
        text = uiLabel('写一段附言，让选中的智能体知道要回复什么。', 'Add a caption for the selected agents to answer.');
      } else {
        text += uiLabel(' · 按附言回复', ' · Replies use the caption');
      }
    }
    const label = document.getElementById('group-composer-routing-text');
    if (label.textContent !== text) label.textContent = text;
    node.dataset.kind = kind;
  }

  function renderReplyDraft() {
    if (!replyPanel) return;
    const scope = sendScope();
    const reply = currentSource === 'social' && replyDrafts.get(scope);
    replyPanel.hidden = !reply;
    const state = reply?.state || '';
    const title = !reply ? '' : state ? uiLabel('回复引用', 'Reply quote') : uiLabel('回复 ' + reply.author, 'Reply to ' + reply.author);
    const excerpt = state === 'checking' ? uiLabel('正在核对原消息…', 'Checking the original message…')
      : state === 'retry' ? uiLabel('无法核对原消息，请重试或取消引用。', 'Couldn’t check the original message. Retry or remove the quote.')
        : state === 'missing' ? uiLabel('原消息已不可用，请取消引用。', 'The original message is unavailable. Remove the quote to send.')
          : reply?.excerpt || '';
    if (replyDraftTitle.textContent !== title) replyDraftTitle.textContent = title;
    if (replyDraftBody.textContent !== excerpt) replyDraftBody.textContent = excerpt;
    if (replyDraftRetry) replyDraftRetry.hidden = state !== 'retry';
    const changed = (replyPanel.dataset.state || '') !== state;
    replyPanel.dataset.state = state;
    syncComposerSend(scope);
    if (changed) syncPlusState();
    renderGroupComposerRouting();
  }

  function setReplyDraft(scope, reply) {
    if (reply) replyDrafts.set(scope, reply);
    else replyDrafts.delete(scope);
    try {
      const storage = document.defaultView?.sessionStorage;
      if (reply) storage?.setItem(replyDraftKey(scope), reply.message_id);
      else storage?.removeItem(replyDraftKey(scope));
    } catch {}
    if (sendScope() === scope) renderReplyDraft();
  }

  async function restoreReplyDraft(items, {allowLookup = true, retry = false} = {}) {
    if (currentSource !== 'social' || !currentUser || !currentConversation?.id) return;
    const scope = sendScope();
    const current = replyDrafts.get(scope);
    let id = current?.message_id;
    if (!id) {
      try { id = document.defaultView?.sessionStorage?.getItem(replyDraftKey(scope)); } catch {}
    }
    if (!chatPathId(id)) return;
    const cid = currentConversation.id;
    const wid = workspaceId();
    const matching = item => item.id === id && (!item.conversation_id || item.conversation_id === cid)
      && (!item.workspace_id || item.workspace_id === wid);
    const pending = {message_id:id, available:false, state:'checking'};
    const apply = item => setReplyDraft(scope, item && !item.retracted
      ? composerReply(item, socialMessageAuthor(item)) : {...pending, state:'missing'});
    const visible = items.find(matching);
    if (visible) {
      if (!current?.available || visible.retracted) apply(visible);
      return;
    }
    if (!allowLookup || current?.available || (!retry && current?.state === 'missing')) return;
    setReplyDraft(scope, pending);
    const query = new URLSearchParams({around:id, limit:'1'});
    const result = await request('GET', `${socialBase()}/${cid}/messages?${query}`, undefined, undefined, AbortSignal.timeout(4500))
      .catch(() => ({status:0}));
    if (sendScope() !== scope || replyDrafts.get(scope) !== pending) return;
    if (result.status === 200 || [403,404,410].includes(result.status)) {
      const items = result.status === 200 && Array.isArray(result.body?.items) ? result.body.items : [];
      apply(items.find(matching));
    } else setReplyDraft(scope, {...pending, state:'retry'});
  }

  function socialMessageAuthor(item, people = currentConversation?.members || members) {
    if (item.role === 'agent') return item.reply_job_id ? groupReplyAuthor(item)
      : (item.agent_name || uiLabel('智能体', 'Agent')) + uiLabel(' · AI 智能体 · 运行时回复', ' · AI agent · DS-Bot');
    if (item.user_id === currentUser?.id) return uiLabel('我', 'Me');
    return people.find(entry => entry.user_id === item.user_id)?.username || uiLabel('成员', 'Member');
  }

  function composerReply(item, author) {
    const excerpt = String(item.body || item.attachment?.title || (item.voice ? '语音消息' : '消息'))
      .replace(/\s+/g, ' ').trim().slice(0, 120);
    const agentTarget = item.role === 'agent' && item.agent_id && item.agent_owner_id ?
      {agent_id:item.agent_id, owner_id:item.agent_owner_id} : undefined;
    return {message_id: item.id, author, excerpt, available: true, agentTarget};
  }

  function composeReply(item, author) {
    if (currentSource !== 'social' || item.retracted) return;
    setReplyDraft(sendScope(), composerReply(item, author));
    document.getElementById('chat-body').focus();
  }

  function consumeReplyDraft(scope, reply) {
    if (reply && replyDrafts.get(scope) === reply) {
      setReplyDraft(scope, null);
    }
  }

  document.getElementById('chat-reply-cancel')?.addEventListener('click', () => {
    consumeReplyDraft(sendScope(), replyDrafts.get(sendScope()));
    document.getElementById('chat-body').focus();
  });
  replyDraftRetry?.addEventListener('click', () => void restoreReplyDraft(lastSocialItems, {retry:true}));

  function quoteBlock(reply, interactive = false) {
    const canJump = interactive && reply.available;
    const element = document.createElement(canJump ? 'button' : 'div');
    element.className = 'message-quote';
    if (!reply.available) {
      element.textContent = reply.state === 'checking' ? uiLabel('回复引用', 'Reply quote') : '原消息不可查看';
      return element;
    }
    const name = document.createElement('strong');
    const excerpt = document.createElement('span');
    name.textContent = reply.author;
    excerpt.textContent = reply.excerpt;
    element.append(name, excerpt);
    if (canJump) {
      element.type = 'button';
      element.setAttribute('aria-label', '查看 ' + reply.author + ' 的原消息');
      element.addEventListener('click', async () => {
        const scope = sendScope();
        if (await jumpToMessage(reply.message_id, null) === false && sendScope() === scope) {
          show('error', '原消息已不可查看。');
        }
      });
    }
    return element;
  }

  function show(kind, text, {announceOnly = false} = {}) {
    status.dataset.kind = kind;
    status.dataset.announceOnly = String(announceOnly);
    status.textContent = text;
  }

  function sendClosed() {
    return Boolean(sessionTransition?.pending) || (currentSource === 'social'
      ? currentConversation?.public_agent?.open === false || currentConversation?.direct?.open === false
      : Boolean(currentAgent?.archived || currentAgent?.native_deleted || currentConversation?.archived || currentConversation?.open === false));
  }

  function syncComposerSend(scope = sendScope()) {
    document.getElementById('chat-send').disabled = sendClosed() || memoryWrites.has(scope) || quoteBlocksSend(scope);
  }

  function stickerContext() {
    if (!servedByDsbot || !currentUser || sendClosed() || currentConversation?.public_agent) return null;
    if (currentSource === 'agent' ? !currentAgent : !currentConversation) return null;
    return {owner:currentUser.id, scope:sendScope()};
  }

  function syncStickers() {
    stickerPicker?.sync();
    const scope = stickerContext()?.scope;
    for (const [controller, origin] of stickerSaves) {
      if (origin !== scope) controller.abort();
    }
  }

  function resetStickerSurface() {
    for (const controller of stickerSaves.keys()) controller.abort();
    stickerPicker?.close();
    const dialog = document.getElementById('composer-emoji-dialog');
    if (dialog?.open) dialog.close();
  }

  function renderMessageFile(attachment) {
    const card = renderChatFile(document, attachment);
    const target = stickerContext();
    if (!target || !['image/png','image/jpeg','image/gif','image/webp'].includes(attachment.mime)
        || !attachment.bytes || attachment.bytes > 8 * 1024 * 1024 || !attachment.path) return card;
    const save = document.createElement('button');
    save.type = 'button';
    save.dataset.saveSticker = '1';
    save.textContent = uiLabel('存为贴纸', 'Save as sticker');
    save.addEventListener('click', async () => {
      if (target.scope !== stickerContext()?.scope || save.disabled) return;
      save.disabled = true;
      const controller = new AbortController();
      stickerSaves.set(controller, target.scope);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      const scopedRequest = (...args) => {
        if (target.scope !== stickerContext()?.scope) throw new Error('Sticker source changed');
        return request(...args);
      };
      let result;
      try {
        const {saveChatSticker} = await loadStickers();
        signal.throwIfAborted();
        result = await saveChatSticker({request:scopedRequest, attachment, signal});
      } catch {} finally {
        stickerSaves.delete(controller);
      }
      if (target.scope !== stickerContext()?.scope || controller.signal.aborted) return;
      const saved = [200, 201].includes(result?.status) && Boolean(result.body?.sticker?.id);
      save.disabled = saved;
      if (saved) save.textContent = uiLabel('已存为贴纸', 'Sticker saved');
      show(saved ? 'ok' : 'error', saved ? uiLabel('已保存到贴纸库。', 'Saved to your stickers.')
        : uiLabel('无法保存贴纸，请重试。', 'Couldn’t save the sticker. Try again.'), {announceOnly:saved});
    });
    card.append(save);
    return card;
  }

  function setAgentStarterStatus(message) {
    if (starterStatus.hidden && !message) return;
    starterStatus.textContent = message;
    starterStatus.hidden = !message;
  }

  function nativeStarterAgent(agent) {
    return servedByDsbot && currentUser?.id && currentSource === 'agent' && agent?.id
      && agent.id === currentAgent?.id && agent.workspace_id === workspaceId() && agent.served_by === 'ds-bot';
  }

  function renderAgentQuickStarts(agent) {
    const eligible = nativeStarterAgent(agent) && !agent.archived && !agent.native_deleted
      && !currentConversation?.archived && currentConversation?.open !== false;
    const values = eligible && Array.isArray(agent.quick_starts)
      ? agent.quick_starts.slice(0, 5).flatMap(value =>
        typeof value === 'string' && value.trim() && value.trim().length <= 80 ? [value.trim()] : [])
      : [];
    const scope = sendScope();
    const key = values.length ? JSON.stringify([scope, values]) : '';
    if (key === (starterView?.key ?? '')) return;
    const view = values.length ? {key, scope} : null;
    starterView = view;
    starterPanel.hidden = !view;
    setAgentStarterStatus('');
    const buttons = values.map(text => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.title = text;
      button.addEventListener('click', () => {
        if (starterView !== view || view.scope !== sendScope() || mainPanel.hidden || starterComposer.disabled) return;
        const original = starterComposer.value;
        const next = original && original !== text ? original + '\n\n' + text : text;
        const limit = starterComposer.maxLength > 0 ? starterComposer.maxLength : 4000;
        if (next.length > limit) {
          setAgentStarterStatus('输入框里的草稿已保留。缩短后可添加这条开场。');
          return;
        }
        starterComposer.value = next;
        starterComposer.dispatchEvent(new Event('input', {bubbles: true}));
        starterComposer.focus({preventScroll: true});
        starterComposer.setSelectionRange?.(next.length, next.length);
      });
      return button;
    });
    starterList.replaceChildren(...buttons);
    starterList.scrollLeft = 0;
  }

  async function refreshAgentQuickStarts() {
    if (!nativeStarterAgent(currentAgent) || mainPanel.hidden || !viewingSocialMessages()) return;
    const scope = sendScope();
    const open = socialOpen;
    if (starterRefresh?.scope === scope && starterRefresh.open === open) return;
    const next = {scope, open};
    starterRefresh = next;
    const result = await request('GET', agentBase()).catch(() => ({status: 0}));
    if (starterRefresh !== next) return;
    starterRefresh = null;
    if (open !== socialOpen || scope !== sendScope() || document.visibilityState === 'hidden') return;
    const agent = result.body?.agent;
    if (result.status === 200 && nativeStarterAgent(agent)) {
      currentAgent = agent;
      renderAgentQuickStarts(currentAgent);
    } else if ([200, 403, 404, 410].includes(result.status)) {
      currentAgent = {...currentAgent, quick_starts: []};
      renderAgentQuickStarts();
    }
  }

  function renderPendingSend() {
    const list = document.getElementById('message-list');
    const scope = sendScope();
    const queue = pendingSends.get(scope);
    const closed = sendClosed();
    document.getElementById('chat-form').hidden = currentSource === 'agent' && currentConversation?.archived === true;
    document.getElementById('chat-body').disabled = closed;
    syncComposerSend(scope);
    syncPrivateReplyStop();
    agentMentions.refresh();
    syncStickers();
    syncPrivateThreadControls();
    syncMemoryRecall(scope);
    const replying = queue?.replying;
    if (replying && !replying.replyView) {
      replying.replyView = makeAgentMessage({role: 'assistant', status: 'queued', client_key: replying.key}).replyView;
      if (replying.replyView) replying.replyView.bubble.dataset.sendPending = 'reply';
    }
    const replyBubble = replying?.replyView?.bubble;
    const bubbles = new Set((queue?.jobs || []).map(job => job.bubble));
    if (replyBubble) bubbles.add(replyBubble);
    for (const child of Array.from(list.children)) {
      if (child.dataset.sendPending && !bubbles.has(child)) child.remove();
      bubbles.delete(child);
    }
    for (const job of queue?.jobs || []) {
      paintSendJob(job);
      if (bubbles.has(job.bubble)) list.append(job.bubble);
      if (job === replying && bubbles.has(replyBubble)) {
        const children = Array.from(list.children);
        const next = children[children.indexOf(job.bubble) + 1];
        if (next) list.insertBefore(replyBubble, next);
        else list.append(replyBubble);
      }
    }
    if (currentSource === 'agent' && currentAgent) {
      const pending = Boolean(replying) || lastAgentItems.some(waitingAgentReply);
      const label = pending ? uiLabel('正在回复…', 'Replying…') : currentConversation?.deferred
        ? uiLabel('草稿 · 发送首条消息后保存对话', 'Draft · Send the first message to save this chat')
        : uiLabel('AI 智能体 · 经运行时回复', 'AI agent · DS-Bot');
      setChatSubtitle(currentConversation?.title_edited ? `${currentAgent.name} · ${pending ? label : 'DS-Bot'}` : label, pending);
    }
    const empty = document.getElementById('chat-empty');
    empty.dataset.agent = String(currentSource === 'agent' && Boolean(currentAgent));
    empty.hidden = list.children.length > 0;
  }

  function paintSendJob(job) {
    if (job.status.textContent !== job.state) job.status.textContent = job.state;
    job.status.hidden = Boolean(job.replyView);
    job.bubble.dataset.sendPending = job.failed ? 'failed' : 'pending';
    job.actions.hidden = !job.failed;
    job.retry.disabled = sendClosed() || memoryWrites.has(sendScope());
    const action = job.quoteUnavailable ? uiLabel('恢复到输入框', 'Restore to composer') : uiLabel('重试', 'Retry');
    if (job.retry.textContent !== action) job.retry.textContent = action;
  }

  function restoreUnavailableQuote(queue, job) {
    if (sendScope() !== queue.scope || sendClosed()) return false;
    const input = document.getElementById('chat-body');
    if (input.value || replyDrafts.has(queue.scope) || attachmentSender?.draftFiles?.(queue.scope)?.length ||
        !agentMentions.restoreDraft(job.message.agent_mentions)) return false;
    if (job.files.length && !attachmentSender?.addFiles(job.files, queue.scope, {stage:true})) return false;
    input.value = job.message.body;
    publicDraft.persist();
    setReplyDraft(queue.scope, {message_id:job.reply.message_id, state:'missing', available:false});
    removeSendJob(queue, job);
    return true;
  }

  function makeSendJob(queue, message, files, reply, sticker, sendKey) {
    const firstText = servedByDsbot && !queue.social && !queue.conversationId &&
      !queue.jobs.length && !files.length && !reply && !sticker;
    const key = sendKey || (firstText ? queue.createKey : idempotencyKey(queue.social ? 'socialmsg-' : files.length ? 'agent-files-' : 'msg-'));
    const bubble = document.createElement('li');
    bubble.className = queue.social ? 'mine' : 'user';
    const body = document.createElement('div');
    body.className = 'body';
    renderMessageBody(document, body, message.body || '', chatPreferences);
    body.hidden = !message.body;
    const status = document.createElement('p');
    status.className = 'send-feedback';
    status.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'send-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试';
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.textContent = '移除';
    actions.append(retry, discard);
    if (reply) bubble.append(quoteBlock(reply));
    bubble.append(body);
    if (sticker) bubble.append(renderChatFile(document, {...sticker,sticker:true}, {pending:true}));
    const previews = [];
    for (const file of files) {
      const {card, preview} = localChatFile(document, file);
      if (preview) previews.push(preview);
      bubble.append(card);
    }
    const progress = files.length ? chatUploadProgress(document, uiLabel('上传进度', 'Upload progress')) : null;
    bubble.append(status);
    if (progress) bubble.append(progress);
    bubble.append(actions);
    const job = {key, message, reply, files, previews, progress, bubble, status, actions, retry, failed: false,
      state: queue.active ? '等待发送…' : '正在发送…'};
    retry.addEventListener('click', () => {
      if (!job.failed || job.retry.disabled) return;
      if (job.quoteUnavailable) {
        if (restoreUnavailableQuote(queue, job)) {
          renderPendingSend();
          document.getElementById('chat-body').focus({preventScroll:true});
        } else {
          job.state = uiLabel('请先处理输入框中的草稿、引用或提及，再恢复这条消息。',
            'Finish or clear the current draft, quote, or mentions before restoring this message.');
          paintSendJob(job);
        }
        return;
      }
      job.failed = false;
      job.state = '等待发送…';
      paintSendJob(job);
      if (!queue.social) resumePrivateSending();
      void drainSends(queue);
    });
    discard.addEventListener('click', () => {
      removeSendJob(queue, job);
      renderPendingSend();
    });
    return job;
  }

  function removeSendJob(queue, job, {keepStored = false} = {}) {
    queue.jobs = queue.jobs.filter(item => item !== job);
    if (job.storedText && !keepStored) savePendingChatText(document.defaultView, queue.scope, job.key);
    job.bubble.remove();
    job.replyView?.bubble.remove();
    for (const url of job.previews) document.defaultView.URL.revokeObjectURL(url);
    if (!queue.jobs.length && !queue.active && pendingSends.get(queue.scope) === queue) pendingSends.delete(queue.scope);
  }

  function clearPendingSends() {
    stopReplyProgress();
    stopGroupReplyProgress();
    stopPolling();
    for (const queue of pendingSends.values()) {
      for (const job of queue.jobs) removeSendJob(queue,job,{keepStored:true});
    }
    pendingSends.clear();
    reactionWrites.clear();
    forwarding.clear();
    uncertainForwards.clear();
    forwardNotice = null;
    privateReplyRetries.clear();
    stoppingPrivateReplies.clear();
    privateThreadWrites.clear();
    privateThreadReceipts.clear();
    groupManagementReceipts.clear();
    hiddenMessageReceipts.clear();
    if (hideDialog?.open) hideDialog.close();
    closePrivateThreadDialogs();
    resetStickerSurface();
  }

  function pendingMessageKeys() {
    return new Set((pendingSends.get(sendScope())?.jobs || []).map(job => job.key));
  }

  function uncertainPrivateWrite(result) {
    const status = result?.status || 0;
    return !status || status === 408 || status >= 500 ||
      ([200, 201, 202].includes(status) && (!result?.body?.message?.id || !result?.body?.reply?.id));
  }

  function privateReplyPair(body, target, key) {
    const {message, reply} = body || {};
    const scoped = item => item?.id && item.client_key === key &&
      (!item.workspace_id || item.workspace_id === target.wid) && (!item.agent_id || item.agent_id === target.agentId) &&
      (!item.conversation_id || item.conversation_id === target.conversationId);
    return message?.role === 'user' && reply?.role === 'assistant' && scoped(message) && scoped(reply) && message.id !== reply.id
      ? {message, reply} : null;
  }

  function privateHistoryAfterSends(items, sends) {
    if (!sends?.length) return items;
    const delivered = new Map();
    for (const {delivery} of sends) {
      if (!delivery) continue;
      delivered.set(delivery.message.id, delivery.message);
      delivered.set(delivery.reply.id, delivery.reply);
    }
    if (!delivered.size) return items;
    const reconciled = items.map(item => {
      const receipt = delivered.get(item.id);
      delivered.delete(item.id);
      return receipt && waitingAgentReply(item) && !waitingAgentReply(receipt) ? receipt : item;
    });
    return [...reconciled, ...delivered.values()];
  }

  async function privateSendReceipt(target, key, current, accept = () => true, delays = [0, 350, 800]) {
    const query = new URLSearchParams({key, receipt: '1'});
    const path = `${target.base}/${target.conversationId}/reply-progress?${query}`;
    for (const delay of delays) {
      if (delay) await new Promise(resolve => globalThis.setTimeout(resolve, delay));
      if (!current()) return null;
      const result = await request('GET', path, undefined, undefined, AbortSignal.timeout(3000)).catch(() => null);
      if (!current()) return null;
      const pair = result?.status === 200 && privateReplyPair(result.body, target, key);
      if (pair && accept(pair.reply)) return pair;
      if (result && ![200, 404].includes(result.status) && !uncertainPrivateWrite(result)) return null;
    }
    return null;
  }

  function confirmPostedSend(queue, job) {
    job.receipt ||= privateSendReceipt(queue, job.key, () => queue.owner === currentUser?.id &&
      pendingSends.get(queue.scope) === queue && queue.jobs.includes(job)).finally(() => { job.receipt = null; });
    return job.receipt;
  }

  async function socialSendReceipt(target, key, current, isExpected = () => true) {
    const active = () => target.owner === currentUser?.id && current();
    if (!active()) return null;
    const path = `/v1/workspaces/${target.wid}/social/conversations/${target.conversationId}/messages?limit=50`;
    const result = await request('GET', path, undefined, undefined, AbortSignal.timeout(4000)).catch(() => null);
    if (!active() || result?.status !== 200 || !Array.isArray(result.body?.items)) return null;
    return result.body.items.find(message => ownSocialReceipt(message, target, key) && isExpected(message)) || null;
  }

  async function request(method, path, body, extra, signal, {keepalive = false} = {}) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie), ...(extra || {})};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin', signal,
      ...(keepalive ? {keepalive} : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  function inPersonalWorkspace() {
    return servedByDsbot && workspaces.some(space => space.id === workspaceId() && space.kind === 'personal');
  }

  function contactMembers(result) {
    return (result.body?.items || []).filter(row => row.status === 'accepted' && row.peer?.handle)
      .map(row => ({user_id:row.peer.handle, handle:row.peer.handle, username:row.peer.display_name || row.peer.handle, contact:true}));
  }

  function agentBase() {
    return `/v1/workspaces/${workspaceId()}/agents/${currentAgent && currentAgent.id}`;
  }

  function socialBase() {
    return `/v1/workspaces/${workspaceId()}/social/conversations`;
  }

  const messageSearch = createMessageSearch(async (query, conversationId, cursor) => {
    const result = await request(
      'GET',
      `/v1/workspaces/${workspaceId()}/search/messages?${messageSearchQuery(query, conversationId, cursor)}`,
    );
    if (result.status !== 200) throw new Error(messageFor(result.body.error, '无法搜索消息。'));
    return result.body;
  });

  function groupReplyDraft(scope) {
    if (groupReplyDrafts.has(scope)) return groupReplyDrafts.get(scope);
    try {
      const saved = JSON.parse(document.defaultView.sessionStorage.getItem('flybot-workspace.group-reply-draft:' + scope) || 'null');
      const keys = groupAgentKeys(saved?.agentKeys ?? saved?.agentIds);
      if (typeof saved?.prompt === 'string' && saved.prompt.length <= 4000 && keys) {
        const reference = studioRevisionReference(saved.studioReference);
        const studioDocumentId = typeof saved.studioDocumentId === 'string' && PRIVATE_THREAD_ID.test(saved.studioDocumentId)
          ? saved.studioDocumentId : reference?.document_id || '';
        const attempt = saved.attempt;
        const attemptReference = studioRevisionReference(attempt?.studioReference);
        const attemptKeys = groupAgentKeys(attempt?.agentKeys ?? attempt?.agentIds);
        const legacyIds = Array.isArray(attempt?.agentIds) && attempt.agentIds.every(id =>
          typeof id === 'string' && GROUP_AGENT_ID.test(id)) ? attempt.agentIds : null;
        const validAttempt = typeof attempt?.key === 'string' && /^[a-zA-Z0-9_-]{16,64}$/.test(attempt.key)
          && typeof attempt.prompt === 'string' && validMessage(attempt.prompt)
          && attemptKeys && attemptKeys.length > 0 && attemptKeys.length <= 5
          && (attempt.agentIds == null || (legacyIds &&
            legacyIds.join(',') === attemptKeys.map(key => groupAgentTarget(key).agent_id).sort().join(',')))
          && (attempt.studioReference == null || attemptReference);
        const draft = {
          prompt: saved.prompt, agentKeys: keys, studioDocumentId,
          studioReference: reference?.document_id === studioDocumentId ? reference : null,
          attempt: validAttempt
            ? {key: attempt.key, prompt: attempt.prompt, agentKeys: attemptKeys, agentIds: legacyIds,
              studioReference: attemptReference} : null,
        };
        groupReplyDrafts.set(scope, draft);
        return draft;
      }
    } catch {}
    return {prompt: '', agentKeys: [], studioDocumentId: '', studioReference: null, attempt: null};
  }

  function saveGroupReplyDraft(scope, draft) {
    const hasDraft = Boolean(draft.prompt || draft.agentKeys.length || draft.studioDocumentId || draft.attempt);
    if (hasDraft) groupReplyDrafts.set(scope, draft);
    else groupReplyDrafts.delete(scope);
    try {
      const storage = document.defaultView.sessionStorage;
      const key = 'flybot-workspace.group-reply-draft:' + scope;
      if (hasDraft) storage.setItem(key, JSON.stringify(draft));
      else storage.removeItem(key);
    } catch {}
  }

  const groupReplyCheckedAgents = () => [...document.querySelectorAll('#group-agent-choices input[name="group-agent"]:checked')];
  const sameGroupReplyRequest = (attempt, prompt, agentKeys, studioReference) => attempt?.prompt === prompt
    && attempt.agentKeys.join(',') === agentKeys.join(',') && sameStudioReference(attempt.studioReference, studioReference);

  function rememberGroupReplyDraft() {
    if (!groupReplyFormScope || groupReplyFormScope !== sendScope()) return;
    saveGroupReplyDraft(groupReplyFormScope, {...groupReplyDraft(groupReplyFormScope),
      prompt: document.getElementById('group-agent-prompt').value,
      agentKeys: groupReplyCheckedAgents().map(box => box.value).sort()});
  }

  function confirmGroupReplyDraft(scope, key) {
    const draft = groupReplyDraft(scope);
    if (!key || draft.attempt?.key !== key) return false;
    const clearPrompt = sameGroupReplyRequest(draft.attempt, draft.prompt.trim(), draft.agentKeys, draft.studioReference)
      && draft.studioDocumentId === (draft.attempt.studioReference?.document_id || '');
    saveGroupReplyDraft(scope, {...draft, attempt: null,
      ...(clearPrompt ? {prompt: '', studioDocumentId: '', studioReference: null} : {})});
    if (clearPrompt && groupReplyFormScope === scope && sendScope() === scope) {
      document.getElementById('group-agent-prompt').value = '';
      if (groupStudio?.scope === scope) {
        groupStudio.preview?.abort();
        groupStudio.preview = null;
        groupStudioPanel.open = false;
        clearGroupStudioPreview();
        groupStudioNode('status').textContent = '';
        renderGroupStudioPicker();
      }
    }
    return true;
  }

  const groupStudioNode = id => document.getElementById('group-studio-' + id);
  const groupStudioPanel = document.getElementById('group-studio');
  let groupStudio = null;

  function namedTeamGroup() {
    const workspace = workspaceId();
    return servedByDsbot && currentSource === 'social' && currentConversation?.kind === 'group'
      && !currentConversation.public_agent && !currentConversation.account_group && !currentConversation.direct
      && currentConversation.workspace_id === workspace && workspaces.some(item => item.id === workspace && item.kind === 'team');
  }

  const currentGroupStudio = state => groupStudio === state && state?.scope === sendScope() && namedTeamGroup();
  const groupStudioRevisionLabel = revision => uiLabel('版本 ' + revision, 'Version ' + revision);

  function clearGroupStudioPreview() {
    if (groupStudio) groupStudio.review = null;
    groupStudioNode('preview').hidden = true;
    for (const field of ['title', 'revision', 'excerpt']) groupStudioNode(field).textContent = '';
  }

  function syncGroupStudioPicker() {
    if (!groupStudio) return;
    const draft = groupReplyDraft(groupStudio.scope);
    const select = groupStudioNode('document');
    select.disabled = !groupStudio.items.length && !draft.studioDocumentId;
    groupStudioNode('review').disabled = !draft.studioDocumentId || Boolean(groupStudio.preview);
    groupStudioNode('mark').textContent = draft.studioReference
      ? ' · ' + groupStudioRevisionLabel(draft.studioReference.revision)
      : draft.studioDocumentId ? uiLabel(' · 待确认', ' · Review needed') : '';
  }

  function renderGroupStudioPicker() {
    const draft = groupStudio && groupReplyDraft(groupStudio.scope);
    const select = groupStudioNode('document');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = uiLabel('不引用文档', 'No document reference');
    const rows = [...(groupStudio?.items || [])];
    if (draft?.studioDocumentId && !rows.some(item => item.id === draft.studioDocumentId)) {
      rows.push({id: draft.studioDocumentId, title: uiLabel('已选文档', 'Selected document')});
    }
    select.replaceChildren(none, ...rows.map(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.title;
      return option;
    }));
    select.value = draft?.studioDocumentId || '';
    syncGroupStudioPicker();
  }

  function setGroupStudio(scope = '') {
    if (groupStudio?.scope === scope || (!groupStudio && !scope)) return;
    groupStudio?.controller.abort();
    groupStudio?.preview?.abort();
    groupStudio = scope ? {scope, workspace: workspaceId(), controller: new AbortController(), items: [], loading: false,
      preview: null, review: null, referenceError: false} : null;
    groupStudioPanel.hidden = !groupStudio;
    groupStudioPanel.open = false;
    groupStudioNode('mark').textContent = '';
    groupStudioNode('status').textContent = '';
    groupStudioNode('refresh').hidden = true;
    clearGroupStudioPreview();
    renderGroupStudioPicker();
  }

  function updateGroupStudioDraft(scope, documentId, reference = null) {
    saveGroupReplyDraft(scope, {...groupReplyDraft(scope), studioDocumentId: documentId, studioReference: reference});
    if (groupStudio?.scope === scope) syncGroupStudioPicker();
    if (groupReplyFormScope === scope && scope === sendScope()) syncGroupReplySubmit(scope);
  }

  const groupStudioPath = state => `/v1/workspaces/${state.workspace}/studio/documents`;
  async function loadGroupStudioDocuments() {
    const state = groupStudio;
    if (!currentGroupStudio(state) || state.loading) return;
    state.loading = true;
    const feedback = groupStudioNode('status');
    const refresh = groupStudioNode('refresh');
    refresh.disabled = true;
    if (!state.preview && !state.review && !state.referenceError) feedback.textContent = uiLabel('正在读取团队文档…', 'Loading team documents…');
    const result = await request('GET', groupStudioPath(state), undefined, undefined,
      AbortSignal.any([state.controller.signal, AbortSignal.timeout(12000)])).catch(() => null);
    if (!currentGroupStudio(state)) return;
    state.loading = false;
    refresh.disabled = false;
    refresh.hidden = false;
    if (result?.status !== 200 || !Array.isArray(result.body.items)) {
      if (!state.preview && !state.review && !state.referenceError) feedback.textContent = uiLabel('无法读取团队文档，请重试。', 'Couldn’t load team documents. Try again.');
      return;
    }
    state.items = result.body.items.filter(item => typeof item?.id === 'string' && PRIVATE_THREAD_ID.test(item.id)
      && typeof item.title === 'string');
    renderGroupStudioPicker();
    if (state.preview || state.review || state.referenceError) return;
    const draft = groupReplyDraft(state.scope);
    feedback.textContent = draft.studioDocumentId && !draft.studioReference
      ? uiLabel('请选择并确认要引用的版本。', 'Preview and confirm the version to reference.')
      : state.items.length ? '' : uiLabel('这个团队还没有可引用的文档。', 'This team has no documents to reference.');
  }

  async function previewGroupStudioDocument() {
    const state = groupStudio;
    if (!currentGroupStudio(state)) return;
    const {scope} = state;
    const id = groupReplyDraft(scope).studioDocumentId;
    if (!id) return;
    state.preview?.abort();
    const controller = new AbortController();
    state.preview = controller;
    state.referenceError = false;
    clearGroupStudioPreview();
    const feedback = groupStudioNode('status');
    feedback.textContent = uiLabel('正在读取已保存的版本…', 'Loading the saved version…');
    syncGroupStudioPicker();
    syncGroupReplySubmit(scope);
    const result = await request('GET', groupStudioPath(state) + '/' + id, undefined, undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(12000)])).catch(() => null);
    if (!currentGroupStudio(state) || state.preview !== controller || groupReplyDraft(scope).studioDocumentId !== id) return;
    state.preview = null;
    const item = result?.body?.document;
    const reference = studioRevisionReference({document_id: item?.id, revision: item?.revision});
    if (result?.status !== 200 || reference?.document_id !== id || typeof item.title !== 'string' || typeof item.body !== 'string') {
      const unavailable = [403, 404, 410].includes(result?.status);
      feedback.textContent = unavailable ? uiLabel('这个团队文档已不可用，请选择其他文档或取消引用。', 'This document is unavailable. Select another document or remove the reference.')
        : uiLabel('无法预览文档，请重试。', 'Couldn’t preview the document. Try again.');
      state.referenceError = true;
      if (unavailable) updateGroupStudioDraft(scope, id);
      syncGroupStudioPicker();
      syncGroupReplySubmit(scope);
      return;
    }
    state.review = reference;
    if (!sameStudioReference(reference, groupReplyDraft(scope).studioReference)) updateGroupStudioDraft(scope, id);
    const characters = [...item.body];
    groupStudioNode('title').textContent = item.title;
    groupStudioNode('revision').textContent = groupStudioRevisionLabel(reference.revision);
    groupStudioNode('excerpt').textContent = characters.slice(0, STUDIO_EXCERPT_LIMIT).join('')
      || uiLabel('正文为空。', 'This document has no text.');
    groupStudioNode('truncated').hidden = characters.length <= STUDIO_EXCERPT_LIMIT;
    groupStudioNode('preview').hidden = false;
    feedback.textContent = '';
    syncGroupStudioPicker();
    syncGroupReplySubmit(scope);
  }

  function syncGroupReplySubmit(scope) {
    const button = document.getElementById('group-agent-submit');
    const busy = groupReplyBusy.has(scope);
    const draft = groupReplyDraft(scope);
    const pendingReview = groupStudio?.scope === scope && (groupStudio.preview || (draft.studioDocumentId && !draft.studioReference));
    button.disabled = busy || Boolean(pendingReview) || !document.getElementById('group-agent-choices').querySelector('input:not(:disabled)');
    const label = button.firstElementChild || button;
    label.textContent = busy ? uiLabel('发送中…', 'Sending…') : uiLabel('发送并请求回复', 'Send and request a reply');
  }

  function groupAgentOwnerLabel(agent) {
    if (agent.mine !== false) return uiLabel('我的', 'Mine');
    return agent.owner_name || agent.owner_handle || uiLabel('群成员', 'Group member');
  }

  function renderAgentRoster(saved, {direct, paired}) {
    const chips = document.getElementById('group-agent-chips');
    chips.replaceChildren();
    for (const agent of saved) {
      const li = document.createElement('li');
      li.className = 'agent-chip';
      const glyph = document.createElement('span');
      glyph.className = 'group-roster-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = leadGlyph(agent.name);
      const name = document.createElement('span');
      const fullName = paired ? groupAgentName(agent.name, groupAgentOwnerLabel(agent), agent.owner_id,
        agent.mine === false ? agent.owner_handle : '') : agent.name;
      name.className = 'group-roster-name';
      name.textContent = fullName + (agent.archived ? uiLabel('（已归档）', ' (archived)') : '');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = uiLabel('移除', 'Remove');
      const id = agent.id || agent.agent_id;
      remove.dataset.removeAgent = id;
      remove.setAttribute('aria-label', uiLabel(`移除 ${fullName}`, `Remove ${fullName}`));
      if (direct) {
        remove.dataset.agentOwnerId = agent.owner_id;
      }
      li.append(glyph, name);
      if (direct ? Boolean(agent.owner_id && groupAgentKey(id, agent.owner_id)) : agent.mine !== false) li.append(remove);
      chips.append(li);
    }
  }

  function availableAgentAdditions(catalogue, roster) {
    const joined = new Set(roster.filter(agent => agent.mine !== false).map(agent => agent.id || agent.agent_id));
    return catalogue.filter(agent => !agent.archived && !agent.native_deleted && !joined.has(agent.id));
  }

  function renderAgentAddition(catalogue, roster, {busy = false, retry = false, placeholder = '',
    add = document.getElementById('group-agent-add'), button = document.getElementById('group-agent-add-submit')} = {}) {
    const selected = add.value;
    add.replaceChildren();
    const available = availableAgentAdditions(catalogue, roster);
    if (placeholder) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = placeholder;
      add.append(option);
    }
    for (const agent of available) {
      const option = document.createElement('option');
      option.value = agent.id;
      option.textContent = agent.name;
      add.append(option);
    }
    if (available.some(agent => agent.id === selected)) add.value = selected;
    else if (placeholder) add.value = '';
    add.disabled = busy || !available.length;
    button.textContent = retry ? uiLabel('重试', 'Retry') : uiLabel('添加', 'Add');
    button.disabled = busy || (!retry && (!available.length || (placeholder && !add.value)));
    return available.length;
  }

  const agentRosterCurrent = view => agentRosterView === view && view?.scope === sendScope() && !sendClosed();

  function rosterActivityRevision(version) {
    // Bot Social places the monotonic activity revision after the message sequence.
    return typeof version === 'string' ? Number(/^\d+\.(\d+)\.[01]\.\d+$/.exec(version)?.[1] ?? -1) : -1;
  }

  function rosterAfterRead(conversation) {
    const saved = agentRosterView?.scope === sendScope() ? agentRosterView.roster : null;
    if (!saved || conversation?.id !== saved.id || conversation.workspace_id !== saved.workspace_id) return conversation;
    const revision = rosterActivityRevision(conversation.activity_version);
    return revision < rosterActivityRevision(saved.activity_version)
      ? {...conversation, agent_members:saved.agent_members, group_agent_routing:saved.group_agent_routing}
      : conversation;
  }

  function directAgentStatus(text) {
    const node = document.getElementById('direct-agent-status');
    node.textContent = text;
    node.hidden = !text;
  }

  function renderDirectAgentAddition(view) {
    const count = renderAgentAddition(view.catalogue || [], currentConversation.agent_members || [],
      {busy: view.busy || view.loading, retry:view.failed === true});
    if (view.status) directAgentStatus(view.status);
    else if (view.catalogue && !count) directAgentStatus(uiLabel('暂无可添加的个人智能体。', 'No personal agents available to add.'));
    else directAgentStatus('');
  }

  async function loadDirectAgentCatalogue() {
    const view = agentRosterView;
    if (!view?.direct || !agentRosterCurrent(view) || !agentRosterSheet.open || view.catalogue || view.loading) return;
    const personal = personalWorkspaceId || workspaces.find(space => space.kind === 'personal')?.id;
    view.loading = true;
    view.failed = false;
    view.status = uiLabel('正在加载个人智能体…', 'Loading personal agents…');
    renderDirectAgentAddition(view);
    const result = personal ? await request('GET', `/v1/workspaces/${personal}/agents?limit=100`)
      .catch(() => ({status:0,body:{}})) : {status:0,body:{}};
    if (!agentRosterCurrent(view)) return;
    view.loading = false;
    view.failed = result.status !== 200;
    view.catalogue = view.failed ? null : result.body.items || [];
    view.status = view.failed ? uiLabel('无法加载个人智能体，请重试。', 'Could not load personal agents. Try again.') : '';
    renderDirectAgentAddition(view);
  }

  function renderGroupReplyAction(requests) {
    const panel = document.getElementById('group-agent-action');
    const isGroup = currentSource === 'social' && currentConversation?.kind === 'group' && !currentConversation.public_agent;
    const direct = currentSource === 'social' && directAgentRoom(currentConversation);
    const scope = sendScope();
    panel.hidden = !isGroup && !direct;
    if (panel.hidden) {
      agentRosterSheet.open = false;
      agentRosterView = null;
      setGroupStudio();
      return;
    }
    if (agentRosterView?.scope !== scope || agentRosterView.direct !== direct) {
      agentRosterSheet.open = false;
      agentRosterView = {scope, direct};
    }
    agentRosterView.requests = requests;
    const label = direct ? uiLabel('私聊智能体', 'Chat agents') : uiLabel('群内智能体', 'Group agents');
    document.getElementById('conversation-agents-text').textContent = label;
    document.getElementById('conversation-agents-heading').textContent = label;
    document.getElementById('group-agent-request-help').hidden = direct;
    document.getElementById('direct-agent-help').hidden = !direct;
    document.getElementById('group-agent-form').hidden = direct;
    const list = document.getElementById('group-agent-requests');
    list.hidden = direct;
    const saved = currentConversation.agent_members || [];
    renderGroupRosterSummary(saved, {direct});
    const paired = direct || currentConversation.group_agent_requests === true;
    renderAgentRoster(saved, {direct, paired});
    if (direct) {
      setGroupStudio();
      renderDirectAgentAddition(agentRosterView);
      return;
    }
    directAgentStatus('');
    renderAgentAddition(agents, saved);
    const choices = new Map();
    const ownKeys = new Map();
    for (const agent of saved) {
      if (agent.archived || (!paired && agent.mine === false) || (paired && !agent.owner_id)) continue;
      const id = agent.id || agent.agent_id;
      const key = groupAgentKey(id, paired ? agent.owner_id : undefined);
      if (!key || choices.has(key)) continue;
      choices.set(key, agent);
      if (agent.mine !== false) ownKeys.set(id, key);
    }
    const qualifyOwnKeys = keys => [...new Set(keys.map(key => ownKeys.get(key) || key))].sort();
    const active = new Set((requests || []).filter(item => ['queued', 'running'].includes(item.status))
      .map(item => item.agent_owner_id ? groupAgentKey(item.agent_id, paired ? item.agent_owner_id : undefined)
        : ownKeys.get(item.agent_id)));
    const holder = document.getElementById('group-agent-choices');
    let draft = groupReplyDraft(scope);
    let checked;
    const focusedKey = document.activeElement?.name === 'group-agent' && document.activeElement.value;
    if (groupReplyFormScope === scope) {
      checked = new Set();
      for (const label of holder.children) {
        const box = label.children[0];
        if (box?.checked) checked.add(box.value);
      }
    } else {
      groupReplyFormScope = scope;
      document.getElementById('group-agent-prompt').value = draft.prompt;
      document.getElementById('group-agent-choice-status').textContent = '';
      checked = new Set(draft.agentKeys);
    }
    const keys = qualifyOwnKeys(draft.agentKeys);
    const attemptKeys = draft.attempt && qualifyOwnKeys(draft.attempt.agentKeys);
    if (keys.join(',') !== draft.agentKeys.join(',') ||
        (attemptKeys && attemptKeys.join(',') !== draft.attempt.agentKeys.join(','))) {
      draft = {...draft, agentKeys: keys, attempt: draft.attempt && {...draft.attempt, agentKeys: attemptKeys}};
      saveGroupReplyDraft(scope, draft);
    }
    checked = new Set(qualifyOwnKeys([...checked]));
    holder.replaceChildren();
    const peers = [...choices.values()].filter(agent => agent.mine === false);
    for (const [key, agent] of choices) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'group-agent';
      box.value = key;
      box.dataset.agentId = agent.id || agent.agent_id;
      if (agent.owner_id) box.dataset.agentOwnerId = agent.owner_id;
      box.disabled = active.has(key);
      box.checked = checked.has(key);
      const text = document.createElement('span');
      text.className = 'group-agent-choice-name';
      text.textContent = agent.name;
      if (paired) {
        const owner = document.createElement('span');
        owner.className = 'group-agent-choice-owner';
        const name = groupAgentOwnerLabel(agent);
        const sameLabel = agent.mine === false && agent.owner_handle && peers.some(peer =>
          peer.owner_id !== agent.owner_id && peer.name === agent.name && groupAgentOwnerLabel(peer) === name);
        owner.textContent = ' · ' + name + (sameLabel ? ' (@' + agent.owner_handle + ')' : '');
        text.append(owner);
      }
      if (box.disabled) text.append(document.createTextNode(uiLabel('（回复中）', ' (replying)')));
      label.append(box, text);
      holder.append(label);
      if (focusedKey === key && !box.disabled) box.focus({preventScroll: true});
    }
    const empty = document.getElementById('group-agent-empty');
    empty.hidden = choices.size > 0;
    list.replaceChildren();
    for (const request of (requests || []).filter(item => item.status !== 'passed')) {
      const item = document.createElement('li');
      item.textContent = groupAgentName(request.agent_name, request.agent_owner_name,
        request.agent_owner_id, request.agent_owner_handle) + ' · ' +
        request.prompt + ' · ' + groupReplyStatus(request);
      item.dataset.replyStatus = request.status;
      list.append(item);
    }
    setGroupStudio(namedTeamGroup() ? scope : '');
    syncGroupReplySubmit(scope);
  }

  function renderGroupRosterSummary(saved, {direct}) {
    const count = document.getElementById('conversation-agents-count');
    const preview = document.getElementById('conversation-agents-preview');
    const help = document.getElementById('social-agent-members');
    const available = saved.filter(agent => !agent.archived);
    count.hidden = false;
    count.textContent = String(available.length);
    const previews = available.slice(0, 2).map(agent => {
      const chip = document.createElement('span');
      chip.className = 'group-roster-preview-chip';
      chip.textContent = agent.name;
      return chip;
    });
    if (available.length > previews.length) {
      const extra = document.createElement('span');
      extra.className = 'group-roster-preview-more';
      extra.textContent = `+${available.length - previews.length}`;
      previews.push(extra);
    }
    preview.replaceChildren(...previews);
    preview.hidden = !available.length;
    document.getElementById('group-agent-manage').hidden = direct;
    help.textContent = available.length ? (!currentConversation.group_agent_routing && !direct ? groupAgentSummary(currentConversation) : '')
      : uiLabel('还没有可回复的智能体。', 'There are no agents available to reply.');
    help.hidden = !help.textContent;
  }

  function groupHeaderSubtitle(conversation) {
    const {people, agents} = groupInfoCounts(conversation);
    return uiLabel(`${people} 人`, `${people} ${people === 1 ? 'person' : 'people'}`) +
      (agents ? uiLabel(` · ${agents} 位智能体`, ` · ${agents} ${agents === 1 ? 'agent' : 'agents'}`) : '');
  }

  function stopPolling() {
    if (pollTimer) {
      globalThis.clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }

  function isSearchOpen() {
    return !document.getElementById('search-panel').hidden;
  }

  function setSessionsOpen(open) {
    if (open) {
      document.body.classList.add('sessions-open');
      if (narrowScreen()) stopGroupReplyProgress({preservePreview: true});
    } else document.body.classList.remove('sessions-open');
  }

  function narrowScreen() {
    return typeof globalThis.matchMedia === 'function'
      && globalThis.matchMedia('(max-width: 900px)').matches;
  }

  let sessionsStatus = '';

  function setSessionsStatus(text) {
    sessionsStatus = text;
    const notice = document.getElementById('conversations-status');
    if (notice) {
      notice.textContent = text;
      notice.hidden = !text;
    }
    if (text) document.getElementById('conversations-empty').hidden = true;
  }

  let markingConversationsRead = false;

  const privateRename = document.getElementById('private-thread-rename');
  const privateArchive = document.getElementById('private-thread-archive');
  const privateRestore = document.getElementById('private-thread-restore');
  const privateArchivedState = document.getElementById('private-thread-archived-state');
  const privateArchiveOpen = document.getElementById('private-archive-open');
  const privateNameDialog = document.getElementById('private-thread-dialog');
  const privateNameInput = document.getElementById('private-thread-name');
  const privateNameStatus = document.getElementById('private-thread-name-status');
  const privateNameSave = document.getElementById('private-thread-save-name');
  const privateArchiveDialog = document.getElementById('private-archive-dialog');
  const privateArchiveList = document.getElementById('private-archive-list');
  const privateArchiveStatus = document.getElementById('private-archive-status');
  const privateArchiveMore = document.getElementById('private-archive-more');
  let renameTarget = null;
  let archiveView = null;

  const privateThreadKey = ({owner, wid, aid, cid}) => JSON.stringify([owner, wid, aid, cid]);
  const currentThreadWorkspace = () => servedByDsbot && currentUser?.id && PRIVATE_THREAD_ID.test(workspaceId());
  const threadWorkspaceMatches = target => target.owner === currentUser?.id && target.wid === workspaceId();
  const threadMatches = target => threadWorkspaceMatches(target) && currentSource === 'agent' &&
    target.aid === currentAgent?.id && target.cid === currentConversation?.id;

  function currentPrivateThread() {
    const wid = workspaceId(), aid = currentAgent?.id, cid = currentConversation?.id;
    if (!currentThreadWorkspace() || currentSource !== 'agent' || !PRIVATE_THREAD_ID.test(aid || '') ||
        !PRIVATE_THREAD_ID.test(cid || '') || currentConversation.deferred || currentConversation.workspace_id !== wid ||
        currentConversation.agent_id !== aid ||
        typeof currentConversation.archived !== 'boolean') return null;
    return {owner: currentUser.id, wid, aid, cid, agent: currentAgent, conversation: currentConversation};
  }

  function syncPrivateThreadControls() {
    if (!privateRename) return;
    const target = currentPrivateThread();
    const archived = target?.conversation.archived === true;
    const writing = Boolean(target && privateThreadWrites.has(privateThreadKey(target)));
    privateRename.hidden = !target || archived;
    privateArchive.hidden = !target || archived;
    privateArchivedState.hidden = !archived;
    privateRename.disabled = privateArchive.disabled = privateRestore.disabled = writing;
    if (target?.conversation.title_edited) {
      document.getElementById('chat-title').textContent = privateThreadTitle(target.conversation, target.agent);
    }
  }

  function threadAfterRead(conversation, target, since) {
    if (!conversation) return conversation;
    const receipt = privateThreadReceipts.get(privateThreadKey(target));
    if (receipt && receipt.seq > since) return {...conversation, ...receipt.metadata};
    return conversation;
  }

  function closePrivateThreadDialogs() {
    renameTarget = archiveView = null;
    if (privateNameDialog?.open) privateNameDialog.close();
    if (privateArchiveDialog?.open) privateArchiveDialog.close();
  }

  async function organizePrivateThread(target, action, title) {
    const key = privateThreadKey(target);
    if (!threadWorkspaceMatches(target) || privateThreadWrites.has(key)) return null;
    const operation = {target, action};
    privateThreadWrites.set(key, operation);
    syncPrivateThreadControls();
    const result = await request('POST', agentConversationPath(target.wid, target.aid, target.cid),
      {action, ...(action === 'rename' ? {title} : {})}, undefined, AbortSignal.timeout(10000)).catch(() => ({status: 0, body: {}}));
    if (privateThreadWrites.get(key) !== operation) return null;
    privateThreadWrites.delete(key);
    if (!threadWorkspaceMatches(target)) return null;
    const row = result.body.conversation;
    if (result.status !== 200 || row?.id !== target.cid || row.workspace_id !== target.wid || row.agent_id !== target.aid ||
        typeof row.archived !== 'boolean' || typeof row.title !== 'string') {
      syncPrivateThreadControls();
      return false;
    }
    const metadata = {title: row.title, title_edited: row.title_edited, archived: row.archived, archived_at: row.archived_at};
    privateThreadReceipts.set(key, {seq: ++privateThreadReceipt, metadata, restored: action === 'restore'});
    const previous = sessions.find(item => item.source === 'agent' && item.id === row.id);
    sessions = sessions.filter(item => item !== previous);
    if (!row.archived && !target.agent?.archived && !target.agent?.native_deleted) {
      const preview = previous?.preview === target.conversation.title ? undefined : previous?.preview;
      const activeRow = mergeSessions([{...row, agent: target.agent, preview, unread_count: previous?.unread_count}], [], target.owner)[0];
      if (activeRow) sessions = sortSessions([...sessions, activeRow]);
    }
    if (threadMatches(target)) {
      Object.assign(currentConversation, metadata);
      renderPendingSend();
      renderAgentQuickStarts(currentAgent);
    }
    renderSessions();
    if (archiveView && threadWorkspaceMatches(archiveView.scope)) {
      if (row.archived) archiveView.rows.set(row.id, {...row, agent: target.agent});
      else archiveView.rows.delete(row.id);
      renderPrivateArchive(archiveView);
    }
    return true;
  }

  function renderPrivateArchive(state) {
    const rows = [...state.rows.values()].sort((a, b) => (b.archived_at || b.updated) - (a.archived_at || a.updated));
    privateArchiveList.replaceChildren();
    for (const row of rows) {
      const target = {...state.scope, cid: row.id, aid: row.agent_id, conversation: row, agent: row.agent};
      const item = document.createElement('li');
      item.dataset.archivedConversation = row.id;
      const copy = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = privateThreadTitle(row, row.agent);
      copy.append(name);
      if (row.agent?.name && row.agent.name !== name.textContent) {
        const identity = document.createElement('span');
        identity.textContent = row.agent.name;
        copy.append(identity);
      }
      const actions = document.createElement('div');
      actions.className = 'private-thread-actions';
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = uiLabel('查看', 'Open');
      open.dataset.archiveAction = 'open';
      open.setAttribute('aria-label', uiLabel(`查看「${name.textContent}」`, `Open “${name.textContent}”`));
      open.addEventListener('click', async () => {
        if (archiveView !== state || !threadWorkspaceMatches(target)) return;
        privateArchiveDialog.close();
        if (await openSessionTarget({source: 'agent', cid: row.id, agent: row.agent_id, title: name.textContent})) {
          document.getElementById('chat-title').focus({preventScroll: true});
        }
      });
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = uiLabel('恢复', 'Restore');
      restore.dataset.archiveAction = 'restore';
      restore.setAttribute('aria-label', uiLabel(`恢复「${name.textContent}」`, `Restore “${name.textContent}”`));
      restore.disabled = privateThreadWrites.has(privateThreadKey(target));
      restore.addEventListener('click', async () => {
        if (archiveView !== state || restore.disabled) return;
        restore.disabled = true;
        const result = await organizePrivateThread(target, 'restore');
        if (archiveView !== state || result === null) return;
        restore.disabled = false;
        privateArchiveStatus.textContent = result ? uiLabel('已恢复到会话列表。', 'Restored to conversations.')
          : uiLabel('无法确认恢复结果，请重试。', 'Couldn’t verify the restore. Try again.');
        if (result) document.getElementById('private-archive-heading').focus({preventScroll: true});
      });
      actions.append(open, restore);
      item.append(copy, actions);
      privateArchiveList.append(item);
    }
    privateArchiveMore.hidden = !state.cursor && !state.failed;
    privateArchiveMore.disabled = state.loading;
    privateArchiveMore.textContent = state.failed ? uiLabel('重试', 'Retry') : uiLabel('加载更多', 'Load more');
  }

  async function loadPrivateArchive(state) {
    if (archiveView !== state || state.loading || !threadWorkspaceMatches(state.scope)) return;
    state.loading = true;
    privateArchiveMore.disabled = true;
    privateArchiveStatus.textContent = uiLabel('正在读取归档…', 'Loading archived conversations…');
    const {owner, wid} = state.scope;
    const since = privateThreadReceipt;
    const params = new URLSearchParams({include: 'conversations', conversation_status: 'archived', include_archived: '1', limit: '100'});
    if (state.cursor) params.set('cursor', state.cursor);
    const result = await request('GET', `/v1/workspaces/${wid}/agents?${params}`, undefined, undefined,
      AbortSignal.timeout(10000)).catch(() => ({status: 0, body: {}}));
    if (archiveView !== state || !threadWorkspaceMatches(state.scope)) return;
    state.loading = false;
    state.failed = result.status !== 200 || !Array.isArray(result.body.items) || !Array.isArray(result.body.conversations);
    if (state.failed) {
      privateArchiveStatus.textContent = uiLabel('无法读取归档，请重试。', 'Couldn’t load archived conversations.');
      renderPrivateArchive(state);
      return;
    }
    const byAgent = new Map(result.body.items.map(agent => [agent.id, agent]));
    for (const listed of result.body.conversations) {
      const agent = byAgent.get(listed?.agent_id);
      if (!agent || !PRIVATE_THREAD_ID.test(agent.id) || !PRIVATE_THREAD_ID.test(listed.id) ||
          (listed.workspace_id && listed.workspace_id !== wid) || (agent.workspace_id && agent.workspace_id !== wid)) continue;
      const row = threadAfterRead(listed, {owner, wid, aid: agent.id, cid: listed.id}, since);
      if (row.archived === true) state.rows.set(row.id, {...row, agent});
    }
    const next = result.body.cursor;
    state.cursor = /^\d{1,15}\.[a-f0-9]{32}$/.test(next || '') && next !== state.cursor ? next : '';
    privateArchiveStatus.textContent = state.rows.size ? '' : state.cursor
      ? uiLabel('当前没有结果，可以继续加载。', 'No results on this page. You can load more.')
      : uiLabel('没有已归档的私聊。', 'No archived conversations.');
    renderPrivateArchive(state);
  }

  privateRename?.addEventListener('click', () => {
    const target = currentPrivateThread();
    if (!target || target.conversation.archived || privateRename.disabled) return;
    renameTarget = target;
    privateNameInput.value = target.conversation.title_edited ? target.conversation.title : privateThreadTitle(target.conversation, target.agent);
    privateNameInput.disabled = privateNameSave.disabled = false;
    privateNameStatus.textContent = '';
    privateNameDialog.showModal();
    privateNameInput.focus();
    privateNameInput.select();
  });
  document.getElementById('private-thread-cancel-name')?.addEventListener('click', () => privateNameDialog.close());
  privateNameDialog?.addEventListener('close', () => {
    const target = renameTarget;
    renameTarget = null;
    if (target && threadMatches(target)) (narrowScreen() ? document.getElementById('chat-more') : privateRename).focus();
  });
  document.getElementById('private-thread-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const target = renameTarget;
    if (!target || !threadMatches(target) || privateNameSave.disabled) return;
    const title = privateNameInput.value.trim();
    if (!title || title.length > 120) {
      privateNameStatus.textContent = uiLabel('请输入 1–120 个字符的对话名称。', 'Enter a conversation name of 1–120 characters.');
      return;
    }
    privateNameSave.disabled = privateNameInput.disabled = true;
    privateNameStatus.textContent = uiLabel('正在保存名称…', 'Saving name…');
    const result = await organizePrivateThread(target, 'rename', title);
    if (renameTarget !== target || !privateNameDialog.open || !threadMatches(target)) return;
    if (result) {
      privateNameDialog.close();
      show('ok', uiLabel('对话名称已保存。', 'Conversation renamed.'), {announceOnly: true});
    } else {
      privateNameInput.disabled = privateNameSave.disabled = false;
      privateNameStatus.textContent = uiLabel('无法确认名称是否已保存，请重试。', 'Couldn’t verify the new name. Try again.');
    }
  });
  privateArchive?.addEventListener('click', async () => {
    const target = currentPrivateThread();
    if (!target || target.conversation.archived || privateArchive.disabled) return;
    const opened = socialOpen;
    const result = await organizePrivateThread(target, 'archive');
    if (opened !== socialOpen || !threadMatches(target) || result === null) return;
    if (result) {
      show('ok', uiLabel('对话已归档。', 'Conversation archived.'), {announceOnly: true});
      privateRestore.focus({preventScroll: true});
    } else show('error', uiLabel('无法确认归档结果，请重试。', 'Couldn’t verify the archive. Try again.'));
  });
  privateRestore?.addEventListener('click', async () => {
    const target = currentPrivateThread();
    if (!target?.conversation.archived || privateRestore.disabled) return;
    const opened = socialOpen;
    const result = await organizePrivateThread(target, 'restore');
    if (opened !== socialOpen || !threadMatches(target) || result === null) return;
    if (result) {
      show('ok', uiLabel('已恢复到会话列表。', 'Restored to conversations.'), {announceOnly: true});
      document.getElementById('chat-title').focus({preventScroll: true});
    } else show('error', uiLabel('无法确认恢复结果，请重试。', 'Couldn’t verify the restore. Try again.'));
  });
  privateArchiveOpen?.addEventListener('click', () => {
    if (!currentThreadWorkspace()) return;
    const scope = {owner: currentUser.id, wid: workspaceId()};
    archiveView = {scope, rows: new Map(), cursor: '', loading: false, failed: false};
    renderPrivateArchive(archiveView);
    privateArchiveDialog.showModal();
    document.getElementById('private-archive-heading').focus();
    return loadPrivateArchive(archiveView);
  });
  privateArchiveMore?.addEventListener('click', () => { if (archiveView) return loadPrivateArchive(archiveView); });
  document.getElementById('private-archive-close')?.addEventListener('click', () => privateArchiveDialog.close());
  privateArchiveDialog?.addEventListener('close', () => { archiveView = null; });

  function sessionTargetMatches(target, row) {
    return target?.cid === row.dataset.conversation && target.source === row.dataset.source;
  }

  function syncSessionTransition() {
    const transition = sessionTransition;
    const pending = Boolean(transition?.pending);
    document.getElementById('session-transition').hidden = !transition;
    const message = !transition ? '' : pending
      ? uiLabel(`正在打开「${transition.title}」…`, `Opening “${transition.title}”…`)
      : uiLabel(`无法打开「${transition.title}」。`, `Couldn’t open “${transition.title}”.`);
    document.getElementById('session-transition-status').textContent = message;
    const openingView = document.getElementById('session-opening-view');
    openingView.hidden = !pending;
    openingView.textContent = pending ? message : '';
    const retry = document.getElementById('session-transition-retry');
    retry.hidden = !transition || pending;
    retry.textContent = uiLabel('重试', 'Retry');
    mainPanel.inert = pending;
    for (const item of document.getElementById('conversation-list').children) {
      const row = item.children[0];
      if (pending && sessionTargetMatches(transition, row)) row.setAttribute('aria-busy', 'true');
      else row.removeAttribute('aria-busy');
    }
    renderPendingSend();
  }

  function clearSessionTransition() {
    const transition = sessionTransition;
    if (!transition) return;
    sessionTransition = null;
    transition.controller.abort();
    syncSessionTransition();
  }

  function resumeOpenSession(target) {
    if (target.source !== currentSource || target.cid !== currentConversation?.id ||
        (target.source === 'agent' && target.agent !== currentAgent?.id)) return false;
    const returningFromList = narrowScreen() && document.body.classList.contains('sessions-open');
    if (sessionTransition?.pending) socialOpen += 1;
    clearSessionTransition();
    setSessionsOpen(false);
    if (currentSource === 'social') {
      scheduleUnreadRead();
      syncGroupReplyProgress();
      if (!pollTimer && !socialHistory?.readingHistory) scheduleSocialPoll(currentConversation);
    } else if (!syncReplyProgress() && lastAgentItems.some(waitingAgentReply) && !pollTimer) schedulePoll();
    if (narrowScreen()) document.getElementById('chat-title').focus({preventScroll:true});
    if (returningFromList && currentSource === 'agent') refreshForegroundPrivate();
    return true;
  }

  function readingPositionKey(source, wid, cid, aid) {
    return JSON.stringify([currentUser?.id, wid, source, cid, aid || '']);
  }

  function rememberReadingPosition() {
    const state = currentSource === 'agent' ? privateHistory : socialHistory;
    if (!servedByDsbot || !state || state.owner !== currentUser?.id || state.cid !== currentConversation?.id ||
        !historyScroller.clientHeight) return;
    const key = readingPositionKey(currentSource, state.wid, state.cid, state.aid);
    readingPositions.delete(key);
    if (!state.readingHistory && messageScrollerAtBottom(historyScroller)) return;
    const {id, offset} = chatHistoryAnchor();
    if (!id || !Number.isFinite(offset)) return;
    readingPositions.set(key, {key, id, offset:offset - historyScroller.getBoundingClientRect().top, top:0});
    if (readingPositions.size > 50) readingPositions.delete(readingPositions.keys().next().value);
  }

  function readingPositionAnchor(position) {
    return position && {...position, offset:position.offset + historyScroller.getBoundingClientRect().top};
  }

  async function openSessionTarget(target, {resume = false} = {}) {
    if (sessionTransition?.pending && sessionTransition.cid === target.cid && sessionTransition.source === target.source) return false;
    if (resume && resumeOpenSession(target)) return true;
    rememberReadingPosition();
    sessionTransition?.controller.abort();
    const controller = new AbortController();
    const transition = {...target, pending: true, controller};
    sessionTransition = transition;
    if (narrowScreen()) setSessionsOpen(true);
    syncSessionTransition();
    show('', '');
    const position = !target.message && readingPositions.get(readingPositionKey(target.source, workspaceId(), target.cid, target.agent));
    const exactMessage = target.source === 'agent' ? PRIVATE_THREAD_ID.test(target.message || '') : chatPathId(target.message);
    const message = servedByDsbot && exactMessage ? target.message : '';
    const options = {acknowledge: !target.message, startUnread: target.unread && !target.message, transition, position, message,
      signal:AbortSignal.any([controller.signal, AbortSignal.timeout(12000)])};
    const opened = target.source === 'social' ? await openSocialConversation(target.cid, options)
      : await openAgentConversation(target.agent, target.cid, options);
    if (sessionTransition !== transition) return false;
    if (!opened) {
      transition.pending = false;
      syncSessionTransition();
      show('', '');
      return false;
    }
    clearSessionTransition();
    if (target.message) {
      const open = socialOpen;
      const scope = sendScope();
      const isCurrent = () => open === socialOpen && scope === sendScope() && !sessionTransition?.pending;
      const located = await jumpToMessage(target.message, null, isCurrent, {readWindow: !message});
      if (!located && isCurrent()) show('error', uiLabel('找不到这条来源消息。', 'The original message is unavailable.'));
      if (located || !isCurrent()) return true;
    }
    if (narrowScreen() && !document.body.classList.contains('sessions-open')
      && document.activeElement === document.body) document.getElementById('chat-title').focus();
    return true;
  }

  document.getElementById('session-transition-retry').addEventListener('click', () => {
    if (sessionTransition && !sessionTransition.pending) void openSessionTarget(sessionTransition);
  });

  function draftScopeForSession(session) {
    return JSON.stringify([currentUser?.id, workspaceId(), session.source, session.agent_id, session.id]);
  }

  const visibleSessionUnread = session => session.muted ? 0 : session.unread_count;

  function paintSessionPreview({button, preview, session}, value) {
    const unread = visibleSessionUnread(session);
    const draft = value.trim().replace(/\s+/g, ' ').slice(0, 160);
    if (draft) {
      const mark = document.createElement('span');
      mark.className = 'session-draft-label';
      mark.textContent = uiLabel('草稿', 'Draft');
      preview.replaceChildren(mark, document.createTextNode(draft));
    } else fillBold(document, preview, session.preview || '');
    button.setAttribute('aria-label', sessionDisplayGroup(session) + '：' + session.title +
      (unread ? uiLabel(`，${unread} 条未读消息`, `, ${unread} unread`) : '') +
      (session.muted ? '，免打扰' : '') + (draft ? uiLabel('，有未发送的草稿', ', unsent draft') : ''));
  }

  function sessionDraftChanged(scope, text, previous) {
    const row = sessionRows.get(scope);
    if (document.getElementById('session-filter-value')?.value === 'drafts' && Boolean(text.trim()) !== Boolean(previous.trim())) {
      if (row || sessions.some(session => draftScopeForSession(session) === scope)) renderSessions();
    } else if (row) paintSessionPreview(row, text);
  }

  function clearComposerDrafts() {
    publicDraft.clear();
    for (const row of sessionRows.values()) paintSessionPreview(row, '');
    sessionRows.clear();
  }

  function renderSessions() {
    const list = document.getElementById('conversation-list');
    const active = document.activeElement;
    const focused = active?.parentElement?.parentElement === list ? active.dataset : null;
    let nextFocus;
    if (privateArchiveOpen) privateArchiveOpen.hidden = !currentThreadWorkspace();
    sessionRows.clear();
    const filterNode = document.getElementById('session-filter-value');
    const filter = (filterNode && filterNode.value) || 'all';
    const draftFor = item => currentUser ? publicDraft.lookup(draftScopeForSession(item), item.kind === 'public') : '';
    const visible = sessions.filter(item => filter === 'all'
      || (filter === 'agent' && item.source === 'agent')
      || (filter === 'personal' && item.source === 'agent' && item.agent_id === personalAgentId)
      || (filter === 'pinned' && item.pinned)
      || (filter === 'drafts' && Boolean(draftFor(item).trim()))
      || (filter === 'unread' && visibleSessionUnread(item) > 0)
      || (filter === 'read' && !item.unread_count)
      || (filter === 'group' && item.kind === 'group') || (filter === 'dm' && item.kind === 'dm'));
    const heading = filter === 'drafts' ? uiLabel('草稿', 'Drafts') : uiLabel('对话', 'Conversations');
    document.getElementById('conversation-heading').textContent = `${heading} · ${visible.length}`;
    const empty = document.getElementById('conversations-empty');
    empty.hidden = Boolean(sessionsStatus) || visible.length > 0;
    if (!empty.hidden) empty.textContent = filter === 'drafts' ? uiLabel('还没有未发送的草稿。', 'No unsent drafts.') : filter === 'all'
      ? '还没有对话。用右上角的 + 新建群组或前往智能体目录。' : '当前筛选下没有对话。';
    const readAll = document.getElementById('conversations-read-all');
    if (readAll) {
      readAll.hidden = !sessions.some(item => item.source === 'social' && visibleSessionUnread(item) > 0);
      readAll.disabled = markingConversationsRead;
    }
    const items = [];
    const portraits = new Map(agents.map(agent => [agent.id,agent.portrait]));
    let lastGroup = '';
    const now = Date.now();
    for (const session of groupSessionsForDisplay(visible)) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-row';
      button.dataset.conversation = session.id;
      button.dataset.source = session.source;
      if (session.agent_id) button.dataset.agent = session.agent_id;
      if (focused?.conversation === session.id && focused.source === session.source) nextFocus = button;
      if (sessionTransition?.pending && sessionTargetMatches(sessionTransition, button)) button.setAttribute('aria-busy', 'true');
      if (currentConversation && currentConversation.id === session.id && currentSource === session.source) {
        button.setAttribute('aria-current', 'true');
      }
      const lookAvatar = session.source === 'agent' && createLookAvatar(agentPortraitLook(session.agent_id,
        portraits.get(session.agent_id), session.agent_id === personalAgentId ? personalLook : null), document);
      const avatar = lookAvatar || document.createElement('span');
      if (!lookAvatar) {
        avatar.className = 'avatar';
        avatar.textContent = initial(session.title);
        avatar.dataset.tone = avatarTone(session.title);
        avatar.dataset.kind = session.kind || session.source || '';
      }
      const copy = document.createElement('span');
      copy.className = 'copy';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = (session.pinned ? '置顶 · ' : '') + session.title;
      const preview = document.createElement('span');
      preview.className = 'preview';
      const row = {button, preview, session};
      sessionRows.set(draftScopeForSession(session), row);
      paintSessionPreview(row, draftFor(session));
      copy.append(title, preview);
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatSessionTime(session.updated, now);
      time.title = formatTime(session.updated);
      button.append(avatar, copy, time);
      if (session.muted) button.classList.add('is-muted');
      const count = visibleSessionUnread(session);
      if (count > 0) {
        button.classList.add('is-unread');
        const unread = document.createElement('span');
        unread.className = 'unread-badge';
        unread.textContent = String(count);
        unread.setAttribute('aria-hidden', 'true');
        time.append(unread);
      }

      const group = sessionDisplayGroup(session);
      if (group !== lastGroup) {
        li.className = 'session-divider'; li.dataset.section = group; lastGroup = group;
      }
      li.append(button);
      items.push(li);
    }
    list.replaceChildren(...items);
    nextFocus?.focus({preventScroll: true});
  }

  function setChatSubtitle(text, busy = false) {
    const line = document.getElementById('chat-subtitle');
    if (!line) return;
    line.textContent = text || '';
    line.hidden = !text;
    if (busy) line.dataset.busy = '1'; else delete line.dataset.busy;
  }

  function memorySources(item) {
    if (item.role !== 'assistant' || item.status !== 'succeeded') return null;
    const wid = workspaceId();
    const citationIds = [wid, currentAgent?.id, currentConversation?.id];
    const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
    const origin = citationIds.every(validId)
      ? [...citationIds, ...(validId(item.id) ? [item.id] : [])].join('.') : '';
    const refs = Array.isArray(item.memory_refs) ? item.memory_refs : [];
    const links = [];
    for (const ref of refs) {
      if (!/^[0-9a-f]{32}$/.test(ref?.id || '') || !/^[0-9a-f]{32}$/.test(ref.workspace_id || '')) continue;
      const workspace = workspaces.find(entry => entry.id === ref.workspace_id);
      if (ref.workspace_id !== wid && !workspace) continue;
      const params = new URLSearchParams({workspace:ref.workspace_id,page:ref.id});
      let title = ref.title || '记忆页';
      if (ref.kind === 'action') {
        params.set('page','todos');
        params.set('action',ref.id);
        title = '行动 · ' + title;
      } else if (Number.isSafeInteger(ref.revision) && ref.revision > 0) params.set('revision',String(ref.revision));
      if (ref.workspace_id !== wid && workspace?.name) title += ' · ' + workspace.name;
      links.push([params,title]);
    }
    if (item.memory_profile_workspace === wid) {
      links.push([new URLSearchParams({workspace:wid, page:'profile'}), '我的资料与偏好']);
    }
    if (!links.length) return null;
    const sources = document.createElement('details');
    sources.className = 'reply-memory-sources';
    const summary = document.createElement('summary');
    summary.textContent = `参考记忆 · ${links.length}`;
    const list = document.createElement('ol');
    for (const [params, title] of links) {
      const row = document.createElement('li');
      const link = document.createElement('a');
      if (origin) params.set('from', origin);
      link.href = '/memory?' + params.toString();
      link.textContent = title;
      row.append(link);
      list.append(row);
    }
    sources.append(summary, list);
    return sources;
  }

  let lastAgentItems = [];
  const captureButton = document.getElementById('history-capture-open');
  const captureDialog = document.getElementById('history-capture-dialog');
  const captureList = document.getElementById('history-capture-list');
  const captureQuery = document.getElementById('history-capture-query');
  const captureMore = document.getElementById('history-capture-more');
  const captureSubmit = document.getElementById('history-capture-submit');
  const captureStatus = document.getElementById('history-capture-status');
  const captureInbox = document.getElementById('history-capture-inbox');
  let captureDraft = null;

  function syncCaptureButton() {
    if (!captureButton) return;
    captureButton.hidden = !servedByDsbot || currentSource !== 'agent' || !currentConversation || currentConversation.deferred
      || !lastAgentItems.some(item => item.role === 'user' && item.body?.trim() && /^[0-9a-f]{32}$/.test(item.id));
  }

  function syncCaptureSelection() {
    const count = captureDraft.selected.size;
    for (const choice of captureDraft.visible) choice.disabled = captureDraft.busy || (!choice.checked && count >= 12);
    captureSubmit.disabled = !count || captureDraft.busy;
    captureSubmit.textContent = captureDraft.busy ? '正在加入队列…' : count ? `提炼 ${count} 条消息` : '提炼所选消息';
  }

  function renderCaptureChoices() {
    if (!captureDraft) return;
    const query = captureQuery.value.trim().toLocaleLowerCase();
    const rows = captureDraft.items.filter(item => item.body.toLocaleLowerCase().includes(query));
    captureDraft.visible = [];
    captureList.replaceChildren();
    for (const item of rows.slice(0,captureDraft.limit)) {
      const label = document.createElement('label');
      const choice = document.createElement('input');
      choice.type = 'checkbox';
      choice.checked = captureDraft.selected.has(item.id);
      choice.addEventListener('change', () => {
        if (choice.checked) captureDraft.selected.add(item.id);
        else captureDraft.selected.delete(item.id);
        syncCaptureSelection();
      });
      const excerpt = document.createElement('span');
      excerpt.textContent = item.body.length > 280 ? item.body.slice(0,280) + '…' : item.body;
      label.append(choice,excerpt);
      captureList.append(label);
      captureDraft.visible.push(choice);
    }
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = '没有找到匹配的消息。';
      captureList.append(empty);
    }
    captureMore.hidden = rows.length <= captureDraft.limit;
    syncCaptureSelection();
  }

  captureButton?.addEventListener('click', () => {
    if (captureButton.hidden || !captureDialog) return;
    const items = lastAgentItems.filter(item => item.role === 'user' && item.body?.trim() && /^[0-9a-f]{32}$/.test(item.id)).reverse();
    if (!items.length) return;
    captureDraft = {scope:sendScope(),items,selected:new Set(),limit:24,busy:false};
    captureQuery.value = '';
    captureStatus.textContent = '';
    captureInbox.href = '/memory?' + new URLSearchParams({workspace:workspaceId(),page:'candidates'});
    captureInbox.hidden = true;
    document.getElementById('chat-more')?.setAttribute('aria-expanded','false');
    renderCaptureChoices();
    captureDialog.showModal();
    captureQuery.focus();
  });
  captureQuery?.addEventListener('input', () => {
    if (!captureDraft) return;
    captureDraft.limit = 24;
    renderCaptureChoices();
  });
  captureMore?.addEventListener('click', () => {
    if (!captureDraft) return;
    captureDraft.limit += 24;
    renderCaptureChoices();
  });
  document.getElementById('history-capture-close')?.addEventListener('click', () => captureDialog.close());
  captureDialog?.addEventListener('close', () => {
    captureDraft = null;
    document.getElementById('chat-more')?.focus();
  });
  document.getElementById('history-capture-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = captureDraft;
    if (!draft || draft.busy || !draft.selected.size || sendScope() !== draft.scope) return;
    draft.busy = true;
    syncCaptureSelection();
    captureStatus.textContent = '';
    const path = `${agentBase()}/conversations/${currentConversation.id}/memory/capture`;
    try {
      const result = await request('POST',path,{message_ids:[...draft.selected]});
      if (captureDraft !== draft || sendScope() !== draft.scope) return;
      if (result.status !== 202) {
        captureStatus.textContent = messageFor(result.body.error,'无法提炼所选消息，请重试。');
        return;
      }
      const {queued,skipped,full} = result.body;
      captureStatus.textContent = [
        queued ? `${queued} 条已加入后台提炼。` : '',
        skipped ? `${skipped} 条已有处理记录。` : '',
        full ? `队列已满，${full} 条可稍后重试。` : '',
      ].filter(Boolean).join(' ');
      captureInbox.hidden = !(queued || skipped);
      if (!full) draft.selected.clear();
      renderCaptureChoices();
    } catch {
      if (captureDraft === draft) captureStatus.textContent = '无法提炼所选消息，请重试。';
    } finally {
      if (captureDraft === draft) { draft.busy = false; syncCaptureSelection(); }
    }
  });

  function waitingAgentReply(item) {
    return item.role === 'assistant' && (item.status === 'queued' || item.status === 'running');
  }

  function messageScrollerAtBottom(scroller, viewportHeight = scroller.clientHeight || 0) {
    return scroller.scrollHeight - scroller.scrollTop - viewportHeight < 48;
  }

  function activeStoppableReply() {
    if (!servedByDsbot || currentSource !== 'agent' || !currentConversation?.id || !currentAgent?.id ||
        sendClosed() || readingPrivateContext()) return null;
    const wid = workspaceId(), agentId = currentAgent.id, conversationId = currentConversation.id;
    const item = lastAgentItems.find(row => row.role === 'assistant' && row.status === 'running' &&
      row.can_stop === true && typeof row.client_key === 'string' && /^[a-f0-9]{32}$/.test(row.id) &&
      Number.isSafeInteger(row.attempt) && row.attempt > 0 &&
      row.workspace_id === wid && row.agent_id === agentId && row.conversation_id === conversationId);
    if (!item) return null;
    const scope = sendScope(), key = item.client_key;
    return {wid, agentId, conversationId, replyId:item.id, attempt:item.attempt, key, scope,
      base:`${agentBase()}/conversations`, operation:JSON.stringify([scope, key, item.attempt])};
  }

  function syncPrivateReplyStop() {
    if (!replyStopButton) return;
    const target = activeStoppableReply();
    const stopping = target && stoppingPrivateReplies.has(target.operation);
    const label = stopping ? uiLabel('正在停止生成…', 'Stopping reply…') : uiLabel('停止生成', 'Stop generating');
    if (!target && document.activeElement === replyStopButton) document.getElementById('chat-body').focus({preventScroll:true});
    replyStopButton.hidden = !target;
    replyStopButton.disabled = Boolean(stopping);
    replyStopButton.setAttribute('aria-label', label);
    replyStopButton.title = label;
  }

  replyStopButton?.addEventListener('click', async () => {
    const target = activeStoppableReply();
    if (!target || stoppingPrivateReplies.has(target.operation)) return;
    stoppingPrivateReplies.add(target.operation);
    syncPrivateReplyStop();
    const current = () => target.scope === sendScope() && stoppingPrivateReplies.has(target.operation);
    const cancelled = reply => reply.id === target.replyId && reply.attempt === target.attempt && reply.status === 'cancelled';
    try {
      const result = await request('POST', `${target.base}/${target.conversationId}/reply-stop`,
        {key:target.key, attempt:target.attempt}, undefined, AbortSignal.timeout(10000)).catch(() => ({status:0}));
      if (!current()) return;
      let pair = result.status === 200 && privateReplyPair(result.body, target, target.key);
      if (!pair || !cancelled(pair.reply)) {
        pair = result.status === 409 ? null : await privateSendReceipt(target, target.key, current, cancelled);
      }
      if (!current()) return;
      if (!pair) {
        await openAgentConversation(target.agentId, target.conversationId, {refresh:true});
        if (current() && activeStoppableReply()?.operation === target.operation) {
          show('error', uiLabel('暂时无法停止这条回复，请重试。', 'Couldn’t stop this reply. Try again.'));
        }
        return;
      }
      privateRefresh += 1;
      const items = lastAgentItems.map(row => row.id === pair.reply.id ? pair.reply : row.id === pair.message.id ? pair.message : row);
      if (renderAgentMessages(items, {followLatest:false})) schedulePoll();
      show('ok', uiLabel('已停止生成。', 'Reply stopped.'), {announceOnly:true});
    } finally {
      stoppingPrivateReplies.delete(target.operation);
      syncPrivateReplyStop();
    }
  });

  function addPrivateReplyRetry(bubble, item) {
    if (!servedByDsbot || item.status !== 'failed' || item.can_retry !== true ||
        !item.client_key || !Number.isSafeInteger(item.attempt) || item.attempt < 1 ||
        !currentConversation?.id || !currentAgent?.id || !/^[a-f0-9]{32}$/.test(item.id || '')) return;
    const scope = sendScope(), key = JSON.stringify([scope, item.id]);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.privateReplyRetry = item.id;
    const actions = document.createElement('div');
    actions.className = 'send-actions';
    actions.append(button);
    bubble.append(actions);
    const sync = () => {
      const operation = privateReplyRetries.get(key);
      button.disabled = sendClosed() || Boolean(operation?.pending);
      button.textContent = operation?.pending ? uiLabel('正在重试…', 'Retrying…')
        : operation ? uiLabel('确认并重试回复', 'Check and retry reply') : uiLabel('重试回复', 'Retry reply');
    };
    sync();
    button.addEventListener('click', async () => {
      if (button.disabled || scope !== sendScope() || sendClosed() || privateReplyRetries.get(key)?.pending) return;
      const opened = socialOpen;
      const target = {owner: currentUser?.id, wid: workspaceId(), agentId: currentAgent.id,
        conversationId: currentConversation.id, base: `${agentBase()}/conversations`};
      let operation = privateReplyRetries.get(key);
      if (!operation || operation.attempt !== item.attempt) operation = {attempt: item.attempt, key: idempotencyKey('reply-')};
      operation.pending = true;
      privateReplyRetries.set(key, operation);
      sync();
      show('', '');
      const path = `${target.base}/${target.conversationId}/messages/${item.id}/retry`;
      const result = await request('POST', path, {attempt: operation.attempt}, {'Idempotency-Key': operation.key},
        AbortSignal.timeout(15000)).catch(() => ({status: 0, body: {}}));
      const ownsOperation = () => privateReplyRetries.get(key) === operation && currentUser?.id === target.owner;
      if (!ownsOperation()) return;
      const confirmed = reply => reply.id === item.id && Number.isSafeInteger(reply.attempt) && reply.attempt > operation.attempt;
      const accepted = [200, 202].includes(result.status);
      let pair = accepted && privateReplyPair(result.body, target, item.client_key);
      if (!pair || !confirmed(pair.reply)) pair = null;
      const uncertain = !pair && (accepted || uncertainPrivateWrite(result));
      if (!pair && (uncertain || result.status === 409)) {
        pair = await privateSendReceipt(target, item.client_key, ownsOperation, confirmed);
      }
      if (!ownsOperation()) return;
      operation.pending = false;
      if (pair || !uncertain) privateReplyRetries.delete(key);
      if (scope !== sendScope()) return;
      if (opened !== socialOpen) {
        if (pair) void openAgentConversation(target.agentId, target.conversationId, {refresh: true});
        else renderAgentMessages(lastAgentItems, {followLatest: false});
        return;
      }
      if (!pair) {
        sync();
        show('error', uncertain ? uiLabel('暂时无法确认回复是否已重试。', 'Couldn’t verify that the reply was retried yet.')
          : uiLabel('无法重试这条回复，请刷新后再试。', 'Couldn’t retry this reply. Refresh and try again.'));
        if (result.status === 409) void openAgentConversation(target.agentId, target.conversationId, {refresh: true});
        return;
      }
      privateRefresh += 1;
      const list = document.getElementById('message-list');
      const focused = document.activeElement === button;
      const items = lastAgentItems.map(row => row.id === pair.reply.id ? pair.reply : row.id === pair.message.id ? pair.message : row);
      if (renderAgentMessages(items, {followLatest: false})) schedulePoll();
      if (focused) {
        const updated = Array.from(list.children).find(row => row.dataset.messageId === item.id);
        if (updated) {
          updated.tabIndex = -1;
          updated.focus({preventScroll: true});
        }
      }
      const notice = sendNotice(pair.reply);
      show(notice.kind, waitingAgentReply(pair.reply) ? uiLabel('已重新请求回复。', 'Retry requested.') : notice.text, notice);
    });
  }

  // Message controls can change while the reader is still using the same body.
  const interactiveMessageBodies = new WeakMap();

  function captureMessageBodies(list, scope) {
    const bodies = new Map();
    const previews = new Map();
    const scroll = [];
    const focused = document.activeElement;
    let restoreFocus = false;
    if (list.dataset.messageBodyScope === scope) {
      for (const row of list.children) {
        const body = Array.from(row.children).find(child =>
          interactiveMessageBodies.has(child) || streamingReplies.get(child)?.markdown);
        if (!body) continue;
        if (interactiveMessageBodies.has(body) && row.dataset.messageId) bodies.set(row.dataset.messageId, body);
        else if (row.dataset.replyProgress) previews.set(row.dataset.replyProgress, body);
        restoreFocus ||= Boolean(focused && body.contains?.(focused));
        for (const node of body.querySelectorAll?.('.chat-markdown-table-scroll, .chat-flowchart, .chat-code-block pre') || []) {
          const left = node.scrollLeft;
          if (left) scroll.push([node, left]);
        }
      }
    }
    list.dataset.messageBodyScope = scope;
    return {
      bodies, previews,
      restoreView() {
        for (const [node, left] of scroll) if (node.isConnected) node.scrollLeft = left;
        if (restoreFocus && focused?.isConnected && document.activeElement === document.body) focused.focus({preventScroll:true});
      },
    };
  }

  function transcriptMessageBody(previous, text, assistantReply = false, preview) {
    const rendered = interactiveMessageBodies.get(previous);
    const language = document.documentElement?.lang;
    if (rendered && rendered.text === text && rendered.assistantReply === assistantReply &&
        rendered.prefs === chatPreferences && rendered.language === language) return previous;

    const body = document.createElement('div');
    if (renderMessageBody(document, body, text, chatPreferences, assistantReply, preview)) {
      interactiveMessageBodies.set(body, {text, assistantReply, prefs:chatPreferences, language});
    }
    return body;
  }

  function makeAgentMessage(item, previousBody, preview) {
    const bubble = document.createElement('li');
    if (item.id) bubble.dataset.messageId = item.id;
    bubble.className = item.role === 'user' ? 'user' : 'assistant';
    const role = document.createElement('p');
    role.className = item.role === 'user' ? 'role visually-hidden' : 'role';
    role.textContent = item.role === 'user' ? uiLabel('你', 'You') : (currentAgent?.name || uiLabel('智能体', 'Agent'));
    const waiting = waitingAgentReply(item);
    const failed = item.role === 'assistant' && item.status === 'failed';
    const cancelled = item.role === 'assistant' && item.status === 'cancelled';
    const partial = waiting && servedByDsbot && item.client_key;
    const body = partial || (failed && item.error_code !== 'session/attachment-invalid')
      ? document.createElement('div')
      : transcriptMessageBody(previousBody, (cancelled || item.role === 'user') ? (item.body || '') : statusLabel(item),
        servedByDsbot && item.role === 'assistant' && item.status === 'succeeded', preview);
    body.className = 'body' + (partial ? ' reply-preview' : waiting ? ' pending' : failed ? ' failed' : '');
    if (partial) {
      bubble.dataset.replyProgress = item.client_key;
      body.setAttribute('aria-live', 'off');
      body.hidden = true;
    } else if (failed && item.error_code === 'model-unconfigured') {
      body.textContent = uiLabel('当前没有可用的模型。', 'No model is currently available.');
      const configure = document.createElement('a');
      configure.className = 'chat-model-settings';
      configure.href = '/settings#model-api';
      configure.textContent = uiLabel('查看模型设置', 'View model settings');
      body.append(configure);
    } else if (item.role === 'assistant' && item.status === 'failed' && item.error_code !== 'session/attachment-invalid') {
      body.textContent = item.can_retry === true ? uiLabel('回复未完成，可以重试。', 'The reply didn’t finish. You can retry.')
        : uiLabel('回复未完成。', 'The reply didn’t finish.');
    } else body.hidden = Boolean((cancelled || item.attachments?.length) && !item.body);
    if (waiting || failed || cancelled) bubble.dataset.state = item.status;
    bubble.append(role);
    let replyView;
    if (waiting) {
      const heading = document.createElement('p');
      heading.className = 'reply-state';
      heading.setAttribute('role', 'status');
      heading.textContent = partial ? privateReplyLabel(item.status, 'preparing', '')
        : item.status === 'running' ? uiLabel('正在生成回复', 'Writing a reply')
        : uiLabel('正在准备回复', 'Preparing a reply');
      bubble.append(heading);
      if (partial) replyView = {bubble, heading, body};
    }
    bubble.append(body);
    if (cancelled) {
      const label = document.createElement('p');
      label.className = 'reply-stopped';
      label.textContent = uiLabel('已停止生成', 'Reply stopped');
      bubble.append(label);
    }
    for (const attachment of item.attachments || []) bubble.append(renderMessageFile(attachment));
    const sources = memorySources(item);
    if (sources) bubble.append(sources);
    if (item.role === 'assistant' && saveableAgentMessage(item)) {
      const link = savedAgentWorkLink(item.saved_work);
      bubble.append(link || saveMessageButton(item, currentAgent.id));
    }
    if (canSaveChatAction(item, currentAgent?.id)) {
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'save-chat-action';
      save.dataset.saveAction = item.id;
      save.textContent = uiLabel('转为行动', 'Create action');
      const agentId = currentAgent.id;
      save.addEventListener('click', () => openSaveChatAction(item, agentId));
      bubble.append(save);
    }
    if (failed) addPrivateReplyRetry(bubble, item);
    return {bubble, replyView};
  }

  // A reply update only changes a few rows. Keep unchanged transcript controls
  // mounted so streamed replies do not interrupt reading or keyboard focus.
  const paintedAgentRows = new WeakMap();

  function renderAgentMessages(items, {followLatest = true, anchor} = {}) {
    const scroller = document.getElementById('message-scroller');
    const top = anchor?.top ?? scroller.scrollTop;
    const follow = anchor?.follow ?? (followLatest || messageScrollerAtBottom(scroller));
    const list = document.getElementById('message-list');
    const scope = sendScope();
    const context = JSON.stringify([scope, currentAgent?.name, document.documentElement?.lang, personalWorkspaceId]);
    const canSaveSticker = Boolean(stickerContext());
    const bodyViews = captureMessageBodies(list, scope);
    const previousRows = new Map();
    for (const row of list.children) {
      const painted = paintedAgentRows.get(row);
      if (painted?.context === context && painted.preferences === chatPreferences &&
          (painted.canSaveSticker === undefined || painted.canSaveSticker === canSaveSticker)) previousRows.set(painted.id, {row, painted});
    }
    const rows = [];
    agentReplyViews.clear();
    lastAgentItems = items || [];
    syncCaptureButton();
    restorePendingPrivateText(lastAgentItems);
    const queue = pendingSends.get(scope);
    if (queue && !queue.social) {
      const delivered = new Set(lastAgentItems.filter(item => item.role === 'user').map(item => item.client_key).filter(Boolean));
      for (const job of queue.jobs) if (job.failed && delivered.has(job.key)) removeSendJob(queue, job);
    }
    const pendingKeys = pendingMessageKeys();
    for (const item of lastAgentItems) {
      if (pendingKeys.has(item.client_key)) continue;
      const waiting = waitingAgentReply(item);
      if (waiting && item.client_key && replyWatch?.scope === scope && replyWatch.key === item.client_key) {
        // Keep the visible preview when the pending message gets its stored ID.
        const view = replyWatch.view;
        view.bubble.dataset.messageId = item.id;
        delete view.bubble.dataset.sendPending;
        agentReplyViews.set(item.client_key, view);
        rows.push(view.bubble);
        continue;
      }
      const stable = item.id && !waiting && !(item.status === 'failed' && item.can_retry);
      const previous = stable && previousRows.get(item.id);
      const signature = stable && (previous?.painted.item === item ? previous.painted.signature : JSON.stringify(item));
      if (previous && previous.painted.signature === signature) {
        previousRows.delete(item.id);
        rows.push(previous.row);
        continue;
      }
      const {bubble, replyView} = makeAgentMessage(item, bodyViews.bodies.get(item.id), bodyViews.previews.get(item.client_key));
      if (replyView) agentReplyViews.set(item.client_key, replyView);
      if (stable) paintedAgentRows.set(bubble, {id:item.id, item, signature, context, preferences:chatPreferences,
        canSaveSticker:item.attachments?.length ? canSaveSticker : undefined});
      rows.push(bubble);
    }
    const next = new Set(rows);
    const existing = new Set(list.children);
    for (const row of existing) if (!next.has(row) && !row.dataset.sendPending) row.remove();
    // Pending outbox bubbles keep their place after the durable transcript.
    rows.forEach((row, index) => {
      if (list.children[index] === row) return;
      if (existing.has(row)) row.remove();
      const before = list.children[index];
      if (before) list.insertBefore(row, before);
      else list.append(row);
    });
    renderPendingSend();
    const tracking = syncReplyProgress();
    attachmentSender?.render();
    const anchoredMessage = anchor?.id && Array.from(list.children).find(node => node.dataset.messageId === anchor.id);
    scroller.scrollTop = follow ? scroller.scrollHeight : top;
    if (anchoredMessage) scroller.scrollTop += anchoredMessage.getBoundingClientRect().top - anchor.offset;
    bodyViews.restoreView();
    updateLatestMessageControl();
    return lastAgentItems.some(waitingAgentReply) && !tracking;
  }

  function stopReplyProgress() {
    const watch = replyWatch;
    if (!watch) return;
    replyWatch = null;
    approvalNotice.stop();
    globalThis.clearTimeout(watch.timer);
    globalThis.clearTimeout(watch.timeout);
    globalThis.clearTimeout(watch.receiptTimer);
    watch.controller?.abort();
    closeReplyStream(watch);
  }

  function isCurrentReply(watch) {
    return replyWatch === watch && sendScope() === watch.scope && canWatchReply();
  }

  function canWatchReply() {
    return document.visibilityState !== 'hidden'
      && !(narrowScreen() && document.body.classList.contains('sessions-open'));
  }

  function privateReplyLabel(state, phase, text, reconnecting = false) {
    if (reconnecting) return uiLabel('正在重新连接回复…', 'Reconnecting to the reply…');
    const thinking = phase === 'thinking' || (state === 'running' && phase !== 'preparing' && !text);
    if (text) return thinking ? uiLabel('正在思考', 'Thinking') : uiLabel('正在生成回复', 'Writing a reply');
    const name = currentAgent?.name || uiLabel('智能体', 'Agent');
    return thinking ? uiLabel(`${name} 正在思考…`, `${name} is thinking…`)
      : uiLabel(`${name} 正在准备回复…`, `${name} is preparing a reply…`);
  }

  function paintReplyProgress(view, snapshot, reconnecting) {
    const state = snapshot.state === 'running' ? 'running' : 'queued';
    if (view.bubble.dataset.state !== state) view.bubble.dataset.state = state;
    const previous = streamingReplySource(view.body);
    const text = typeof snapshot.text === 'string' ? snapshot.text : previous;
    const label = privateReplyLabel(state, snapshot.phase, text.trim(), reconnecting);
    if (view.heading.textContent !== label) view.heading.textContent = label;
    if (previous === text) return;
    const scroller = document.getElementById('message-scroller');
    const follow = messageScrollerAtBottom(scroller);
    paintStreamingReply(document, view.body, text);
    if (follow) scroller.scrollTop = scroller.scrollHeight;
    else updateLatestMessageControl();
  }

  function paintReplyWatch(watch) {
    const reconnecting = watch.failures >= 2 && Boolean(watch.snapshot || !watch.posting);
    if (!watch.snapshot && !reconnecting) return;
    const snapshot = watch.snapshot || {state:watch.view.bubble.dataset.state};
    paintReplyProgress(watch.view, snapshot, reconnecting);
  }

  function scheduleReplyProgress(watch, delay = 400) {
    if (!isCurrentReply(watch)) return;
    watch.timer = globalThis.setTimeout(() => void pollReplyProgress(watch), delay);
  }

  async function acceptPostingReply(watch) {
    const queue = pendingSends.get(watch.scope);
    const job = queue?.replying;
    if (job?.key !== watch.key || !job.acceptReceipt) return false;
    const pair = await confirmPostedSend(queue, job);
    if (!pair || !job.acceptReceipt || (watch.terminal && waitingAgentReply(pair.reply))) return false;
    job.acceptReceipt({status: 200, body: pair});
    return true;
  }

  function observeReplyProgress(watch, snapshot) {
    watch.snapshot = snapshot;
    paintReplyProgress(watch.view, snapshot);
    if (!watch.posting || snapshot.state !== 'running' || watch.receiptTimer !== undefined) return;
    // A running stream can arrive before the send response. Once the ordinary
    // receipt has had a chance to arrive, reconcile the one saved message pair
    // so Stop uses the server's reply ID and attempt while the stream stays live.
    watch.receiptTimer = globalThis.setTimeout(() => {
      if (isCurrentReply(watch) && watch.posting && !watch.terminal) void acceptPostingReply(watch);
    }, 250);
  }

  async function settleReplyProgress(watch, {terminal = true} = {}) {
    watch.terminal ||= terminal;
    if (terminal && replyWatch === watch) approvalNotice.stop();
    globalThis.clearTimeout(watch.receiptTimer);
    if (watch.posting) {
      if (!await acceptPostingReply(watch)) scheduleReplyProgress(watch, 1200);
      return;
    }
    await openAgentConversation(currentAgent.id, currentConversation.id, {refresh: true});
    scheduleReplyProgress(watch, 1500);
  }

  async function pollReplyProgress(watch) {
    if (!isCurrentReply(watch)) return;
    const controller = watch.controller = new AbortController();
    watch.timeout = globalThis.setTimeout(() => controller.abort(), 5000);
    const result = await request('GET', watch.path + '&after=' + watch.revision, undefined, undefined, controller.signal).catch(() => null);
    globalThis.clearTimeout(watch.timeout);
    watch.controller = null;
    if (!isCurrentReply(watch)) return;
    const snapshot = result?.status === 200 ? result.body : null;
    if (snapshot?.state === 'pending' || snapshot?.state === 'running') {
      watch.failures = 0;
      const hasRevision = Number.isSafeInteger(snapshot.revision);
      if (snapshot.state === 'running' && !hasRevision && snapshot.text === '' && watch.snapshot) {
        // The saved reply can still be running while live progress is unavailable.
        snapshot.text = watch.snapshot.text;
      }
      observeReplyProgress(watch, snapshot);
      const changed = hasRevision && snapshot.revision !== watch.revision;
      if (changed) watch.revision = snapshot.revision;
      scheduleReplyProgress(watch, changed ? 50 : 750);
      return;
    }
    if (['succeeded','failed','cancelled'].includes(snapshot?.state)) return settleReplyProgress(watch);
    watch.failures += 1;
    paintReplyWatch(watch);
    if (!watch.posting && watch.failures >= 4) return settleReplyProgress(watch, {terminal: false});
    scheduleReplyProgress(watch, watch.failures < 3 ? 400 : 1200);
  }

  function closeReplyStream(watch) {
    globalThis.clearTimeout(watch.streamTimeout);
    const source = watch.stream;
    watch.stream = null;
    source?.close();
  }

  function startReplyStream(watch) {
    const EventSource = document.defaultView?.EventSource;
    if (typeof EventSource !== 'function') return false;
    const params = new URLSearchParams({workspace:workspaceId(),agent:currentAgent.id,
      conversation:currentConversation.id,key:watch.key});
    let source;
    try { source = new EventSource('/b/api/flybot-workspace/reply-stream?' + params); } catch { return false; }
    watch.stream = source;
    const active = () => watch.stream === source && isCurrentReply(watch);
    const fallback = () => {
      if (!active()) return;
      closeReplyStream(watch);
      scheduleReplyProgress(watch, 0);
    };
    const timeout = delay => {
      globalThis.clearTimeout(watch.streamTimeout);
      watch.streamTimeout = globalThis.setTimeout(fallback, delay);
    };
    const keepalive = () => { if (active()) timeout(16000); };
    source.addEventListener('open', keepalive);
    source.addEventListener('heartbeat', keepalive);
    source.addEventListener('error', fallback);
    source.addEventListener('message', event => {
      if (!active()) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return fallback(); }
      if (['succeeded','failed','cancelled'].includes(data?.state)) {
        closeReplyStream(watch);
        void settleReplyProgress(watch);
        return;
      }
      if (data?.state !== 'running' && data?.state !== 'pending') return fallback();
      keepalive();
      if (typeof data.text !== 'string' && typeof data.append !== 'string') return fallback();
      const text = typeof data.text === 'string' ? data.text : (watch.snapshot?.text || '') + data.append;
      if (text.length > 20000) return fallback();
      if (Number.isSafeInteger(data.revision)) watch.revision = data.revision;
      observeReplyProgress(watch, {state:data.state,phase:data.phase,text});
    });
    timeout(6000);
    return true;
  }

  function syncReplyProgress() {
    const scope = sendScope();
    const job = pendingSends.get(scope)?.replying;
    const activeKey = replyWatch?.scope === scope ? replyWatch.key : null;
    const activeView = agentReplyViews.get(activeKey) ?? (job?.key === activeKey ? job.replyView : null);
    const [key, view] = activeView ? [activeKey, activeView]
      : agentReplyViews.entries().next().value ?? (job ? [job.key, job.replyView] : []);
    if (!servedByDsbot || currentSource !== 'agent' || !currentConversation || !canWatchReply() || readingPrivateContext() || !view) {
      stopReplyProgress();
      return false;
    }
    const posting = job?.key === key;
    if (replyWatch?.scope === scope && replyWatch.key === key) {
      replyWatch.view = view;
      replyWatch.posting = posting;
      paintReplyWatch(replyWatch);
      return true;
    }
    stopReplyProgress();
    const path = `${agentBase()}/conversations/${currentConversation.id}/reply-progress?${new URLSearchParams({key})}`;
    replyWatch = {scope, key, view, path, posting, failures: 0, revision:0};
    const watch = replyWatch;
    if (!startReplyStream(watch)) scheduleReplyProgress(watch);
    void approvalNotice.start(() => isCurrentReply(watch) && !watch.terminal);
    return true;
  }

  let selecting = false;
  let selectionEpoch = 0;
  let selectionScope = '';
  const forwarding = new Map();
  const uncertainForwards = new Map();
  let forwardNotice = null;
  const forwardStatus = document.getElementById('forward-status');
  const selectedMessages = new Set();
  const hideDialog = document.getElementById('message-selection-hide-dialog');
  const hideConfirm = document.getElementById('message-selection-hide-confirm');
  const hideStatus = document.getElementById('message-selection-hide-status');
  const hidingMessages = new Set();
  const hiddenMessageReceipts = new Map();
  let hideTarget = null;
  let pinnedIds = new Set();

  const selectedSocialIds = () => selectionScope === sendScope() ? [...selectedMessages] : [];
  const forwardSignature = (scope, target, ids) => JSON.stringify([scope, target, [...ids].sort()]);

  function syncForwardBar() {
    const bar = document.getElementById('forward-bar');
    if (!bar) return;
    const scope = sendScope();
    if (selecting && selectionScope !== scope) {
      selecting = false;
      selectedMessages.clear();
    }
    bar.hidden = !selecting;
    const count = selectedMessages.size;
    document.getElementById('forward-count').textContent = uiLabel(forwardCountLabel(count), `${count} selected`);
    const target = document.getElementById('forward-target');
    const hiding = hidingMessages.has(scope);
    const pending = forwarding.get(scope);
    target.disabled = Boolean(pending) || target.options.length < 2;
    document.getElementById('forward-submit').disabled = Boolean(pending) || hiding || !(count && target.value);
    if (forwardStatus) {
      const issue = forwardNotice?.epoch === selectionEpoch &&
        forwardNotice.signature === forwardSignature(scope, target.value, selectedMessages) ? forwardNotice.message : '';
      forwardStatus.textContent = !selecting ? '' : pending
        ? uiLabel(`正在转发 ${pending.count} 条消息…`, `Forwarding ${pending.count} ${pending.count === 1 ? 'message' : 'messages'}…`) : issue;
      forwardStatus.dataset.kind = pending ? '' : 'error';
    }
    const remove = document.getElementById('selection-hide');
    if (remove) {
      remove.hidden = !servedByDsbot;
      remove.disabled = !count || hiding || Boolean(pending);
    }
    if (hideDialog?.open && (!selecting || hideTarget?.scope !== sendScope())) hideDialog.close();
    const capture = document.getElementById('selection-group-capture');
    if (capture) {
      capture.hidden = !servedByDsbot || currentSource !== 'social' || currentConversation?.kind !== 'group' || Boolean(currentConversation.public_agent);
      capture.disabled = !count || hiding;
    }
    for (const id of ['selection-memory', 'selection-meeting']) {
      const action = document.getElementById(id);
      if (action) action.disabled = !count || hiding;
    }
    const toggle = document.getElementById('multi-select-toggle');
    if (toggle) { toggle.setAttribute('aria-pressed', selecting ? 'true' : 'false'); toggle.textContent = selecting ? '退出多选' : '多选'; }
  }

  function fillForwardTargets() {
    const target = document.getElementById('forward-target');
    if (!target) return;
    const options = forwardTargets(socialConversations, currentConversation?.id, currentUser?.id);
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.disabled = true;
    prompt.textContent = options.length ? uiLabel('选择会话', 'Choose a conversation') : uiLabel('暂无可用会话', 'No available conversations');
    target.replaceChildren(prompt, ...options.map(item => {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; return option;
    }));
    target.disabled = !options.length;
    target.value = '';
  }

  function setSelecting(on, messageId) {
    const anchor = currentSource === 'social' && currentConversation ? chatHistoryAnchor(undefined, messageId) : null;
    selecting = on;
    selectionScope = on ? sendScope() : '';
    selectionEpoch += 1;
    selectedMessages.clear();
    if (on && messageId) selectedMessages.add(messageId);
    const more = document.getElementById('message-selection-more');
    if (more) more.open = false;
    if (on) fillForwardTargets();
    syncForwardBar();
    if (anchor) renderSocialMessages(lastSocialItems, {anchor});
    if (on && messageId) {
      const row = [...document.getElementById('message-list').children].find(item => item.dataset.messageId === messageId);
      row?.querySelector('.message-tools input')?.focus({preventScroll: true});
    }
  }

  function renderPinned(list) {
    const hidden = hiddenMessageReceipts.get(sendScope());
    if (hidden) list = list?.filter(item => !hidden.has(item.message_id));
    pinnedIds = new Set((list || []).map(item => item.message_id));
    const section = document.getElementById('pinned-messages');
    const holder = document.getElementById('pinned-message-list');
    if (!section || !holder) return;
    section.hidden = !(list && list.length);
    holder.replaceChildren(...(list || []).map(item => {
      const li = document.createElement('li');
      li.dataset.pinnedMessage = item.message_id;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.excerpt || '查看置顶消息';
      if (item.pinned_by_username) button.title = '由 ' + item.pinned_by_username + ' 置顶';
      button.addEventListener('click', () => jumpToMessage(item.message_id));
      li.append(button);
      return li;
    }));
  }

  function rememberHiddenMessages(scope, ids) {
    const hidden = hiddenMessageReceipts.get(scope) || new Set();
    for (const id of ids) hidden.add(id);
    hiddenMessageReceipts.set(scope, hidden);
  }

  function forgetSocialMessages(ids, exitSelection = false) {
    const removed = new Set(ids);
    const anchor = chatHistoryAnchor(removed);
    if (exitSelection) {
      selecting = false;
      selectionEpoch += 1;
      selectedMessages.clear();
    } else for (const id of ids) selectedMessages.delete(id);
    syncForwardBar();
    const scope = sendScope(), reply = replyDrafts.get(scope);
    if (removed.has(reply?.message_id)) setReplyDraft(scope, {message_id:reply.message_id, state:'missing', available:false});
    const pins = document.getElementById('pinned-message-list');
    for (const row of [...pins.children]) if (removed.has(row.dataset.pinnedMessage)) row.remove();
    for (const id of ids) pinnedIds.delete(id);
    document.getElementById('pinned-messages').hidden = !pinnedIds.size;
    renderSocialMessages(lastSocialItems, {anchor});
  }

  function showSocialMessageChange(scope, message) {
    const prior = lastSocialItems.find(item => item.id === message.id);
    if (!prior || prior.revision > message.revision) return;
    const anchor = chatHistoryAnchor();
    const draft = replyDrafts.get(scope);
    if (draft?.message_id === message.id) {
      setReplyDraft(scope, message.retracted ? {message_id:message.id, state:'missing', available:false}
        : composerReply(message, draft.author));
    }
    if (pinnedIds.has(message.id)) {
      const pin = Array.from(document.getElementById('pinned-message-list').children)
        .find(row => row.dataset.pinnedMessage === message.id);
      if (message.retracted) {
        pin?.remove();
        pinnedIds.delete(message.id);
        document.getElementById('pinned-messages').hidden = !pinnedIds.size;
      } else {
        const button = pin?.querySelector('button');
        if (button) button.textContent = message.body.replace(/\s+/g, ' ').slice(0, 100);
      }
    }
    renderSocialMessages(lastSocialItems.map(item => item.id === message.id ? message : item), {anchor});
  }

  function messageTools(item, row) {
    const tools = document.createElement('span');
    tools.className = 'message-tools';
    if (selecting) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selectedMessages.has(item.id);
      box.setAttribute('aria-label', uiLabel('选择这条消息', 'Select this message'));
      row.classList.add('message-selectable');
      row.dataset.messageSelected = String(box.checked);
      row.addEventListener('click', event => {
        if (!event.target.closest('button, a, input, label, audio, video')) box.click();
      });
      box.addEventListener('change', () => {
        if (box.checked && selectedMessages.size >= 20) {
          box.checked = false;
          show('error', uiLabel('一次最多选择 20 条消息。', 'Select up to 20 messages.'));
        } else if (box.checked) {
          selectedMessages.add(item.id);
        } else {
          selectedMessages.delete(item.id);
        }
        row.dataset.messageSelected = String(box.checked);
        syncForwardBar();
      });
      label.append(box, document.createTextNode('选择'));
      tools.append(label);
      return tools;
    }
    const pin = document.createElement('button');
    pin.type = 'button';
    const isPinned = pinnedIds.has(item.id);
    pin.textContent = isPinned ? '取消置顶' : '置顶';
    pin.setAttribute('aria-label', isPinned ? '取消置顶这条消息' : '置顶这条消息');
    pin.addEventListener('click', async () => {
      const wid = workspaceId(), cid = currentConversation && currentConversation.id;
      const result = await request('POST', `${socialBase()}/${cid}/messages/${item.id}/pin`, {pinned: !isPinned});
      if (workspaceId() !== wid || !currentConversation || currentConversation.id !== cid) return;
      if (result.status !== 200) { show('error', messageFor(result.body.error, '无法置顶消息。')); return; }
      renderPinned(result.body.pinned_messages);
      renderSocialMessages(lastSocialItems);
    });
    pin.hidden = true;
    tools.append(pin);
    return tools;
  }

  function reactionBar(item) {
    const bar = document.createElement('div');
    bar.className = 'message-reactions';
    const scope = sendScope();
    const queue = reactionWrites.get(JSON.stringify([scope,item.id]));
    if (queue) Object.assign(queue,{bar,item});
    fillReactionBar(bar, item, scope);
    return bar;
  }

  async function drainReactions(key, queue) {
    if (queue.active) return;
    queue.active = true;
    const current = () => reactionWrites.get(key) === queue && currentUser?.id === queue.owner;
    try {
      while (current() && queue.actions.length) {
        const action = queue.actions[0];
        const result = await request('POST',queue.path,action,undefined,AbortSignal.timeout(5000))
          .catch(() => ({status:0,body:{}}));
        if (!current()) return;
        queue.actions.shift();
        const saved = result.status === 200 && Array.isArray(result.body?.reactions);
        if (saved) queue.saved = result.body.reactions;
        queue.item.reactions = queue.saved;
        if (queue.scope === sendScope() && queue.bar.isConnected !== false) {
          fillReactionBar(queue.bar,queue.item,queue.scope);
          if (!saved && !queue.actions.some(next=>next.emoji===action.emoji)) {
            show('error',messageFor(result.body?.error,uiLabel('表情回应未保存。','Could not save the reaction.')));
          }
        }
      }
    } finally {
      if (reactionWrites.get(key) === queue) reactionWrites.delete(key);
    }
  }

  function fillReactionBar(bar, item, scope, focusEmoji) {
    const key = JSON.stringify([scope,item.id]);
    const queue = reactionWrites.get(key);
    const reactions = queue ? queue.actions.reduce(applyReaction,queue.saved) : item.reactions || [];
    const focused = bar.contains?.(document.activeElement) ? document.activeElement : null;
    const restore = focusEmoji || focused;
    const keptPicker = !focusEmoji && bar.querySelector('.reaction-add')?.getAttribute('aria-expanded') === 'true';
    const emojiToFocus = focusEmoji || focused?.dataset.reactionEmoji;
    bar.replaceChildren();
    const react = emoji => {
      if (scope !== sendScope() || !currentConversation || bar.isConnected === false) return;
      let pending = reactionWrites.get(key);
      if (!pending) {
        pending = {scope,owner:currentUser?.id,bar,item,saved:item.reactions || [],actions:[],
          path:`${socialBase()}/${currentConversation.id}/messages/${item.id}/reactions`};
        reactionWrites.set(key,pending);
      }
      pending.actions.push(reactionToggle(reactions,emoji));
      fillReactionBar(bar,item,scope,emoji);
      return drainReactions(key,pending);
    };
    let nextFocus;
    for (const reaction of reactions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reaction-chip' + (reaction.mine ? ' is-mine' : '');
      chip.dataset.reactionEmoji = reaction.emoji;
      chip.setAttribute('aria-pressed', reaction.mine ? 'true' : 'false');
      chip.setAttribute('aria-label', `${reaction.emoji} ${reaction.count} 人回应${reaction.mine ? '，含我' : ''}`);
      chip.textContent = `${reaction.emoji} ${reaction.count}`;
      chip.addEventListener('click', () => react(reaction.emoji));
      bar.append(chip);
      if (reaction.emoji === emojiToFocus) nextFocus = chip;
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'reaction-add';
    add.textContent = '+😊';
    add.setAttribute('aria-label', '添加表情回应');
    add.setAttribute('aria-expanded', String(keptPicker));
    const picker = document.createElement('span');
    picker.className = 'reaction-picker';
    picker.hidden = !keptPicker;
    for (const emoji of MESSAGE_REACTIONS) {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.textContent = emoji;
      choice.dataset.reactionEmoji = emoji;
      choice.setAttribute('aria-label', '回应 ' + emoji);
      choice.addEventListener('click', () => react(emoji));
      picker.append(choice);
      if (keptPicker && focused?.parentElement?.classList.contains('reaction-picker') && emoji === emojiToFocus) nextFocus = choice;
    }
    add.addEventListener('click', () => {
      picker.hidden = !picker.hidden;
      add.setAttribute('aria-expanded', picker.hidden ? 'false' : 'true');
    });
    bar.append(add, picker);
    if (restore) {
      const overflow = narrowScreen() && !reactions.length && !keptPicker ? bar.closest('[data-message-id]')?.querySelector('.message-more') : null;
      (nextFocus || overflow || add).focus({preventScroll:true});
    }
  }

  let messageMenuTarget = null;
  function closeMessageMenu() {
    const menu = document.getElementById('message-context-menu');
    if (menu) menu.hidden = true;
    messageMenuTarget = null;
  }

  const messageLinkDialog = document.getElementById('message-link-dialog');
  const messageLinkUrl = document.getElementById('message-link-url');
  messageLinkDialog?.addEventListener('close', () => { messageLinkUrl.value = ''; });

  function shareableMessageHref(item) {
    if (!servedByDsbot || !currentConversation || currentConversation.public_agent || item.retracted) return '';
    return socialMessageHref({
      workspace: currentConversation.direct || currentConversation.account_group ? '' : workspaceId(),
      conversation: currentConversation.id, message: item.id,
    });
  }

  async function copyMessageLink(href, scope) {
    if (!href || sendScope() !== scope) return;
    const view = document.defaultView;
    const url = new URL(href, view.location.origin).href;
    try {
      await view.navigator.clipboard.writeText(url);
      if (sendScope() === scope) show('ok', uiLabel('已复制消息链接。', 'Message link copied.'));
    } catch {
      if (sendScope() !== scope || messageLinkDialog.open) return;
      messageLinkUrl.value = url;
      messageLinkDialog.showModal();
      messageLinkUrl.focus();
      messageLinkUrl.select();
    }
  }

  function openMessageMenu(item, li, mine, x, y) {
    const menu = document.getElementById('message-context-menu');
    if (!menu) return;
    const scroller = document.getElementById('message-scroller');
    messageMenuTarget = {item, li, mine, scope: sendScope(), scrollTop: scroller?.scrollTop};
    const reactions = document.getElementById('message-menu-reactions');
    reactions.replaceChildren(...MESSAGE_REACTIONS.map(emoji => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = emoji;
      button.setAttribute('aria-label', '回应 ' + emoji);
      button.dataset.emoji = emoji;
      return button;
    }));
    const pin = menu.querySelector('[data-menu="pin"]');
    pin.textContent = pinnedIds.has(item.id) ? '取消置顶' : '置顶';
    menu.querySelector('[data-menu="reply"]').hidden = currentConversation?.public_agent?.open === false
      || currentConversation?.direct?.open === false;
    const askGroup = menu.querySelector('[data-menu="ask-group"]');
    if (askGroup) askGroup.hidden = item.retracted || !agentMentions.canPick();
    menu.querySelector('[data-menu="retract"]').hidden = !mine;
    const edit = menu.querySelector('[data-menu="edit"]');
    if (edit) edit.hidden = !mine;
    menu.querySelector('[data-menu="forward"]').disabled = forwardTargets(socialConversations, currentConversation && currentConversation.id).length === 0;
    const publicThread = Boolean(currentConversation?.public_agent);
    for (const action of ['translate', 'ask', 'forward', 'select']) {
      menu.querySelector(`[data-menu="${action}"]`).hidden = publicThread;
    }
    menu.querySelector('[data-menu="save"]').hidden = publicThread || !saveableSocialMessage(item);
    const saveAction = menu.querySelector('[data-menu="save-action"]');
    if (saveAction) saveAction.hidden = !canSaveChatAction(item);
    menu.querySelector('[data-menu="copy-link"]').hidden = !shareableMessageHref(item);
    menu.hidden = false;
    const width = menu.offsetWidth || 200, height = menu.offsetHeight || 360;
    const left = Math.max(8, Math.min(x, globalThis.innerWidth - width - 8));
    const top = Math.max(8, Math.min(y, globalThis.innerHeight - height - 8));
    menu.style.setProperty('left', left + 'px');
    menu.style.setProperty('top', top + 'px');
    const first = menu.querySelector('button:not(:disabled)');
    if (first) first.focus({preventScroll: true});
  }

  const messageMenu = document.getElementById('message-context-menu');
  if (messageMenu) {
    messageMenu.addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button || button.disabled || !messageMenuTarget) return;
      const {item, li, scope} = messageMenuTarget;
      const action = button.dataset.menu;
      closeMessageMenu();
      if (button.dataset.emoji) {
        const choice = li.querySelector(`.reaction-picker button[aria-label="回应 ${button.dataset.emoji}"]`);
        if (choice) choice.click();
      } else if (action === 'reply') {
        const author = li.querySelector('.role')?.textContent || '成员';
        composeReply(item, author);
      } else if (action === 'ask-group' && scope === sendScope()) {
        const reply = composerReply(item, li.querySelector('.role')?.textContent || uiLabel('成员', 'Member'));
        agentMentions.openPicker({reply, onApply: () => setReplyDraft(scope, reply)});
      } else if (action === 'translate' || action === 'ask') {
        messageUtilities.open(item, action);
      } else if (action === 'save') {
        openSaveMessage(item);
      } else if (action === 'save-action' && scope === sendScope()) {
        openSaveChatAction(item);
      } else if (action === 'edit') {
        const edit = Array.from(li.querySelectorAll(':scope > button')).find(node => node.textContent === '编辑');
        if (edit) edit.click();
      } else if (action === 'copy') {
        try { await navigator.clipboard.writeText(item.body || ''); show('ok', '已复制。'); }
        catch { show('error', '浏览器不允许复制，请手动选择文本。'); }
      } else if (action === 'copy-link') {
        li.querySelector('.message-more')?.focus({preventScroll: true});
        await copyMessageLink(shareableMessageHref(item), scope);
      } else if (action === 'forward' || action === 'select') {
        if (scope === sendScope()) setSelecting(true, item.id);
      } else if (action === 'pin') {
        const pinButton = li.querySelector('.message-tools button');
        if (pinButton) pinButton.click();
      } else if (action === 'remind-1h' || action === 'remind-tomorrow') {
        await setMessageReminder(item, action === 'remind-1h' ? 'later' : 'tomorrow');
      } else if (action === 'retract') {
        const retract = Array.from(li.querySelectorAll(':scope > button')).find(node => node.textContent === '撤回');
        if (retract) retract.click();
      } else if (action === 'delete') {
        if (scope !== sendScope() || !currentConversation) return;
        const cid = currentConversation.id;
        const result = await request('DELETE', `${socialBase()}/${cid}/messages/${item.id}`)
          .catch(() => ({status: 0, body: {}}));
        if (result.status !== 204) {
          if (scope === sendScope()) show('error', messageFor(result.body.error, '消息未从你的会话删除，请重试。'));
          return;
        }
        rememberHiddenMessages(scope, [item.id]);
        if (scope !== sendScope()) return;
        forgetSocialMessages([item.id]);
        show('ok', '已从你的会话删除。', {announceOnly:true});
        void loadSessions();
      }
    });
    document.addEventListener('click', event => {
      if (!messageMenu.hidden && !messageMenu.contains(event.target)) closeMessageMenu();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !messageMenu.hidden) closeMessageMenu(); });
    globalThis.addEventListener('resize', closeMessageMenu);
    const scroller = document.getElementById('message-scroller');
    if (scroller) scroller.addEventListener('scroll', () => {
      if (messageMenuTarget && scroller.scrollTop !== messageMenuTarget.scrollTop) closeMessageMenu();
    }, {passive: true});
  }

  let saveMessageTarget = null;
  const saveMessageDialog = document.getElementById('save-message-dialog');
  let saveActionTarget;
  const saveActionDialog = document.getElementById('save-action-dialog');
  const saveActionTitle = document.getElementById('save-action-title');
  const saveActionNotes = document.getElementById('save-action-notes');
  const saveActionError = document.getElementById('save-action-error');
  const saveActionSubmit = document.getElementById('save-action-submit');
  const saveActionCancel = document.getElementById('save-action-cancel');

  function canSaveChatAction(item, agentId) {
    if (!servedByDsbot || !/^[0-9a-f]{32}$/.test(personalWorkspaceId) || !currentConversation ||
        typeof item?.body !== 'string' || !item.body.trim() || item.retracted || item.attachment || item.voice || item.attachments?.length) return false;
    return agentId ? /^[0-9a-f]{32}$/.test(agentId) && /^[0-9a-f]{32}$/.test(item.id) &&
        ['sent','succeeded'].includes(item.status)
      : !currentConversation.public_agent && /^otm_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(item.id);
  }

  function openSaveChatAction(item, agentId) {
    if (!canSaveChatAction(item, agentId) || saveActionDialog.open) return;
    const source = {kind:agentId ? 'agent' : 'social', workspace_id:workspaceId(),
      conversation_id:currentConversation.id, message_id:item.id,
      ...(agentId ? {agent_id:agentId} : {revision:item.revision || 1})};
    saveActionTarget = {source, personal:personalWorkspaceId, scope:sendScope(), key:idempotencyKey('chat-action-')};
    saveActionTitle.value = defaultSaveTitle(item.body);
    saveActionNotes.value = item.body.trim().slice(0, 2000).toWellFormed();
    saveActionError.hidden = true;
    saveActionSubmit.disabled = saveActionCancel.disabled = false;
    saveActionDialog.showModal();
    saveActionTitle.focus();
  }

  saveActionDialog?.addEventListener('close', () => {
    if (!saveActionDialog.open) saveActionTarget = null;
  });
  saveActionDialog?.addEventListener('cancel', event => {
    if (saveActionSubmit.disabled) event.preventDefault();
  });
  saveActionCancel?.addEventListener('click', () => saveActionDialog.close());
  document.getElementById('save-action-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const target = saveActionTarget;
    const current = () => saveActionTarget === target && saveActionDialog.open && sendScope() === target.scope;
    if (!target || !current() || saveActionSubmit.disabled) return;
    const {source,personal,key} = target;
    const title = saveActionTitle.value.trim();
    if (!title) { saveActionTitle.focus(); return; }
    saveActionError.hidden = true;
    saveActionSubmit.disabled = saveActionCancel.disabled = true;
    try {
      const result = await request('POST', `/v1/workspaces/${personal}/memory/actions/from-chat`,
        {source,title,notes:saveActionNotes.value}, {'Idempotency-Key':key}, AbortSignal.timeout(12000))
        .catch(() => ({status:0,body:{}}));
      if (!current()) return;
      const saved = result.body.action;
      if (![200,201].includes(result.status) || saved?.workspace_id !== personal || !/^[0-9a-f]{32}$/.test(saved?.id || '')) {
        saveActionError.textContent = result.status === 409
          ? uiLabel('原消息已经变化，请关闭后重新选择。', 'The original message changed. Close and select it again.')
          : uiLabel('无法确认行动已保存，请重试。', 'Could not confirm the action was saved. Try again.');
        saveActionError.hidden = false;
        return;
      }
      saveActionDialog.close();
      saveActionTarget = null;
      show('ok', result.status === 201 ? uiLabel('已保存到下一步行动。', 'Saved to Next Actions.')
        : uiLabel('这条消息已有行动。', 'This message already has an action.'));
      const link = document.createElement('a');
      link.className = 'chat-action-receipt';
      link.href = '/memory?' + new URLSearchParams({workspace:personal,page:'todos',action:saved.id});
      link.textContent = uiLabel('打开行动', 'Open action');
      status.append(link);
      link.focus({preventScroll:true});
    } finally {
      if (saveActionTarget === target) saveActionSubmit.disabled = saveActionCancel.disabled = false;
    }
  });

  // One click on a message becomes a real one-shot automation in this workspace; the
  // idempotency key is the message id, so setting it twice answers "already set".
  async function setMessageReminder(item, choice) {
    const wid = workspaceId();
    if (!wid || !currentUser) return;
    const payload = reminderPayload(item, choice, new Date(), readableTimeZone(), currentUser.username);
    let result;
    try {
      result = await request('POST', `/v1/workspaces/${wid}/automations`, payload,
        {'Idempotency-Key': reminderKey(item.id)});
    } catch {
      show('error', '网络失败，没能设成提醒。');
      return;
    }
    if (workspaceId() !== wid) return;
    show(result.status === 201 || result.status === 200 ? 'ok' : 'error',
      reminderNotice(result.status, result.body));
  }

  function savedAgentWorkLink(work) {
    if (!/^[0-9a-f]{32}$/.test(work?.id || '')) return null;
    const link = document.createElement('a');
    link.className = 'saved-agent-work';
    link.href = spaceHref(workspaceId(), work.id);
    const label = uiLabel('打开已保存文档', 'Open saved document');
    link.textContent = work.title ? label + ' · ' + work.title : label;
    return link;
  }

  function showSavedAgentWork(target, artifact) {
    const link = savedAgentWorkLink(artifact);
    if (!link) return false;
    // A refresh started before the document was saved must not undo its receipt.
    privateRefresh += 1;
    lastAgentItems = lastAgentItems.map(item => item.id === target.message
      ? {...item, saved_work:{id:artifact.id, title:artifact.title}} : item);
    const button = document.getElementById('message-list').querySelector(`[data-save="${target.message}"]`);
    if (!button) return false;
    button.replaceWith(link);
    link.focus({preventScroll:true});
    return true;
  }

  function openSaveMessage(item, agentId) {
    if (!currentConversation) return;
    const workspace = workspaceId(), conversation = currentConversation.id;
    const path = agentId ? agentSavePath(workspace, agentId, conversation, item.id)
      : socialSavePath(workspace, conversation, item.id);
    saveMessageTarget = {workspace, path, scope:sendScope(), message:item.id,
      revision:agentId ? null : item.revision || 1};
    document.getElementById('save-message-title').value = defaultSaveTitle(item.body);
    document.getElementById('save-message-error').hidden = true;
    document.getElementById('save-message-submit').disabled = false;
    saveMessageDialog.showModal();
    document.getElementById('save-message-title').focus();
  }

  function saveMessageButton(item, agentId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.save = item.id;
    button.textContent = uiLabel('保存到资料空间', 'Save to Space');
    button.addEventListener('click', () => openSaveMessage(item, agentId));
    return button;
  }
  saveMessageDialog?.addEventListener('close', () => {
    if (!saveMessageDialog.open) saveMessageTarget = null;
  });
  document.getElementById('save-message-cancel')?.addEventListener('click', () => saveMessageDialog.close());
  const saveMessageForm = document.getElementById('save-message-form');
  saveMessageForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const target = saveMessageTarget;
    const current = () => saveMessageDialog.open && saveMessageTarget === target && sendScope() === target.scope;
    if (!target || !current()) return;
    const button = document.getElementById('save-message-submit');
    if (button.disabled) return;
    const error = document.getElementById('save-message-error');
    button.disabled = true;
    error.hidden = true;
    try {
      const body = {title:document.getElementById('save-message-title').value.trim()};
      if (target.revision !== null) body.revision = target.revision;
      let result = await request('POST', target.path, body, undefined, AbortSignal.timeout(12000))
        .catch(() => ({status:0, body:{}}));
      if (!current()) return;
      const committed = result => [200, 201].includes(result.status)
        && /^[0-9a-f]{32}$/.test(result.body?.artifact?.id || '');
      const uncertain = !result.status || result.status === 408 || result.status >= 500
        || ([200, 201].includes(result.status) && !committed(result));
      if (uncertain && target.revision === null) {
        const receipt = await request('GET', target.path, undefined, undefined, AbortSignal.timeout(4500)).catch(() => null);
        if (!current()) return;
        if (receipt?.status === 200 && committed(receipt)) result = receipt;
      }
      if (!committed(result)) {
        error.textContent = uncertain
          ? uiLabel('暂时无法确认保存结果，可以重试。', 'Couldn’t confirm the save. You can try again.')
          : messageFor(result.body.error, uiLabel('消息未保存，请重试。', 'Couldn’t save the message. Try again.'));
        error.hidden = false;
        return;
      }
      saveMessageDialog.close();
      saveMessageTarget = null;
      const artifact = result.body.artifact;
      const shown = target.revision === null && showSavedAgentWork(target, artifact);
      const copy = result.status === 201
        ? uiLabel('已保存到资料空间。', 'Saved to Space.')
        : uiLabel('资料空间已有这条消息的副本。', 'This message already has a copy in Space.');
      show('ok', copy, {announceOnly:shown});
      if (!shown) {
        const link = savedAgentWorkLink(artifact);
        status.append(document.createTextNode(' '), link);
      }
    } finally {
      if (saveMessageTarget === target) button.disabled = false;
    }
  });

  let socialHistory = null;
  let privateHistory = null;
  let privateRefresh = 0;
  let socialOpen = 0;
  let historyJump = 0;
  let searchHighlightTimer;
  let groupReplyWatch = null;
  const groupReplyViews = new Map();
  const groupBotActivity = document.getElementById('group-bot-activity');
  const groupReplyRetries = new Map();
  let groupReplyScope = null;
  const olderMessages = document.getElementById('chat-load-older');
  const latestMessages = document.getElementById('chat-back-to-latest');
  const historyScroller = document.getElementById('message-scroller');
  const newerMessages = document.getElementById('chat-load-newer');
  const markThreadRead = document.getElementById('chat-mark-thread-read');
  const unreadActions = document.getElementById('chat-unread-actions');
  const unreadNotice = document.getElementById('chat-unread-status');
  const historyNotice = document.getElementById('chat-history-status');
  let unreadScrollTimer;

  function setSocialHistory(state) {
    clearTimeout(unreadScrollTimer);
    socialHistory = state;
    if (!state || state.readingHistory) stopGroupReplyProgress();
    const scope = state && sendScope();
    if (groupReplyScope !== scope) {
      groupReplyScope = scope;
      groupReplyViews.clear();
      groupReplyRetries.clear();
    }
    if (historyNotice) historyNotice.textContent = '';
    if (unreadNotice) unreadNotice.textContent = '';
    updateHistoryControls();
  }

  function agentConversationPath(wid, aid, cid) {
    return `/v1/workspaces/${wid}/agents/${aid}/conversations/${cid}`;
  }

  function setPrivateHistory(state) {
    privateHistory = state;
    if (state?.readingHistory) stopReplyProgress();
    if (historyNotice) historyNotice.textContent = '';
    updateHistoryControls();
  }

  function readingPrivateContext() {
    return Boolean(privateHistory?.readingHistory || privateHistory?.loading || privateHistory?.jumping);
  }

  function updateLatestMessageControl() {
    if (!latestMessages || !historyScroller) return;
    const state = currentSource === 'agent' ? privateHistory : socialHistory;
    const atLatest = !historyScroller.clientHeight || messageScrollerAtBottom(historyScroller);
    const hidden = !currentConversation || (!state?.readingHistory && atLatest);
    const disabled = Boolean(state?.restoring);
    if (latestMessages.hidden !== hidden) latestMessages.hidden = hidden;
    if (latestMessages.disabled !== disabled) latestMessages.disabled = disabled;
  }

  function updateHistoryControls() {
    const state = currentSource === 'agent' ? privateHistory : socialHistory;
    if (olderMessages) {
      olderMessages.hidden = !state?.cursor;
      olderMessages.disabled = Boolean(state?.loading || state?.jumping || state?.restoring);
    }
    if (historyScroller) {
      if (state?.readingHistory) historyScroller.dataset.readingHistory = '';
      else delete historyScroller.dataset.readingHistory;
    }
    updateLatestMessageControl();
    const unread = currentSource === 'social' ? state?.unread : null;
    const canLoadNewer = Boolean(state?.after || unread?.after);
    const canMarkRead = Boolean(unread && unread.committed < unread.latest);
    if (newerMessages) {
      newerMessages.hidden = !canLoadNewer;
      newerMessages.disabled = Boolean(state?.loading || state?.jumping || state?.restoring);
    }
    if (markThreadRead) {
      markThreadRead.hidden = !canMarkRead;
      markThreadRead.disabled = Boolean(unread?.saving);
    }
    if (unreadActions) unreadActions.hidden = !canLoadNewer && !canMarkRead && !unreadNotice?.textContent;
  }

  function visibleSocialHistory(state) {
    return state && state === socialHistory && currentSource === 'social' && state.owner === currentUser?.id &&
      state.wid === workspaceId() && state.cid === currentConversation?.id && viewingSocialMessages() &&
      document.visibilityState !== 'hidden' && !sessionTransition?.pending;
  }

  function scheduleUnreadRead() {
    const state = socialHistory;
    if (!state?.unread?.firstId || state.unread.committed >= state.unread.latest || !visibleSocialHistory(state)) return;
    clearTimeout(unreadScrollTimer);
    unreadScrollTimer = setTimeout(() => readVisibleUnread(state), 160);
  }

  function readVisibleUnread(state) {
    if (!visibleSocialHistory(state) || state.loading || selecting || document.querySelector?.('dialog[open]')) return;
    const unread = state.unread;
    const scroller = document.getElementById('message-scroller');
    const bounds = scroller.getBoundingClientRect();
    for (const row of document.getElementById('message-list').children) {
      const seq = Number(row.dataset.messageSeq);
      if (!seq || seq <= unread.committed) continue;
      const rect = row.getBoundingClientRect();
      if (rect.top >= bounds.bottom) break;
      const visible = Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top);
      if (visible > 0 && visible >= Math.min(rect.height / 2, 96)) unread.seen.add(seq);
    }
    let through = unread.committed;
    for (const message of lastSocialItems) {
      if (message.seq <= through) continue;
      if (!unread.seen.has(message.seq)) break;
      through = message.seq;
    }
    if (through > unread.committed) void commitUnread(state, through);
  }

  async function commitUnread(state, seq, explicit = false) {
    const unread = state?.unread;
    if (!visibleSocialHistory(state) || !unread || unread.saving || !Number.isSafeInteger(seq) || seq <= unread.committed) return;
    const latestOnRead = unread.latest;
    unread.saving = true;
    updateHistoryControls();
    try {
      const result = await request('POST', `/v1/workspaces/${state.wid}/social/conversations/${state.cid}/read`,
        {seq}, undefined, AbortSignal.timeout(8000));
      if (state !== socialHistory || state.owner !== currentUser?.id || state.wid !== workspaceId() ||
          state.cid !== currentConversation?.id) return;
      if (result.status !== 200 || !Number.isSafeInteger(result.body.unread_count) || result.body.unread_count < 0) throw new Error('read');
      unread.committed = seq;
      for (const seen of unread.seen) if (seen <= seq) unread.seen.delete(seen);
      applyOpenedRead('social', currentConversation, result.body.unread_count, null, latestOnRead);
      if (!unread.after && seq >= unread.latest) {
        state.readingHistory = false;
        syncGroupReplyProgress();
        scheduleSocialPoll(currentConversation);
      }
      renderSessions();
      if (explicit && historyNotice) historyNotice.textContent = uiLabel('已标为已读。', 'Marked as read.');
      scheduleUnreadRead();
    } catch {
      if (state === socialHistory && explicit && unreadNotice) unreadNotice.textContent =
        uiLabel('未能标为已读，请重试。', 'Could not mark as read. Try again.');
    } finally {
      unread.saving = false;
      if (state === socialHistory) updateHistoryControls();
    }
  }

  async function historyPage(state, query, signal) {
    const open = socialOpen;
    const result = await request('GET', `/v1/workspaces/${state.wid}/social/conversations/${state.cid}/messages?${query}`, undefined, undefined, signal);
    return socialHistory === state && open === socialOpen && currentSource === 'social' &&
      workspaceId() === state.wid && currentConversation?.id === state.cid && currentUser?.id === state.owner ? result : null;
  }

  async function privateHistoryPage(state, query, signal) {
    const open = socialOpen;
    const scope = sendScope();
    const path = agentConversationPath(state.wid, state.aid, state.cid);
    const result = await request('GET', `${path}?${query}`, undefined, undefined, signal).catch(() => null);
    if (privateHistory !== state || open !== socialOpen || scope !== sendScope() || currentUser?.id !== state.owner) return null;
    const conversation = result?.body.conversation;
    if (!result || (result.status === 200 && (conversation?.id !== state.cid
      || (conversation.workspace_id && conversation.workspace_id !== state.wid)
      || (conversation.agent_id && conversation.agent_id !== state.aid)))) throw new Error('History unavailable');
    return result;
  }

  function chatHistoryAnchor(excluded, preferredId) {
    const scroller = document.getElementById('message-scroller');
    const top = scroller.getBoundingClientRect().top;
    const rows = Array.from(document.getElementById('message-list').children);
    const preferred = preferredId && rows.find(node => node.dataset.messageId === preferredId);
    const message = preferred || rows.find(node => node.dataset.messageId && !excluded?.has(node.dataset.messageId)
      && node.getBoundingClientRect().bottom >= top);
    return {top: scroller.scrollTop, follow: false, id: message?.dataset.messageId,
      offset: message?.getBoundingClientRect().top};
  }

  function restorePrivateLatest(state) {
    if (privateHistory !== state) return Promise.resolve(false);
    if (state.restoring) return state.restoring;
    state.restoring = openAgentConversation(state.aid, state.cid).finally(() => {
      if (privateHistory === state) {
        state.restoring = null;
        updateHistoryControls();
      }
    });
    updateHistoryControls();
    return state.restoring;
  }

  function resumePrivateSending() {
    const state = privateHistory;
    if (state?.readingHistory) void restorePrivateLatest(state);
    else if (state && readingPrivateContext()) setPrivateHistory({...state, loading: false, jumping: null});
  }

  olderMessages?.addEventListener('click', async () => {
    const privateChat = currentSource === 'agent';
    const currentHistory = () => privateChat ? privateHistory : socialHistory;
    const state = currentHistory();
    if (!state?.cursor || state.loading || state.jumping || state.restoring) return;
    const jump = privateChat ? ++historyJump : historyJump;
    state.loading = true;
    if (privateChat) {
      stopReplyProgress();
      stopPolling();
    } else syncGroupReplyProgress();
    updateHistoryControls();
    if (historyNotice) historyNotice.textContent = '';
    try {
      const query = new URLSearchParams({before: String(state.cursor), limit: HISTORY_PAGE_SIZE});
      const result = await (privateChat ? privateHistoryPage(state, query) : historyPage(state, query));
      if (!result || (privateChat && jump !== historyJump)) return;
      if (result.status !== 200) throw new Error('History unavailable');
      const existing = new Set((privateChat ? lastAgentItems : lastSocialItems).map(item => item.id));
      const older = (result.body.items || []).filter(item => !existing.has(item.id));
      const anchor = privateChat && older.length ? chatHistoryAnchor() : null;
      state.cursor = result.body.cursor ?? null;
      state.readingHistory = true;
      const notice = older.length
        ? uiLabel(`已加载 ${older.length} 条旧消息。`, `Loaded ${older.length} earlier messages.`)
        : uiLabel('没有更早的消息。', 'No earlier messages.');
      if (!privateChat && older.length) renderSocialMessages([...older, ...lastSocialItems], {keepScroll: true});
      if (historyNotice) historyNotice.textContent = notice;
      if (!privateChat) return;
      searchScrollSnapshot = null;
      updateHistoryControls();
      if (older.length) renderAgentMessages([...older, ...lastAgentItems], {anchor});
    } catch {
      if (currentHistory() === state && (!privateChat || jump === historyJump) && historyNotice) {
        historyNotice.textContent = uiLabel('旧消息加载失败，请重试。', 'Couldn’t load earlier messages. Try again.');
      }
    } finally {
      state.loading = false;
      updateHistoryControls();
      if (!privateChat) syncGroupReplyProgress();
      else if (privateHistory === state && !readingPrivateContext()
        && !syncReplyProgress() && lastAgentItems.some(waitingAgentReply)) schedulePoll();
    }
  });
  function openSocialLatest() {
    const state = socialHistory;
    if (state?.restoring) return state.restoring;
    const unread = state?.unread;
    const preserveUnread = Boolean(unread && unread.committed < unread.latest);
    const opened = openSocialConversation(currentConversation.id, {
      acknowledge: !preserveUnread, preserveUnread, requireVisible: true, signal: AbortSignal.timeout(10000),
    });
    if (!state) return opened;
    state.restoring = opened.finally(() => {
      if (socialHistory === state) {
        state.restoring = null;
        updateHistoryControls();
      }
    });
    updateHistoryControls();
    return state.restoring;
  }

  latestMessages?.addEventListener('click', () => {
    if (!currentConversation || !historyScroller) return;
    historyScroller.focus({preventScroll: true});
    if (currentSource === 'social' && (socialHistory?.readingHistory || (liveBanner && !liveBanner.hidden))) {
      void openSocialLatest();
    } else if (currentSource === 'agent' && privateHistory && (privateHistory.readingHistory || (liveBanner && !liveBanner.hidden))) {
      void restorePrivateLatest(privateHistory);
    } else {
      historyScroller.scrollTop = historyScroller.scrollHeight;
      updateLatestMessageControl();
    }
  });
  markThreadRead?.addEventListener('click', () => {
    const state = socialHistory;
    if (unreadNotice) unreadNotice.textContent = '';
    if (state?.unread) void commitUnread(state, state.unread.latest, true);
  });
  historyScroller?.addEventListener('scroll', () => {
    updateLatestMessageControl();
    scheduleUnreadRead();
  }, {passive: true});
  const ResizeObserver = document.defaultView?.ResizeObserver;
  if (historyScroller && ResizeObserver) {
    let previousHeight = historyScroller.clientHeight;
    new ResizeObserver(() => {
      const before = previousHeight;
      previousHeight = historyScroller.clientHeight;
      if (!before || !previousHeight || before === previousHeight) return;
      // Growing the composer reduces the viewport before ResizeObserver runs.
      if (currentConversation && messageScrollerAtBottom(historyScroller, before)
          && !(currentSource === 'agent' ? readingPrivateContext() : readingSocialContext(before))) {
        historyScroller.scrollTop = historyScroller.scrollHeight;
      }
      updateLatestMessageControl();
    }).observe(historyScroller, {box: 'border-box'});
  }
  globalThis.addEventListener('resize', updateLatestMessageControl);
  newerMessages?.addEventListener('click', async () => {
    const privateChat = currentSource === 'agent';
    const currentHistory = () => privateChat ? privateHistory : socialHistory;
    const state = currentHistory();
    const unread = !privateChat && state?.unread;
    const timeline = state?.after ? state : unread;
    const after = timeline?.after;
    const scope = sendScope();
    const visible = () => privateChat
      ? privateHistory === state && scope === sendScope() && canWatchReply() && !sessionTransition?.pending
      : visibleSocialHistory(state);
    if (!after || !visible() || state.loading || state.jumping || state.restoring) return;
    const jump = historyJump;
    const open = socialOpen;
    const stillCurrent = () => open === socialOpen && jump === historyJump && visible();
    const hadButtonFocus = document.activeElement === newerMessages;
    state.loading = true;
    if (unreadNotice) unreadNotice.textContent = '';
    updateHistoryControls();
    try {
      const query = new URLSearchParams({after, limit: HISTORY_PAGE_SIZE});
      if (!privateChat) query.set('scope', 'workspace');
      const signal = AbortSignal.timeout(8000);
      const result = await (privateChat ? privateHistoryPage(state, query, signal) : historyPage(state, query, signal));
      if (!result || !stillCurrent()) return;
      if (result.status !== 200 || !Array.isArray(result.body.items)) throw new Error('history');
      const currentItems = privateChat ? lastAgentItems : lastSocialItems;
      const existing = new Set(currentItems.map(message => message.id));
      const items = result.body.items.filter(message => !existing.has(message.id) &&
        (privateChat ? PRIVATE_THREAD_ID.test(message.id || '') : Number.isSafeInteger(message.seq) && message.seq > after));
      if (result.body.has_newer && !items.length) throw new Error('history cursor');
      const anchor = chatHistoryAnchor();
      if (unread && Number.isSafeInteger(result.body.last_seq)) unread.latest = Math.max(unread.latest, result.body.last_seq);
      timeline.after = result.body.has_newer ? (privateChat ? items.at(-1).id : items.at(-1).seq) : null;
      if (items.length) {
        const updated = [...currentItems, ...items];
        if (privateChat) {
          searchScrollSnapshot = null;
          renderAgentMessages(updated, {anchor});
        } else renderSocialMessages(updated, {anchor});
      }
      if ((!privateChat || !timeline.after) && hadButtonFocus && [document.body, newerMessages].includes(document.activeElement)) {
        historyScroller?.focus({preventScroll:true});
      }
      if (!timeline.after && timeline === state && unreadNotice) unreadNotice.textContent =
        uiLabel('已加载到最新消息。', 'All newer messages are loaded.');
    } catch {
      if (stillCurrent() && unreadNotice) unreadNotice.textContent = uiLabel('后续消息加载失败，请重试。', 'Could not load newer messages. Try again.');
    } finally {
      state.loading = false;
      if (state === currentHistory()) {
        updateHistoryControls();
        if (stillCurrent()) {
          if (hadButtonFocus && document.activeElement === document.body && !newerMessages.hidden) {
            newerMessages.focus({preventScroll:true});
          }
          if (!privateChat) scheduleUnreadRead();
        }
      }
    }
  });

  let lastSocialItems = [];
  function waitingGroupReply(job) {
    return job.status === 'queued' || job.status === 'running';
  }

  function hasPendingReplies(items = lastSocialItems) {
    return items?.some(item => item.reply_jobs?.some(waitingGroupReply));
  }

  function canWatchGroupReplies() {
    return servedByDsbot && currentSource === 'social' && (currentConversation?.kind === 'group' || directAgentRoom(currentConversation))
      && !currentConversation.public_agent && socialHistory?.cid === currentConversation.id
      && !socialHistory.readingHistory && !socialHistory.loading
      && canWatchReply() && (groupReplyViews.size > 0 || Boolean(compactGroupReplies() && currentConversation.native_room_id));
  }

  function matchesGroupReply(snapshot, view) {
    return snapshot?.message_id === view.messageId && snapshot.attempt === view.attempt;
  }

  function activeGroupBotLabel(items, workingBots) {
    if (!groupBotActivity || !compactGroupReplies()) return '';
    const bots = new Map();
    for (const [id, snapshot] of items) {
      const view = groupReplyViews.get(id);
      if (!view || snapshot.status !== 'running' || !matchesGroupReply(snapshot, view)) continue;
      const {agent_id, agent_name, agent_owner_id} = view.job;
      if (!agent_name) continue;
      const key = JSON.stringify([agent_owner_id, agent_id ?? agent_name]);
      bots.set(key, view.job);
    }
    for (const bot of workingBots) {
      if (groupAgentTarget(bot?.id) && typeof bot.name === 'string' && bot.name) {
        bots.set('native:' + bot.id, {agent_name:bot.name});
      }
    }
    if (!bots.size) return '';
    const active = [...bots.values()];
    const names = active.map(bot => bot.agent_owner_id && active.some(other => other !== bot && other.agent_name === bot.agent_name)
      ? groupAgentName(bot.agent_name, bot.agent_owner_name, bot.agent_owner_id, bot.agent_owner_handle)
      : bot.agent_name).join(uiLabel('、', ', '));
    return uiLabel(`${names} 正在工作…`, `${names} ${bots.size === 1 ? 'is' : 'are'} working…`);
  }

  function visibleGroupReply(id) {
    const view = groupReplyViews.get(id);
    if (!view || view.row.hidden || !streamingReplySource(view.preview)) return false;
    const viewport = document.getElementById('message-scroller').getBoundingClientRect();
    const reply = view.row.getBoundingClientRect();
    return reply.bottom > viewport.top && reply.top < viewport.bottom;
  }

  function withGroupReplyScroll(update) {
    const scroller = document.getElementById('message-scroller');
    const top = scroller.scrollTop;
    const follow = messageScrollerAtBottom(scroller);
    const viewportTop = scroller.getBoundingClientRect().top;
    const anchor = !follow && [...document.getElementById('message-list').children]
      .find(row => !row.hidden && row.getBoundingClientRect().bottom > viewportTop);
    const offset = anchor && anchor.getBoundingClientRect().top;
    update();
    scroller.scrollTop = follow ? scroller.scrollHeight : top;
    if (anchor?.isConnected && !anchor.hidden) scroller.scrollTop += anchor.getBoundingClientRect().top - offset;
    if (!follow) updateLatestMessageControl();
  }

  function paintGroupReplyProgress(items, {preserveMissing = false, showActivity = true, workingBots = []} = {}) {
    const changes = [];
    for (const [id, view] of groupReplyViews) {
      const item = items.get(id);
      // The live snapshot disappears just before the durable reply or failure arrives.
      if (!item && preserveMissing && view.row.dataset.state === 'running') {
        view.missingSince ??= Date.now();
        if (Date.now() - view.missingSince < 2000) continue;
      } else view.missingSince = null;
      const snapshot = matchesGroupReply(item, view) ? item : null;
      if (snapshot?.status === 'passed') {
        changes.push({id, view, passed:true});
        continue;
      }
      const previousText = streamingReplySource(view.preview);
      // The progress feed can drop a reply before the transcript receives it.
      // Keep the same attempt readable until its durable result replaces it.
      if (preserveMissing && previousText && !snapshot?.text && (!item || snapshot)) continue;
      const text = typeof snapshot?.text === 'string' ? snapshot.text : '';
      const state = snapshot?.status === 'running' || text ? 'running' : view.job.status;
      if (previousText !== text || view.row.dataset.state !== state) changes.push({view, text, state});
    }
    const activity = showActivity ? activeGroupBotLabel(items, workingBots) : '';
    const activityChanged = groupBotActivity && activity !== groupBotActivity.textContent;
    if (!changes.length && !activityChanged) return;
    withGroupReplyScroll(() => {
      if (activityChanged) groupBotActivity.textContent = activity;
      for (const {id, view, text, state, passed} of changes) {
        if (passed) {
          view.row.remove();
          groupReplyViews.delete(id);
          continue;
        }
        if (streamingReplySource(view.preview) !== text) paintStreamingReply(document, view.preview, text);
        view.row.dataset.state = state;
        view.note.textContent = groupReplyLabel(state, view.job);
      }
      updateGroupReplyVisibility();
    });
  }

  function stopGroupReplyProgress({preservePreview = false} = {}) {
    const watch = groupReplyWatch;
    groupReplyWatch = null;
    if (watch) {
      globalThis.clearTimeout(watch.timer);
      globalThis.clearTimeout(watch.timeout);
      watch.controller?.abort();
    }
    // A hidden pane pauses polling. Keep its scoped text and scroll anchor
    // available while the same reply reconnects.
    if (!preservePreview || groupReplyScope !== sendScope()) paintGroupReplyProgress(new Map());
    else if (groupBotActivity) groupBotActivity.textContent = '';
  }

  function currentGroupReplyWatch(watch) {
    return watch && groupReplyWatch === watch && sendScope() === watch.scope && canWatchGroupReplies();
  }

  function scheduleGroupReplyProgress(watch, delay = 500) {
    if (!currentGroupReplyWatch(watch)) return;
    watch.timer = globalThis.setTimeout(() => void pollGroupReplyProgress(watch), delay);
  }

  async function pollGroupReplyProgress(watch) {
    if (!currentGroupReplyWatch(watch)) {
      if (groupReplyWatch === watch) stopGroupReplyProgress({preservePreview: !canWatchReply()});
      return;
    }
    const controller = watch.controller = new AbortController();
    watch.timeout = globalThis.setTimeout(() => controller.abort(), 5000);
    const result = await request('GET', watch.path, undefined, undefined, controller.signal).catch(() => null);
    globalThis.clearTimeout(watch.timeout);
    watch.controller = null;
    if (!currentGroupReplyWatch(watch)) {
      if (groupReplyWatch === watch) stopGroupReplyProgress({preservePreview: !canWatchReply()});
      return;
    }
    if (result?.status === 200 && Array.isArray(result.body.items)) {
      const items = new Map(result.body.items.filter(item => item?.id).map(item => [item.id, item]));
      const missing = [...groupReplyViews].filter(([id, view]) => {
        const snapshot = items.get(id);
        return !snapshot || (snapshot.message_id === view.messageId && snapshot.attempt > view.attempt);
      });
      const transitioned = missing.some(([id, view]) => matchesGroupReply(watch.items.get(id), view));
      watch.items = items;
      watch.workingBots = Array.isArray(result.body.working_bots) ? result.body.working_bots : [];
      if (watch.degraded) stopPolling();
      watch.degraded = false;
      paintGroupReplyProgress(items, {preserveMissing: true, workingBots:watch.workingBots});
      // Replies can settle before the first progress poll, between tab visits,
      // or while Social activity delivery is reconnecting. Reconcile from the
      // durable transcript even when this watch never saw an active snapshot.
      if (missing.length) {
        if (readingSocialContext()) {
          // A long preview can put the reader above the bottom of the timeline.
          // Reconcile that visible reply without interrupting history or a draft edit.
          const finishing = new Set(missing.filter(([id]) => !items.has(id) && visibleGroupReply(id)).map(([id]) => id));
          if (finishing.size && !readingSocialContext(undefined, {allowScrolled:true}) &&
              !watch.reconciling && (transitioned || Date.now() >= watch.nextReconcileAt)) {
            watch.nextReconcileAt = Date.now() + 8000;
            watch.reconciling = true;
            void openSocialConversation(currentConversation.id, {refresh:true, finishing})
              .finally(() => { watch.reconciling = false; });
          }
          if (liveBanner) liveBanner.hidden = false;
        } else if (!pollTimer && (transitioned || Date.now() >= watch.nextReconcileAt)) {
          // The progress feed is bounded. Throttle repeated reads for any
          // still-pending jobs that are outside its current window.
          watch.nextReconcileAt = Date.now() + 8000;
          schedulePoll(350);
        }
      }
      scheduleGroupReplyProgress(watch, groupReplyViews.size || watch.workingBots.length ? 500 : 1500);
    } else if ([401, 403, 404].includes(result?.status)) {
      stopGroupReplyProgress();
      if (!pollTimer) scheduleSocialPoll(currentConversation);
    } else {
      watch.degraded = true;
      if (groupBotActivity) groupBotActivity.textContent = '';
      if (!pollTimer) scheduleSocialPoll(currentConversation);
      scheduleGroupReplyProgress(watch, 1500);
    }
  }

  function syncGroupReplyProgress() {
    if (!canWatchGroupReplies()) {
      stopGroupReplyProgress({preservePreview: !canWatchReply()});
      return;
    }
    const scope = sendScope();
    if (groupReplyWatch?.scope === scope) {
      paintGroupReplyProgress(groupReplyWatch.items, {
        preserveMissing:true, showActivity:!groupReplyWatch.degraded, workingBots:groupReplyWatch.workingBots,
      });
      return;
    }
    if (groupReplyWatch) stopGroupReplyProgress();
    groupReplyWatch = {
      scope, path: `${socialBase()}/${currentConversation.id}/reply-progress`, items: new Map(), nextReconcileAt: 0,
    };
    scheduleGroupReplyProgress(groupReplyWatch);
  }

  const groupReplyLabels = {
    queued: ['正在等待智能体', 'Waiting for the agent'],
    running: ['正在生成回复', 'Writing a reply'],
    failed: ['回复未完成', 'Reply could not be completed'],
    replied: ['回复已完成', 'Reply completed'],
  };
  function compactGroupReplies() {
    return currentConversation?.kind === 'group' && !currentConversation.public_agent;
  }

  function updateGroupReplyVisibility(list = document.getElementById('message-list')) {
    if (!compactGroupReplies()) return;
    for (const row of list.children) {
      if (!row.classList.contains('group-reply-job')) continue;
      const state = row.dataset.state;
      const waiting = state === 'queued' || state === 'running';
      const preview = groupReplyViews.get(row.dataset.replyJobId)?.preview;
      row.hidden = waiting && !streamingReplySource(preview).trim();
    }
  }

  function groupReplyLabel(state, job) {
    if (state === 'failed' && job?.error_code === 'reply_timeout') {
      return uiLabel('回复超时', 'The reply timed out');
    }
    if (state === 'failed' && job?.error_code === 'direct_agent_unavailable') {
      return uiLabel('智能体已无法在此私聊回复', 'This agent is no longer available in this chat');
    }
    if (state === 'failed' && job?.error_code === 'group_agent_unavailable') {
      return uiLabel('智能体已无法在此群聊回复', 'This agent is no longer available in the group');
    }
    return uiLabel(...(groupReplyLabels[state] || groupReplyLabels.queued));
  }

  function groupAgentName(name, ownerName, ownerId, ownerHandle) {
    const owner = ownerName || (ownerHandle && '@' + ownerHandle);
    if (!owner) return name;
    const sameName = ownerHandle && (currentConversation?.agent_members || []).some(agent =>
      agent.name === name && agent.owner_name === ownerName && agent.owner_id !== ownerId);
    return name + ' · ' + owner + (sameName ? ' (@' + ownerHandle + ')' : '');
  }
  const groupReplyAuthor = reply => groupAgentName(reply.agent_name, reply.agent_owner_name,
    reply.agent_owner_id, reply.agent_owner_handle) + uiLabel(' · AI 智能体', ' · AI agent');
  const groupReplyButton = row => [...(row?.children || [])].find(node => node.className === 'group-reply-retry');

  function setGroupReplyRetryButton(button, busy) {
    if (!button) return;
    button.setAttribute('aria-disabled', String(busy));
    button.textContent = busy ? uiLabel('重试中…', 'Retrying…') : uiLabel('重试', 'Retry');
  }

  function renderGroupReplyRow(item, job, row = document.createElement('li'), previous) {
    const attempt = Number.isSafeInteger(job.attempt) ? String(job.attempt) : '';
    const sameAttempt = row.dataset.replyAttempt === attempt;
    const previewBefore = sameAttempt ? previous?.preview : null;
    const wasRunning = sameAttempt && row.dataset.state === 'running';
    row.className = 'other group-reply-job';
    row.hidden = false;
    row.dataset.chatAuthor = 'agent';
    row.tabIndex = -1;
    row.dataset.replyJobId = job.id;
    row.dataset.state = job.status;
    row.dataset.replyAttempt = attempt;
    const role = document.createElement('p');
    role.className = 'role';
    role.textContent = groupReplyAuthor(job);
    const note = document.createElement('div');
    note.className = 'group-reply-state';
    note.setAttribute('role', 'status');
    row.replaceChildren(role, note);
    if (servedByDsbot && waitingGroupReply(job) && Number.isSafeInteger(job.attempt) && job.attempt > 0) {
      const preview = previewBefore || document.createElement('div');
      preview.className = 'group-reply-preview body';
      preview.hidden = !streamingReplySource(preview);
      preview.setAttribute('aria-live', 'off');
      if (wasRunning) row.dataset.state = 'running';
      groupReplyViews.set(job.id, {messageId: item.id, attempt: job.attempt, job, row, note, preview,
        missingSince: sameAttempt ? previous?.missingSince : null});
      row.append(preview);
    } else groupReplyViews.delete(job.id);
    note.textContent = groupReplyLabel(row.dataset.state, job);
    if (job.can_retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'group-reply-retry';
      button.setAttribute('aria-label', uiLabel('重试 ', 'Retry ') +
        groupAgentName(job.agent_name, job.agent_owner_name, job.agent_owner_id, job.agent_owner_handle));
      setGroupReplyRetryButton(button, groupReplyRetries.has(job.id));
      button.addEventListener('click', () => retryGroupReply(item, job));
      row.append(button);
    }
    return row;
  }

  async function retryGroupReply(item, job) {
    if (groupReplyRetries.has(job.id)) return;
    const cid = currentConversation.id;
    const scope = sendScope();
    const findRow = () => [...document.getElementById('message-list').children]
      .find(row => row.dataset.replyJobId === job.id);
    const retry = Symbol();
    groupReplyRetries.set(job.id, retry);
    const inScope = () => sendScope() === scope && currentSource === 'social' && currentConversation?.id === cid;
    const ownedRetry = () => groupReplyRetries.get(job.id) === retry && inScope();
    const advanced = candidate => candidate?.id === job.id && Number.isSafeInteger(candidate.attempt) &&
      candidate.attempt > job.attempt && candidate.agent_id === job.agent_id && candidate.agent_owner_id === job.agent_owner_id;
    setGroupReplyRetryButton(groupReplyButton(findRow()), true);
    const result = await request('POST', `${socialBase()}/${cid}/messages/${item.id}/agent-retry`,
      {job_id: job.id, attempt: job.attempt}, undefined, AbortSignal.timeout(15000)).catch(() => ({status: 0, body: {}}));
    let next = result.status === 200 && Array.isArray(result.body.reply_jobs) && result.body.reply_jobs.find(advanced);
    const history = socialHistory;
    if (!next && servedByDsbot && ownedRetry() && history && chatPathId(item.id) &&
        (unclearSocialDelivery(result.status) || result.status === 409)) {
      // A lost acknowledgement can leave a real retry running in Bot Social.
      const query = new URLSearchParams({around:item.id,limit:'1',scope:'workspace'});
      const receipt = await historyPage(history,query,AbortSignal.timeout(4500)).catch(() => null);
      const original = receipt?.status === 200 && Array.isArray(receipt.body.items) && receipt.body.items.find(message =>
        message.id === item.id && !message.retracted && message.conversation_id === cid &&
        message.workspace_id === history.wid && message.user_id === history.owner);
      next = Array.isArray(original?.reply_jobs) && original.reply_jobs.find(advanced);
    }
    if (groupReplyRetries.get(job.id) !== retry) return;
    groupReplyRetries.delete(job.id);
    if (!inScope()) return;
    const row = findRow();
    const button = groupReplyButton(row);
    const source = lastSocialItems.find(message => message.id === item.id && !message.retracted);
    const current = source?.reply_jobs?.find(candidate => candidate.id === job.id);
    if (next) {
      if (current && next.attempt > current.attempt) {
        const updated = {...source, reply_jobs: source.reply_jobs.map(candidate => candidate === current ? next : candidate)};
        lastSocialItems = lastSocialItems.map(message => message === source ? updated : message);
        if (row?.dataset.state && row.dataset.state !== 'replied') {
          const focused = Boolean(button && document.activeElement === button);
          withGroupReplyScroll(() => {
            if (next.status === 'passed') { row.remove(); groupReplyViews.delete(next.id); }
            else renderGroupReplyRow(updated, next, row);
            updateGroupReplyVisibility();
          });
          if (focused && next.status !== 'passed') (groupReplyButton(row) || row).focus({preventScroll: true});
        }
        syncGroupReplyProgress();
      } else setGroupReplyRetryButton(button, false);
      if (next.status === 'replied') {
        if (!readingSocialContext()) void openSocialConversation(cid, {refresh:true});
        else if (liveBanner) liveBanner.hidden = false;
      } else if (!socialHistory?.readingHistory) scheduleSocialPoll(currentConversation);
      show('ok', uiLabel('已重新请求回复。', 'Reply requested again.'), {announceOnly: true});
    } else {
      setGroupReplyRetryButton(button, false);
      show('error', messageFor(result.body.error, uiLabel('暂时无法重试，请稍后再试。', 'Could not retry. Try again.')));
      if (result.status === 409 && !readingSocialContext()) void openSocialConversation(cid, {refresh: true});
    }
  }

  const groupMemoryDialog = document.getElementById('group-memory-dialog');
  const groupMemoryStatus = document.getElementById('group-memory-status');
  const groupMemoryList = document.getElementById('group-memory-list');
  const groupMemoryAuto = document.getElementById('group-memory-auto');
  const groupMemoryAutoStatus = document.getElementById('group-memory-auto-status');
  let groupMemoryView = null;

  function groupMemoryButton(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  const groupMemoryActive = view => groupMemoryDialog?.open && groupMemoryView === view && sendScope() === view.scope;
  groupMemoryAuto?.addEventListener('click', async () => {
    const view = groupMemoryView;
    if (!groupMemoryActive(view) || typeof view.autoCapture !== 'boolean') return;
    const enabled = !view.autoCapture;
    groupMemoryAuto.setAttribute('aria-checked', String(enabled));
    groupMemoryAuto.disabled = true;
    groupMemoryAutoStatus.textContent = '';
    const result = await request('POST', `${view.path}/auto-capture`,{enabled})
      .catch(() => ({status:0,body:{}}));
    if (!groupMemoryActive(view)) return;
    if (result.status === 200) view.autoCapture = result.body.enabled === true;
    else groupMemoryAutoStatus.textContent = messageFor(result.body.error,'设置保存失败，请重试。');
    groupMemoryAuto.setAttribute('aria-checked', String(view.autoCapture));
    groupMemoryAuto.disabled = false;
  });

  async function openGroupMemory(highlight) {
    if (!servedByDsbot || currentSource !== 'social' ||
        currentConversation?.kind !== 'group' || currentConversation.public_agent) return;
    const view = {scope:sendScope(), path:`${socialBase()}/${currentConversation.id}/shared-memory`};
    groupMemoryView = view;
    const active = () => groupMemoryActive(view);
    groupMemoryAuto.disabled = true;
    groupMemoryAuto.setAttribute('aria-checked','false');
    groupMemoryAutoStatus.textContent = '';
    document.getElementById('group-memory-inbox').href = '/memory?'+new URLSearchParams({workspace:workspaceId(),page:'candidates'});
    groupMemoryList.replaceChildren();
    groupMemoryStatus.textContent = '正在读取群记忆…';
    if (!groupMemoryDialog.open) groupMemoryDialog.showModal();
    const result = await request('GET', view.path).catch(() => ({status:0,body:{}}));
    if (!active()) return;
    if (result.status !== 200) {
      groupMemoryStatus.textContent = messageFor(result.body.error,'群记忆加载失败，请重试。');
      return;
    }
    view.autoCapture = result.body.auto_capture === true;
    groupMemoryAuto.setAttribute('aria-checked',String(view.autoCapture));
    groupMemoryAuto.disabled = false;
    const items = result.body.items || [];
    const selected = items.find(item => item.id === highlight);
    groupMemoryStatus.textContent = highlight && !selected ? '这条群记忆已失效或被移除。'
      : items.length ? '' : '还没有共享的记忆。';
    const rows = items.map(item => {
      const row = document.createElement('li');
      const title = document.createElement('h3');
      title.textContent = item.title;
      const body = document.createElement('p');
      body.className = 'group-memory-body';
      body.textContent = item.body;
      const author = document.createElement('p');
      author.className = 'note';
      author.textContent = item.author;
      const actions = document.createElement('div');
      actions.className = 'group-memory-actions';
      const source = groupMemoryButton('查看原消息', async () => {
        groupMemoryDialog.close();
        setGroupInfoOpen(false);
        if (await jumpToMessage(item.source_message_id, null) === false && sendScope() === view.scope) {
          show('error', '这条原消息已无法查看。');
        }
      });
      actions.append(source);
      if (item.can_remove) {
        const remove = groupMemoryButton('移除', () => {
          const confirm = groupMemoryButton('确认移除', async () => {
            confirm.disabled = cancel.disabled = true;
            const result = await request('POST', `${view.path}/${encodeURIComponent(item.id)}/remove`, {})
              .catch(() => ({status:0,body:{}}));
            if (!active()) return;
            if (result.status === 200) await openGroupMemory();
            else {
              confirm.disabled = cancel.disabled = false;
              groupMemoryStatus.textContent = messageFor(result.body.error,'移除失败，请重试。');
            }
          });
          const cancel = groupMemoryButton('取消', () => {
            actions.replaceChildren(source, remove);
            remove.focus();
          });
          actions.replaceChildren(source, confirm, cancel);
          confirm.focus();
        });
        actions.append(remove);
      }
      row.append(title, author, body, actions);
      return row;
    });
    groupMemoryList.replaceChildren(...rows);
    if (selected) {
      const row = rows[items.indexOf(selected)];
      row.tabIndex = -1;
      row.focus();
    }
  }

  function renderGroupMemoryRefs(refs) {
    const block = document.createElement('div');
    block.className = 'group-memory-refs';
    const label = document.createElement('span');
    label.textContent = '参考群记忆';
    block.append(label, ...refs.map(ref => groupMemoryButton(ref.title, () => openGroupMemory(ref.id))));
    return block;
  }

  function renderSocialMessages(items, {keepScroll = Boolean(socialHistory?.readingHistory), refresh = false, anchor} = {}) {
    const hidden = hiddenMessageReceipts.get(sendScope());
    if (hidden && items) items = items.filter(row => !hidden.has(row.id)).map(row =>
      hidden.has(row.reply_preview?.message_id)
        ? {...row, reply_preview: {message_id: row.reply_preview.message_id, available: false}} : row);
    const translateRoom = currentConversation?.kind === 'group' || (currentConversation?.kind === 'dm' && chatPreferences.auto_translate === true);
    autoTranslation.open(servedByDsbot && currentUser && translateRoom && !currentConversation?.public_agent
      ? {user:currentUser.id,wid:workspaceId(),cid:currentConversation.id}
      : null);
    autoTranslation.clearRows();
    const scroller = document.getElementById('message-scroller');
    const oldHeight = scroller.scrollHeight;
    const oldTop = scroller.scrollTop;
    const wasAtLatest = oldHeight - oldTop - scroller.clientHeight < 48;
    clearVoicePlayers();
    const list = document.getElementById('message-list');
    const scope = sendScope();
    const bodyViews = captureMessageBodies(list, scope);
    const sameReplyScope = list.dataset.groupReplyScope === scope;
    list.dataset.groupReplyScope = scope;
    const existingGroupReplies = new Map();
    let focusedGroupReply;
    const active = document.activeElement;
    if (sameReplyScope) {
      for (const row of list.children) {
        const id = row.dataset.replyJobId;
        if (!id) continue;
        existingGroupReplies.set(id, row);
        if (active?.closest?.('[data-reply-job-id]') === row) focusedGroupReply = {id, active, retry: active === groupReplyButton(row)};
      }
    }
    const previousGroupViews = sameReplyScope ? new Map(groupReplyViews) : new Map();
    if (sameReplyScope && items) {
      const previous = new Map(lastSocialItems.filter(item => item.edited || item.retracted).map(item => [item.id, item]));
      if (previous.size) items = items.map(item => {
        const changed = previous.get(item.id);
        return changed?.revision > item.revision ? changed : item;
      });
    }
    if (sameReplyScope && items?.some(item => item.reply_jobs?.length)) {
      // An earlier history read can settle after the retry receipt. Keep the
      // acknowledged attempt until the transcript catches up.
      const previousJobs = new Map(lastSocialItems.flatMap(item => item.reply_jobs || []).map(job => [job.id, job]));
      items = items.map(item => item.reply_jobs?.some(job => previousJobs.get(job.id)?.attempt > job.attempt)
        ? {...item, reply_jobs: item.reply_jobs.map(job => previousJobs.get(job.id)?.attempt > job.attempt ? previousJobs.get(job.id) : job)}
        : item);
    }
    lastSocialItems = items || [];
    const editedSources = new Map(lastSocialItems.filter(item => item.retracted || item.edited).map(item => [item.id, item]));
    const queue = pendingSends.get(scope);
    if (servedByDsbot && queue?.social) {
      for (const job of queue.jobs) {
        const receipt = lastSocialItems.find(item => ownSocialReceipt(item, queue, job.key));
        if (receipt) {
          job.acceptReceipt?.({status:200, body:{message:receipt}});
          removeSendJob(queue, job);
        }
      }
    }
    if (currentConversation?.kind === 'group' && !currentConversation.public_agent) {
      const attempt = groupReplyDraft(scope).attempt;
      if (attempt && lastSocialItems.some(item => item.client_key === attempt.key) && confirmGroupReplyDraft(scope, attempt.key)) {
        show('ok', uiLabel('已发送到群聊。', 'Sent to the group.'), {announceOnly: true});
      }
    }
    const durableGroupReplies = new Set(lastSocialItems
      .filter(item => item.role === 'agent' && item.reply_job_id)
      .map(item => item.reply_job_id));
    // Keep an open model attached to its original message when a sync rebuilds the list.
    const models = new Map();
    const focusedModelControl = document.activeElement?.closest('.chat-file-model3d') ? document.activeElement : null;
    for (const row of list.children) {
      const model = Array.from(row.children).find(child => child.dataset.model3dSource);
      if (model) models.set(row.dataset.messageId, model);
    }
    list.replaceChildren();
    groupReplyViews.clear();
    document.getElementById('chat-empty').hidden = (items || []).length > 0;
    const people = currentConversation && currentConversation.members || members;
    const pendingKeys = pendingMessageKeys();
    const unread = socialHistory?.unread;
    let needsDivider = Boolean(unread?.firstId);
    const showsStudioReferences = namedTeamGroup();
    for (const item of items || []) {
      if (pendingKeys.has(item.client_key)) continue;
      if (needsDivider && item.seq >= unread.firstSeq) {
        const divider = document.createElement('li');
        divider.className = 'chat-unread-divider';
        divider.id = 'chat-first-unread';
        divider.textContent = uiLabel('未读消息', 'Unread messages');
        list.append(divider);
        needsDivider = false;
      }
      const groupReplyID = item.role === 'agent' && item.reply_job_id;
      const li = (groupReplyID && existingGroupReplies.get(groupReplyID)) || document.createElement('li');
      if (groupReplyID) {
        li.replaceChildren();
        li.hidden = false;
        li.dataset.replyJobId = groupReplyID;
        li.dataset.state = 'replied';
        delete li.dataset.replyAttempt;
        li.tabIndex = -1;
      }
      li.dataset.messageId = item.id;
      if (Number.isSafeInteger(item.seq)) li.dataset.messageSeq = String(item.seq);
      const mine = item.role !== 'agent' && item.user_id === (currentUser && currentUser.id);
      li.dataset.chatAuthor = item.role === 'agent' ? 'agent' : 'person';
      li.className = mine ? 'mine' : 'other';
      const role = document.createElement('p');
      role.className = mine && item.role !== 'agent' && !item.forwarded_from ? 'role visually-hidden' : 'role';
      role.textContent = socialMessageAuthor(item, people);
      const body = transcriptMessageBody(bodyViews.bodies.get(item.id), item.retracted ? '此消息已撤回' : (item.body || ''),
        servedByDsbot && item.role === 'agent' && !item.retracted, previousGroupViews.get(groupReplyID)?.preview);
      body.className = 'body';
      body.hidden = item.attachment?.bytes !== undefined && item.body === item.attachment.title;
      if (item.forwarded_from && !item.retracted) {
        body.dataset.forwarded = '1';
        body.title = '转发自 ' + item.forwarded_from.author;
        role.textContent += ' · 转发自 ' + item.forwarded_from.author;
      } else if (body.dataset.forwarded) {
        delete body.dataset.forwarded;
        body.removeAttribute('title');
      }
      const time = document.createElement('p');
      time.className = 'time';
      time.textContent = formatTime(item.created);
      li.append(role);
      if (item.role !== 'agent' && !item.retracted && item.reply_preview) {
        const original = editedSources.get(item.reply_preview.message_id);
        const reply = original?.retracted ? {message_id:original.id, available:false}
          : original && item.reply_preview.available ? {...item.reply_preview, excerpt:original.body.replace(/\s+/g, ' ').trim().slice(0,120)}
          : item.reply_preview;
        li.append(quoteBlock(reply, true));
      }
      li.append(body, time);
      if (!item.retracted && item.group_memory_refs?.length) li.insertBefore(renderGroupMemoryRefs(item.group_memory_refs), time);
      const studioReference = !item.retracted && showsStudioReferences && studioRevisionReference(item.studio_reference);
      if (studioReference) {
        const link = document.createElement('a');
        link.className = 'group-studio-reference';
        link.href = studioDocumentHref(workspaceId(), studioReference.document_id, studioReference.revision);
        link.textContent = uiLabel('团队文档 · 引用版本 ', 'Team document · Referenced version ') + studioReference.revision;
        li.insertBefore(link, time);
      }
      if (!mine) autoTranslation.add(item,li,body);
      if (item.voice && !item.retracted) li.insertBefore(voicePlayer(item), time);
      if (item.attachment?.bytes !== undefined && !item.retracted) {
        const model = models.get(item.id);
        const reuse = item.attachment.mime === 'model/gltf-binary'
          && model?.dataset.model3dSource === item.attachment.path;
        li.insertBefore(reuse ? model : renderMessageFile(item.attachment), time);
      } else if (item.attachment && !item.retracted) {
        const card = document.createElement('article');
        card.className = 'stream-artifact';
        const copy = document.createElement('span');
        copy.className = 'stream-artifact-copy';
        const heading = document.createElement('strong');
        heading.textContent = item.attachment.title || '附件';
        const file = document.createElement('a');
        file.href = item.attachment.path;
        // An attachment is a workspace media artifact, so a picture can be
        // shown as a picture. Before this, every attachment was a document
        // card: the sender saw a DOC cover instead of the photo they shared.
        if (String(item.attachment.mime || '').startsWith('image/')) {
          card.classList.add('stream-artifact-picture');
          const image = document.createElement('img');
          image.className = 'stream-artifact-image';
          image.src = item.attachment.path;
          image.alt = item.attachment.title || '聊天图片';
          image.setAttribute('loading', 'lazy');
          file.textContent = '查看原图：' + (item.attachment.title || '图片');
          copy.append(heading, file);
          card.append(image, copy);
        } else {
          const cover = document.createElement('span');
          cover.className = 'stream-artifact-cover';
          cover.textContent = 'DOC';
          if (chatPreferences.document_cards) { file.className = 'chat-document-card'; file.setAttribute('aria-label', '作品卡片：' + item.attachment.title); }
          file.textContent = '下载作品：' + item.attachment.title + (item.attachment.revision ? ' · 修订 ' + item.attachment.revision : '');
          copy.append(heading, file);
          card.append(cover, copy);
        }
        li.append(card);
      }
      if (mine && !item.retracted) {
        const edit = document.createElement('button');
        edit.type = 'button'; edit.textContent = '编辑'; edit.hidden = true;
        const retract = document.createElement('button');
        retract.type = 'button'; retract.textContent = '撤回'; retract.hidden = true;
        const controls = document.createElement('span');
        controls.className = 'message-edit-controls';
        let changing = false;
        const change = async (operation, confirm, cancel, text) => {
          if (scope !== sendScope() || changing) return;
          changing = cancel.disabled = true;
          confirm.setAttribute('aria-busy', 'true');
          const payload = {revision: item.revision || 1};
          if (operation === 'edit') payload.body = text;
          const owner = currentUser, wid = workspaceId(), cid = currentConversation.id;
          const result = await request('POST', `${socialBase()}/${cid}/messages/${item.id}/${operation}`, payload, undefined,
            AbortSignal.timeout(10000)).catch(() => ({status:0, body:{}}));
          changing = cancel.disabled = false;
          confirm.removeAttribute('aria-busy');
          if (currentUser !== owner || workspaceId() !== wid) return;
          const message = result.body?.message;
          if (result.status !== 200 || message?.id !== item.id || message.user_id !== owner.id ||
              message.workspace_id !== wid || message.conversation_id !== cid || !Number.isSafeInteger(message.revision) ||
              message.revision <= payload.revision || message.retracted !== (operation === 'retract')) {
            if (scope === sendScope()) {
              show('error', messageFor(result.body?.error, '消息未更新，请重试。'));
              if (!sessionTransition?.pending) confirm.focus({preventScroll:true});
            }
            return;
          }
          if (scope === sendScope()) {
            const restoreFocus = document.activeElement === confirm && !sessionTransition?.pending;
            showSocialMessageChange(scope, message);
            if (restoreFocus) {
              const row = Array.from(list.children).find(node => node.dataset.messageId === item.id);
              if (row) { row.tabIndex = -1; row.focus({preventScroll:true}); }
            }
          }
          void loadSessions();
        };
        edit.addEventListener('click', () => {
          if (changing) return;
          controls.replaceChildren();
          const input = document.createElement('textarea'); input.value = item.body || '';
          input.setAttribute('aria-label', '编辑消息'); input.maxLength = 4000;
          const save = document.createElement('button'); save.type = 'button'; save.textContent = '保存修改';
          save.addEventListener('click', () => {
            // Editing replaces text that is already on the other side, so this
            // button only opens the confirm step; the explicit confirm sends it.
            const draft = input.value;
            const note = document.createElement('span');
            note.className = 'message-edit-note';
            note.textContent = '保存后，这条已发出的消息会被新内容替换，其他人看到的是修改后的版本。';
            const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = '确认修改';
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
            cancel.addEventListener('click', () => controls.replaceChildren());
            confirm.addEventListener('click', () => change('edit', confirm, cancel, draft));
            controls.replaceChildren(note, confirm, cancel);
            confirm.focus({preventScroll:true});
          });
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
          cancel.addEventListener('click', () => controls.replaceChildren());
          controls.append(input, save, cancel);
          input.focus({preventScroll:true});
        });
        retract.addEventListener('click', () => {
          if (changing) return;
          controls.replaceChildren();
          const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = '确认撤回';
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
          cancel.addEventListener('click', () => controls.replaceChildren());
          confirm.addEventListener('click', () => change('retract', confirm, cancel));
          controls.append(confirm, cancel);
          confirm.focus({preventScroll:true});
        });
        li.append(edit, retract, controls);
      }
      if (item.role === 'agent' && !item.retracted && currentConversation?.public_agent?.open !== false
        && currentConversation?.direct?.open !== false) {
        const reply = document.createElement('button');
        reply.type = 'button';
        reply.textContent = '回复';
        reply.setAttribute('aria-label', '回复 ' + item.agent_name);
        reply.addEventListener('click', () => composeReply(item, item.agent_name || '智能体'));
        li.append(reply);
      }
      if (item.role === 'agent' && !currentConversation?.public_agent && saveableSocialMessage(item)) li.append(saveMessageButton(item));
      if (item.role === 'agent' && shareableMessageHref(item)) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = uiLabel('复制消息链接', 'Copy message link');
        copy.addEventListener('click', () => copyMessageLink(shareableMessageHref(item), scope));
        li.append(copy);
      }
      if (!item.retracted && (item.role !== 'agent' || selecting)) li.append(messageTools(item, li));
      if (!selecting && item.role !== 'agent' && !item.retracted) li.append(reactionBar(item));
      if (!selecting && item.role !== 'agent' && !item.retracted) {
        const more = document.createElement('button');
        more.type = 'button'; more.className = 'message-more'; more.textContent = '⋯';
        more.setAttribute('aria-label', '消息操作'); more.setAttribute('aria-haspopup', 'menu');
        const openAtMessage = () => {
          const rect = more.getBoundingClientRect();
          openMessageMenu(item, li, mine, rect.left, rect.bottom);
        };
        more.addEventListener('click', event => { event.stopPropagation(); openAtMessage(); });
        li.addEventListener('keydown', event => {
          if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); openAtMessage(); }
        });
        li.append(more);
        li.addEventListener('contextmenu', event => {
          if (selecting) return;
          event.preventDefault();
          openMessageMenu(item, li, mine, event.clientX, event.clientY);
        });
      }
      list.append(li);
      if (!item.retracted) {
        for (const job of item.reply_jobs || []) {
          if (job.status === 'replied' || job.status === 'passed' || durableGroupReplies.has(job.id)) continue;
          list.append(renderGroupReplyRow(item, job, existingGroupReplies.get(job.id), previousGroupViews.get(job.id)));
        }
      }
    }
    updateGroupReplyVisibility(list);
    if (focusedModelControl?.isConnected) focusedModelControl.focus({preventScroll: true});
    if (focusedGroupReply) {
      const target = [...list.children].find(row => row.dataset.replyJobId === focusedGroupReply.id);
      const focusTarget = focusedGroupReply.active.isConnected ? focusedGroupReply.active
        : (focusedGroupReply.retry && groupReplyButton(target)) || target;
      focusTarget?.focus({preventScroll: true});
    }
    renderPendingSend();
    syncGroupReplyProgress();
    attachmentSender?.confirmFromHistory?.(scope, lastSocialItems);
    attachmentSender?.render();
    if (anchor) {
      scroller.scrollTop = anchor.top;
      const anchored = [...list.children].find(row => anchor.id && row.dataset.messageId === anchor.id);
      if (anchored) scroller.scrollTop += anchored.getBoundingClientRect().top - anchor.offset;
    } else if (keepScroll) scroller.scrollTop = Math.max(0, oldTop + scroller.scrollHeight - oldHeight);
    else scroller.scrollTop = refresh && !wasAtLatest ? oldTop : scroller.scrollHeight;
    bodyViews.restoreView();
    updateLatestMessageControl();
    return false;
  }

  function setDirectoryLink(session) {
    if (!session || session.source !== 'social') {
      document.getElementById('social-agent-members').hidden = true;
      document.getElementById('group-agent-action').hidden = true;
      if (agentRosterView?.direct) {
        agentRosterSheet.open = false;
        agentRosterView = null;
      }
      setGroupStudio();
    }
    const link = document.getElementById('open-agent-dir');
    link.hidden = Boolean(session?.public_agent);
    if (session && session.source === 'social') {
      const id = workspaceId();
      const personal = inPersonalWorkspace();
      const membersHref = /^[a-f0-9]{32}$/.test(id) ? '/members#workspace=' + id : '/members';
      link.href = personal ? '/contacts' : membersHref;
      link.textContent = personal ? uiLabel('联系人', 'Contacts') : uiLabel('成员', 'Members');
    } else {
      const workspace = workspaceId();
      const agent = currentAgent?.workspace_id && currentAgent.workspace_id !== workspace ? null : currentAgent?.id;
      link.href = agentDirectoryHref(workspace, agent);
      link.textContent = uiLabel('资料', 'Resources');
    }
  }

  let notificationSeq = 0;
  let notificationEpoch = 0;
  let notificationSnapshot = null;
  const notificationReads = new Set();
  const notificationKind = document.getElementById('notifications-kind');
  const notificationUnread = document.getElementById('notifications-unread');
  const notificationNotice = document.getElementById('notifications-status');
  const notificationScope = () => ({workspace: workspaceId(), owner: currentUser?.id, epoch: notificationEpoch});
  const currentNotificationScope = scope =>
    Boolean(scope?.owner && scope.owner === currentUser?.id && scope.workspace === workspaceId() && scope.epoch === notificationEpoch);

  function setNotificationStatus(text = '') {
    if (!notificationNotice) return;
    notificationNotice.textContent = text;
    notificationNotice.hidden = !text;
    if (text) {
      const empty = document.getElementById('notifications-empty');
      if (empty) empty.hidden = true;
    }
  }

  function resetNotifications() {
    notificationEpoch += 1;
    notificationSnapshot = null;
    setNotificationsOpen(false);
    renderNotifications({items: [], unread_count: 0}, notificationScope());
  }

  function applyNotificationRead(scope, result, id) {
    if (!currentNotificationScope(scope) || !notificationSnapshot) return;
    notificationSeq += 1;
    const body = notificationSnapshot.body;
    const wasUnread = (body.items || []).some(item => item.id === id && !item.read);
    notificationSnapshot.body = {
      ...body,
      // Individual acknowledgements can arrive in a different order from the writes.
      unread_count: id ? Math.max(0, Number(body.unread_count || 0) - Number(wasUnread))
        : result.body?.unread_count ?? body.unread_count,
      items: (body.items || []).map(item => !id || item.id === id ? {...item, read: true} : item),
    };
    renderNotifications(notificationSnapshot.body, scope);
  }

  function renderNotifications(body, scope) {
    const badge = document.getElementById('notification-count');
    const toggle = document.getElementById('notifications-toggle');
    const text = notificationBadgeText(body.unread_count);
    if (badge) { badge.textContent = text; badge.hidden = !text; }
    if (toggle) toggle.setAttribute('aria-label', text ? uiLabel(`通知，${body.unread_count} 条未读`, `Notifications, ${body.unread_count} unread`) : uiLabel('通知', 'Notifications'));
    const list = document.getElementById('notification-list');
    if (!list) return;
    const mentionsOnly = notificationKind?.value === 'mention';
    const automationsOnly = notificationKind?.value === 'automation';
    const items = (body.items || []).filter(item => (!mentionsOnly || item.kind === 'mention' || item.kind === 'messenger.mention')
      && (!automationsOnly || item.kind === AUTOMATION_RUN_FINISHED)
      && (!notificationUnread?.checked || !item.read));
    list.replaceChildren(...items.map(item => {
      const li = document.createElement('li');
      const target = notificationTarget(item, scope.workspace);
      const conversation = !target && chatPathId(item.conversation_id) &&
        (!item.workspace_id || item.workspace_id === scope.workspace) ? item.conversation_id : '';
      const button = document.createElement(target ? 'a' : 'button');
      const invalidLink = !target && (LINKED_NOTIFICATION_KINDS.has(item.kind) || (item.conversation_id && !conversation));
      if (target) button.href = target;
      else {
        button.type = 'button';
        if (invalidLink) { button.disabled = true; button.title = uiLabel('通知目标不可用', 'Notification destination unavailable'); }
      }
      button.className = 'notification-item' + (item.read ? '' : ' is-unread');
      button.dataset.notification = item.id;
      button.dataset.notificationKind = item.kind;
      const readKey = `${scope.epoch}:${item.id}`;
      if (notificationReads.has(readKey)) button.setAttribute('aria-busy', 'true');
      const summary = document.createElement('strong'); summary.textContent = notificationSummary(item, uiLabel);
      button.append(summary);
      if (item.kind !== AUTOMATION_RUN_FINISHED) {
        const excerpt = document.createElement('span'); excerpt.className = 'notification-excerpt'; excerpt.textContent = item.excerpt;
        button.append(excerpt);
      }
      const time = document.createElement('time'); time.textContent = formatSessionTime(item.created);
      button.append(time);
      button.addEventListener('click', async event => {
        if (target) event.preventDefault();
        if (invalidLink || !currentNotificationScope(scope) || (!conversation && notificationReads.has(readKey))) return;
        setNotificationStatus();
        let read;
        if (!item.read && !notificationReads.has(readKey)) {
          notificationReads.add(readKey);
          button.setAttribute('aria-busy', 'true');
          read = request('POST', `/v1/workspaces/${scope.workspace}/notifications/read`,
            {notification_id: item.id}, undefined, AbortSignal.timeout(5000), {keepalive: Boolean(target)})
            .catch(() => ({status: 0, body: {}}))
            .then(result => {
              notificationReads.delete(readKey);
              button.removeAttribute('aria-busy');
              if (!currentNotificationScope(scope)) return result;
              if (result.status === 200) applyNotificationRead(scope, result, item.id);
              else if (conversation && !document.getElementById('notifications-panel').hidden) {
                setNotificationStatus(uiLabel('无法标记这条通知为已读，请重试。', 'Could not mark this notification as read. Try again.'));
                if (notificationSnapshot) renderNotifications(notificationSnapshot.body, scope);
              }
              return result;
            });
        }
        if (conversation) {
          setNotificationsOpen(false);
          await openSessionTarget({source:'social', cid:conversation, message:item.message_id,
            title:item.title || uiLabel('会话', 'conversation')});
          return;
        }
        if (read) {
          const result = target ? await waitForLinkedNotificationRead(read) : await read;
          if (!currentNotificationScope(scope)) return;
          if (result && result.status !== 200 && (!target || (result.status !== 0 && result.status < 500))) {
            setNotificationStatus('无法标记这条通知为已读，请重新打开通知后重试。');
            if (notificationSnapshot) renderNotifications(notificationSnapshot.body, scope);
            return;
          }
        }
        setNotificationsOpen(false);
        if (target) { globalThis.location.assign(target); return; }
        await loadNotifications();
      });
      li.append(button);
      return li;
    }));
    const empty = document.getElementById('notifications-empty');
    if (empty) {
      empty.hidden = items.length > 0 || Boolean(notificationNotice && !notificationNotice.hidden);
      empty.textContent = automationsOnly
        ? (notificationUnread?.checked ? uiLabel('暂无未读自动化通知。', 'No unread automation notices.')
          : uiLabel('暂无自动化运行通知。', 'No automation run notices.')) : mentionsOnly
        ? (notificationUnread?.checked ? '暂无未读提及。' : '暂无提及。')
        : (notificationUnread?.checked ? '暂无未读通知。' : '暂无通知。');
    }
    const all = document.getElementById('notifications-read-all'); if (all) all.disabled = !(body.unread_count > 0);
  }

  async function loadNotifications({interactive = false} = {}) {
    const scope = notificationScope();
    if (!scope.workspace || !scope.owner) return;
    const token = ++notificationSeq;
    const unreadOnly = Boolean(notificationUnread?.checked);
    if (interactive) {
      setNotificationStatus('正在加载通知…');
      const old = notificationSnapshot;
      const items = old && (!old.unreadOnly || unreadOnly) ? old.body.items : [];
      renderNotifications({items, unread_count: old?.body.unread_count || 0}, scope);
    }
    const announce = interactive || notificationNotice?.textContent === '正在加载通知…';
    const suffix = unreadOnly ? '?filter=unread' : '';
    const result = await request('GET', `/v1/workspaces/${scope.workspace}/notifications${suffix}`)
      .catch(() => ({status: 0, body: {}}));
    if (token !== notificationSeq || !currentNotificationScope(scope) || unreadOnly !== Boolean(notificationUnread?.checked)) return;
    if (result.status !== 200) {
      if (announce) setNotificationStatus('无法加载通知。关闭后可重新打开。');
      return;
    }
    if (announce) setNotificationStatus();
    notificationSnapshot = {body: result.body, scope, unreadOnly};
    renderNotifications(result.body, scope);
  }

  // Live-ish delivery: poll the inbox while the tab is visible. No server push.
  const NOTIFICATION_POLL_MS = 30000;
  if (typeof globalThis.setInterval === 'function') {
    const handle = globalThis.setInterval(() => {
      if (document.visibilityState === 'hidden' || !currentUser) return;
      loadNotifications();
      loadDueReminders();
    }, NOTIFICATION_POLL_MS);
    if (handle && typeof handle.unref === 'function') handle.unref();
  }


  let dueSeq = 0;

  function renderDueReminders(state) {
    const panel = document.getElementById('due-reminders');
    const heading = document.getElementById('due-reminders-heading');
    const note = document.getElementById('due-reminders-note');
    const list = document.getElementById('due-reminders-list');
    if (!panel || !heading || !note || !list) return;
    const model = state || {};
    const today = model.today || [];
    const older = model.older || [];
    const failed = Boolean(model.failed);
    panel.hidden = !failed && today.length + older.length === 0;
    heading.textContent = failed ? '今天到点的提醒' : `今天到点的提醒 ${today.length} 条`;
    note.hidden = !failed && older.length === 0;
    note.textContent = failed ? '读不到到点的提醒。'
      : (older.length ? `另有 ${older.length} 条更早到点的提醒。` : '');
    if (failed) { list.replaceChildren(); return; }
    list.replaceChildren(...[...today, ...older].map(item => {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = '/automations';
      link.textContent = item.title || '提醒';
      const when = document.createElement('span');
      when.className = 'note';
      when.textContent = reminderDueLabel(item, Date.now());
      link.append(when);
      row.append(link);
      return row;
    }));
  }

  async function loadDueReminders() {
    const wid = workspaceId();
    if (!wid || !currentUser) return;
    const token = ++dueSeq;
    let result;
    try { result = await request('GET', `/v1/workspaces/${wid}/automations`); } catch { result = {status: 0, body: {}}; }
    if (token !== dueSeq || workspaceId() !== wid) return;
    if (result.status !== 200) { renderDueReminders({failed: true}); return; }
    renderDueReminders(dueReminders(result.body.items || [], currentUser, Date.now()));
  }

  function setNotificationsOpen(open) {
    const panel = document.getElementById('notifications-panel');
    const toggle = document.getElementById('notifications-toggle');
    if (panel) panel.hidden = !open;
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) setNotificationStatus();
  }

  const liveBanner = document.getElementById('conversation-live-update');
  const workspaceEvents = servedByDsbot ? mountChatActivity(document, {request, update: applySocialActivity}) : null;

  function viewingSocialMessages() {
    return !narrowScreen() || !document.body.classList.contains('sessions-open');
  }

  function readingSocialContext(viewportHeight, {allowScrolled = false} = {}) {
    const scroller = document.getElementById('message-scroller');
    const unread = socialHistory?.unread;
    return socialHistory?.readingHistory || socialHistory?.loading || selecting
      || (unread && unread.committed < unread.latest)
      || (!allowScrolled && !messageScrollerAtBottom(scroller, viewportHeight))
      || document.activeElement?.closest?.('.message-edit-controls')
      || [...(scroller.querySelectorAll?.('audio') || [])].some(audio => !audio.paused);
  }

  async function applySocialActivity(wid, items) {
    if (!currentUser || wid !== workspaceId() || wid !== sessionsWorkspace) return;
    const cid = currentSource === 'social' && currentConversation?.id;
    const next = items.find(row => row.id === cid);
    if (cid && !next && currentConversation.group_management &&
        (items.length < 200 || socialConversations.some(row => row.id === cid))) {
      const allowed = await refreshGroupManagement({...groupManagementContext(),conversationId:cid});
      if (!allowed && currentSource !== 'social') return;
    }
    if (next && viewingSocialMessages() && socialHistory?.cid === cid
      && next.activity_version !== currentConversation.activity_version) {
      const scope = sendScope();
      const queue = pendingSends.get(scope);
      if (queue?.active) {
        // An active send keeps the history view stable. A newly stored message
        // can still confirm the exact send and release the next queued message.
        const sending = queue.jobs.find(job => job.acceptReceipt);
        if (sending && Number.isSafeInteger(next.last_seq) && next.last_seq > (lastSocialItems.at(-1)?.seq ?? 0) &&
            next.last_seq > (sending.activityReceiptSeq ?? 0)) {
          sending.activityReceiptSeq = next.last_seq;
          const current = () => sendScope() === scope && pendingSends.get(scope) === queue &&
            queue.jobs.includes(sending) && Boolean(sending.acceptReceipt);
          const message = await socialSendReceipt(queue, sending.key, current);
          if (message) sending.acceptReceipt?.({status:200, body:{message}});
        }
      } else if (readingSocialContext()) {
        if (liveBanner) liveBanner.hidden = false;
      } else {
        await openSocialConversation(cid, {refresh: true});
      }
    }
    if (!currentUser || wid !== workspaceId() || wid !== sessionsWorkspace || document.visibilityState === 'hidden') return;
    const listed = new Map(socialConversations.map(row => [row.id, row]));
    const directoryChanged = items.length !== listed.size || items.some(row => {
      const old = listed.get(row.id);
      return !old || old.activity_version !== row.activity_version || old.unread_count !== row.unread_count
        || old.pinned !== row.pinned || old.muted !== row.muted;
    });
    if (!directoryChanged) return;
    const sequence = sessionsRequest;
    const user = currentUser;
    const readPinReceipt = pinReceipt;
    const result = await request('GET', `${socialBase()}?limit=100`);
    if (sequence !== sessionsRequest || user !== currentUser || wid !== workspaceId() || result.status !== 200) return;
    const changed = (result.body.items || []).map(row => mergeGroupRead(
      mergePinRead(row, user.id, wid, readPinReceipt), user.id, wid)).filter(Boolean);
    const incoming = changed.some(row => !listed.has(row.id) || row.last_seq > listed.get(row.id).last_seq);
    socialConversations = changed;
    sessions = sortSessions([...sessions.filter(row => row.source === 'agent'), ...mergeSessions([], changed, user.id)]);
    renderSessions();
    if (currentSource === 'social') syncConversationPin(currentConversation);
    if (incoming || !document.getElementById('notifications-panel')?.hidden) void loadNotifications();
    if (['all', 'groups'].includes(searchTab)) refreshDirectorySearch();
  }

  document.getElementById('conversation-live-load')?.addEventListener('click', async () => {
    if (currentSource === 'social' && currentConversation) await openSocialLatest();
    else if (currentSource === 'agent' && privateHistory) await restorePrivateLatest(privateHistory);
  });
  let sessionsRequest = 0, sessionsWorkspace = null, sessionsUser = null;
  let startingInboxDirectory = null;
  let membersStatus = '';
  async function loadSessions(link, {nativeDirectory, pendingNativeDirectory, onPrivate} = {}) {
    const sequence = ++sessionsRequest;
    const user = currentUser;
    loadNotifications();
    loadDueReminders();
    const id = workspaceId();
    if (id !== sessionsWorkspace) workspaceEvents?.start(null);
    if (id !== sessionsWorkspace || user !== sessionsUser || !id) {
      setSessionsStatus('正在加载对话…');
      sessionsWorkspace = id; sessionsUser = user;
      sessions = []; agents = []; members = []; socialConversations = [];
      membersStatus = 'loading';
      renderSessions();
    }
    if (!id) return;
    const startupRead = pendingNativeDirectory || (currentSource === 'social' && startingInboxDirectory?.owner === user &&
      startingInboxDirectory.workspace === id ? startingInboxDirectory.read : null);
    const isLocalPersonal = inPersonalWorkspace();
    const threadReceiptAtStart = privateThreadReceipt;
    const current = () => sequence === sessionsRequest && id === workspaceId() && user === currentUser;
    const path = `/v1/workspaces/${id}`;
    const read = suffix => request('GET', path + suffix).catch(() => ({status: 0, body: {}}));
    if (isLocalPersonal) {
      const picking = !document.getElementById('compose-dialog').hidden && composeMode === 'group';
      if (picking || (isSearchOpen() && ['all','contacts'].includes(searchTab))) void loadPersonalContacts();
    } else {
      void read('/members').then(result => {
        if (!current()) return;
        membersStatus = result.status === 200 ? '' : 'failed';
        if (!membersStatus) members = result.body.items || [];
        if (!document.getElementById('compose-dialog').hidden) renderMemberChoices(composeMode === 'contact', true);
        if (['all', 'contacts'].includes(searchTab)) refreshDirectorySearch();
      });
    }
    function applyReceipt(source, directory) {
      const receipt = link?.readReceipt;
      if (receipt?.source !== source) return;
      const row = directory.find(item => item.id === receipt.id);
      const covered = Number.isSafeInteger(receipt.seq) && Number.isSafeInteger(row?.last_seq)
        ? row.last_seq <= receipt.seq
        : Number.isFinite(row?.updated) && Number.isFinite(receipt.updated) && row.updated <= receipt.updated;
      if (covered) row.unread_count = Math.min(Number(row.unread_count) || 0, receipt.count);
    }
    let privateReady = false, socialReady = false;
    const readPinReceipt = pinReceipt;
    const socialRequest = read('/social/conversations?limit=100').then(social => {
      if (!current()) return social;
      socialReady = true;
      socialConversations = social.status === 200
        ? (social.body.items || []).map(row => mergeGroupRead(
          mergePinRead(row, user.id, id, readPinReceipt), user.id, id)).filter(Boolean)
        : [];
      applyReceipt('social', socialConversations);
      if (!privateReady && socialConversations.length) {
        sessions = sortSessions([...sessions.filter(row => row.source === 'agent'), ...mergeSessions([], socialConversations, user.id)]);
        renderSessions();
        if (currentSource === 'social') syncConversationPin(currentConversation);
        if (['all', 'groups'].includes(searchTab)) refreshDirectorySearch();
      }
      return social;
    });
    const startupDirectory = nativeDirectory || (startupRead ? await startupRead : null);
    if (!current()) return;
    const readThreadReceipt = startupDirectory ? 0 : threadReceiptAtStart;
    const listed = startupDirectory ? {status: 200, body: startupDirectory}
      : await read('/agents?limit=100&include=conversations');
    if (!current()) return;
    const nextAgents = listed.status === 200 ? listed.body.items || [] : [];
    let rows = listed.body.conversations;
    let partial = listed.status !== 200;
    if (!Array.isArray(rows)) {
      // A tab served by a previous runtime image may still return only the agent list.
      const results = await Promise.all(nextAgents.map(async agent => ({
        agent, response: await read(`/agents/${agent.id}/conversations?limit=100`),
      })));
      if (!current()) return;
      rows = results.flatMap(({agent, response}) => response.status === 200
        ? (response.body.items || []).map(row => ({...row, agent_id: agent.id})) : []);
      partial ||= results.some(({response}) => response.status !== 200);
    }
    privateReady = true;
    agents = nextAgents;
    const agentById = new Map(agents.map(agent => [agent.id, agent]));
    const privateRows = () => {
      const included = new Set(rows.map(row => row.id));
      const directory = [...rows];
      // An active-only read can omit a thread restored after the request began.
      for (const row of sessions) {
        if (row.source !== 'agent' || included.has(row.id)) continue;
        const receipt = privateThreadReceipts.get(privateThreadKey({owner: user.id, wid: id, aid: row.agent_id, cid: row.id}));
        if (receipt?.restored && receipt.seq > readThreadReceipt) directory.push(row);
      }
      return directory.flatMap(row => {
        const agent = agentById.get(row.agent_id);
        if (!agent) return [];
        const currentRow = threadAfterRead(row, {owner: user.id, wid: id, aid: agent.id, cid: row.id}, readThreadReceipt);
        return currentRow.archived === true ? [] : [{...currentRow, agent}];
      });
    };
    const listedPrivate = !socialReady || onPrivate ? privateRows() : [];
    if (listedPrivate.length) {
      applyReceipt('agent', listedPrivate);
      sessions = mergeSessions(listedPrivate, socialConversations, user.id);
      if (!socialReady) renderSessions();
    }
    if (isLocalPersonal && listed.status === 200) {
      onPrivate?.(listedPrivate.length ? sessions.find(row => row.source === 'agent') : null, socialReady);
    }
    const social = await socialRequest;
    if (!current()) return;
    partial ||= social.status !== 200;
    applyReceipt('social', socialConversations);
    const finalPrivateRows = privateRows();
    applyReceipt('agent', finalPrivateRows);
    sessions = mergeSessions(finalPrivateRows, socialConversations, user.id);
    setSessionsStatus(partial ? '部分对话加载失败，请重试。' : '');
    renderSessions();
    if (currentSource === 'social') syncConversationPin(currentConversation);
    if (!document.getElementById('compose-dialog').hidden && composeMode === 'group') renderMemberChoices(false, true);
    if (['all', 'agents', 'groups'].includes(searchTab)) refreshDirectorySearch();
    // Start activity checks after the initial directory commits.
    workspaceEvents?.start(id);
  }

  function memberRow(name, note, kind) {
    const row = document.createElement('li');
    row.className = 'group-info-member';
    row.dataset.kind = kind;
    const avatar = document.createElement('span');
    avatar.className = 'group-info-member-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = kind === 'empty' ? '+' : leadGlyph(name);
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = name;
    text.append(strong);
    if (note) {
      const small = document.createElement('small');
      small.textContent = note;
      text.append(small);
    }
    row.append(avatar, text);
    return row;
  }

  function groupManagementContext() {
    return servedByDsbot && currentUser && currentSource === 'social' && currentConversation?.group_management
      ? {owner:currentUser.id, workspace:workspaceId(), conversation:currentConversation} : null;
  }

  const groupReceiptKey = (owner, workspace, id) => JSON.stringify([owner,workspace,id]);
  const groupWorkspaceMatches = target => target.owner === currentUser?.id && target.workspace === workspaceId();
  const groupMatches = target => groupWorkspaceMatches(target) && currentSource === 'social'
    && currentConversation?.id === target.conversationId;

  function mergeGroupRead(row, owner, workspace) {
    if (!row?.group_management) return row;
    const key = groupReceiptKey(owner, workspace, row.id);
    const receipt = groupManagementReceipts.get(key);
    if (!receipt) return row;
    if (receipt.revision > row.group_management.revision || (receipt.left && receipt.revision === row.group_management.revision)) {
      return receipt.left ? null : {...row,...receipt.fields};
    }
    if (receipt.revision < row.group_management.revision) groupManagementReceipts.delete(key);
    return row;
  }

  function reportGroupChange(conversation, target) {
    if (!groupWorkspaceMatches(target) || conversation.id !== target.conversationId ||
        conversation.workspace_id !== target.workspace || !Number.isSafeInteger(conversation.group_management?.revision)) return;
    conversation = rosterAfterRead(conversation);
    const key = groupReceiptKey(target.owner,target.workspace,conversation.id);
    const fields = Object.fromEntries(['title','members','agent_members','group_management','group_agent_routing','updated']
      .filter(name => Object.hasOwn(conversation, name)).map(name => [name,conversation[name]]));
    const revision = conversation.group_management.revision;
    if (revision < (groupManagementReceipts.get(key)?.revision ?? -1)) return;
    groupManagementReceipts.set(key,{revision,fields});
    socialConversations = socialConversations.map(row => row.id === conversation.id ? {...row,...fields} : row);
    sessions = sortSessions([...sessions.filter(row => row.source === 'agent'), ...mergeSessions([], socialConversations, target.owner)]);
    renderSessions();
    if (!groupMatches(target) || currentConversation.group_management.revision > revision) return;
    Object.assign(currentConversation, fields);
    applyChatIdentity(document, conversationLabel(currentConversation,currentUser.id), currentConversation);
    setChatSubtitle(groupHeaderSubtitle(currentConversation));
    setGroupInfo(currentConversation);
    renderGroupRosterSummary(currentConversation.agent_members || [], {direct:false});
    agentMentions.refresh();
    renderGroupComposerRouting();
  }

  function forgetGroup(target, revoked = false) {
    if (!groupWorkspaceMatches(target)) return;
    const id = target.conversationId;
    groupManagementReceipts.set(groupReceiptKey(target.owner,target.workspace,id), {
      left:true, revision:target.conversation.group_management.revision,
    });
    socialConversations = socialConversations.filter(row => row.id !== id);
    sessions = sessions.filter(row => row.source !== 'social' || row.id !== id);
    if (groupMatches(target)) {
      const exactScope = sendScope();
      const pending = pendingSends.get(exactScope);
      if (pending) {
        for (const job of pending.jobs.slice()) removeSendJob(pending,job);
        pendingSends.delete(exactScope);
      }
      setReplyDraft(exactScope, null);
      publicDraft.forget(exactScope);
      agentMentions.forget(exactScope);
      attachmentSender?.forget?.(exactScope);
      voiceRecorder.clear();
      lastSocialItems = [];
      clearChatScope();
      setGroupInfo(null);
      setSocialHeaderTools(false);
      for (const dialogId of ['announcement-dialog','message-assist-dialog']) {
        const dialog = document.getElementById(dialogId);
        if (dialog?.open) dialog.close();
      }
      writeHash({workspace:target.workspace});
      setSessionsOpen(true);
      const list = document.getElementById('conversation-list');
      list.tabIndex = -1;
      list.focus({preventScroll:true});
      show(revoked ? 'error' : 'ok', revoked ? uiLabel('你已无法访问此群聊。','You no longer have access to this group.')
        : uiLabel('已退出群聊。','You left the group.'));
    }
    renderSessions();
  }

  async function refreshGroupManagement(target) {
    if (!target || !groupMatches(target)) return false;
    const path = `/v1/workspaces/${target.workspace}/social/conversations/${target.conversationId}/management`;
    const result = await request('GET', path).catch(() => ({status:0,body:{}}));
    if (!groupMatches(target)) return false;
    if ([403,404].includes(result.status)) {
      forgetGroup(target,true);
      return false;
    }
    if (result.status !== 200 || result.body?.conversation?.id !== target.conversationId) return false;
    reportGroupChange(result.body.conversation,target);
    return true;
  }

  async function initializeGroupManagement({fromShortcut = false} = {}) {
    if (groupManagement) return groupManagement;
    const target = groupManagementContext();
    if (!target) return null;
    const {mountGroupManagement} = await loadGroupManagement();
    if (!groupMatches({...target,conversationId:target.conversation.id}) ||
        (!fromShortcut && document.getElementById('group-info-panel').hidden)) return null;
    if (!groupManagement) {
      groupManagement = mountGroupManagement(document, {
        request, context:groupManagementContext, notify:show,
        onChanged:reportGroupChange, onLeft:forgetGroup,
        onRefresh:refreshGroupManagement,
      });
      setGroupInfo(currentConversation);
    }
    return groupManagement;
  }

  function renderGroupReplyPolicy(conversation) {
    const section = document.getElementById('group-reply-policy');
    const summary = document.getElementById('group-reply-policy-summary');
    const shortcut = document.getElementById('group-reply-shortcut');
    const routing = conversation?.group_agent_routing;
    const policy = routing?.policy;
    section.hidden = conversation?.kind !== 'group' || Boolean(conversation.public_agent);
    if (shortcut) shortcut.hidden = section.hidden || !servedByDsbot || !routing;
    if (section.hidden) return;
    if (policy?.mode === 'mentions') summary.textContent = uiLabel('仅在被 @ 时回复', 'Only when mentioned');
    else if (!conversation.agent_members?.some(agent => !agent.archived && !agent.native_deleted)) {
      summary.textContent = uiLabel('群里暂无可回复的智能体', 'There are no group agents available to reply');
    } else if (policy?.mode === 'everyone') summary.textContent = uiLabel('由所有群内智能体判断是否回复', 'All group agents decide whether to reply');
    else if (policy?.mode === 'lead') {
      const lead = !policy.lead_unavailable && activeGroupAgent(conversation, policy.lead);
      if (lead) {
        const name = groupAgentName(lead.name, groupAgentOwnerLabel(lead), lead.owner_id, lead.mine === false ? lead.owner_handle : '');
        summary.textContent = uiLabel(`指定智能体优先 · ${name}`, `Preferred agent · ${name}`);
      } else {
        summary.textContent = uiLabel('优先智能体不可用，由其他群内智能体判断是否回复。',
          'The preferred agent is unavailable. Other group agents decide whether to reply.');
      }
    } else if (groupUsesLegacyAutoReplies(conversation) && conversation.agent_members?.some(
      agent => !agent.archived && !agent.native_deleted && agent.auto_reply)) {
      summary.textContent = uiLabel('跟随群组默认 · 由开启自动回复的智能体判断',
        'Group default · Agents with auto-reply enabled decide');
    } else summary.textContent = uiLabel('跟随群组默认 · 由群内智能体判断', 'Group default · Group agents decide');
    if (shortcut && !shortcut.hidden) {
      const canEdit = routing.can_edit === true;
      shortcut.title = summary.textContent;
      shortcut.setAttribute('aria-description', summary.textContent);
      shortcut.setAttribute('aria-controls', canEdit ? 'group-management-dialog' : 'group-info-panel');
      if (canEdit) shortcut.setAttribute('aria-haspopup', 'dialog');
      else shortcut.removeAttribute('aria-haspopup');
    }
  }

  function syncGroupAutoReplyNote(conversation) {
    const note = document.getElementById('group-agent-auto-reply-note');
    const supported = groupUsesLegacyAutoReplies(conversation);
    note.hidden = !supported || document.getElementById('group-info-agents').hidden;
    if (!supported) document.getElementById('group-agent-auto-reply-status').hidden = true;
  }

  function setGroupInfoTab(which) {
    const agentsTab = document.getElementById('group-info-tab-agents');
    const peopleTab = document.getElementById('group-info-tab-people');
    agentsTab.setAttribute('aria-selected', String(which === 'agents'));
    peopleTab.setAttribute('aria-selected', String(which === 'people'));
    document.getElementById('group-info-agents').hidden = which !== 'agents';
    document.getElementById('group-info-add-agent').hidden = which !== 'agents';
    document.getElementById('group-info-add-agent-feedback').hidden = which !== 'agents';
    syncGroupAutoReplyNote(currentConversation);
    document.getElementById('group-info-people').hidden = which !== 'people';
    document.getElementById('group-info-invite').hidden = which !== 'people';
  }

  const groupInfoAddOpener = document.getElementById('group-info-add-agent');
  const groupInfoAddDialog = document.getElementById('group-info-add-agent-dialog');
  const groupInfoAddSelect = document.getElementById('group-info-add-agent-select');
  const groupInfoAddSubmit = document.getElementById('group-info-add-agent-submit');
  const groupInfoAddStatus = document.getElementById('group-info-add-agent-status');
  const groupInfoAddRetry = document.getElementById('group-info-add-agent-retry');
  const groupInfoAddDirectory = document.getElementById('group-info-add-agent-directory');
  const groupInfoAddCancel = document.getElementById('group-info-add-agent-cancel');
  const groupInfoAddFeedback = document.getElementById('group-info-add-agent-feedback');
  let groupInfoAdd;
  let groupInfoFeedbackScope;

  const groupInfoAddCurrent = state => Boolean(state && state === groupInfoAdd && groupInfoAddDialog.open &&
    agentRosterCurrent(state.view) && !state.view.direct);

  function renderGroupInfoAdd(state) {
    const count = renderAgentAddition(state.catalogue || [], currentConversation.agent_members || [], {
      busy:state.loading || state.view.busy, add:groupInfoAddSelect, button:groupInfoAddSubmit,
      placeholder:uiLabel('选择智能体','Select an agent'),
    });
    const empty = state.catalogue && !count;
    groupInfoAddSubmit.disabled ||= Boolean(state.reload);
    groupInfoAddStatus.textContent = state.error || (state.loading ? uiLabel('正在读取工作区智能体…','Loading workspace agents…')
      : state.view.busy ? uiLabel('正在添加智能体…','Adding agent…')
        : empty ? uiLabel('当前工作区没有可添加的智能体。','There are no workspace agents available to add.') : '');
    groupInfoAddStatus.dataset.kind = state.error ? 'error' : '';
    groupInfoAddRetry.hidden = !state.reload;
    groupInfoAddRetry.disabled = state.loading || state.view.busy;
    groupInfoAddDirectory.hidden = !empty;
    if (empty) groupInfoAddDirectory.href = agentDirectoryHref(state.workspace);
    groupInfoAddCancel.disabled = Boolean(state.view.busy);
  }

  async function loadGroupInfoAddAgents(state) {
    if (!groupInfoAddCurrent(state) || state.loading || state.view.busy) return;
    state.loading = true;
    state.error = '';
    state.reload = false;
    renderGroupInfoAdd(state);
    const agents = new Map();
    const cursors = new Set();
    let cursor = '';
    do {
      const query = new URLSearchParams({limit:'100'});
      if (cursor) query.set('cursor',cursor);
      const result = await request('GET', `/v1/workspaces/${state.workspace}/agents?${query}`)
        .catch(() => ({status:0,body:{}}));
      if (!groupInfoAddCurrent(state)) return;
      if (result.status !== 200) {
        state.reload = true;
        state.error = result.status === 403 ? uiLabel('你无法读取此工作区的智能体。','You cannot view agents in this workspace.')
          : uiLabel('无法读取工作区智能体，请重试。','Could not load workspace agents. Try again.');
        break;
      }
      for (const agent of result.body.items || []) agents.set(agent.id,agent);
      cursor = result.body.cursor || '';
      if (cursors.has(cursor)) break;
      cursors.add(cursor);
    } while (cursor);
    state.loading = false;
    if (!state.error) state.catalogue = [...agents.values()].sort((a,b)=>a.name.localeCompare(b.name));
    renderGroupInfoAdd(state);
  }

  groupInfoAddOpener.addEventListener('click', () => {
    const view = agentRosterView;
    if (!agentRosterCurrent(view) || view.direct || view.busy || groupInfoAddDialog.open) return;
    const state = groupInfoAdd = {view,workspace:workspaceId()};
    document.getElementById('group-info-add-agent-context').textContent = conversationLabel(currentConversation,currentUser?.id);
    groupInfoAddSelect.value = '';
    groupInfoAddFeedback.textContent = '';
    groupInfoAddDialog.showModal();
    void loadGroupInfoAddAgents(state);
  });
  groupInfoAddSelect.addEventListener('change', () => {
    if (!groupInfoAddCurrent(groupInfoAdd)) return;
    if (!groupInfoAdd.reload) groupInfoAdd.error = '';
    renderGroupInfoAdd(groupInfoAdd);
  });
  groupInfoAddRetry.addEventListener('click', () => void loadGroupInfoAddAgents(groupInfoAdd));
  groupInfoAddCancel.addEventListener('click', () => groupInfoAddDialog.close());
  groupInfoAddDialog.addEventListener('cancel', event => { if (groupInfoAdd?.view.busy) event.preventDefault(); });
  groupInfoAddDialog.addEventListener('close', () => {
    if (groupInfoAddDialog.open) return;
    if (agentRosterCurrent(groupInfoAdd?.view) && !document.getElementById('group-info-panel').hidden) {
      groupInfoAddOpener.focus({preventScroll:true});
    }
    groupInfoAdd = null;
  });
  document.getElementById('group-info-add-agent-form').addEventListener('submit', async event => {
    event.preventDefault();
    const state = groupInfoAdd;
    if (!groupInfoAddCurrent(state) || groupInfoAddSubmit.disabled) return;
    const selected = availableAgentAdditions(state.catalogue || [], currentConversation.agent_members || [])
      .find(agent=>agent.id === groupInfoAddSelect.value);
    if (!selected) { renderGroupInfoAdd(state); return; }
    state.error = '';
    const result = writeAgentRoster(state.view,'',{agent_ids:[selected.id]},true,(kind,text,status) => {
      if (!groupInfoAddCurrent(state)) return;
      if (kind === 'ok') {
        groupInfoAddFeedback.textContent = text;
        groupInfoAddDialog.close();
      } else {
        state.reload = [403,404].includes(status);
        state.error = status === 403 ? uiLabel('群聊权限已变化。请重新打开群信息后再试。','Group permissions changed. Reopen group info and try again.')
          : status === 404 ? uiLabel('智能体已不可用，请重新读取列表。','The agent is unavailable. Reload the list.')
            : uiLabel('暂时无法添加智能体。请使用当前选择重试。','Could not add the agent. Try again with the current selection.');
      }
    });
    renderGroupInfoAdd(state);
    await result;
    if (groupInfoAddCurrent(state)) {
      renderGroupInfoAdd(state);
      if (state.error) groupInfoAddStatus.focus({preventScroll:true});
    }
  });

  const groupInvite = document.getElementById('group-invite-dialog');
  const groupInviteQuery = document.getElementById('group-invite-query');
  const groupInviteChoices = document.getElementById('group-invite-choices');
  const groupInviteSelection = document.getElementById('group-invite-selection');
  const groupInviteSelectedCount = document.getElementById('group-invite-selected-count');
  const groupInviteReview = document.getElementById('group-invite-review');
  const groupInviteStatus = document.getElementById('group-invite-status');
  const groupInviteSubmit = document.getElementById('group-invite-submit');
  let inviteTarget = null;
  let invitingMembers = false;

  const inviteMatches = (target) => target && target.owner === currentUser?.id && target.workspace === workspaceId() &&
    currentSource === 'social' && currentConversation?.id === target.conversation;
  const groupInviteLinkPanel = document.getElementById('group-invite-link-panel');
  const groupInviteLinkStatus = document.getElementById('group-invite-link-status');
  const groupInviteLinkCreate = document.getElementById('group-invite-link-create');
  let showGroupInviteLink;
  const currentInvite = target => groupInvite.open && inviteTarget === target && inviteMatches(target);

  async function prepareGroupInviteLink(target, conversation) {
    if (!currentInvite(target) || !conversation.group_management?.can_rename) return;
    if (showGroupInviteLink) return showGroupInviteLink(target, conversation);
    groupInviteLinkPanel.hidden = false;
    groupInviteLinkCreate.disabled = true;
    groupInviteLinkCreate.textContent = uiLabel('正在加载…', 'Loading…');
    groupInviteLinkStatus.textContent = '';
    try {
      const {mountGroupInviteLink} = await loadGroupInviteModule();
      if (!currentInvite(target)) return;
      showGroupInviteLink ||= mountGroupInviteLink(document, request, currentInvite);
      showGroupInviteLink(target, conversation);
    } catch {
      if (!currentInvite(target)) return;
      groupInviteLinkCreate.disabled = false;
      groupInviteLinkCreate.textContent = uiLabel('重试', 'Retry');
      groupInviteLinkStatus.textContent = uiLabel('邀请链接暂时无法加载。', 'Could not load invitation links.');
    }
  }

  groupInviteLinkCreate.addEventListener('click', () => {
    if (!showGroupInviteLink && inviteTarget) void prepareGroupInviteLink(inviteTarget, currentConversation);
  });
  const selectedInviteMembers = () => [...groupInviteChoices.querySelectorAll('input:checked')].map(box => box.value);
  const inviteSearchText = value => value.normalize('NFKC').trim().toLocaleLowerCase();
  const reviewingGroupInvite = () => groupInviteReview.getAttribute('aria-pressed') === 'true';

  function syncGroupInviteSubmit(count = selectedInviteMembers().length) {
    groupInviteSubmit.disabled = invitingMembers || count < 1 || count > 50;
    groupInviteReview.disabled = invitingMembers;
    groupInviteQuery.disabled = invitingMembers || reviewingGroupInvite();
    groupInviteChoices.inert = invitingMembers;
  }

  function syncGroupInvite() {
    const count = selectedInviteMembers().length;
    const wasReviewing = reviewingGroupInvite();
    const reviewing = count > 0 && wasReviewing;
    groupInviteReview.setAttribute('aria-pressed', String(reviewing));
    groupInviteSelection.hidden = !count;
    groupInviteSelectedCount.textContent = count
      ? uiLabel(`已选 ${count} 位成员`, `${count} ${count === 1 ? 'member' : 'members'} selected`) : '';
    const needle = inviteSearchText(groupInviteQuery.value).replace(/^@/, '');
    let visible = 0;
    for (const choice of groupInviteChoices.children) {
      choice.hidden = reviewing ? !choice.children[0].checked : !choice.dataset.search.includes(needle);
      if (!choice.hidden) visible++;
    }
    syncGroupInviteSubmit(count);
    if (wasReviewing && !reviewing) groupInviteQuery.focus({preventScroll:true});
    if (groupInviteChoices.children.length) {
      groupInviteStatus.textContent = count > 50 ? uiLabel('一次最多添加 50 位成员。', 'You can add up to 50 members at once.')
        : !visible ? uiLabel('没有匹配的成员。', 'No matching members.') : '';
    }
  }

  async function openGroupInvite() {
    const conversation = currentConversation;
    if (currentSource !== 'social' || conversation?.kind !== 'group' || groupInvite.open) return;
    const target = {workspace: workspaceId(), conversation: conversation.id, owner: currentUser?.id};
    inviteTarget = target;
    groupInviteQuery.value = '';
    groupInviteChoices.replaceChildren();
    groupInviteChoices.scrollTop = 0;
    groupInviteReview.setAttribute('aria-pressed', 'false');
    groupInviteReview.textContent = uiLabel('仅显示已选', 'Show selected only');
    syncGroupInvite();
    const personal = Boolean(conversation.account_group);
    const roster = personal ? '联系人' : '工作区成员';
    const searchLabel = personal ? uiLabel('搜索联系人姓名或 @用户名', 'Search contacts by name or @handle')
      : uiLabel('搜索工作区成员姓名或 @用户名', 'Search workspace members by name or @handle');
    groupInviteQuery.placeholder = searchLabel;
    groupInviteQuery.setAttribute('aria-label', searchLabel);
    groupInviteStatus.textContent = '正在加载' + roster + '…';
    document.getElementById('group-invite-context').textContent = conversationLabel(conversation, currentUser?.id);
    groupInvite.showModal();
    groupInviteQuery.focus();
    void prepareGroupInviteLink(target, conversation);
    const result = await request('GET', personal ? '/v1/contacts' : `/v1/workspaces/${target.workspace}/members`).catch(() => ({status: 0}));
    if (inviteTarget !== target || !inviteMatches(target) || !groupInvite.open) return;
    if (result.status !== 200) {
      groupInviteStatus.textContent = '无法加载' + roster + '，请重新打开后再试。';
      return;
    }
    const joined = new Set((currentConversation.members || []).map(member => personal ? member.handle : member.user_id));
    const candidates = memberChoices(personal ? contactMembers(result) : result.body.items, currentUser?.id)
      .filter(member => member.user_id && !member.suspended && !joined.has(member.user_id));
    for (const [index, member] of candidates.entries()) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = member.handle || member.user_id;
      const identity = document.createElement('span');
      identity.className = 'group-invite-identity';
      const name = document.createElement('span');
      name.id = `group-invite-member-name-${index}`;
      name.textContent = member.username || box.value;
      box.setAttribute('aria-labelledby', name.id);
      identity.append(name);
      const handle = member.handle ? '@' + member.handle.replace(/^@/, '') : '';
      if (handle) {
        const descriptor = document.createElement('small');
        descriptor.id = `group-invite-member-handle-${index}`;
        descriptor.textContent = handle;
        box.setAttribute('aria-describedby', descriptor.id);
        identity.append(descriptor);
      }
      label.dataset.search = inviteSearchText(`${name.textContent} ${handle}`);
      label.append(box, identity);
      groupInviteChoices.append(label);
    }
    groupInviteStatus.textContent = candidates.length ? '' : '没有可添加的' + roster + '。';
    syncGroupInvite();
  }

  document.getElementById('chat-group-invite').addEventListener('click', openGroupInvite);
  document.getElementById('group-info-invite').addEventListener('click', openGroupInvite);
  document.getElementById('group-invite-cancel').addEventListener('click', () => groupInvite.close());
  groupInvite.addEventListener('close', () => {
    if (groupInvite.open) return;
    inviteTarget = null;
    showGroupInviteLink?.(null);
    groupInviteLinkPanel.hidden = true;
  });
  groupInvite.addEventListener('cancel', event => { if (invitingMembers) event.preventDefault(); });
  groupInviteQuery.addEventListener('input', syncGroupInvite);
  groupInviteReview.addEventListener('click', () => {
    groupInviteReview.setAttribute('aria-pressed', String(!reviewingGroupInvite()));
    groupInviteChoices.scrollTop = 0;
    syncGroupInvite();
  });
  groupInviteChoices.addEventListener('change', syncGroupInvite);
  document.getElementById('group-invite-form').addEventListener('submit', async event => {
    event.preventDefault();
    const target = inviteTarget;
    const memberIds = selectedInviteMembers();
    if (invitingMembers || !inviteMatches(target) || !memberIds.length || memberIds.length > 50) return;
    invitingMembers = true;
    const cancel = document.getElementById('group-invite-cancel');
    cancel.disabled = true;
    syncGroupInviteSubmit(memberIds.length);
    groupInviteSubmit.textContent = '添加中…';
    try {
      const path = `/v1/workspaces/${target.workspace}/social/conversations/${target.conversation}/members`;
      const result = await request('POST', path, {member_ids: memberIds});
      if (!inviteMatches(target) || inviteTarget !== target) return;
      if (result.status !== 200 || result.body.conversation?.id !== target.conversation) {
        groupInviteStatus.textContent = result.status === 403 ? '所选成员的权限有变化，请重新打开后再试。'
          : result.status === 404 ? '群聊或工作区成员有变化，请刷新后再试。' : '无法添加成员，请重试。';
        return;
      }
      currentConversation = result.body.conversation;
      const title = conversationLabel(currentConversation, currentUser?.id);
      applyChatIdentity(document, title, currentConversation);
      setChatSubtitle(groupHeaderSubtitle(currentConversation));
      setGroupInfo(currentConversation);
      renderGroupRosterSummary(currentConversation.agent_members || [], {direct:false});
      agentMentions.refresh();
      renderGroupComposerRouting();
      groupInvite.close();
      show('ok', '群成员已更新。');
    } catch {
      if (inviteMatches(target) && inviteTarget === target) groupInviteStatus.textContent = '暂时无法确认添加结果，可以重试。';
    } finally {
      invitingMembers = false;
      cancel.disabled = false;
      groupInviteSubmit.textContent = '添加';
      syncGroupInviteSubmit();
    }
  });

  const pendingAutoReplies = new Set();

  function renderGroupAgent(conversation, agent) {
    const name = conversation.group_agent_requests === true
      ? groupAgentName(agent.name, groupAgentOwnerLabel(agent), agent.owner_id, agent.mine === false ? agent.owner_handle : '')
      : agent.name;
    const canAutoReply = groupUsesLegacyAutoReplies(conversation) && !agent.archived && !agent.native_deleted;
    let note = '';
    if (agent.archived) note = uiLabel('已归档', 'Archived');
    else if (agent.native_deleted) note = uiLabel('已不可用', 'Unavailable');
    else if (canAutoReply) note = agent.auto_reply ? '自动回复已开启' : '自动回复已关闭';
    const row = memberRow(name, note, 'agent');
    if (!agent.mine || !canAutoReply) return row;
    const wid = workspaceId();
    const key = `${wid}/${conversation.id}/${agent.id}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'group-info-switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', `${agent.name}的自动回复`);
    toggle.setAttribute('aria-checked', String(Boolean(agent.auto_reply)));
    toggle.setAttribute('aria-describedby', 'group-agent-auto-reply-note');
    toggle.disabled = pendingAutoReplies.has(key);
    toggle.addEventListener('click', async () => {
      if (workspaceId() !== wid || currentConversation?.id !== conversation.id || pendingAutoReplies.has(key)) return;
      const notice = document.getElementById('group-agent-auto-reply-status');
      const activeConversation = currentConversation;
      const enabled = toggle.getAttribute('aria-checked') !== 'true';
      pendingAutoReplies.add(key);
      toggle.disabled = true;
      if (notice) notice.hidden = true;
      try {
        const path = `/v1/workspaces/${wid}/social/conversations/${conversation.id}/agents/${encodeURIComponent(agent.id)}/auto-reply`;
        const result = await request('POST', path, {auto_reply: enabled});
        if (workspaceId() !== wid || currentConversation?.id !== conversation.id) return;
        if (result.status !== 200 || result.body.auto_reply !== enabled) throw new Error('Automatic replies were not updated');
        const currentAgent = currentConversation.agent_members?.find(item => item.id === agent.id && item.mine);
        if (currentAgent) currentAgent.auto_reply = enabled;
        renderGroupComposerRouting();
        renderGroupReplyPolicy(currentConversation);
        if (currentConversation === activeConversation && currentAgent === agent) {
          toggle.setAttribute('aria-checked', String(enabled));
          const description = row.children[1]?.children[1];
          if (description) description.textContent = enabled ? '自动回复已开启' : '自动回复已关闭';
        }
      } catch {
        if (notice && workspaceId() === wid && currentConversation?.id === conversation.id && groupUsesLegacyAutoReplies(currentConversation)) {
          notice.textContent = '自动回复设置保存失败，请重试。';
          notice.hidden = false;
        }
      } finally {
        pendingAutoReplies.delete(key);
        toggle.disabled = false;
        if (workspaceId() === wid && currentConversation?.id === conversation.id && currentConversation !== activeConversation) {
          setGroupInfo(currentConversation);
        }
      }
    });
    row.append(toggle);
    return row;
  }

  function setGroupInfo(conversation) {
    if (!conversation) autoTranslation.open(null);
    syncConversationPin(conversation);
    groupManagement?.sync();
    const toggle = document.getElementById('group-info-toggle');
    const panel = document.getElementById('group-info-panel');
    if (!toggle || !panel) return;
    renderGroupReplyPolicy(conversation);
    syncGroupAutoReplyNote(conversation);
    const group = Boolean(conversation && conversation.kind === 'group' && !conversation.public_agent);
    const feedbackScope = group ? sendScope() : '';
    if (feedbackScope !== groupInfoFeedbackScope) groupInfoAddFeedback.textContent = '';
    groupInfoFeedbackScope = feedbackScope;
    if (groupInfoAddDialog.open && (!group || !groupInfoAddCurrent(groupInfoAdd))) groupInfoAddDialog.close();
    if (groupInvite.open && (!group || !inviteMatches(inviteTarget))) groupInvite.close();
    if (groupMemoryDialog?.open && (!group || groupMemoryView?.scope !== sendScope())) groupMemoryDialog.close();
    const memoryOpen = document.getElementById('group-memory-open');
    if (memoryOpen) memoryOpen.hidden = !group || !servedByDsbot;
    toggle.hidden = !group;
    if (!group) {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      return;
    }
    const title = conversationLabel(conversation, currentUser && currentUser.id);
    const counts = groupInfoCounts(conversation);
    document.getElementById('group-info-title').textContent = title;
    document.getElementById('group-info-avatar').textContent = leadGlyph(title, '群');
    document.getElementById('group-info-count').textContent = counts.text;
    document.getElementById('group-info-tab-agents').textContent = `智能体 (${counts.agents})`;
    document.getElementById('group-info-tab-people').textContent = `成员 (${counts.people})`;
    const agentList = document.getElementById('group-info-agents');
    agentList.replaceChildren(...(conversation.agent_members || []).map(agent => renderGroupAgent(conversation, agent)));
    if (!agentList.children.length) agentList.append(memberRow(uiLabel('还没有智能体','No agents yet'),
      uiLabel('可以添加你的工作区智能体。','Add one of your workspace agents.'), 'empty'));
    const peopleList = document.getElementById('group-info-people');
    peopleList.replaceChildren(...(conversation.members || []).map(member => {
      const row = memberRow(member.username, currentUser && member.user_id === currentUser.id ? '你'
        : (conversation.account_group ? '群成员' : '工作区成员'), 'person');
      return groupManagement?.decorateMember(row, member) ?? row;
    }));
  }

  function setGroupInfoOpen(open, opener) {
    const toggle = document.getElementById('group-info-toggle');
    const panel = document.getElementById('group-info-panel');
    if (!toggle || !panel) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      groupInfoOpener = opener || toggle;
      const group = groupManagementContext()?.conversation;
      if (group && group.id !== lastGroupInfo) {
        lastGroupInfo = group.id;
        setGroupInfoTab(group.agent_members?.length ? 'agents' : 'people');
      }
      void initializeGroupManagement().catch(() => {});
    }
  }

  function showPublicChatState(state) {
    const notice = document.getElementById('public-chat-status');
    const directClosed = currentSource === 'social' && currentConversation?.direct?.open === false;
    if (notice) {
      notice.textContent = state?.open === false ? '发布者已关闭访客聊天。'
        : directClosed ? '联系人关系已解除，仍可查看历史消息。'
          : state?.pending ? '正在等待智能体回复…' : '';
      notice.hidden = !notice.textContent;
    }
    document.getElementById('chat-body').disabled = state?.open === false || directClosed;
    document.getElementById('chat-send').disabled = state?.open === false || directClosed;
  }

  function renderStudioDiscussionSource(source) {
    const panel = document.getElementById('chat-studio-discussion-source');
    const link = document.getElementById('chat-studio-discussion-link');
    if (!panel || !link) return;
    const href = source && Number.isSafeInteger(source.revision)
      ? studioDocumentHref(source.workspace_id, source.document_id, source.revision) : '';
    panel.hidden = !href;
    if (!href) {
      link.removeAttribute('href');
      link.textContent = '';
      return;
    }
    link.href = href;
    link.textContent = uiLabel(`查看来源团队文档 · 版本 ${source.revision}`, `View source team document · Version ${source.revision}`);
  }

  function setSocialHeaderTools(social) {
    renderStudioDiscussionSource(null);
    if (social && captureButton) captureButton.hidden = true;
    const publicChat = social ? currentConversation?.public_agent : null;
    showPublicChatState(publicChat);
    const group = social && currentConversation?.kind === 'group' && !publicChat;
    const kind = group ? 'group' : '';
    if (mainPanel.dataset.chatKind !== kind) document.getElementById('chat-more').setAttribute('aria-expanded', 'false');
    mainPanel.dataset.chatKind = kind;
    document.getElementById('chat-empty').dataset.group = String(group);
    if (!social) {
      document.getElementById('group-agent-action').hidden = true;
      agentRosterSheet.open = false;
      agentRosterView = null;
    }
    document.getElementById('chat-group-invite').hidden = !group;
    const multi = document.getElementById('multi-select-toggle');
    workspaceInvite.sync();
    if (multi) multi.hidden = !social || Boolean(publicChat);
    if (!social || publicChat) {
      selecting = false; selectedMessages.clear(); syncForwardBar();
      if (!social) renderPinned([]);
    }
  }

  function openEmptyAgentChat(agentId) {
    const agent = agents.find(item => item.id === agentId);
    if (!agent) return;
    clearSessionTransition();
    cancelStartupLink();
    stopReplyProgress();
    socialOpen += 1;
    currentConversation = null;
    currentAgent = agent;
    currentSource = 'agent';
    closeInChatSearch({restoreScroll: false, focus: false});
    publicDraft.enter(sendScope());
    stopPolling();
    setSocialHistory(null);
    setPrivateHistory(null);
    autoTranslation.open(null);
    agentMentions.clear();
    voiceRecorder.clear();
    voiceRecorder.refresh();
    clearVoicePlayers();
    chatCalls.sync();
    setSocialHeaderTools(false);
    setGroupInfo(null);
    renderReplyDraft();
    if (liveBanner) liveBanner.hidden = true;
    document.getElementById('social-agent-members').hidden = true;
    document.getElementById('pin-conversation').hidden = true;
    setDirectoryLink({source:'agent'});
    applyChatIdentity(document, agent.name, null, agentPortraitLook(agent.id, agent.portrait, agent.id === personalAgentId ? personalLook : null));
    writeHash({workspace:workspaceId(), agent:agentId});
    setSessionsOpen(false);
    renderAgentMessages([]);
    renderAgentQuickStarts(agent);
    syncPlusState();
  }

  let startupLink = null;
  const openingStartupLink = () => startupLink?.open === socialOpen && startupLink.current();

  function cancelStartupLink() {
    if (!startupLink) return;
    startupLink = null;
    if (status.dataset.kind === 'loading' && status.textContent === '正在打开对话…') show('', '');
  }

  function validStartupTranscript(body, wid, aid, cid) {
    const {agent, conversation, items, has_newer} = body || {};
    return agent && agent.id === aid && agent.workspace_id === wid && !agent.archived && !agent.native_deleted
      && conversation && conversation.id === cid && conversation.agent_id === aid && conversation.workspace_id === wid
      && has_newer === false && Array.isArray(items) && items.length <= Number(HISTORY_PAGE_SIZE)
      && items.every(item => item?.workspace_id === wid && item.agent_id === aid && item.conversation_id === cid);
  }

  function ownedStartingTranscript(local, aid, cid) {
    // Only an owned, exact, bounded transcript can replace the separate history read.
    const body = local?.entry;
    if (!validStartupTranscript(body, local?.space.id, aid, cid)) return;
    return () => ({status: 200, body});
  }

  function readStartupSnapshot(wid, aid, cid, desktopTranscript) {
    if (![wid, aid, cid].every(id => /^[a-f0-9]{32}$/.test(id))) return null;
    const owner = currentUser?.id;
    let expires = performance.now() + startupTranscriptAge;
    const path = agentConversationPath(wid, aid, cid);
    const pending = Promise.resolve(desktopTranscript).then(prepared => {
      if (prepared?.owner === owner && prepared.workspace === wid && prepared.agent === aid &&
          prepared.conversation === cid && performance.now() < prepared.expires) {
        expires = prepared.expires;
        return prepared.result;
      }
      return request('GET', `${path}?limit=${HISTORY_PAGE_SIZE}&snapshot=1`,
        undefined, undefined, AbortSignal.timeout(startupTranscriptAge));
    }).then(result => {
      return result.status === 200 && validStartupTranscript(result.body, wid, aid, cid) ? result : null;
    }).catch(() => null);
    return async () => {
      if (performance.now() >= expires) return null;
      const result = await pending;
      return performance.now() < expires ? result : null;
    };
  }

  async function openAgentConversation(agentId, conversationId, {
    refresh = false, acknowledge = true, link, transition, startupSnapshot, foreground = false, signal, position, message,
  } = {}) {
    if (sessionTransition?.pending && transition !== sessionTransition) return false;
    if (refresh && openingStartupLink()) return false;
    const nativeRefresh = refresh && servedByDsbot;
    const history = privateHistory;
    if (nativeRefresh && (currentSource !== 'agent' || currentAgent?.id !== agentId
      || currentConversation?.id !== conversationId || readingPrivateContext())) return false;
    if (!refresh) {
      if (!link) cancelStartupLink();
      renderAgentQuickStarts();
      stopReplyProgress();
      stopGroupReplyProgress();
      stopPolling();
    }
    const open = nativeRefresh ? socialOpen : ++socialOpen;
    const refreshId = nativeRefresh ? ++privateRefresh : null;
    const readThreadReceipt = startupSnapshot ? 0 : privateThreadReceipt;
    const wid = workspaceId();
    const owner = currentUser;
    // A send can finish after the returning read was taken and before it reaches this view.
    const sends = servedByDsbot && !refresh
      ? pendingSends.get(JSON.stringify([owner?.id, wid, 'agent', agentId, conversationId]))?.jobs.slice() : null;
    const sameScope = () => open === socialOpen && workspaceId() === wid && currentUser === owner
      && (!foreground || (foreground === foregroundPrivateRead && canRefreshForegroundPrivate()))
      && (!nativeRefresh || (refreshId === privateRefresh && !readingPrivateContext()));
    const stillOpen = () => sameScope() && (!link || link.current());
    const path = agentConversationPath(wid, agentId, conversationId);
    if (!PRIVATE_THREAD_ID.test(position?.id || '')) position = null;
    let around = position?.id || message;
    const snapshot = startupSnapshot && !around ? await startupSnapshot() : null;
    if (startupSnapshot && !around && !stillOpen()) return false;
    const latestPath = servedByDsbot ? `${path}?limit=${HISTORY_PAGE_SIZE}` : path;
    const read = url => request('GET', url,
      undefined, undefined, signal || (foreground ? AbortSignal.timeout(5000) : undefined))
      .catch(() => ({status: 0, body: {}}));
    let result = snapshot || await read(around ? latestPath + '&around=' + around : latestPath);
    if (around && stillOpen() && (result.status === 404 ||
        (result.status === 200 && !result.body.items?.some(item => item.id === around)))) {
      if (position) readingPositions.delete(position.key);
      position = null;
      around = null;
      result = await read(latestPath);
    }
    if (!stillOpen() || (nativeRefresh && history !== privateHistory)) return false;
    if (result.status !== 200) {
      if (refresh && [403, 404, 410].includes(result.status)) renderAgentQuickStarts();
      if (!refresh) {
        show('error', messageFor(result.body.error, '无法打开对话。'));
        syncReplyProgress();
        syncGroupReplyProgress();
      }
      return false;
    }
    const detailAgent = result.body.agent?.id === agentId ? result.body.agent : null;
    // Older private detail payloads can omit the agent projection. Reuse the
    // directory request already in flight without fetching history twice.
    if (!detailAgent && !agents.some(item => item.id === agentId) && link?.directory) {
      await link.directory;
      if (!stillOpen()) return false;
    }
    const listedAgent = agents.find(item => item.id === agentId);
    const agent = servedByDsbot ? detailAgent || listedAgent : listedAgent || detailAgent;
    const conversation = threadAfterRead(result.body.conversation, {owner: owner?.id, wid, aid: agentId, cid: conversationId}, readThreadReceipt);
    if (!agent || conversation?.id !== conversationId || ((link || foreground || message) && (
      (agent.workspace_id && agent.workspace_id !== wid) || (conversation.workspace_id && conversation.workspace_id !== wid)
      || (conversation.agent_id && conversation.agent_id !== agentId)))) {
      if (!refresh) show('error', '无法打开对话。');
      return false;
    }
    if (foreground) {
      if (!Array.isArray(result.body.items)) return false;
      const sameHistory = JSON.stringify(result.body.items) === JSON.stringify(lastAgentItems);
      const sameConversation = JSON.stringify(conversation) === JSON.stringify(currentConversation);
      if (sameHistory && sameConversation && JSON.stringify(agent) === JSON.stringify(currentAgent)) return true;
      const scroller = document.getElementById('message-scroller');
      const selection = document.getSelection?.();
      if (!messageScrollerAtBottom(scroller) || scroller.contains?.(document.activeElement) ||
          (selection && !selection.isCollapsed && scroller.contains?.(selection.anchorNode))) {
        if (liveBanner) liveBanner.hidden = false;
        return true;
      }
    }
    setSocialHistory(null);
    agentMentions.clear();
    voiceRecorder.clear();
    clearVoicePlayers();
    setSocialHeaderTools(false);
    setGroupInfo(null);
    const pin = document.getElementById('pin-conversation');
    if (pin) pin.hidden = true;
    syncMuteButton();
    currentSource = 'agent';
    currentAgent = agent;
    renderReplyDraft();
    if (liveBanner) liveBanner.hidden = true;
    chatCalls.sync();
    voiceRecorder.refresh();
    document.getElementById('social-agent-members').hidden = true;
    setDirectoryLink({source: 'agent'});
    syncPlusState();
    applyChatIdentity(document, agent.name, null, agentPortraitLook(agent.id, agent.portrait, agent.id === personalAgentId ? personalLook : null));
    if (currentConversation?.id !== conversation.id) {
      const autoReplyNotice = document.getElementById('group-agent-auto-reply-status');
      if (autoReplyNotice) autoReplyNotice.hidden = true;
      closeInChatSearch({restoreScroll: false, focus: false});
    }
    currentConversation = conversation;
    renderStudioDiscussionSource(conversation.studio_source);
    let items = around ? result.body.items : privateHistoryAfterSends(result.body.items || [], sends);
    if (servedByDsbot) {
      const state = nativeRefresh && history ? history : {wid, aid: agentId, cid: conversationId, owner: owner?.id,
        readingHistory: Boolean(around) || !acknowledge};
      state.cursor = result.body.cursor ?? null;
      if (around && result.body.has_newer && PRIVATE_THREAD_ID.test(items.at(-1)?.id || '')) state.after = items.at(-1).id;
      if (!around && sends?.length && items.length > Number(HISTORY_PAGE_SIZE)) {
        items = items.slice(-Number(HISTORY_PAGE_SIZE));
        state.cursor = items[0].id;
      }
      setPrivateHistory(state);
    } else setPrivateHistory(null);
    publicDraft.enter(sendScope());
    renderAgentQuickStarts(detailAgent);
    if (!link) writeHash({workspace: wid, agent: agentId, conversation: conversationId});
    setSessionsOpen(false);
    const pending = renderAgentMessages(items, {followLatest: !refresh, anchor:readingPositionAnchor(position)});
    const finished = items.filter(item => item.role === 'assistant' && item.status === 'succeeded');
    if (!position && acknowledge && currentConversation.unread_count > 0 && finished.length && document.visibilityState !== 'hidden') {
      const read = request('POST', `${path}/read`,
        {message_id: finished[finished.length - 1].id}).then(acknowledged => {
        if (!sameScope() || acknowledged.status !== 200) return;
        applyOpenedRead('agent', conversation, acknowledged.body.unread_count, link);
      }).catch(() => {});
      if (!servedByDsbot && !link) await read;
    }
    if (!stillOpen()) return false;
    renderSessions();
    if (pending) schedulePoll();
    else stopPolling();
    return stillOpen();
  }

  async function openSocialConversation(conversationId, {acknowledge = true, startUnread = false, preserveUnread = false,
    refresh = false, publicStartCurrent, link, transition, quiet = false, initialRead, signal, finishing, position, message, requireVisible = false} = {}) {
    if (sessionTransition?.pending && transition !== sessionTransition) return false;
    if (refresh && (openingStartupLink() || currentSource !== 'social'
      || currentConversation?.id !== conversationId)) return false;
    if (!refresh && !link) cancelStartupLink();
    stopReplyProgress();
    renderAgentQuickStarts();
    const open = ++socialOpen;
    const wid = workspaceId();
    const owner = currentUser;
    stopPolling();
    const sameScope = () => open === socialOpen && workspaceId() === wid && currentUser === owner;
    const stillOpen = () => sameScope() && (!link || link.current()) && (!requireVisible || viewingSocialMessages());
    const readPinReceipt = pinReceipt;
    const unreadEntry = servedByDsbot && acknowledge && startUnread && !refresh;
    if (!chatPathId(position?.id)) position = null;
    let around = position?.id || message;
    const path = `${socialBase()}/${conversationId}`;
    const latestPath = path + (unreadEntry ? '?start=unread' : '');
    const read = url => request('GET', url, undefined, undefined, signal).catch(() => ({status: 0, body: {}}));
    let result = initialRead || await read(around ? path + '?around=' + encodeURIComponent(around) : latestPath);
    if (around && stillOpen() && ((result.status === 404 && result.body?.error?.code === 'history_anchor_missing') ||
        (result.status === 200 && !result.body.items?.some(item => item.id === around)))) {
      if (position) readingPositions.delete(position.key);
      position = null;
      around = null;
      result = await read(latestPath);
    }
    if (!stillOpen() || (publicStartCurrent && !publicStartCurrent())) return false;
    if (result.status !== 200) {
      if (refresh) {
        const target = groupManagementContext();
        if (target?.conversation.id === conversationId && [403,404].includes(result.status)) {
          forgetGroup({...target,conversationId}, true);
          return false;
        }
        scheduleSocialPoll(currentConversation);
        return false;
      }
      if (!quiet) show('error', [403,404].includes(result.status) ? uiLabel('无法打开此会话。','This conversation could not be opened.')
        : messageFor(result.body?.error, '无法打开会话。'));
      if (currentSource === 'agent' && !syncReplyProgress() && lastAgentItems.some(waitingAgentReply)) schedulePoll();
      if (currentSource === 'social') { syncGroupReplyProgress(); scheduleSocialPoll(currentConversation); }
      return false;
    }
    const updated = rosterAfterRead(mergeGroupRead(mergePinRead(result.body.conversation, owner?.id, wid, readPinReceipt), owner?.id, wid));
    if (updated?.id !== conversationId || ((link || initialRead || message) && updated.workspace_id && updated.workspace_id !== wid)) {
      if (link) show('error', '无法打开会话。');
      return false;
    }
    if (publicStartCurrent && (!updated.public_agent || updated.public_agent.open === false)) return false;
    const finishedVisibleReply = finishing?.size && !readingSocialContext(undefined, {allowScrolled:true}) &&
      (result.body.items || []).some(item => (finishing.has(item.reply_job_id) && visibleGroupReply(item.reply_job_id))
        || item.reply_jobs?.some(job => !waitingGroupReply(job) && finishing.has(job.id) && visibleGroupReply(job.id)));
    if (refresh && servedByDsbot && (!viewingSocialMessages() || (readingSocialContext() && !finishedVisibleReply)
        || pendingSends.get(sendScope())?.active)) {
      if (viewingSocialMessages() && liveBanner && updated.activity_version !== currentConversation?.activity_version) liveBanner.hidden = false;
      scheduleSocialPoll(currentConversation);
      return false;
    }
    if (refresh && currentConversation?.id === updated.id
      && JSON.stringify(currentConversation) === JSON.stringify(updated)
      && JSON.stringify(lastSocialItems) === JSON.stringify(result.body.items)) {
      scheduleSocialPoll(updated);
      return true;
    }
    if (currentSource !== 'social' || currentConversation?.id !== updated.id) {
      document.getElementById('chat-more').setAttribute('aria-expanded', 'false');
      voiceRecorder.clear();
      closeInChatSearch({restoreScroll: false, focus: false});
    }
    currentAgent = null;
    currentSource = 'social';
    currentConversation = updated;
    if (privateHistory) setPrivateHistory(null);
    publicDraft.enter(sendScope(), Boolean(updated.public_agent));
    const shown = result.body.items || [];
    void restoreReplyDraft(shown, {allowLookup:!refresh});
    renderReplyDraft();
    if (liveBanner) liveBanner.hidden = true;
    const lastSeq = shown.at(-1)?.seq;
    const snapshot = !position && unreadEntry ? result.body.unread_window : null;
    const first = snapshot?.first;
    const unread = first && Number.isSafeInteger(first.seq) && Number.isSafeInteger(snapshot.read_seq) &&
      Number.isSafeInteger(snapshot.last_seq) && Number.isSafeInteger(lastSeq) && shown.some(item => item.id === first.id)
      ? {firstId:first.id, firstSeq:first.seq, committed:snapshot.read_seq, latest:snapshot.last_seq,
        after:snapshot.has_newer ? lastSeq : null, seen:new Set()}
      : preserveUnread && Number.isSafeInteger(lastSeq) && updated.unread_count > 0
        ? {committed:0, latest:lastSeq, seen:new Set()} : null;
    const followsLiveLink = link && message && around === message && result.body.has_newer === false;
    setSocialHistory({wid, cid: conversationId, owner: owner?.id, cursor: result.body.cursor ?? null,
      readingHistory: Boolean((around && !followsLiveLink) || unread?.firstId), unread,
      after: around && result.body.has_newer && Number.isSafeInteger(lastSeq) && lastSeq > 0 ? lastSeq : null});
    if (snapshot?.first === null && Number.isSafeInteger(snapshot.last_seq)) applyOpenedRead('social', updated, 0, link, snapshot.last_seq);
    chatCalls.sync();
    agentMentions.refresh();
    voiceRecorder.refresh();
    setSessionsOpen(false);
    syncMuteButton(currentConversation);
    applyChatIdentity(document, conversationLabel(
      currentConversation, currentUser && currentUser.id), currentConversation);
    setDirectoryLink({source: 'social', public_agent: currentConversation.public_agent});
    if (!link) writeHash({workspace: wid, social: conversationId});
    if (selecting && (!lastSocialItems.length || lastSocialItems[0].conversation_id !== conversationId)) {
      selecting = false; selectedMessages.clear(); syncForwardBar();
    }
    renderPinned(result.body.pinned_messages || []);
    setSocialHeaderTools(true);
    syncPlusState();
    setGroupInfo(currentConversation);
    messageUtilities.refreshAnnouncement();
    const publicChat = currentConversation.public_agent;
    setChatSubtitle(publicChat ? '公开智能体 · 发布者可查看此对话'
      : currentConversation.kind === 'group' ? groupHeaderSubtitle(currentConversation)
        : '单聊 · ' + ((currentConversation.members || []).length) + ' 人');
    if (!refresh) restorePendingSocialText(shown);
    renderSocialMessages(shown, {refresh, anchor:readingPositionAnchor(position)});
    renderGroupReplyAction(result.body.agent_replies || []);
    if (unread?.firstId) {
      const divider = document.getElementById('chat-first-unread');
      const scroller = document.getElementById('message-scroller');
      if (divider?.getBoundingClientRect && scroller.getBoundingClientRect) {
        scroller.scrollTop += divider.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
      }
      // The rendered conversation becomes interactive after the sidebar transition clears.
      setTimeout(scheduleUnreadRead, 0);
    }
    // Acknowledge only the last message actually rendered, not messages that
    // arrived after this snapshot, and never consume unread in a hidden tab.
    if (!position && acknowledge && !unread && currentConversation.unread_count > 0 && shown.length && document.visibilityState !== 'hidden') {
      const last = shown[shown.length - 1];
      const cursor = Number.isSafeInteger(last.seq) ? {seq:last.seq} : {message_id:last.id};
      const read = request('POST', `${socialBase()}/${conversationId}/read`, cursor).then(acknowledged => {
        if (!sameScope() || acknowledged.status !== 200) return;
        applyOpenedRead('social', updated, acknowledged.body.unread_count, link, cursor.seq);
        if (servedByDsbot && !link) renderSessions();
      }).catch(() => {});
      if (!servedByDsbot && !link) await read;
    }
    if (!stillOpen()) return false;
    renderSessions();
    scheduleSocialPoll(currentConversation);
    if ((result.body.agent_replies || []).some(item => ['queued', 'running'].includes(item.status))) schedulePoll();
    return true;
  }

  function applyOpenedRead(source, conversation, unread, link, seq) {
    if (!Number.isSafeInteger(unread) || unread < 0) return;
    conversation.unread_count = unread;
    const listed = source === 'social' && socialConversations.find(item => item.id === conversation.id);
    if (!(Number.isSafeInteger(seq) && listed?.last_seq > seq)) {
      const session = sessions.find(item => item.source === source && item.id === conversation.id);
      if (session) session.unread_count = unread;
      if (listed) listed.unread_count = unread;
    }
    if (link) {
      link.readReceipt = {source, id:conversation.id, count:unread, updated:conversation.updated, seq};
      renderSessions();
    }
  }

  function socialPinned(conversation) {
    const row = sessions.find(item => item.source === 'social' && item.id === conversation.id);
    return Boolean(row?.pinned ?? conversation.pinned);
  }

  function pinKey(owner, workspace, conversation) {
    return JSON.stringify([owner, workspace, conversation]);
  }

  function mergePinRead(conversation, owner, workspace, readReceipt) {
    if (!conversation) return conversation;
    const change = conversationPins.get(pinKey(owner, workspace, conversation.id));
    // A directory or detail read started before a save may still return its old value.
    if (change && (change.pending || change.receipt > readReceipt)) {
      return {...conversation, pinned: change.pinned};
    }
    return conversation;
  }

  function syncConversationPin(conversation) {
    const change = conversation && conversationPins.get(pinKey(currentUser?.id, workspaceId(), conversation.id));
    const pinned = Boolean(conversation && (change?.pending ? change.pinned : socialPinned(conversation)));
    const busy = Boolean(change?.pending);
    if (pinButton) {
      pinButton.hidden = !conversation;
      pinButton.disabled = busy;
      pinButton.setAttribute('aria-pressed', String(pinned));
      pinButton.textContent = pinned ? uiLabel('取消置顶', 'Unpin conversation') : uiLabel('置顶会话', 'Pin conversation');
    }
    if (groupPin) {
      groupPin.disabled = busy;
      groupPin.setAttribute('aria-checked', String(pinned));
    }
  }

  async function toggleConversationPin() {
    if (!currentUser || currentSource !== 'social' || !currentConversation || sessionTransition?.pending) return;
    const {id} = currentConversation;
    const owner = currentUser.id;
    const workspace = workspaceId();
    const key = pinKey(owner, workspace, id);
    if (conversationPins.get(key)?.pending) return;
    const previous = socialPinned(currentConversation);
    const change = {pinned: !previous, pending: true, receipt: pinReceipt};
    conversationPins.set(key, change);
    const matchesWorkspace = () => workspaceId() === workspace && currentUser?.id === owner;
    const matchesConversation = () => matchesWorkspace() && currentSource === 'social' && currentConversation?.id === id;
    function apply() {
      if (!matchesWorkspace()) return;
      if (sessionsWorkspace === workspace && sessionsUser?.id === owner) {
        const directoryRow = socialConversations.find(row => row.id === id);
        const sessionRow = sessions.find(row => row.source === 'social' && row.id === id);
        if (directoryRow) directoryRow.pinned = change.pinned;
        if (sessionRow) sessionRow.pinned = change.pinned;
        sortSessions(sessions);
        renderSessions();
      }
      if (matchesConversation()) {
        currentConversation.pinned = change.pinned;
        syncConversationPin(currentConversation);
      }
    }
    apply();
    const result = await request('POST', `/v1/workspaces/${workspace}/social/conversations/${id}/preferences`, {pinned: change.pinned})
      .catch(() => ({status: 0, body: {}}));
    const saved = result.status === 200 && result.body?.pinned === change.pinned;
    if (!saved) change.pinned = previous;
    change.pending = false;
    change.receipt = ++pinReceipt;
    apply();
    if (!saved && matchesConversation() && !sessionTransition?.pending) {
      show('error', uiLabel('置顶未保存，请重试。', 'Couldn’t save the pin. Try again.'));
    }
  }

  function scheduleSocialPoll(conversation) {
    if (hasPendingReplies() || conversation?.public_agent?.pending) {
      if (currentGroupReplyWatch(groupReplyWatch) && !groupReplyWatch.degraded) return;
      schedulePoll(servedByDsbot ? 8000 : 1800);
    } else if (!servedByDsbot && pollsAccountThread(conversation)) {
      schedulePoll(8000);
    }
  }

  function pollsAccountThread(conversation) {
    return Boolean(conversation?.public_agent?.open || conversation?.direct?.open || conversation?.account_group);
  }

  function schedulePoll(delay = 2000) {
    stopPolling();
    if (currentSource === 'agent' && (!canWatchReply() || readingPrivateContext())) return;
    pollTimer = globalThis.setTimeout(() => {
      pollTimer = 0;
      if (currentConversation && currentAgent && currentSource === 'agent' && canWatchReply()) {
        openAgentConversation(currentAgent.id, currentConversation.id, {refresh: true});
      } else if (currentConversation && currentSource === 'social' && !socialHistory?.readingHistory) {
        if (document.visibilityState !== 'hidden' && viewingSocialMessages() && (!servedByDsbot || !readingSocialContext())) {
          openSocialConversation(currentConversation.id, {refresh: true});
        } else if (servedByDsbot && viewingSocialMessages()) {
          scheduleSocialPoll(currentConversation);
        }
      }
    }, delay);
  }

  function canRefreshForegroundPrivate() {
    if (!currentPrivateThread() || !privateHistory || !canWatchReply() || readingPrivateContext() ||
        sessionTransition?.pending || openingStartupLink()) return false;
    const scope = sendScope();
    const queue = pendingSends.get(scope);
    return !queue?.active && !memoryWrites.has(scope) && !replyWatch && !lastAgentItems.some(waitingAgentReply);
  }

  let foregroundPrivateRead;
  function refreshForegroundPrivate() {
    if (!canRefreshForegroundPrivate()) return false;
    const scope = sendScope();
    const now = performance.now();
    if (foregroundPrivateRead?.scope === scope && (foregroundPrivateRead.busy || now - foregroundPrivateRead.started < 750)) return true;
    const reading = foregroundPrivateRead = {scope, started:now, busy:true};
    void openAgentConversation(currentAgent.id, currentConversation.id, {refresh:true, foreground:reading})
      .finally(() => { reading.busy = false; });
    return true;
  }

  globalThis.addEventListener('focus', refreshForegroundPrivate);
  globalThis.addEventListener('blur', () => { foregroundPrivateRead = null; });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') foregroundPrivateRead = null;
    if (currentSource === 'agent') {
      if (document.visibilityState === 'visible' && !refreshForegroundPrivate()) void refreshAgentQuickStarts();
      if (!canWatchReply()) stopPolling();
      if (!syncReplyProgress() && currentConversation && lastAgentItems.some(waitingAgentReply)) schedulePoll();
      return;
    }
    if (document.visibilityState === 'visible') scheduleUnreadRead();
    syncGroupReplyProgress();
    if (document.visibilityState !== 'visible' || currentSource !== 'social' || !currentConversation
      || pollTimer || socialHistory?.readingHistory || !viewingSocialMessages()) return;
    if (servedByDsbot) scheduleSocialPoll(currentConversation);
    else if (pollsAccountThread(currentConversation) || hasPendingReplies()) {
      void openSocialConversation(currentConversation.id, {refresh: true});
    }
  });

  const composeMenuButton = document.getElementById('new-conversation');
  const composeMenu = mountActionMenus(document).bind(composeMenuButton, document.getElementById('compose-menu'), {
    onOpen() {
      document.getElementById('compose-add-contact').hidden = inPersonalWorkspace();
      const meetingNotes = document.getElementById('compose-meeting-notes');
      if (meetingNotes) meetingNotes.href = '/meetings#' + new URLSearchParams({workspace: workspaceId(), new: '1'});
    },
  });

  function selectedMemberCount() {
    return document.querySelectorAll('#member-choices input:checked').length;
  }

  let composePhase = '';
  let composeAttempt = null;
  let composeReceipt = null;
  let composeView = 0;
  const composeError = document.getElementById('compose-dialog-error');
  function setComposeError(text = '') {
    composeError.hidden = !text;
    composeError.textContent = text;
    if (text) {
      composeError.focus({preventScroll:true});
      composeError.scrollIntoView?.({block:'nearest'});
    }
  }

  function composeCreateError(status, template, error) {
    if (!status) return uiLabel('连接中断，当前选择已保留。请重试。', 'Connection interrupted. Your selections are saved. Try again.');
    if (template && error?.code === 'team_template_role_conflict') {
      const detail = typeof error.message === 'string' && error.message.length <= 240 && /\p{Script=Han}/u.test(error.message)
        ? error.message : '模板角色的名称被占用。请在「智能体」中恢复已归档的角色，或将占用名称的智能体改名后重试。';
      return uiLabel(detail, 'A template role’s name is in use. In Agents, restore the archived role or rename the conflicting agent, then try again.');
    }
    if (template && error?.code === 'team_template_agent_quota') {
      return uiLabel('当前工作区的智能体数量已达上限。请切换到有可用名额的工作区后重试。',
        'This workspace has reached its agent limit. Switch to a workspace with available slots and try again.');
    }
    if (status === 401) return uiLabel('登录已失效。请重新登录后再创建。', 'Your session expired. Sign in again to create the conversation.');
    if (status === 403) return template
      ? uiLabel('只有工作区所有者或管理员可以从模板创建团队。请切换到你能管理的工作区。', 'Only workspace owners or admins can use templates. Switch to a workspace you can manage.')
      : uiLabel('你在当前工作区没有创建权限。请切换工作区后重试。', 'You do not have permission to create conversations here. Switch workspaces and try again.');
    if (status === 400 || status === 404 || status === 409) return template
      ? uiLabel('暂时无法使用所选模板。请选择其他模板，或稍后重试。', 'The selected template is unavailable. Choose another template or try again later.')
      : uiLabel('请核对成员和群组名称后重试。', 'Review the selected members and conversation name, then try again.');
    if (status === 429) return uiLabel('创建请求暂时过多。当前选择已保留，请稍后重试。', 'Too many creation requests. Your selections are saved. Try again later.');
    return template ? uiLabel('暂时无法创建智能体团队。所选模板已保留，请重试。', 'Could not create the agent team. Your template is still selected. Try again.')
      : uiLabel('暂时无法创建会话。当前选择已保留，请重试。', 'Could not create the conversation. Your selections are saved. Try again.');
  }

  function syncComposeCreate() {
    const button = document.getElementById('compose-dialog-submit');
    const cancel = document.getElementById('compose-dialog-cancel');
    const progress = document.getElementById('compose-dialog-progress');
    const busy = Boolean(composePhase);
    const team = composeMode === 'group' && groupMode === 'team';
    const template = team ? document.querySelector('#team-template-choices input:checked') : null;
    button.disabled = busy || (!composeReceipt && !composeCreateEnabled({
      composeMode,
      groupMode,
      personal: inPersonalWorkspace(),
      selectedAgentCount: document.querySelectorAll('#member-choices input[name="agent-member"]:checked').length,
      selectedCount: selectedMemberCount(),
      selectedHumanCount: document.querySelectorAll('#member-choices input[name="member"]:checked').length,
      templateSelected: Boolean(template),
    }));
    const action = team ? uiLabel('创建团队', 'Create team') : composeMode === 'group'
      ? uiLabel('创建群组', 'Create group') : uiLabel('开始私聊', 'Start chat');
    button.textContent = composePhase === 'opening' ? uiLabel('打开中…', 'Opening…')
      : busy ? uiLabel('创建中…', 'Creating…')
        : composeReceipt ? uiLabel('重新打开', 'Reopen') : action;
    cancel.disabled = busy;
    cancel.textContent = composeReceipt ? uiLabel('关闭', 'Close') : uiLabel('取消', 'Cancel');
    progress.textContent = composePhase === 'opening' ? uiLabel('已创建，正在打开会话…', 'Created. Opening the conversation…')
      : busy && template ? uiLabel(`正在创建${template.dataset.templateName}…`, `Creating ${template.dataset.templateName}…`)
        : busy ? uiLabel('正在创建会话…', 'Creating the conversation…') : '';
    const locked = busy || Boolean(composeReceipt);
    for (const id of ['compose-mode-switch', 'compose-dialog-body']) {
      document.getElementById(id).inert = locked;
    }
  }

  function applyMemberFilter() {
    const input = document.getElementById('compose-member-search');
    const needle = (input.value || '').trim().toLocaleLowerCase();
    const labels = [...document.querySelectorAll('#member-choices label')];
    let visible = 0;
    for (const label of labels) {
      const show = !needle || label.textContent.trim().toLocaleLowerCase().includes(needle);
      label.hidden = !show;
      if (show) visible += 1;
    }
    const empty = document.getElementById('compose-members-empty');
    if (!labels.length) {
      empty.hidden = false;
      const roster = inPersonalWorkspace() ? '联系人' : '工作区成员';
      empty.textContent = membersStatus === 'loading' ? '正在加载' + roster + '…'
        : (membersStatus === 'failed' ? '无法加载' + roster + '。' : '没有可邀请的' + roster + '。');
    } else if (!visible) {
      empty.hidden = false;
      empty.textContent = '没有匹配的成员。';
    } else {
      empty.hidden = true;
    }
  }

  function syncSelectedCount() {
    const count = selectedMemberCount();
    document.getElementById('compose-selected-count').textContent = uiLabel(composeSelectedLabel(count), `${count} selected`);
    syncComposeCreate();
  }

  function setGroupMode(mode) {
    groupMode = mode === 'team' ? 'team' : 'custom';
    setComposeError();
    for (const button of document.querySelectorAll('#compose-mode-switch [data-group-mode]')) {
      const selected = button.dataset.groupMode === groupMode;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    const team = composeMode === 'group' && groupMode === 'team';
    document.getElementById('compose-team-panel').hidden = !team;
    document.getElementById('compose-custom-panel').hidden = team;
    document.getElementById('compose-dialog-body').scrollTop = 0;
    if (team) void loadTeamTemplates();
    syncComposeCreate();
  }

  let loadingTeamTemplates = false;
  async function loadTeamTemplates() {
    const holder = document.getElementById('team-template-choices');
    if (loadingTeamTemplates || holder.children.length) return;
    const status = document.getElementById('team-templates-status');
    const retry = document.getElementById('team-templates-retry');
    loadingTeamTemplates = true;
    retry.hidden = true;
    status.textContent = uiLabel('正在加载团队模板…', 'Loading team templates…');
    const result = await request('GET', '/v1/team-templates', undefined, undefined, AbortSignal.timeout(10000)).catch(() => null);
    loadingTeamTemplates = false;
    if (result?.status !== 200 || !Array.isArray(result.body.items)) {
      status.textContent = uiLabel('暂时无法读取团队模板。', 'Could not load team templates.');
      retry.hidden = false;
      return;
    }
    for (const template of result.body.items) {
      const label = document.createElement('label');
      label.className = 'team-template-option';
      const box = document.createElement('input');
      box.type = 'radio';
      box.name = 'team-template';
      box.value = template.slug;
      box.dataset.templateName = template.name;
      const content = document.createElement('span');
      content.className = 'team-template-content';
      const name = document.createElement('span');
      name.id = `team-template-${template.slug}-name`;
      name.className = 'team-template-name';
      name.textContent = template.name;
      box.setAttribute('aria-labelledby', name.id);
      content.append(name);
      if (template.summary) {
        const summary = document.createElement('span');
        summary.className = 'team-template-summary';
        summary.textContent = template.summary;
        content.append(summary);
      }
      const roles = document.createElement('span');
      roles.id = `team-template-${template.slug}-roles`;
      roles.className = 'team-template-roles';
      for (const agent of template.agents) {
        const role = document.createElement('span');
        role.textContent = agent.name;
        roles.append(role);
      }
      box.setAttribute('aria-describedby', roles.id);
      content.append(roles);
      label.append(box, content);
      holder.append(label);
    }
    status.textContent = result.body.items.length ? '' : uiLabel('暂无可用的团队模板。', 'No team templates are available.');
    syncComposeCreate();
  }

  let composeOpener;
  function closeComposeDialog({focus = false} = {}) {
    composeView += 1;
    const saved = composeReceipt;
    composeReceipt = null;
    composePhase = '';
    const opener = composeOpener;
    composeOpener = null;
    const dialog = document.getElementById('compose-dialog');
    if (dialog.open) dialog.close();
    dialog.hidden = true;
    document.getElementById('compose-social-form').reset();
    setGroupMode('custom');
    applyMemberFilter();
    syncSelectedCount();
    if (focus && opener?.isConnected !== false) opener?.focus({preventScroll: true});
    if (focus && saved) void loadSessions();
  }

  function renderMemberChoices(single, preserveSelection = false) {
    const holder = document.getElementById('member-choices');
    const selected = preserveSelection
      ? new Set([...document.querySelectorAll('#member-choices input:checked')].map(box => box.name + ':' + box.value))
      : new Set();
    holder.replaceChildren();
    const choices = groupPickerChoices(members, currentUser && currentUser.id, single ? [] : agents);
    for (const member of choices) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = single ? 'radio' : 'checkbox';
      box.name = member.kind === 'agent' ? 'agent-member' : 'member';
      box.value = member.id;
      box.checked = selected.has(box.name + ':' + box.value);
      const text = document.createElement('span');
      text.className = 'choice-label';
      text.textContent = member.label;
      label.append(box, text);
      holder.append(label);
    }
    applyMemberFilter();
    syncSelectedCount();
  }

  let contactsRead = 0;
  async function loadPersonalContacts() {
    const version = ++contactsRead;
    const wid = workspaceId();
    const user = currentUser;
    membersStatus = 'loading';
    const result = await request('GET', '/v1/contacts').catch(() => ({status:0}));
    if (version !== contactsRead || wid !== workspaceId() || user !== currentUser || !inPersonalWorkspace()) return;
    membersStatus = result.status === 200 ? '' : 'failed';
    if (!membersStatus) members = contactMembers(result);
    if (!document.getElementById('compose-dialog').hidden) renderMemberChoices(false, true);
    refreshDirectorySearch();
  }

  function openComposeDialog(mode, {keyboard = false} = {}) {
    if (composePhase || composeReceipt) return;
    composeView += 1;
    composeMenu.close({focus: true});
    composeOpener = document.activeElement || composeMenuButton;
    composeMode = mode;
    const dialog = document.getElementById('compose-dialog');
    const isGroup = mode === 'group';
    document.getElementById('compose-dialog-title').textContent = isGroup ? uiLabel('新建群组', 'New group') : uiLabel('工作区私聊', 'Workspace chat');
    document.getElementById('compose-members-legend').textContent = isGroup ? uiLabel('成员', 'Members') : uiLabel('选择一位成员', 'Choose a member');
    const intro = document.getElementById('compose-intro');
    intro.hidden = !isGroup;
    if (isGroup) intro.textContent = inPersonalWorkspace() ? uiLabel(GROUP_CREATE_INTRO, 'Choose contacts or agents for your group.')
      : uiLabel('至少选择一位工作区成员，也可以添加智能体。', 'Choose at least one workspace member. You can also add agents.');
    document.getElementById('compose-mode-switch').hidden = !isGroup;
    document.getElementById('compose-title-label').hidden = !isGroup;
    document.getElementById('compose-member-tools').hidden = !isGroup;
    const panel = document.getElementById('compose-custom-panel');
    if (isGroup) {
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', 'compose-mode-custom');
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-labelledby');
    }
    if (!isGroup) document.getElementById('compose-title').value = '';
    document.getElementById('compose-member-search').value = '';
    setGroupMode('custom');
    dialog.hidden = false;
    if (!dialog.open) dialog.showModal?.();
    if (isGroup && inPersonalWorkspace()) void loadPersonalContacts();
    renderMemberChoices(mode === 'contact');
    document.getElementById(isGroup && (keyboard || !narrowScreen()) ? 'compose-mode-custom' : 'compose-dialog-title')
      .focus({preventScroll: true});
  }

  function setSearchTab(name) {
    searchTab = name;
    if (name !== 'messages') searchConversation = '';
    for (const tab of document.querySelectorAll('#search-panel [data-search-tab]')) {
      tab.setAttribute('aria-selected', tab.dataset.searchTab === name ? 'true' : 'false');
    }
  }

  function openSearchPanel(tab, conversationId = '', {fromSessionList = true} = {}) {
    if (composePhase) return;
    if (!document.getElementById('compose-dialog').hidden) {
      const saved = composeReceipt;
      closeComposeDialog();
      if (saved) void loadSessions();
    }
    searchFromSessionList = fromSessionList;
    searchConversation = conversationId;
    searchConversationTitle = document.getElementById('chat-title').textContent;
    document.getElementById('search-panel').hidden = false;
    document.getElementById('search-close').hidden = false;
    document.getElementById('conversation-group').hidden = true;
    document.getElementById('pinned-group').hidden = true;
    composeMenu.close();
    setFilterOpen(false, {focus: false});
    setNotificationsOpen(false);
    // The panel is a child of the session pane, which the narrow stylesheet
    // paints only in the sessions-open state. Opening search has to reveal it
    // there, or the panel is laid out inside a display:none parent.
    if (narrowScreen()) setSessionsOpen(true);
    if (tab) setSearchTab(tab);
    if (inPersonalWorkspace() && ['all', 'contacts'].includes(searchTab)) void loadPersonalContacts();
    renderSearch();
  }

  function refreshDirectorySearch() {
    if (isSearchOpen() && !messageSearch.state.loading) void renderSearch({reuseMessages: true});
  }

  function closeSearchPanel({focus = false} = {}) {
    searchSeq++;
    void messageSearch.load('');
    stopSearchSources();
    searchConversation = '';
    document.getElementById('search-panel').hidden = true;
    document.getElementById('search-close').hidden = true;
    document.getElementById('conversation-group').hidden = false;
    document.getElementById('session-search').value = '';
    setSearchTab('all');
    const returnToList = searchFromSessionList || !currentConversation;
    if (narrowScreen()) setSessionsOpen(returnToList);
    if (focus) document.getElementById(returnToList ? 'conversation-heading' : 'chat-title').focus({preventScroll: true});
  }

  function addSearchSection(root, title, items, onPick) {
    if (!items.length) return;
    const section = document.createElement('section');
    section.className = 'search-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      const button = document.createElement(item.href ? 'a' : 'button');
      if (item.href) button.href = item.href;
      else button.type = 'button';
      const name = document.createElement('span');
      name.className = 'title';
      name.textContent = item.title;
      button.append(name);
      if (item.preview) {
        const preview = document.createElement('span');
        preview.className = 'preview';
        preview.textContent = item.preview;
        button.append(preview);
      }
      if (!item.href) button.addEventListener('click', () => onPick(item));
      li.append(button);
      list.append(li);
    }
    section.append(heading, list);
    root.append(section);
  }

  const worksSearchTabs = new Set(['artifacts', 'documents', 'media']);
  let sourceSearch;

  function stopSearchSources() {
    sourceSearch?.controller.abort();
    sourceSearch = null;
  }

  function loadSearchSources(owner, workspace, tab, query) {
    const everySource = tab === 'all' && Boolean(query);
    const works = everySource || worksSearchTabs.has(tab);
    const memories = servedByDsbot && (everySource || tab === 'memory');
    if (!owner?.id || !PRIVATE_THREAD_ID.test(workspace || '') || (!works && !memories)) {
      stopSearchSources();
      return null;
    }
    const key = JSON.stringify([owner.id, workspace, tab, query]);
    if (sourceSearch?.key === key) return sourceSearch;
    stopSearchSources();
    const controller = new AbortController();
    const pending = {key, controller, sections:null};
    const params = new URLSearchParams({limit:'50', order:'recent'});
    if (query) params.set('q', query);
    if (tab === 'documents') params.set('kind','document');
    if (tab === 'media') params.set('kind','media');
    pending.results = Promise.all([
      ...(works ? [{path:'artifacts', title:uiLabel('作品','Works')}] : []),
      ...(memories ? [{path:'memory', title:uiLabel('记忆','Memory')}] : []),
    ].map(async ({path, title}) => {
      const result = await request('GET', `/v1/workspaces/${workspace}/${path}?${params}`,
        undefined, undefined, controller.signal).catch(() => ({status:0,body:{}}));
      const failed = result.status !== 200 || !Array.isArray(result.body.items);
      const items = (failed ? [] : result.body.items).filter(item =>
        item?.workspace_id === workspace && PRIVATE_THREAD_ID.test(item.id || '')
      ).map(item => ({
        title:item.title || uiLabel('未命名','Untitled'),
        preview:item.match?.text || (path === 'artifacts' ? artifactKindLabel(item.kind) : ''),
        href:path === 'artifacts' ? spaceHref(workspace,item.id)
          : '/memory?' + new URLSearchParams({workspace,page:item.id}),
      }));
      return {title, items, failed};
    })).then(sections => pending.sections = sections);
    sourceSearch = pending;
    return pending;
  }

  function contactItems() {
    return memberChoices(members, currentUser && currentUser.id).map(member => ({
      type: 'contact',
      id: member.user_id,
      title: member.username,
      preview: member.contact ? '联系人' : '工作区成员',
      ...(member.contact ? {href:'/contacts'} : {}),
    }));
  }

  function groupItems() {
    return socialConversations.filter(row => row.kind === 'group').map(row => ({
      type: 'social',
      id: row.id,
      title: conversationLabel(row, currentUser && currentUser.id),
      preview: '群聊',
    }));
  }

  function agentItems() {
    return agents.map(agent => ({
      type: 'agent',
      id: agent.id,
      title: agent.name,
      preview: agent.summary || '智能体',
    }));
  }

  async function renderSearch({reuseMessages = false, appendResources = false} = {}) {
    const query = (document.getElementById('session-search').value || '').trim();
    const results = document.getElementById('search-results');
    const empty = document.getElementById('search-empty');
    const note = document.getElementById('search-source-note');
    const more = document.getElementById('search-more');
    const paged = searchTab === 'messages' || searchTab === 'all';
    const owner = currentUser, workspace = workspaceId();
    results.replaceChildren();
    empty.hidden = true;
    note.hidden = Boolean(query) && !searchConversation;
    note.textContent = searchConversation
      ? '仅搜索当前对话：' + searchConversationTitle
      : '搜索当前工作区。';
    const seq = ++searchSeq;
    const current = () => seq === searchSeq && owner === currentUser && workspace === workspaceId();
    if (more) more.hidden = true;

    if (searchTab === 'files' || searchTab === 'links') {
      stopSearchSources();
      const params = new URLSearchParams({kind: searchTab, q: query, limit: '20'});
      if (appendResources && resourceCursor) params.set('cursor', resourceCursor);
      const found = await request('GET', `/v1/workspaces/${workspace}/search/resources?${params}`)
        .catch(() => ({status:0,body:{}}));
      if (!current()) return;
      if (found.status !== 200) { empty.hidden = false; empty.textContent = '无法加载搜索结果。'; return; }
      resourceItems = appendResources ? resourceItems.concat(found.body.items || []) : (found.body.items || []);
      resourceCursor = found.body.cursor || '';
      addSearchSection(results, searchTab === 'files' ? '文件' : '链接', resourceItems, () => {});
      empty.hidden = Boolean(resourceItems.length); empty.textContent = '没有匹配的结果。';
      if (more) { more.hidden = !resourceCursor; more.disabled = false; }
      return;
    }
    if (searchTab === 'messages' && !query) {
      stopSearchSources();
      empty.hidden = false;
      empty.textContent = searchConversation
        ? '输入关键词，搜索当前对话中你有权查看的消息。'
        : '输入关键词，搜索你在这个工作区里有权查看的消息。';
      return;
    }

    let messageItems = [];
    const sources = loadSearchSources(owner, workspace, searchTab, query);
    if (paged && query) {
      if (!reuseMessages) await messageSearch.load(query, searchConversation);
      if (!current()) return;
      const state = messageSearch.state;
      if (state.error && searchTab === 'messages' && !state.hits.length) {
        empty.hidden = false;
        empty.textContent = state.error;
        applySearchMore(document.getElementById('search-more'), {cursor: '', loading: false});
        return;
      }
      if (state.warning) {
        note.hidden = false;
        note.textContent = state.warning;
      }
      messageItems = state.hits;
    }
    let searchable = sources?.sections || [];
    if (sources && !sources.sections) {
      if (searchTab === 'all') {
        void sources.results.then(() => {
          if (current()) void renderSearch({reuseMessages:true});
        });
      } else {
        note.hidden = false;
        note.textContent = uiLabel('正在搜索…','Searching…');
        searchable = await sources.results;
        if (!current()) return;
        note.hidden = Boolean(query);
        note.textContent = uiLabel('搜索当前工作区。','Searching the current workspace.');
      }
    }
    if (!current()) return;
    const failedSources = searchable.filter(source => source.failed).map(source => source.title);
    if (failedSources.length) {
      const warning = uiLabel('暂时无法搜索：','Search unavailable: ') + failedSources.join(' · ');
      note.textContent = note.hidden ? warning : [note.textContent, warning].filter(Boolean).join(' ');
      note.hidden = false;
    }

    const filtered = (items) => items.filter(item => matchesQuery(item, query));
    const sections = [];
    if (searchTab === 'all' || searchTab === 'agents') {
      sections.push(['智能体', filtered(agentItems())]);
    }
    if (searchTab === 'all' || searchTab === 'contacts') {
      sections.push(['联系人', filtered(contactItems())]);
    }
    if (searchTab === 'all' || searchTab === 'groups') {
      sections.push(['群组', filtered(groupItems())]);
    }
    if (searchTab === 'all' || searchTab === 'messages') {
      sections.push(['消息', messageItems]);
    }
    for (const {title, items} of searchable) sections.push([title, items]);

    let total = 0;
    for (const [title, items] of sections) {
      total += items.length;
      addSearchSection(results, title, items, async (item) => {
        closeSearchPanel();
        if (item.type === 'agent') {
          const first = sessions.find(row => row.source === 'agent' && row.agent_id === item.id);
          if (first) await openSessionTarget({source:'agent', cid:first.id, agent:item.id, title:first.title});
          else openEmptyAgentChat(item.id);
        } else if (item.type === 'social' || item.kind === 'social') {
          await openSessionTarget({source:'social', cid:item.conversationId || item.id, message:item.messageId,
            title:item.title || uiLabel('会话', 'conversation')});
        } else if (item.type === 'agent-message' || item.kind === 'agent') {
          const session = sessions.find(row => row.source === 'agent' && row.id === item.conversationId);
          const agentId = item.agentId || session?.agent_id;
          if (agentId) await openSessionTarget({source:'agent', cid:item.conversationId, agent:agentId,
            message:item.messageId, title:session?.title || item.title || uiLabel('会话', 'conversation')});
        } else if (item.type === 'contact') {
          openComposeDialog('contact');
          const box = document.querySelector(`#member-choices input[value="${item.id}"]`);
          if (box) box.checked = true;
        }
      });
    }
    if (!total) {
      empty.hidden = false;
      const directoryStatus = searchTab === 'contacts' ? membersStatus : '';
      if (directoryStatus === 'loading') empty.textContent = '正在加载…';
      else if (directoryStatus === 'failed') empty.textContent = '无法加载搜索范围。';
      else if (!query) empty.textContent = '当前工作区里还没有可列出的内容。';
      else if (failedSources.length || (paged && messageSearch.state.warning)) empty.textContent = '可搜索的内容里没有匹配结果。';
      else empty.textContent = '当前工作区里没有匹配的结果。';
    }
    if (paged && query && messageSearch.state.error) {
      empty.hidden = false;
      empty.textContent = messageSearch.state.error;
    }
    applySearchMore(
      document.getElementById('search-more'),
      paged && query ? messageSearch.state : {cursor: '', loading: false},
    );
  }

  let launchAttempt = null;

  function publicStartError(intent, message, retry) {
    show('error', message);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'public-agent-retry';
      button.className = 'public-agent-action';
      button.textContent = '重试';
      button.addEventListener('click', retry);
      status.append(button);
    }
    const link = document.createElement('a');
    link.href = '/a/' + intent.slug;
    link.className = 'public-agent-action';
    link.textContent = '返回公开主页';
    status.append(link);
  }

  async function startPublicConversation(intent) {
    const continuation = publicAgentContinuation(intent);
    const owner = currentUser?.id;
    if (!owner || !continuation || publicAgentContinuation(publicAgentIntentFromHash(location.hash)) !== continuation) return;
    const scope = owner + continuation;
    if (launchAttempt?.scope === scope && launchAttempt.busy) return;
    const opening = intent.draft && publicAgentOpening(document.defaultView, intent);
    if (intent.draft && !opening) {
      publicStartError(intent, '找不到首页草稿或草稿已过期，请返回公开主页。');
      return;
    }
    const quick = intent.quickStart !== undefined;
    const attempt = {scope, busy: true};
    launchAttempt = attempt;
    let completed = false;
    const retry = () => startPublicConversation(intent);
    const active = () => launchAttempt === attempt && currentUser?.id === owner
      && publicAgentContinuation(publicAgentIntentFromHash(location.hash)) === continuation;
    const previousOpen = socialOpen;
    show('loading', quick ? '正在准备快捷开场…' : '正在打开公开智能体…');
    try {
      const payload = opening ? {listing_id: opening.listingId}
        : quick ? {quick_start: intent.quickStart, quick_start_version: intent.version} : {};
      const result = await request('POST', '/v1/discover/agents/' + intent.slug + '/start', payload);
      if (!active() || socialOpen !== previousOpen) return;
      const {workspace_id, conversation_id, draft_text} = result.body || {};
      if (![200, 201].includes(result.status) || !/^[A-Za-z0-9._-]{1,80}$/.test(conversation_id || '')
          || !workspaces.some(space => space.id === workspace_id) || (quick && (typeof draft_text !== 'string' || !draft_text.trim() || draft_text.length > 80))) {
        const canRetry = result.status === 429 || result.status >= 500 || result.status === 0;
        publicStartError(intent, messageFor(result.body?.error, '无法打开公开智能体。'), canRetry ? retry : null);
        return;
      }
      workspaceSelect.value = workspace_id;
      if (await openSocialConversation(conversation_id, {acknowledge: false, publicStartCurrent: active})) {
        completed = true;
        const current = launchAttempt === attempt && currentUser?.id === owner && currentSource === 'social'
          && currentConversation?.id === conversation_id && workspaceId() === workspace_id;
        if (!current) return;
        if (opening) {
          const available = publicAgentOpening(document.defaultView, intent);
          const filled = available?.listingId === opening.listingId && publicDraft.fillOpening(available.text);
          if (filled) {
            consumePublicAgentOpening(document.defaultView, intent);
            if (filled === 'filled') show('ok', '首页草稿已填入输入框，可编辑后发送。', {announceOnly: true});
            else show('', '');
          } else {
            publicStartError(intent, '无法恢复首页草稿，请返回公开主页。');
          }
        } else if (quick && publicDraft.fill(draft_text)) {
          show('ok', '开场已填入输入框，可编辑后发送。', {announceOnly: true});
        } else {
          show('', '');
        }
        void loadSessions();
      } else if (active()) {
        publicStartError(intent, '暂时无法加载对话。', retry);
      }
    } catch {
      if (active()) publicStartError(intent, '连接中断，请重试。', retry);
    } finally {
      attempt.busy = false;
      if (completed && launchAttempt === attempt) launchAttempt = null;
    }
  }

  async function openLinkedConversation(start, loadCurrent, parallelDirectory, nativeDirectory, startupSnapshot) {
    const owner = currentUser;
    const workspace = workspaceId();
    const link = {current: () => startupLink === link && link.open === socialOpen
      && currentUser === owner && workspaceId() === workspace && loadCurrent()};
    startupLink = link;
    show('loading', '正在打开对话…');
    const message = start.social
      ? (chatPathId(start.message) ? start.message : '')
      : (PRIVATE_THREAD_ID.test(start.message) ? start.message : '');
    const directMessage = servedByDsbot ? message : '';
    const position = !start.message && !start.directAccess && readingPositions.get(start.social
      ? readingPositionKey('social', workspace, start.social)
      : readingPositionKey('agent', workspace, start.conversation, start.agent));
    const opened = start.social
      ? openSocialConversation(start.social, {
        acknowledge: !start.message, startUnread: !start.message, link, position, message: directMessage,
      })
      : openAgentConversation(start.agent, start.conversation, {
        acknowledge: !message, link, startupSnapshot, position, message: directMessage,
      });
    link.open = socialOpen;
    if (parallelDirectory) link.directory = loadSessions(link, {nativeDirectory});
    try {
      if (!await opened || !link.current()) return;
      if (message) {
        const openingHistory = privateHistory;
        const latestReply = lastAgentItems.at(-1);
        const latestUser = lastAgentItems.at(-2);
        const followsReply = !start.social && openingHistory?.readingHistory && !openingHistory.after &&
          latestUser?.role === 'user' && latestUser.id === message && latestReply && waitingAgentReply(latestReply);
        const moved = await jumpToMessage(message, null, link.current, {readWindow: !directMessage});
        if (!link.current()) return;
        if (!moved) {
          show('error', '找不到这条来源消息。');
          return;
        }
        // A receipt for the latest send already opens the live window.
        if (followsReply && privateHistory === openingHistory) {
          privateHistory.readingHistory = false;
          updateHistoryControls();
          if (!syncReplyProgress()) schedulePoll();
        }
      }
      const requestedAgent = start.directAccess;
      const available = !requestedAgent || agentMentions.prepareDirectLink(requestedAgent);
      writeHash(start.social ? {workspace: message && !start.workspace ? '' : workspace, social:start.social, message}
        : {workspace, agent:start.agent, conversation:start.conversation, message});
      if (available) show('', '');
      else show('error',uiLabel('这个智能体已无法在此聊天中调用。','This agent is no longer available in this chat.'));
    } finally {
      if (startupLink === link) startupLink = null;
    }
  }

  let loadRequest = 0;

  function fillChatWorkspaces(items, preferred, personal) {
    workspaces = items;
    workspaceSelect.replaceChildren();
    for (const space of items) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.append(option);
    }
    workspaceSelect.value = (items.find(space => space.id === preferred)
      || items.find(space => space.id === personal) || items[0])?.id || '';
    workspaceInvite.sync();
  }

  function setPersonalChat(personal) {
    personalWorkspaceId = personal?.workspace?.id || '';
    personalAgentId = personal?.agent?.id || '';
    personalLook = personal ? chatSettings?.look || personal.look || null : null;
  }

  function loadChatSettings(owner) {
    if (chatSettings?.owner === owner) return;
    sendShortcut = 'enter';
    chatLanguage = 'auto';
    chatPreferences = defaultChatPreferences;
    const settings = {owner, ready:false, look:null};
    chatSettings = settings;
    settings.promise = request('GET', '/v1/settings', undefined, undefined, AbortSignal.timeout(1800))
      .catch(() => null).then(result => {
        if (chatSettings !== settings || currentUser?.id !== owner) return;
        settings.ready = true;
        const values = result?.status === 200 ? result.body?.settings?.values : null;
        if (values) {
          chatPreferences = values;
          sendShortcut = values.send_shortcut === 'mod_enter' ? 'mod_enter' : 'enter';
          chatLanguage = typeof values.chat_language === 'string' ? values.chat_language : 'auto';
        }
        starterComposer.dataset.sendShortcut = sendShortcut;
        settings.look = result?.status === 200 ? result.body?.personal_look : null;
        if (settings.look && personalAgentId) {
          personalLook = settings.look;
          renderSessions();
          if (currentSource === 'agent' && currentAgent?.id === personalAgentId) {
            applyChatIdentity(document, currentAgent.name, null, agentPortraitLook(currentAgent.id, currentAgent.portrait, personalLook));
          }
        }
        const presentationChanged = values && (values.auto_translate === true
          || Object.keys(defaultChatPreferences).some(key => values[key] !== undefined && values[key] !== defaultChatPreferences[key]));
        if (presentationChanged && currentConversation && !openingStartupLink() && !readingPrivateContext() && !readingSocialContext()) {
          if (currentSource === 'social') renderSocialMessages(lastSocialItems, {refresh:true});
          else renderAgentMessages(lastAgentItems, {followLatest:false});
        }
      });
  }

  async function load() {
    const sequence = ++loadRequest;
    const hash = location.hash;
    const pathname = location.pathname;
    const banner = document.getElementById('onboarding-banner');
    const start = {...chatStartFromHash(hash), directAccess:directAgentAccessFromHash(hash)};
    const publicIntent = publicAgentIntentFromHash(hash);
    let navigation = socialOpen;
    const loadCurrent = () => sequence === loadRequest && location.hash === hash && location.pathname === pathname;
    const bootCurrent = () => loadCurrent() && socialOpen === navigation;
    const read = (path, signal) => request('GET', path, undefined, undefined, signal).catch(() => ({status: 0, body: {}}));
    const {sessionRequest, localRequest, sharedRequest: preparedDirectory, desktopTranscript} = takeChatReads(document)
      || startChatReads(read, start, servedByDsbot && !publicIntent);
    const session = await sessionRequest;
    if (!bootCurrent()) return;
    const view = document.defaultView ?? globalThis;
    const firstDraft = servedByDsbot && signupDraftScope(view, session.body?.user?.id);
    const unconfirmedSignup = !confirmSignupSession(view, session);
    if (session.status !== 200 || !session.body?.user?.id || unconfirmedSignup) {
      if (banner) banner.hidden = true;
      currentUser = null;
      readingPositions.clear();
      chatSettings = null;
      clearSessionTransition();
      currentAgent = null;
      renderAgentQuickStarts();
      resetNotifications();
      workspaceEvents?.start(null);
      autoTranslation.open(null);
      attachmentSender?.reset();
      clearPendingSends();
      memoryDrafts.clear();
      memoryWrites.clear();
      replyDrafts.clear();
      agentMentions.clear();
      clearComposerDrafts();
      renderReplyDraft();
      currentConversation = null;
      chatCalls.sync();
      socialOpen += 1;
      setSocialHistory(null);
      setPrivateHistory(null);
      voiceRecorder.refresh();
      clearVoicePlayers();
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      document.getElementById('session-pane').hidden = true;
      document.body.classList.remove('chat-open');
      setSessionsOpen(false);
      show(unconfirmedSignup ? 'error' : '', unconfirmedSignup ? signupSessionError : '');
      return;
    }
    if (currentUser && currentUser.id !== session.body.user.id) {
      readingPositions.clear();
      clearSessionTransition();
      currentAgent = null;
      currentConversation = null;
      socialOpen += 1;
      navigation = socialOpen;
      setPrivateHistory(null);
      renderAgentQuickStarts();
      resetNotifications();
      attachmentSender?.reset();
      clearPendingSends();
      memoryDrafts.clear();
      memoryWrites.clear();
      replyDrafts.clear();
      agentMentions.clear();
      clearComposerDrafts();
      renderReplyDraft();
    }
    const owner = session.body.user;
    if (currentUser?.id !== owner.id && banner) banner.hidden = true;
    currentUser = owner;
    loadChatSettings(owner.id);
    if (banner) void request('GET', '/v1/onboarding').then(onboarding => {
      if (sequence !== loadRequest || currentUser !== owner || location.pathname !== pathname || onboarding.status !== 200) return;
      banner.hidden = Boolean(onboarding.body.progress?.completed ?? onboarding.body.onboarding?.completed);
    }).catch(() => {});
    if (publicIntent) show('loading', publicIntent.quickStart === undefined ? '正在打开公开智能体…' : '正在准备快捷开场…');
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    if (servedByDsbot && meetingCodeFromHash(hash)) await chatCalls.resumeMeeting();
    document.getElementById('session-pane').hidden = false;
    document.body.classList.add('chat-open');
    setSessionsOpen(true);
    document.getElementById('whoami').textContent = currentUser.username;
    if (!sessions.length) setSessionsStatus('正在加载对话…');
    const listWorkspaces = () => read('/v1/workspaces?limit=100');
    const sharedRequest = servedByDsbot
      ? preparedDirectory?.then(result => result.status === 200 && Array.isArray(result.body?.items)
        ? result : listWorkspaces()) || listWorkspaces()
      : null;
    const localReady = Promise.resolve(localRequest).then(result => ownedChatStartup(result, owner));
    let personalRequest;
    const readPersonal = () => personalRequest ??= read('/v1/workspaces?scope=personal&include=personal-agent').then(result => {
      const identity = ownedChatStartup(result, owner);
      return identity ? {workspace: identity.space, agent: {id: identity.agentId}, look: result.body.personal_look ?? null} : null;
    });
    const socialTarget = start.social && chatPathId(start.social);
    const exactTarget = start.social ? socialTarget : chatPathId(start.agent) && chatPathId(start.conversation);
    const workspaceOnly = !start.social && !start.agent && !start.conversation;
    const validWorkspace = /^[0-9a-f]{32}$/.test(start.workspace);
    const inboxEntry = workspaceOnly && (!start.workspace || validWorkspace);
    const scopedEntry = sharedRequest && !publicIntent && (inboxEntry || (validWorkspace && exactTarget));
    // The signed workspace list authorizes scoped entries while the personal snapshot is pending.
    const {local, shared, personalSpace} = scopedEntry ? await Promise.any([
      localReady.then(async local => {
        if (!local && bootCurrent()) await readPersonal();
        return {local};
      }),
      sharedRequest.then(shared => {
        const items = shared.status === 200 && Array.isArray(shared.body?.items) ? shared.body.items : [];
        const personalSpace = items.find(space => space.kind === 'personal' && (!space.owner_id || space.owner_id === owner.id));
        const target = start.workspace ? items.find(space => space.id === start.workspace) : personalSpace;
        const authorized = target && (['team', 'workspace'].includes(target.kind) ||
          ((socialTarget || inboxEntry) && target === personalSpace));
        return personalSpace && authorized ? {shared, personalSpace} : Promise.reject();
      }),
    ]).catch(() => ({})) : {local: await localReady};
    if (!bootCurrent()) return;

    const openLocal = local && (!start.workspace || start.workspace === local.space.id);
    let personalEntity = local ? {workspace: local.space, agent: {id: local.agentId}} : null;
    let listed;
    if (shared) {
      listed = shared;
      personalEntity = {workspace: personalSpace};
      void localReady.then(async local => {
        if (sequence !== loadRequest || currentUser !== owner || location.pathname !== pathname) return;
        const personal = local ? {workspace: local.space, agent: {id: local.agentId}} : await readPersonal();
        if (sequence !== loadRequest || currentUser !== owner || location.pathname !== pathname ||
            personal?.workspace?.id !== personalSpace.id || !personal.agent?.id) return;
        setPersonalChat(personal);
        if (workspaceId() === personalWorkspaceId) {
          renderSessions();
          if (currentSource === 'agent' && currentAgent?.id === personalAgentId) {
            applyChatIdentity(document, currentAgent.name, null, agentPortraitLook(currentAgent.id, currentAgent.portrait, personalLook));
          }
        }
      });
    } else if (openLocal) {
      listed = {status: 200, body: {items: [local.space]}};
    } else if (local) {
      listed = await sharedRequest;
    } else {
      if (servedByDsbot) {
        personalEntity = await readPersonal();
        if (personalEntity?.agent?.id && personalEntity.workspace?.id) {
          listed = await sharedRequest;
          if (listed.status !== 200 || !listed.body?.items?.some(space => space.id === personalEntity.workspace.id)) listed = null;
        }
      }
      if (!bootCurrent()) return;
      if (!listed) {
        // A first-time account can receive a new workspace during initialization.
        const personal = await request('POST', '/v1/personal-agent').catch(() => ({status: 0, body: {}}));
        personalEntity = [200, 201].includes(personal.status) ? personal.body.personal_agent : null;
        listed = await listWorkspaces();
      }
    }
    if (!bootCurrent()) return;
    const personalWorkspace = personalEntity?.workspace?.id || '';
    setPersonalChat(personalEntity);
    if (listed.status !== 200 || (publicIntent && !listed.body.items?.length)) {
      setSessionsStatus('无法加载工作区，请重试。');
      if (publicIntent && publicAgentContinuation(publicAgentIntentFromHash(location.hash)) === publicAgentContinuation(publicIntent)) {
        publicStartError(publicIntent, '暂时无法加载工作区。', () => void load());
      }
      return;
    }
    const hasLink = start.social || (start.agent && start.conversation);
    const wanted = start.workspace || personalWorkspace || workspaceSelect.value;
    fillChatWorkspaces(listed.body.items || [], wanted, personalWorkspace);
    if (openLocal) void sharedRequest.then(shared => {
      if (shared.status !== 200 || sequence !== loadRequest || currentUser !== owner || location.pathname !== pathname) return;
      const sharedItems = shared.body.items || [];
      const choices = sharedItems.some(space => space.id === personalWorkspace) ? sharedItems : [local.space, ...sharedItems];
      fillChatWorkspaces(choices, workspaceId(), personalWorkspace);
    });
    if (!workspaces.length) {
      setSessionsStatus('');
      document.getElementById('conversations-empty').hidden = false;
      document.getElementById('chat-empty').hidden = false;
      if (hasLink && start.workspace) show('error', '无法访问此会话所在的工作区。');
      else show('', '');
      return;
    }
    if (publicIntent) {
      await startPublicConversation(publicIntent);
      return;
    }
    if (hasLink && start.workspace && workspaceId() !== start.workspace) {
      show('error', '无法访问此会话所在的工作区。');
      void loadSessions();
      return;
    }
    if (hasLink && !(start.social ? chatPathId(start.social) : chatPathId(start.agent) && chatPathId(start.conversation))) {
      show('error', '此对话链接无效。');
      void loadSessions();
      return;
    }
    const portableSocialLink = !start.workspace && (start.directAccess || socialMessageFromHash(hash));
    if (portableSocialLink && (!personalWorkspace || workspaceId() !== personalWorkspace)) {
      show('error', '无法打开此消息所在的会话。');
      void loadSessions();
      return;
    }
    if (hasLink && (start.workspace || portableSocialLink)) {
      const snapshot = openLocal && !start.social ? ownedStartingTranscript(local, start.agent, start.conversation) : undefined;
      await openLinkedConversation(start, loadCurrent, true, openLocal ? local.directory : null, snapshot);
      return;
    }
    const openStartingAgent = async () => {
      const emptyScope = JSON.stringify([owner.id, workspaceId(), 'agent', start.agent, null]);
      if (servedByDsbot && readPendingChatText(view, emptyScope).length) {
        openEmptyAgentChat(start.agent);
        return;
      }
      const personalRoute = start.workspace === personalWorkspace && workspaceId() === personalWorkspace && start.agent === personalAgentId;
      const personalTarget = servedByDsbot && personalRoute && personalDraftScope(view, owner.id, {
        workspace_id: personalWorkspace, agent_id: personalAgentId,
      });
      const coldDraft = takeColdDraftHandoff(view, personalTarget);
      const first = sessions.find(row => row.source === 'agent' && row.agent_id === start.agent);
      if (first) {
        const incomingDraft = coldDraft || firstDraft;
        if (incomingDraft && personalRoute) {
          const threadDraft = JSON.stringify([owner.id, personalWorkspace, 'agent', personalAgentId, first.id]);
          if (publicDraft.lookup(incomingDraft) && publicDraft.lookup(threadDraft)) {
            openEmptyAgentChat(start.agent);
            return;
          }
          publicDraft.move(incomingDraft, threadDraft);
        }
        const startupSnapshot = openLocal ? ownedStartingTranscript(local, start.agent, first.id) : undefined;
        await openAgentConversation(start.agent, first.id, {startupSnapshot});
      }
      else openEmptyAgentChat(start.agent);
    };
    let openingAgent;
    let firstSnapshot;
    // A partial inbox can be used immediately, while the same native request
    // still supplies private sessions and the final default session order.
    const pendingNativeDirectory = shared && inboxEntry && workspaceId() === personalWorkspace
      ? localReady.then(local => local?.space.id === personalWorkspace ? local.directory : null) : null;
    if (pendingNativeDirectory) {
      const opening = {owner, workspace: personalWorkspace, read: pendingNativeDirectory};
      startingInboxDirectory = opening;
      void pendingNativeDirectory.then(() => {
        if (startingInboxDirectory === opening) startingInboxDirectory = null;
      });
    }
    const snapshotOnStartup = (openLocal && local.directory || pendingNativeDirectory) && !hash && !narrowScreen();
    await loadSessions(undefined, {
      nativeDirectory: openLocal ? local.directory : null,
      pendingNativeDirectory,
      onPrivate: !hasLink && (start.agent || snapshotOnStartup) ? (recent, socialReady) => {
        if (!bootCurrent()) return;
        if (start.agent) {
          openingAgent = openStartingAgent();
        } else if (recent && (!socialReady || sessions[0] === recent)) {
          firstSnapshot = {row: recent, read: readStartupSnapshot(workspaceId(), recent.agent_id, recent.id, desktopTranscript)};
        }
      } : null,
    });
    if (openingAgent) {
      await openingAgent;
      return;
    }
    if (!bootCurrent()) return;
    if (hasLink) {
      await openLinkedConversation(start, loadCurrent, false);
      return;
    }
    if (start.agent) {
      await openStartingAgent();
    } else if (sessions.length && !narrowScreen()) {
      const first = sessions[0];
      if (first.source === 'social') {
        if (!await openSocialConversation(first.id, {startUnread: first.unread_count > 0 && first.kind !== 'public'})) return;
      } else {
        const startupSnapshot = firstSnapshot?.row.id === first.id && firstSnapshot.row.agent_id === first.agent_id
          ? firstSnapshot.read : undefined;
        if (!await openAgentConversation(first.agent_id, first.id, {startupSnapshot})) return;
      }
    }
    show('', '');
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    await load();
  });

  function selectedTranscript() {
    const people = currentConversation?.members || [];
    return lastSocialItems.filter(item => selectedMessages.has(item.id) && !item.retracted).map(item => {
      const author = item.agent_name || people.find(person => person.user_id === item.user_id)?.username || '成员';
      const body = item.body?.trim() || item.attachment?.title || (item.voice ? '语音消息' : '');
      return body ? `${author}：${body}` : '';
    }).filter(Boolean).join('\n\n');
  }

  document.getElementById('selection-meeting')?.addEventListener('click', () => {
    const transcript = selectedTranscript(), workspace = workspaceId();
    if (!workspace || !currentUser || !transcript) return;
    if (transcript.length > 40000) {
      show('error', '所选消息超过会议正文上限，请减少选择。');
      return;
    }
    const title = (conversationLabel(currentConversation, currentUser.id) + ' · 会议纪要').slice(0, 120);
    try {
      const href = stageMeetingFromChat(document.defaultView.sessionStorage, {owner:currentUser.id, workspace, transcript, title});
      document.defaultView.location.assign(href);
    } catch {
      show('error', '无法打开会议草稿，请重试。');
    }
  });

  const groupCaptureDialog = document.getElementById('group-capture-dialog');
  const groupCaptureStatus = document.getElementById('group-capture-status');
  const groupCaptureSubmit = document.getElementById('group-capture-submit');
  const groupCaptureInbox = document.getElementById('group-capture-inbox');
  let groupCapture = null;
  document.getElementById('selection-group-capture')?.addEventListener('click', () => {
    if (currentSource !== 'social' || currentConversation?.kind !== 'group' || currentConversation.public_agent) return;
    const matching = lastSocialItems.filter(item => selectedMessages.has(item.id));
    if (!matching.length || matching.length !== selectedMessages.size || matching.length > 12
        || matching.some(item => item.role === 'agent' || item.retracted || item.voice || item.attachment || !item.body?.trim())) {
      show('error','请选择当前记录中 1 到 12 条群成员发出的文字消息。');
      return;
    }
    const workspace = workspaceId();
    groupCapture = {scope:sendScope(), ids:matching.map(item => item.id),
      path:`${socialBase()}/${currentConversation.id}/memory/capture`,busy:false};
    groupCaptureStatus.textContent = '';
    groupCaptureSubmit.disabled = false;
    groupCaptureInbox.hidden = true;
    groupCaptureInbox.href = '/memory?' + new URLSearchParams({workspace,page:'candidates'});
    document.getElementById('group-capture-review').textContent =
      `已选 ${matching.length} 条群聊文字消息，将由你的 DS-Bot 在后台生成待核对建议。`;
    groupCaptureDialog.showModal();
  });
  document.getElementById('group-capture-close')?.addEventListener('click', () => groupCaptureDialog.close());
  groupCaptureDialog?.addEventListener('close', () => {groupCapture = null;});
  document.getElementById('group-capture-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = groupCapture;
    if (!draft || draft.busy || sendScope() !== draft.scope) return;
    draft.busy = groupCaptureSubmit.disabled = true;
    groupCaptureStatus.textContent = '正在核对群聊消息…';
    let done = false;
    try {
      const result = await request('POST',draft.path,{message_ids:draft.ids});
      if (groupCapture !== draft || sendScope() !== draft.scope) return;
      if (result.status !== 202) {
        groupCaptureStatus.textContent = messageFor(result.body.error,'无法提炼所选消息，请重试。');
        return;
      }
      const {queued,skipped,full} = result.body;
      groupCaptureStatus.textContent = [
        queued ? `${queued} 条已加入后台提炼。` : '',
        skipped ? `${skipped} 条已有处理记录。` : '',
        full ? `队列已满，${full} 条可稍后重试。` : '',
      ].filter(Boolean).join(' ');
      groupCaptureInbox.hidden = !(queued || skipped);
      done = !full;
      if (done) setSelecting(false);
    } catch {
      if (groupCapture === draft) groupCaptureStatus.textContent = '无法提炼所选消息，请重试。';
    } finally {
      if (groupCapture === draft) { draft.busy = false; groupCaptureSubmit.disabled = done; }
    }
  });

  const memoryDialog = document.getElementById('selection-memory-dialog');
  const memoryForm = document.getElementById('selection-memory-form');
  const memoryError = document.getElementById('selection-memory-error');
  let memoryDraft = null;
  const openMemory = document.getElementById('selection-memory');
  openMemory?.addEventListener('click', () => {
    const transcript = selectedTranscript();
    if (!transcript || !currentUser || !workspaceId()) return;
    if (transcript.length > 8000) {
      show('error', '所选消息超过记忆正文上限，请减少选择。');
      return;
    }
    memoryDraft = {owner:currentUser.id, workspace:workspaceId(), scope:sendScope(), attempt:null, pending:false};
    memoryForm.elements.title.value = (conversationLabel(currentConversation, currentUser.id) + ' · 聊天记录').slice(0, 80);
    memoryForm.elements.body.value = transcript;
    memoryError.textContent = '';
    memoryDialog.showModal();
    memoryForm.elements.title.focus();
  });
  memoryDialog?.addEventListener('close', () => {memoryDraft = null;});
  document.getElementById('selection-memory-cancel')?.addEventListener('click', () => memoryDialog.close());
  memoryForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = memoryDraft;
    if (!draft || draft.pending || draft.owner !== currentUser?.id || draft.workspace !== workspaceId()) return;
    const payload = {title:memoryForm.elements.title.value.trim(), body:memoryForm.elements.body.value};
    const signature = JSON.stringify(payload);
    if (draft.attempt?.signature !== signature) draft.attempt = {signature, key:idempotencyKey('chat-memory-')};
    const submit = document.getElementById('selection-memory-submit');
    draft.pending = submit.disabled = true;
    memoryError.textContent = '';
    try {
      const result = await request('POST', `/v1/workspaces/${draft.workspace}/memory`, payload, {'Idempotency-Key':draft.attempt.key});
      if (draft !== memoryDraft || draft.owner !== currentUser?.id) return;
      const page = result.body.page;
      if (![200, 201].includes(result.status) || !page?.id) {
        memoryError.textContent = messageFor(result.body.error, '保存失败，请重试。');
        return;
      }
      memoryDialog.close();
      if (sendScope() === draft.scope) setSelecting(false);
      show('ok', '已保存到记忆。');
      const link = document.createElement('a');
      link.href = '/memory?' + new URLSearchParams({workspace:draft.workspace, page:page.id});
      link.textContent = '打开记忆';
      status.append(document.createTextNode(' '), link);
    } catch {
      if (draft === memoryDraft) memoryError.textContent = '无法确认保存结果，请重试。';
    } finally {
      draft.pending = submit.disabled = false;
    }
  });

  const multiToggle = document.getElementById('multi-select-toggle');
  if (multiToggle) multiToggle.addEventListener('click', () => setSelecting(!selecting));
  const forwardCancel = document.getElementById('forward-cancel');
  if (forwardCancel) forwardCancel.addEventListener('click', () => {
    setSelecting(false);
    (narrowScreen() ? document.getElementById('chat-more') : multiToggle)?.focus({preventScroll: true});
  });
  document.getElementById('message-selection-more')?.addEventListener('click', event => {
    if (event.target.closest('button')) event.currentTarget.open = false;
  });
  const hideCancel = document.getElementById('message-selection-hide-cancel');
  document.getElementById('selection-hide')?.addEventListener('click', () => {
    const scope = sendScope(), ids = selectedSocialIds();
    if (!servedByDsbot || !selecting || currentSource !== 'social' || !currentConversation || currentConversation.public_agent ||
        !ids.length || hidingMessages.has(scope) || forwarding.has(scope) || hideDialog.open) return;
    hideTarget = {scope, ids, epoch: selectionEpoch, path: `${socialBase()}/${currentConversation.id}/messages/hide`};
    document.getElementById('message-selection-hide-heading').textContent =
      uiLabel(`从我的记录移除 ${ids.length} 条消息`, `Remove ${ids.length} ${ids.length === 1 ? 'message' : 'messages'} from my history`);
    hideStatus.textContent = '';
    hideConfirm.disabled = false;
    hideDialog.showModal();
    hideCancel.focus();
  });
  hideCancel?.addEventListener('click', () => hideDialog.close());
  hideDialog?.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
  hideDialog?.addEventListener('close', () => { if (!hideDialog.open) hideTarget = null; });
  document.getElementById('message-selection-hide-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const target = hideTarget;
    if (!target || !hideDialog.open || hideConfirm.disabled || target.scope !== sendScope() || !selecting ||
        target.epoch !== selectionEpoch || hidingMessages.has(target.scope)) return;
    hidingMessages.add(target.scope);
    syncForwardBar();
    hideConfirm.disabled = true;
    hideStatus.textContent = uiLabel('正在移除…', 'Removing messages…');
    let result;
    try { result = await request('POST', target.path, {message_ids: target.ids}, undefined, AbortSignal.timeout(10000)); }
    catch {} finally {
      hidingMessages.delete(target.scope);
      syncForwardBar();
    }
    const sameView = hideDialog.open && hideTarget === target;
    const hidden = result?.body?.hidden_message_ids;
    if (result?.status !== 200 || !Array.isArray(hidden) || hidden.length !== target.ids.length || target.ids.some(id => !hidden.includes(id))) {
      if (sameView && target.scope === sendScope()) {
        hideStatus.textContent = result?.status === 404 ? uiLabel('所选消息有变化，请关闭后重新选择。', 'Your selection changed. Close this dialog and select again.')
          : uiLabel('暂时无法确认移除结果，可以重试。', 'Could not confirm the removal. You can try again.');
        hideConfirm.disabled = result?.status === 404;
      }
      return;
    }
    rememberHiddenMessages(target.scope, target.ids);
    if (target.scope !== sendScope()) return;
    if (sameView) hideDialog.close();
    forgetSocialMessages(target.ids, target.epoch === selectionEpoch);
    show('ok', uiLabel(`已从你的记录移除 ${target.ids.length} 条消息。`, `Removed ${target.ids.length} from your history.`), {announceOnly:true});
    if (sameView && !sessionTransition?.pending) document.getElementById('chat-title')?.focus({preventScroll:true});
    void loadSessions();
  });
  const forwardTarget = document.getElementById('forward-target');
  if (forwardTarget) forwardTarget.addEventListener('change', syncForwardBar);
  const forwardSubmit = document.getElementById('forward-submit');
  if (forwardSubmit) forwardSubmit.addEventListener('click', async () => {
    const cid = currentConversation && currentConversation.id, target = forwardTarget.value;
    const ids = selectedSocialIds();
    const scope = sendScope();
    if (!selecting || !cid || !target || !ids.length || forwarding.has(scope) || hidingMessages.has(scope)) return;
    const epoch = selectionEpoch;
    const signature = forwardSignature(scope, target, ids);
    const key = uncertainForwards.get(signature) || idempotencyKey('forward-');
    const pending = {count:ids.length};
    forwarding.set(scope, pending);
    forwardNotice = null;
    syncForwardBar();
    const result = await request('POST', `${socialBase()}/${cid}/forward`,
      {message_ids: ids, target_conversation_id: target}, {'Idempotency-Key':key}, AbortSignal.timeout(15000))
      .catch(() => ({status:0, body:{}}));
    if (forwarding.get(scope) !== pending) return;
    forwarding.delete(scope);
    const saved = [200, 201].includes(result.status) && (!servedByDsbot ||
      (result.body?.target_conversation_id === target && result.body?.forwarded === ids.length));
    const uncertain = !saved && unclearSocialDelivery(result.status);
    uncertainForwards.delete(signature);
    if (uncertain) {
      uncertainForwards.set(signature, key);
      if (uncertainForwards.size > 64) uncertainForwards.delete(uncertainForwards.keys().next().value);
    }
    if (scope === sendScope()) {
      if (saved) {
        if (epoch === selectionEpoch && signature === forwardSignature(scope, forwardTarget.value, selectedMessages)) setSelecting(false);
        show('ok', uiLabel(`已转发 ${ids.length} 条消息。`, `Forwarded ${ids.length} ${ids.length === 1 ? 'message' : 'messages'}.`));
        void loadSessions().catch(() => {});
      } else {
        const fallback = uncertain ? uiLabel('未能确认转发结果，可以重试。', 'Could not confirm forwarding. You can retry.')
          : uiLabel('转发失败，请重试。', 'Could not forward the messages. Try again.');
        forwardNotice = {signature, epoch, message:messageFor(result.body?.error, fallback)};
      }
    }
    syncForwardBar();
  });
  notificationKind?.addEventListener('change', () => {
    if (notificationSnapshot) renderNotifications(notificationSnapshot.body, notificationSnapshot.scope);
  });
  notificationUnread?.addEventListener('change', () => loadNotifications({interactive: true}));
  const notificationsToggle = document.getElementById('notifications-toggle');
  if (notificationsToggle) notificationsToggle.addEventListener('click', async () => {
    const panel = document.getElementById('notifications-panel');
    const open = Boolean(panel && panel.hidden);
    setNotificationsOpen(open);
    if (open) await loadNotifications({interactive: true});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !document.getElementById('notifications-panel')?.hidden) {
      void loadNotifications();
    }
  });
  globalThis.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    void loadNotifications();
    if (!refreshForegroundPrivate()) void refreshAgentQuickStarts();
  });
  const readAll = document.getElementById('notifications-read-all');
  if (readAll) readAll.addEventListener('click', async () => {
    const scope = notificationScope();
    if (!scope.owner || !scope.workspace || readAll.disabled) return;
    readAll.disabled = true;
    const result = await request('POST', `/v1/workspaces/${scope.workspace}/notifications/read`,
      {all: true}, undefined, AbortSignal.timeout(5000)).catch(() => ({status: 0, body: {}}));
    if (!currentNotificationScope(scope)) return;
    if (result.status !== 200) {
      setNotificationStatus('无法标记通知为已读。');
      readAll.disabled = false;
      return;
    }
    applyNotificationRead(scope, result);
    await loadNotifications();
  });
  function clearChatScope() {
    rememberReadingPosition();
    closePrivateThreadDialogs();
    if (messageLinkDialog?.open) messageLinkDialog.close();
    resetStickerSurface();
    clearSessionTransition();
    cancelStartupLink();
    stopReplyProgress();
    stopGroupReplyProgress();
    socialOpen += 1;
    setSocialHistory(null);
    setPrivateHistory(null);
    if (liveBanner) liveBanner.hidden = true;
    resetNotifications();
    agentMentions.clear();
    currentAgent = null;
    currentConversation = null;
    syncConversationPin(null);
    currentSource = 'agent';
    lastGroupInfo = '';
    groupManagement?.sync();
    renderAgentQuickStarts();
    publicDraft.enter(sendScope());
    syncCaptureButton();
    chatCalls.sync();
    voiceRecorder.refresh();
    clearVoicePlayers();
    stopPolling();
    closeSearchPanel();
    closeComposeDialog();
    closeInChatSearch({restoreScroll: false, focus: false});
    applyChatIdentity(document, '聊天');
    setSocialHeaderTools(false);
    renderReplyDraft();
    document.getElementById('message-list').replaceChildren();
    document.getElementById('chat-empty').hidden = false;
    renderPendingSend();
    setDirectoryLink({source: 'agent'});
    syncPlusState();
  }

  workspaceSelect.addEventListener('change', async () => {
    clearChatScope();
    // The selected conversation updates this workspace entry as usual.
    writeHash({workspace: workspaceId()}, {push: true});
    await loadSessions();
  });

  document.getElementById('session-search').addEventListener('focus', () => {
    if (!isSearchOpen()) openSearchPanel();
  });
  document.getElementById('session-search').addEventListener('input', () => {
    if (!isSearchOpen()) openSearchPanel();
    else renderSearch();
  });
  async function readConversationMessageMatches(query, conversationId, cursor, signal) {
    if (currentSource === 'social') {
      const params = new URLSearchParams({q: query, limit: '20'});
      if (cursor) params.set('before', cursor);
      const people = currentConversation?.members || members;
      const viewer = currentUser?.id;
      const result = await request('GET', `${socialBase()}/${conversationId}/messages?${params}`, undefined, undefined, signal);
      if (result.status !== 200) throw new Error('无法搜索当前会话。');
      return {
        items: (result.body.items || []).map(item => {
          const body = String(item.body || '');
          const index = body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
          const start = Math.max(0, index - 48);
          return {
            kind: 'social', conversation_id: conversationId, message_id: item.id, created: item.created,
            role: item.role === 'agent' ? 'assistant' : item.user_id && item.user_id === viewer ? 'user' : '',
            agent_name: item.agent_name,
            author: item.user_id && people.find(member => member.user_id === item.user_id)?.username,
            snippet: (start > 0 ? '…' : '') + body.slice(start, start + 160) + (body.length > start + 160 ? '…' : ''),
          };
        }),
        cursor: result.body.cursor,
      };
    }
    const result = await request('GET', `/v1/workspaces/${workspaceId()}/search/messages?${messageSearchQuery(query, conversationId, cursor)}`, undefined, undefined, signal);
    if (result.status !== 200) throw new Error('无法搜索当前会话。');
    return result.body;
  }
  async function jumpToMessage(messageId, notice = document.getElementById('conversation-search-status'),
    isCurrent = () => true, {signal, onLocated, attachmentPath, readWindow = true} = {}) {
    if (!isCurrent()) return false;
    const list = document.getElementById('message-list');
    const findTarget = () => Array.from(list.children || []).find(node => node.dataset.messageId === messageId);
    const findAnchor = target => attachmentPath && target
      ? Array.from(target.querySelectorAll('[data-chat-file-path]')).find(card => card.dataset.chatFilePath === attachmentPath)
      : target;
    let target = findTarget();
    let anchor = findAnchor(target);
    const jump = ++historyJump;
    const privateChat = currentSource === 'agent';
    const currentHistory = () => privateChat ? privateHistory : socialHistory;
    const state = currentHistory();
    if (readWindow && !anchor && state && (!privateChat || (/^[0-9a-f]{32}$/.test(messageId) && !state.restoring))) {
      if (privateChat) {
        state.jumping = jump;
        stopReplyProgress();
        stopPolling();
        updateHistoryControls();
      }
      try {
        const query = new URLSearchParams({around: messageId, limit: HISTORY_PAGE_SIZE});
        const result = await (privateChat ? privateHistoryPage(state, query, signal) : historyPage(state, query, signal));
        if (!result || jump !== historyJump || !isCurrent()) return false;
        if (result.status === 200 && result.body.items?.some(item => item.id === messageId)) {
          const window = {...state, cursor: result.body.cursor ?? null, readingHistory: true, loading: false};
          searchScrollSnapshot = null;
          if (privateChat) {
            const last = result.body.items.at(-1)?.id;
            const after = result.body.has_newer && PRIVATE_THREAD_ID.test(last || '') ? last : null;
            setPrivateHistory({...window, after, jumping: null});
            renderAgentMessages(result.body.items, {followLatest: false});
          } else {
            const unread = state.unread;
            const retained = unread && unread.committed < unread.latest
              ? {committed: unread.committed, latest: unread.latest, seen: new Set()} : null;
            const last = result.body.items.at(-1)?.seq;
            const after = result.body.has_newer && Number.isSafeInteger(last) && last > 0 ? last : null;
            setSocialHistory({...window, after, unread: retained});
            renderSocialMessages(result.body.items, {keepScroll: false});
          }
          target = findTarget();
          anchor = findAnchor(target);
          if (notice) notice.textContent = '';
        }
      } catch {
        if (currentHistory() !== state || jump !== historyJump || !isCurrent()) return false;
      } finally {
        if (privateChat && privateHistory === state && state.jumping === jump) {
          state.jumping = null;
          updateHistoryControls();
          if (!readingPrivateContext() && !syncReplyProgress() && lastAgentItems.some(waitingAgentReply)) schedulePoll();
        }
      }
    }
    if (jump !== historyJump || !isCurrent()) return false;
    if (!target) {
      if (notice) notice.textContent = '这条消息不在当前已加载的消息窗口里。';
      return false;
    }
    if (!anchor) {
      if (notice) notice.textContent = uiLabel('原消息中的附件已不可用。请刷新附件结果。', 'The attachment is unavailable. Refresh the attachment results.');
      return false;
    }
    onLocated?.(anchor);
    anchor.scrollIntoView?.({block: 'center', behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    anchor.tabIndex = -1; anchor.focus?.({preventScroll: true});
    for (const node of Array.from(list.children || [])) delete node.dataset.searchJump;
    for (const card of list.querySelectorAll('[data-attachment-jump]')) delete card.dataset.attachmentJump;
    target.dataset.searchJump = 'true';
    if (attachmentPath) anchor.dataset.attachmentJump = 'true';
    clearTimeout(searchHighlightTimer);
    searchHighlightTimer = setTimeout(() => {
      delete target.dataset.searchJump;
      delete anchor.dataset.attachmentJump;
    }, SEARCH_JUMP_HIGHLIGHT_MS);
    return true;
  }
  async function jumpToSearchHit(messageId, view, button, attachmentPath) {
    if (!currentSearchView(view) || view.jump?.button === button) return;
    const status = view.jump?.status ?? inChatStatus.textContent;
    view.jump?.controller.abort();
    const controller = new AbortController();
    const jump = {button, status, controller};
    view.jump = jump;
    button.setAttribute('aria-busy', 'true');
    inChatStatus.textContent = uiLabel('正在定位消息…', 'Finding the message…');
    try {
      const located = await jumpToMessage(messageId, inChatStatus,
        () => currentSearchView(view) && view.jump === jump, {
          signal: controller.signal,
          attachmentPath,
          onLocated(target) {
            searchScrollSnapshot = null;
            view.selected?.removeAttribute('aria-current');
            view.selected = button;
            button.setAttribute('aria-current', 'true');
            if (globalThis.matchMedia?.('(max-width: 900px)').matches) {
              closeInChatSearch({restoreScroll: false, focus: false, preserveResults: true});
            } else {
              searchJumpTarget = target;
            }
          },
        });
      if (located && currentSearchView(view) && view.jump === jump) inChatStatus.textContent = view.status || status;
    } finally {
      button.removeAttribute('aria-busy');
      if (view.jump === jump) view.jump = null;
    }
  }

  function searchHitRow(hit, view) {
    const li = document.createElement('li');
    li.className = 'message-search-hit';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-hit';
    button.addEventListener('click', () => jumpToSearchHit(hit.messageId, view, button));
    const avatar = document.createElement('span');
    avatar.className = 'search-hit-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    const who = hit.role === 'user' ? uiLabel('我', 'Me')
      : (hit.agentName || hit.author || hit.title || uiLabel('消息', 'Message'));
    const snippet = hit.preview || '';
    const timestamp = hit.created ? formatSessionTime(hit.created) : '';
    const label = uiLabel('跳到这条消息', 'Jump to this message');
    button.setAttribute('aria-label', [label, who, timestamp, snippet].filter(Boolean).join(' · '));
    avatar.textContent = leadGlyph(who);
    const head = document.createElement('span');
    head.className = 'search-hit-head';
    const name = document.createElement('strong');
    name.textContent = who;
    const when = document.createElement('time');
    when.textContent = timestamp;
    if (timestamp) when.dateTime = new Date(hit.created * 1000).toISOString();
    head.append(name, when);
    const text = document.createElement('span');
    text.className = 'search-hit-text';
    text.append(...highlightParts(snippet, view.query).map(part => {
      if (!part.match) return document.createTextNode(part.text);
      const mark = document.createElement('mark'); mark.textContent = part.text; return mark;
    }));
    button.append(avatar, head, text);
    li.append(button);
    return li;
  }
  const CONVERSATION_SCOPES = {
    messages: {placeholder: '搜索当前会话', note: '搜索当前会话中的消息。'},
    resources: {placeholder: '搜索资料标题', note: '搜索在这个会话中分享的资料。', kind: 'resource', noun: '资料', unit: '份'},
    photos: {placeholder: '搜索照片文件名', note: '搜索当前会话中的照片。', kind: 'photo', noun: '照片', unit: '张'},
    files: {placeholder: '搜索文件名', note: '搜索当前会话中的文件。', kind: 'file', noun: '文件', unit: '个'},
  };
  const inChatPanel = document.getElementById('conversation-search-panel');
  const inChatQuery = document.getElementById('conversation-search-query');
  const inChatResults = document.getElementById('conversation-search-results');
  const inChatStatus = document.getElementById('conversation-search-status');
  const inChatMore = document.getElementById('conversation-search-more');
  const inChatRetry = document.getElementById('conversation-search-retry');
  const inChatReturn = document.getElementById('conversation-search-return');
  const inChatReturnButton = inChatReturn?.querySelector('button');
  let conversationScope = 'messages';
  let searchedChat = '';
  let inChatView;
  let searchDelay;
  const conversationQuery = () => inChatQuery.value.trim();
  const currentSearchView = view => Boolean(view && inChatView === view && !inChatPanel.hidden
    && view.chat === sendScope() && view.scope === conversationScope && view.query === conversationQuery());

  function clearConversationSearch() {
    clearTimeout(searchDelay);
    inChatView?.controller?.abort();
    inChatView?.jump?.controller.abort();
    inChatView = null;
    inChatResults.replaceChildren();
    inChatResults.scrollTop = 0;
    inChatResults.setAttribute('aria-busy', 'false');
    inChatStatus.textContent = '';
    inChatMore.hidden = true;
    inChatMore.disabled = false;
    inChatRetry.hidden = true;
    if (inChatReturn) inChatReturn.hidden = true;
  }

  function setConversationScope(tab) {
    conversationScope = tab;
    for (const name of Object.keys(CONVERSATION_SCOPES)) {
      document.getElementById('conversation-search-tab-' + name)?.setAttribute('aria-selected', String(name === tab));
    }
    const {placeholder, note} = CONVERSATION_SCOPES[tab];
    inChatQuery.placeholder = placeholder;
    document.getElementById('conversation-search-query-label').textContent = placeholder;
    document.getElementById('conversation-search-scope-note').textContent = note;
  }

  function attachmentHitRow(item, view, kind) {
    const {attachment} = item;
    const photo = kind === 'photo';
    const isResource = kind === 'resource';
    const resource = isResource ? attachment.resource : null;
    const title = resource?.title || attachment.title || (photo ? '未命名照片' : isResource ? '未命名资料' : '未命名文件');
    const li = document.createElement('li');
    li.className = 'attachment-search-hit' + (isResource ? ' resource-search-hit' : '');
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'search-hit attachment-search-jump';
    jump.setAttribute('aria-label', '跳到原消息，' + title);
    jump.addEventListener('click', () => jumpToSearchHit(item.message_id, view, jump, attachment.path));
    const avatar = document.createElement('span');
    avatar.className = 'search-hit-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = photo ? '照' : isResource ? '资' : '件';
    const head = document.createElement('span');
    head.className = 'search-hit-head';
    const name = document.createElement('strong');
    name.textContent = title;
    name.title = title;
    head.append(name);
    const when = document.createElement('time');
    when.textContent = formatSessionTime(item.created_at);
    const version = artifactVersionLabel(resource, attachment.mime);
    if (version) {
      const meta = document.createElement('span');
      meta.className = 'search-hit-text resource-search-meta';
      const description = document.createElement('span');
      description.textContent = version;
      meta.append(description, when);
      jump.append(avatar, head, meta);
    } else {
      when.className = 'search-hit-text';
      jump.append(avatar, head, when);
    }
    li.append(jump);
    const download = chatFileDownload(document, attachment);
    if (download) {
      download.className = 'attachment-search-download';
      li.append(download);
    }
    return li;
  }

  async function searchAttachmentPage(view, {kind, noun, unit}, controller) {
    const conversation = currentConversation.id;
    const base = currentSource === 'social' ? socialBase() : agentBase() + '/conversations';
    const params = new URLSearchParams({kind, q: view.query, limit: '20'});
    if (view.cursor) params.set('cursor', view.cursor);
    const result = await request('GET', `${base}/${conversation}/attachments?${params}`, undefined, undefined, controller.signal);
    if (!currentSearchView(view) || view.controller !== controller) return;
    if (result.status !== 200) throw new Error('读不到当前会话的附件，请重试。');
    for (const item of result.body.items || []) {
      if (!item.message_id || !item.attachment?.id) continue;
      const id = JSON.stringify([item.message_id, item.attachment.id]);
      if (view.seen.has(id)) continue;
      view.seen.add(id);
      inChatResults.append(attachmentHitRow(item, view, kind));
    }
    const next = result.body.next_cursor;
    view.cursor = typeof next === 'string' && next !== view.cursor ? next : '';
    view.status = inChatStatus.textContent = view.seen.size ? `已显示 ${view.seen.size} ${unit}${noun}`
      : view.query ? `没有找到匹配的${noun}。` : `这个会话里还没有${noun}。`;
  }

  async function searchCurrentConversation(append = false) {
    if (!currentConversation || inChatPanel.hidden) return;
    if (append) {
      if (!currentSearchView(inChatView) || !inChatView.cursor || inChatView.loading) return;
    } else {
      clearConversationSearch();
      const query = conversationQuery();
      if (conversationScope === 'messages' && !query) return;
      inChatView = {chat: sendScope(), scope: conversationScope, query, cursor: '', seen: new Set()};
    }
    const view = inChatView;
    const scope = CONVERSATION_SCOPES[view.scope];
    const noun = scope.noun || '消息';
    view.loading = true;
    const controller = view.controller = new AbortController();
    const current = () => currentSearchView(view) && view.controller === controller;
    inChatResults.setAttribute('aria-busy', 'true');
    inChatStatus.textContent = append ? '正在加载更多…' : `正在搜索${noun}…`;
    inChatMore.disabled = true;
    inChatRetry.hidden = true;
    try {
      if (scope.kind) {
        await searchAttachmentPage(view, scope, controller);
      } else {
        const page = await readConversationMessageMatches(view.query, currentConversation.id, view.cursor, controller.signal);
        if (!current()) return;
        for (const item of page.items || []) {
          const hit = searchHitFromItem(item);
          if (!hit.messageId || view.seen.has(hit.messageId)) continue;
          view.seen.add(hit.messageId);
          inChatResults.append(searchHitRow(hit, view));
        }
        view.cursor = page.cursor && page.cursor !== view.cursor ? page.cursor : '';
        view.status = inChatStatus.textContent = view.seen.size ? `已显示 ${view.seen.size} 条消息` : '没有找到匹配的消息。试试其他关键词。';
      }
      if (current()) inChatMore.hidden = !view.cursor;
    } catch {
      if (!current()) return;
      view.status = inChatStatus.textContent = append ? '无法加载更多，请重试。' : `无法搜索${noun}，请重试。`;
      view.retryAppend = append;
      inChatMore.hidden = true;
      inChatRetry.hidden = false;
    } finally {
      if (current()) {
        view.loading = false;
        view.controller = null;
        inChatMore.disabled = false;
        inChatResults.setAttribute('aria-busy', 'false');
      }
    }
  }

  for (const scope of Object.keys(CONVERSATION_SCOPES)) {
    document.getElementById('conversation-search-tab-' + scope)?.addEventListener('click', () => {
      if (scope === conversationScope) return;
      setConversationScope(scope);
      return searchCurrentConversation();
    });
  }
  const groupInfoToggle = document.getElementById('group-info-toggle');
  if (groupInfoToggle) {
    groupInfoToggle.addEventListener('click', () => {
      const open = groupInfoToggle.getAttribute('aria-expanded') !== 'true';
      if (open) closeInChatSearch({restoreScroll: false, focus: false});
      setGroupInfoOpen(open);
    });
    document.getElementById('group-info-close').addEventListener('click', () => {
      setGroupInfoOpen(false);
      (groupInfoOpener || groupInfoToggle).focus();
    });
    const replyShortcut = document.getElementById('group-reply-shortcut');
    replyShortcut?.addEventListener('click', async () => {
      if (replyShortcut.hidden) return;
      if (currentConversation?.group_agent_routing?.can_edit !== true) {
        closeInChatSearch({restoreScroll:false, focus:false});
        setGroupInfoOpen(true, replyShortcut);
        document.getElementById('group-reply-policy').focus();
        return;
      }
      const target = groupManagementContext();
      if (!target) return;
      const scope = {...target, conversationId:target.conversation.id};
      try {
        const controls = await initializeGroupManagement({fromShortcut:true});
        if (groupMatches(scope)) controls?.openReplyPolicy();
      } catch {
        if (groupMatches(scope)) show('error', uiLabel('无法打开群回复规则，请重试。', 'Could not open the group reply policy. Try again.'));
      }
    });
    document.getElementById('group-agent-manage').addEventListener('click', () => {
      if (!agentRosterCurrent(agentRosterView) || agentRosterView.direct) return;
      agentRosterSheet.open = false;
      closeInChatSearch({restoreScroll:false, focus:false});
      setGroupInfoOpen(true);
      setGroupInfoTab('agents');
      document.getElementById('group-info-tab-agents').focus({preventScroll:true});
    });
    document.getElementById('group-info-search').addEventListener('click', () => {
      setGroupInfoOpen(false);
      document.getElementById('conversation-search-open').click();
    });
    document.getElementById('group-memory-open')?.addEventListener('click', () => openGroupMemory());
    document.getElementById('group-info-tab-agents').addEventListener('click', () => setGroupInfoTab('agents'));
    document.getElementById('group-info-tab-people').addEventListener('click', () => setGroupInfoTab('people'));
    groupPin?.addEventListener('click', toggleConversationPin);
    document.addEventListener('keydown', event => {
      const panel = document.getElementById('group-info-panel');
      if (event.key !== 'Escape' || panel.hidden || groupInfoAddDialog.open || document.getElementById('group-management-dialog')?.open) return;
      const returnFocus = panel.contains(document.activeElement);
      setGroupInfoOpen(false);
      if (returnFocus) (groupInfoOpener || groupInfoToggle).focus();
    });
  }
  let searchScrollSnapshot = null;
  let searchJumpTarget = null;
  const inChatOpen = document.getElementById('conversation-search-open');
  function openInChatSearch() {
    if (!currentConversation) { show('error', '请先打开一个会话。'); return; }
    setGroupInfoOpen(false);
    if (!inChatPanel.hidden) { inChatQuery.focus(); return; }
    const chat = sendScope();
    if (searchedChat !== chat) {
      searchedChat = chat;
      inChatQuery.value = '';
      setConversationScope('messages');
    }
    searchScrollSnapshot = {chat, top: document.getElementById('message-scroller').scrollTop};
    inChatPanel.hidden = false;
    inChatOpen.setAttribute('aria-expanded', 'true');
    if (inChatReturn) inChatReturn.hidden = true;
    const view = inChatView;
    if (currentSearchView(view) && view.suspendedScroll !== undefined) {
      inChatResults.scrollTop = view.suspendedScroll;
      delete view.suspendedScroll;
      (view.selected || inChatQuery).focus({preventScroll: true});
      return;
    }
    inChatQuery.focus();
    return searchCurrentConversation();
  }
  inChatOpen?.addEventListener('click', openInChatSearch);
  inChatReturnButton?.addEventListener('click', openInChatSearch);
  function closeInChatSearch({restoreScroll = true, focus = true, preserveResults = false} = {}) {
    const target = restoreScroll && searchJumpTarget?.isConnected ? searchJumpTarget : null;
    const targetTop = target?.getBoundingClientRect().top;
    const view = inChatView;
    const preserve = preserveResults && currentSearchView(view) && view.seen.size;
    if (preserve) {
      view.suspendedScroll = inChatResults.scrollTop;
      view.controller?.abort();
      view.jump?.controller.abort();
      view.controller = view.jump = null;
      if (view.loading) {
        view.loading = false;
        inChatResults.setAttribute('aria-busy', 'false');
        inChatMore.disabled = false;
        inChatMore.hidden = !view.cursor;
      }
      inChatStatus.textContent = view.status ?? '';
      if (inChatReturn) inChatReturn.hidden = !view.selected;
      if (view.selected && inChatReturnButton) {
        const messages = view.scope === 'messages';
        inChatReturnButton.setAttribute('data-ui-text', messages ? 'chat.search.back_to_messages' : 'chat.search.back_to_attachments');
        inChatReturnButton.textContent = messages ? uiLabel('返回消息结果', 'Back to message results')
          : uiLabel('返回附件结果', 'Back to attachment results');
      }
    } else {
      clearConversationSearch();
    }
    inChatPanel.hidden = true;
    inChatOpen?.setAttribute('aria-expanded', 'false');
    const scroller = document.getElementById('message-scroller');
    if (restoreScroll && searchScrollSnapshot?.chat === sendScope()) scroller.scrollTop = searchScrollSnapshot.top;
    else if (target) scroller.scrollTop += target.getBoundingClientRect().top - targetTop;
    searchScrollSnapshot = null;
    searchJumpTarget = null;
    if (focus) {
      const opener = inChatOpen?.checkVisibility?.() === false ? document.getElementById('chat-more') : inChatOpen;
      opener?.focus();
    }
  }
  const closeSearch = () => closeInChatSearch({preserveResults: true});
  document.getElementById('conversation-search-close')?.addEventListener('click', closeSearch);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !inChatPanel.hidden) closeSearch();
  });
  document.getElementById('conversation-search-form')?.addEventListener('submit', event => {
    event.preventDefault();
    return searchCurrentConversation();
  });
  inChatQuery.addEventListener('input', event => {
    clearConversationSearch();
    if (!event.isComposing) searchDelay = setTimeout(() => void searchCurrentConversation(), 200);
  });
  inChatMore.addEventListener('click', () => searchCurrentConversation(true));
  inChatRetry.addEventListener('click', () => searchCurrentConversation(inChatView?.retryAppend || false));
  function renderDeliveredSocialMessage(scope, message) {
    if (message && scope === sendScope()) {
      // Only append to a history window when the receipt cannot skip a message.
      const tail = lastSocialItems.at(-1)?.seq;
      const nextInView = Number.isSafeInteger(tail) && message.seq === tail + 1;
      if (socialHistory?.readingHistory && !nextInView) liveBanner.hidden = false;
      else {
        const without = lastSocialItems.filter(item => item.id !== message.id);
        renderSocialMessages([...without, message].sort((a,b) => a.seq - b.seq), {refresh:true});
      }
    }
    void loadSessions();
  }

  function attachmentContext() {
    if (!servedByDsbot || !currentUser || sendClosed()) return null;
    if (currentSource === 'agent' && currentAgent) return {scope:sendScope(), private:true, owner:currentUser.id};
    if (currentSource !== 'social' || !currentConversation || currentConversation.public_agent) return null;
    const wid = workspaceId(), cid = currentConversation.id;
    const scope = sendScope();
    return {scope, wid, conversationId:cid, owner:currentUser.id, reply:replyDrafts.get(scope),
      blocked:quoteBlocksSend(scope),
      path:`/v1/workspaces/${wid}/social/conversations/${cid}/messages`};
  }

  attachmentSender = mountChatFiles(document, {
    context: attachmentContext,
    uiLabel,
    ownerId: () => currentUser?.id,
    csrfToken: () => csrfCookie(document.cookie),
    createKey: () => idempotencyKey('chat-file-'),
    onDraftChange: renderGroupComposerRouting,
    confirmDelivery: (target, key, current) =>
      socialSendReceipt(target, key, current, message => message.attachment || message.retracted),
    sent(destination, message) {
      consumeReplyDraft(destination.scope, destination.reply);
      if (message) renderDeliveredSocialMessage(destination.scope, message);
    },
  });
  const filterButton = document.getElementById('session-filter');
  const filterLabel = document.getElementById('session-filter-label');
  const filterValue = document.getElementById('session-filter-value');
  const filterClear = document.getElementById('session-filter-clear');
  function setFilterOpen(open, {focus = true} = {}) {
    if (!filterLabel || !filterButton) return;
    filterLabel.hidden = !open;
    filterButton.setAttribute('aria-expanded', String(open));
    if (focus) (open ? filterValue : filterButton)?.focus();
  }
  filterButton?.addEventListener('click', () => setFilterOpen(Boolean(filterLabel?.hidden)));
  document.addEventListener('click', event => {
    if (filterLabel && !filterLabel.hidden && !event.target?.closest?.('#session-filter, #session-filter-label')) {
      setFilterOpen(false, {focus: false});
    }
  });
  filterValue?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setFilterOpen(false);
    }
  });
  function applySessionFilter() {
    const active = filterValue.value !== 'all';
    const name = filterValue.selectedOptions?.[0]?.textContent;
    filterButton.dataset.filterActive = String(active);
    if (name) filterButton?.setAttribute('aria-label', uiLabel('会话筛选：', 'Conversation filter: ') + name);
    filterClear.hidden = !active;
    document.getElementById('session-filter-selection').textContent = active ? name || '' : '';
    if (active && name) filterClear.setAttribute('aria-label', uiLabel(`清除「${name}」筛选`, `Clear “${name}” filter`));
    setFilterOpen(false);
    renderSessions();
  }
  filterValue?.addEventListener('change', applySessionFilter);
  filterClear?.addEventListener('click', () => {
    filterValue.value = 'all';
    applySessionFilter();
  });
  document.getElementById('conversations-read-all')?.addEventListener('click', async () => {
    if (markingConversationsRead) return;
    const wid = workspaceId();
    const unread = sessions.filter(item => item.source === 'social' && visibleSessionUnread(item) > 0);
    if (!wid || !unread.length) return;
    markingConversationsRead = true;
    renderSessions();
    try {
      let updated = 0;
      // Use the same per-conversation acknowledgement as opening a conversation.
      // Small batches avoid flooding the user's runtime with simultaneous writes.
      for (let index = 0; index < unread.length && workspaceId() === wid; index += 6) {
        const batch = unread.slice(index, index + 6);
        const results = await Promise.allSettled(batch.map(item =>
          request('POST', `/v1/workspaces/${wid}/social/conversations/${item.id}/read`, {})));
        updated += results.filter(result => result.status === 'fulfilled' && result.value.status === 200).length;
      }
      if (workspaceId() === wid) {
        try { await loadSessions(); }
        catch { show('error', '已提交已读状态，但无法刷新列表。'); return; }
        if (workspaceId() === wid) show(updated === unread.length ? 'ok' : 'error',
          updated === unread.length ? '已标记单聊和群聊为已读。' : '部分会话未能标记为已读，请重试。');
      }
    } finally {
      markingConversationsRead = false;
      renderSessions();
    }
  });
  const muteButton = document.getElementById('mute-conversation');
  const groupMute = document.getElementById('group-info-mute');
  let savingMute = false;
  function syncMuteButton(conversation) {
    const muted = Boolean(conversation?.muted);
    if (muteButton) {
      muteButton.hidden = !conversation || (conversation.kind === 'group' && !conversation.public_agent);
      muteButton.setAttribute('aria-pressed', String(muted));
      muteButton.textContent = muted ? uiLabel('取消免打扰', 'Unmute') : uiLabel('免打扰', 'Mute');
    }
    groupMute?.setAttribute('aria-checked', String(muted));
  }
  async function toggleMute() {
    if (currentSource !== 'social' || !currentConversation || savingMute) return;
    const conversation = currentConversation;
    const scope = notificationScope();
    savingMute = true;
    if (muteButton) muteButton.disabled = true;
    if (groupMute) groupMute.disabled = true;
    try {
      const result = await request('POST', `${socialBase()}/${conversation.id}/preferences`, {muted: !conversation.muted});
      if (result.status !== 200) throw new Error('Mute preference unavailable');
      if (!currentNotificationScope(scope)) return;
      const muted = Boolean(result.body.muted);
      const row = sessions.find(item => item.source === 'social' && item.id === conversation.id);
      if (row) row.muted = muted;
      const listed = socialConversations.find(item => item.id === conversation.id);
      if (listed) listed.muted = muted;
      if (currentSource === 'social' && currentConversation?.id === conversation.id) {
        currentConversation.muted = muted;
        syncMuteButton(currentConversation);
      }
      renderSessions();
      notificationEpoch += 1;
      if (notificationSnapshot) {
        notificationSnapshot = {...notificationSnapshot, scope:notificationScope(),
          body:{...notificationSnapshot.body, items:[]}};
      }
      void loadNotifications({interactive: !document.getElementById('notifications-panel')?.hidden});
    } catch {
      if (currentNotificationScope(scope)) show('error', '免打扰设置保存失败，请重试。');
    } finally {
      savingMute = false;
      if (muteButton) muteButton.disabled = false;
      if (groupMute) groupMute.disabled = false;
    }
  }
  muteButton?.addEventListener('click', toggleMute);
  groupMute?.addEventListener('click', toggleMute);
  pinButton?.addEventListener('click', toggleConversationPin);
  document.getElementById('search-close').addEventListener('click', () => closeSearchPanel({focus: true}));
  document.getElementById('chat-back').addEventListener('click', () => {
    rememberReadingPosition();
    cancelStartupLink();
    stopReplyProgress();
    stopGroupReplyProgress({preservePreview: true});
    if (currentSource === 'agent') stopPolling();
    setSessionsOpen(true);
    document.getElementById('conversation-list').querySelector('[aria-current="true"]')?.focus();
  });

  const chatMore = document.getElementById('chat-more');
  const extraActions = document.getElementById('chat-extra-actions');
  chatMore?.addEventListener('click', () => {
    const open = chatMore.getAttribute('aria-expanded') !== 'true';
    chatMore.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', event => {
    if (chatMore?.getAttribute('aria-expanded') !== 'true' || chatMore.contains(event.target)) return;
    const inside = extraActions.contains(event.target);
    if (inside && !event.target.closest('button, a')) return;
    if (inside && extraActions.contains(document.activeElement)) chatMore.focus();
    chatMore.setAttribute('aria-expanded', 'false');
  });

  document.getElementById('search-more').addEventListener('click', async () => {
    if (searchTab === 'files' || searchTab === 'links') { if (resourceCursor) await renderSearch({appendResources: true}); return; }
    const query = (document.getElementById('session-search').value || '').trim();
    if (!query || messageSearch.state.loading || !messageSearch.state.cursor) return;
    const seq = searchSeq;
    await messageSearch.load(query, searchConversation, {append: true});
    if (seq === searchSeq) await renderSearch({reuseMessages: true});
  });
  document.getElementById('message-search').addEventListener('click', () => {
    if (!currentConversation) {
      show('error', '请先打开一个对话再搜索。');
      return;
    }
    document.getElementById('session-search').value = '';
    openSearchPanel('messages', currentConversation.id, {fromSessionList: false});
    document.getElementById('session-search').focus();
  });
  document.getElementById('search-panel').addEventListener('click', event => {
    const tab = event.target.closest('[data-search-tab]');
    if (!tab) return;
    setSearchTab(tab.dataset.searchTab);
    renderSearch();
  });

  document.getElementById('conversation-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-conversation]');
    if (!button) return;
    const {source, agent, conversation: cid} = button.dataset;
    const session = sessions.find(item => item.id === cid && item.source === source);
    const title = session?.title || uiLabel('会话', 'conversation');
    await openSessionTarget({source, agent, cid, title, unread: source === 'social' && session?.kind !== 'public' && session?.unread_count > 0}, {resume:true});
  });

  for (const [id, action] of [['start-video-meeting', 'create'], ['join-video-meeting', 'join']]) {
    const button = document.getElementById(id);
    button.hidden = !servedByDsbot;
    button.addEventListener('click', () => {
      composeMenu.close({focus: true});
      chatCalls.openMeeting(action);
    });
  }
  document.getElementById('group-agent-prompt').addEventListener('input', rememberGroupReplyDraft);
  document.getElementById('group-agent-choices').addEventListener('change', () => {
    document.getElementById('group-agent-choice-status').textContent = '';
    rememberGroupReplyDraft();
  });
  groupStudioPanel.addEventListener('toggle', () => {
    if (groupStudioPanel.open) return loadGroupStudioDocuments();
  });
  groupStudioNode('refresh').addEventListener('click', loadGroupStudioDocuments);
  groupStudioNode('review').addEventListener('click', previewGroupStudioDocument);
  groupStudioNode('document').addEventListener('change', () => {
    const state = groupStudio;
    if (!currentGroupStudio(state)) return;
    const id = groupStudioNode('document').value;
    if (id && !state.items.some(item => item.id === id)) return;
    state.preview?.abort();
    state.preview = null;
    state.referenceError = false;
    clearGroupStudioPreview();
    groupStudioNode('status').textContent = '';
    updateGroupStudioDraft(state.scope, id);
    if (id) return previewGroupStudioDocument();
  });
  groupStudioNode('confirm').addEventListener('click', () => {
    const state = groupStudio;
    if (!currentGroupStudio(state) || state.review?.document_id !== groupReplyDraft(state.scope).studioDocumentId) return;
    const reference = state.review;
    updateGroupStudioDraft(state.scope, reference.document_id, reference);
    clearGroupStudioPreview();
    groupStudioNode('status').textContent = uiLabel('已引用' + groupStudioRevisionLabel(reference.revision) + '。', 'Attached version ' + reference.revision + '.');
    groupStudioNode('review').focus();
  });
  document.getElementById('group-agent-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (currentSource !== 'social' || currentConversation?.kind !== 'group'
      || currentConversation.public_agent) return;
    const cid = currentConversation.id;
    const scope = sendScope();
    if (groupReplyBusy.has(scope) || groupReplyFormScope !== scope) return;
    const boxes = groupReplyCheckedAgents();
    const agentKeys = groupAgentKeys(boxes.map(box => box.value));
    const prompt = document.getElementById('group-agent-prompt').value.trim();
    const choiceStatus = document.getElementById('group-agent-choice-status');
    if (!agentKeys?.length || agentKeys.length > 5) {
      choiceStatus.textContent = uiLabel('请选择 1 至 5 个群内智能体。', 'Select 1 to 5 group agents.');
      return;
    }
    if (boxes.some(box => box.disabled)) {
      choiceStatus.textContent = uiLabel('选中的智能体正在回复。请稍等或选择其他智能体。', 'A selected agent is replying. Wait or choose another agent.');
      return;
    }
    if (!validMessage(prompt)) return;
    choiceStatus.textContent = '';
    rememberGroupReplyDraft();
    const draft = groupReplyDraft(scope);
    const studioReference = namedTeamGroup() ? draft.studioReference : null;
    if (draft.studioDocumentId && (!studioReference || groupStudio?.preview)) return;
    const targets = agentKeys.map(groupAgentTarget);
    const paired = currentConversation.group_agent_requests === true;
    if (paired && !targets.every(target => target.owner_id)) return;
    const attempt = sameGroupReplyRequest(draft.attempt, prompt, agentKeys, studioReference) ? draft.attempt
      : {prompt, agentKeys, agentIds: paired ? null : targets.map(target => target.agent_id),
        studioReference, key: idempotencyKey('group-reply-')};
    saveGroupReplyDraft(scope, {...draft, attempt});
    groupReplyBusy.add(scope);
    syncGroupReplySubmit(scope);
    try {
      const selection = attempt.agentIds ? {agent_ids: attempt.agentIds} : {agent_targets: targets};
      const result = await request('POST', `${socialBase()}/${cid}/agent-replies`,
        {...selection, prompt, ...(studioReference ? {studio_reference: studioReference} : {})},
        {'Idempotency-Key': attempt.key}, AbortSignal.timeout(15000))
        .catch(() => ({status: 0, body: {}}));
      if (result.status !== 202 || !result.body.message?.id) {
        const latest = groupReplyDraft(scope);
        const code = result.body.error?.code;
        if (['group_agent_unavailable', 'group_agent_request_conflict'].includes(code) && latest.attempt?.key === attempt.key) {
          saveGroupReplyDraft(scope, {...latest, attempt: null});
          if (scope === sendScope()) {
            choiceStatus.textContent = code === 'group_agent_unavailable'
              ? uiLabel('选中的智能体已无法回复。请选择仍在群内的智能体。', 'A selected agent is no longer available. Choose an agent still in the group.')
              : uiLabel('这次请求与已记录的内容不同。请检查草稿后再发送。', 'This request differs from the recorded one. Review the draft and send it again.');
            if (code === 'group_agent_unavailable') void openSocialConversation(cid, {refresh: true});
          }
        } else if (studioReference && ['studio_reference_changed', 'studio_reference_unavailable'].includes(code)
          && latest.attempt?.key === attempt.key && sameStudioReference(latest.studioReference, studioReference)) {
          saveGroupReplyDraft(scope, {...latest, studioReference: null, attempt: null});
          if (currentGroupStudio(groupStudio) && groupStudio.scope === scope) {
            groupStudio.referenceError = true;
            clearGroupStudioPreview();
            const message = code === 'studio_reference_changed'
              ? uiLabel('文档版本已更新，请重新预览并确认。', 'The document has a newer version. Preview and confirm it again.')
              : uiLabel('这个团队文档已不可用，请选择其他文档或取消引用。', 'This document is unavailable. Select another document or remove the reference.');
            groupStudioPanel.open = true;
            groupStudioNode('status').textContent = message;
            syncGroupStudioPicker();
          }
        } else if (scope === sendScope() && latest.attempt?.key === attempt.key) {
          show('error', messageFor(result.body.error, uiLabel('发送未确认，请重试。', 'Delivery is unconfirmed. Try again.')));
        }
        return;
      }
      confirmGroupReplyDraft(scope, attempt.key);
      if (scope === sendScope()) {
        if (socialHistory?.readingHistory) void openSocialConversation(cid);
        else {
          renderDeliveredSocialMessage(scope, result.body.message);
          scheduleSocialPoll(currentConversation);
        }
        show('ok', uiLabel('已发送到群聊。', 'Sent to the group.'), {announceOnly: true});
      }
    } finally {
      groupReplyBusy.delete(scope);
      if (scope === sendScope()) syncGroupReplySubmit(scope);
    }
  });

  agentRosterSheet.addEventListener('toggle', () => void loadDirectAgentCatalogue());

  async function writeAgentRoster(view, suffix, body, adding, notify = (kind, text) => show(kind, text)) {
    if (!agentRosterCurrent(view) || view.busy) return false;
    const cid = currentConversation.id;
    const wid = workspaceId();
    const failure = adding ? uiLabel('无法添加智能体。', 'Could not add the agent.')
      : uiLabel('无法移除智能体。', 'Could not remove the agent.');
    view.busy = true;
    if (view.direct) {
      view.status = adding ? uiLabel('正在添加…', 'Adding…') : uiLabel('正在移除…', 'Removing…');
      renderDirectAgentAddition(view);
    }
    try {
      const result = await request('POST', `${socialBase()}/${cid}/agents${suffix}`, body)
        .catch(() => ({status:0,body:{}}));
      if (!agentRosterCurrent(view)) return false;
      if (result.status !== 200 && (!adding || result.status !== 201)) {
        const text = messageFor(result.body.error, failure);
        if (view.direct) view.status = text;
        else notify('error', text, result.status);
        return false;
      }
      const roster = result.body.roster;
      const revision = rosterActivityRevision(roster?.activity_version);
      const receivedRoster = roster?.id === cid && roster.workspace_id === wid && Array.isArray(roster.agent_members) && revision >= 0;
      let refreshed = true;
      if (receivedRoster) {
        const shownRevision = Math.max(rosterActivityRevision(view.roster?.activity_version),
          rosterActivityRevision(currentConversation.activity_version));
        if (revision >= shownRevision) {
          view.roster = roster;
          currentConversation.agent_members = roster.agent_members;
          currentConversation.group_agent_routing = roster.group_agent_routing;
          setGroupInfo(currentConversation);
          if (!view.direct) {
            applyChatAvatarStack(document, currentConversation);
            setChatSubtitle(groupHeaderSubtitle(currentConversation));
          }
          renderGroupReplyAction(view.requests);
          agentMentions.refresh();
          renderGroupComposerRouting();
        }
      } else refreshed = await openSocialConversation(cid, {acknowledge:false});
      if (!agentRosterCurrent(view)) return false;
      const text = refreshed ? (adding ? uiLabel('已添加智能体。', 'Agent added.') : uiLabel('已移除智能体。', 'Agent removed.'))
        : uiLabel('变更已保存，重新打开对话可查看最新成员。', 'Change saved. Reopen the conversation to see the current members.');
      if (view.direct) view.status = text;
      else notify('ok', text);
      return true;
    } finally {
      view.busy = false;
      if (view.direct && agentRosterCurrent(view)) renderDirectAgentAddition(view);
    }
  }

  document.getElementById('group-agent-chips').addEventListener('click', event => {
    const button = event.target.closest('button[data-remove-agent]');
    const view = agentRosterView;
    if (!button || button.disabled || !agentRosterCurrent(view) || view.busy) return;
    const {removeAgent:agentId, agentOwnerId:ownerId} = button.dataset;
    if (view.direct && (!ownerId || !currentConversation.agent_members?.some(agent => agent.id === agentId && agent.owner_id === ownerId))) return;
    const holder = document.getElementById('group-agent-chips');
    if (holder.querySelector('.agent-remove-confirm')) return;
    const question = document.createElement('span');
    question.className = 'agent-remove-confirm'; question.setAttribute('role', 'alertdialog');
    question.setAttribute('aria-label', uiLabel('移除智能体确认', 'Confirm agent removal'));
    const text = document.createElement('span');
    text.textContent = view.direct ? uiLabel('从当前私聊移除此智能体？已有消息会保留。', 'Remove this agent from the chat? Existing messages will stay.')
      : uiLabel('从当前群聊移除此智能体？已有消息会保留。', 'Remove this agent from the group? Existing messages will stay.');
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = uiLabel('确认移除', 'Remove agent');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = uiLabel('取消', 'Cancel');
    cancel.addEventListener('click', () => { question.remove(); button.focus(); });
    question.addEventListener('keydown', event => { if (event.key === 'Escape') { question.remove(); button.focus(); } });
    confirm.addEventListener('click', async () => {
      if (!agentRosterCurrent(view)) { question.remove(); return; }
      confirm.disabled = true; cancel.disabled = true;
      try {
        if (await writeAgentRoster(view, `/${encodeURIComponent(agentId)}/remove`, view.direct ? {owner_id:ownerId} : {}, false)) {
          question.remove();
          if (agentRosterCurrent(view)) agentRosterSheet.querySelector('summary')?.focus({preventScroll:true});
        }
      }
      finally { confirm.disabled = false; cancel.disabled = false; }
    });
    question.append(text, cancel, confirm); holder.append(question); cancel.focus();
  });

  document.getElementById('group-agent-add-submit').addEventListener('click', async () => {
    const view = agentRosterView;
    if (!agentRosterCurrent(view) || view.busy) return;
    if (view.direct && view.failed) { await loadDirectAgentCatalogue(); return; }
    const select = document.getElementById('group-agent-add');
    if (!select.value || (view.direct && !view.catalogue?.some(agent => agent.id === select.value && !agent.archived && !agent.native_deleted))) return;
    await writeAgentRoster(view, '', {agent_ids: [select.value]}, true);
  });

  document.getElementById('compose-new-group').addEventListener('click', event => openComposeDialog('group', {keyboard: event.detail === 0}));
  document.getElementById('compose-add-contact').addEventListener('click', () => openComposeDialog('contact'));
  document.getElementById('compose-dialog-cancel').addEventListener('click', () => {
    if (!composePhase) closeComposeDialog({focus:true});
  });
  document.getElementById('compose-dialog').addEventListener('cancel', event => {
    event.preventDefault();
    if (!composePhase) closeComposeDialog({focus:true});
  });
  const groupModeSwitch = document.getElementById('compose-mode-switch');
  groupModeSwitch.addEventListener('click', event => {
    const button = event.target.closest('[data-group-mode]');
    if (!button || composeMode !== 'group' || composePhase || composeReceipt) return;
    setGroupMode(button.dataset.groupMode);
  });
  groupModeSwitch.addEventListener('keydown', event => {
    if (composePhase || composeReceipt || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const mode = event.key === 'Home' ? 'custom' : event.key === 'End' ? 'team' : groupMode === 'team' ? 'custom' : 'team';
    setGroupMode(mode);
    document.getElementById('compose-mode-' + mode).focus({preventScroll:true});
  });
  document.getElementById('team-templates-retry').addEventListener('click', () => {
    document.getElementById('compose-mode-team').focus({preventScroll:true});
    void loadTeamTemplates();
  });
  document.getElementById('compose-member-search').addEventListener('input', applyMemberFilter);
  document.getElementById('compose-title').addEventListener('input', () => setComposeError());
  const composeTeamTitle = document.getElementById('compose-team-title');
  composeTeamTitle?.addEventListener('input', () => setComposeError());
  document.getElementById('member-choices').addEventListener('change', () => {
    setComposeError();
    syncSelectedCount();
  });
  const templateChoices = document.getElementById('team-template-choices');
  if (templateChoices) templateChoices.addEventListener('change', () => {
    setComposeError();
    syncComposeCreate();
  });

  document.getElementById('compose-social-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = document.getElementById('compose-dialog-submit');
    if (composePhase || submit.disabled) return;
    const wid = workspaceId();
    const owner = currentUser;
    const view = composeView;
    const current = () => wid === workspaceId() && owner === currentUser && view === composeView &&
      !document.getElementById('compose-dialog').hidden;
    const template = composeReceipt?.template ?? (composeMode === 'group' && groupMode === 'team');
    setComposeError();
    try {
      let initialRead;
      if (!composeReceipt) {
        const memberIds = [...document.querySelectorAll('#member-choices input[name="member"]:checked')].map(box => box.value);
        const agentIds = [...document.querySelectorAll('#member-choices input[name="agent-member"]:checked')].map(box => box.value);
        const title = (template ? composeTeamTitle?.value || '' : document.getElementById('compose-title').value).trim();
        const picked = template ? document.querySelector('#team-template-choices input:checked') : null;
        if (template && !picked) return;
        const path = template ? `/v1/workspaces/${wid}/team-templates/${picked.value}` : socialBase();
        const body = template ? (title ? {title} : {}) : composeMode === 'contact'
          ? {kind:'dm', member_ids:memberIds} : composeGroupPayload(memberIds, title, agentIds);
        const fingerprint = JSON.stringify([owner?.id, path, body]);
        if (composeAttempt?.fingerprint !== fingerprint) composeAttempt = {fingerprint, key:idempotencyKey('conv-')};
        composePhase = 'creating';
        syncComposeCreate();
        const result = await request('POST', path, body, {'Idempotency-Key':composeAttempt.key},
          AbortSignal.timeout(template ? 60000 : 20000));
        if (!current()) return;
        const conversation = result.body.conversation;
        if (![200,201].includes(result.status) || !conversation?.id) {
          setComposeError(composeCreateError(result.status, template, result.body.error));
          return;
        }
        composeAttempt = null;
        composeReceipt = {id:conversation.id, template};
        if (!template && result.status === 201 && conversation.kind === 'group' && conversation.last_seq === 0 &&
            conversation.workspace_id === wid && Array.isArray(conversation.members) && Array.isArray(conversation.agent_members)) {
          initialRead = {status:200, body:{conversation, items:[]}};
        }
      }
      composePhase = 'opening';
      syncComposeCreate();
      const opened = await openSocialConversation(composeReceipt.id,
        {quiet:true, initialRead, signal:AbortSignal.timeout(12000)}).catch(() => false);
      if (!current()) return;
      if (!opened) {
        setComposeError(uiLabel('会话已创建。暂时无法打开，请重试。', 'The conversation is saved. Try opening it again.'));
        return;
      }
      closeComposeDialog();
      document.getElementById('chat-title').focus({preventScroll:true});
      void loadSessions();
      show('ok', template ? '智能体团队已创建。' : '会话已创建。');
    } catch {
      if (current()) setComposeError(composeCreateError(0, template));
    } finally {
      if (current()) {
        composePhase = '';
        syncComposeCreate();
      }
    }
  });


  function sendCurrentMessage() {
    const field = document.getElementById('chat-body');
    const social = currentSource === 'social';
    const scope = sendScope();
    const files = attachmentSender?.draftFiles?.(scope) || [];
    if (!field.value.trim() && !files.length) return;
    if (sendClosed() || memoryWrites.has(scope) || quoteBlocksSend(scope)) return;
    if (social ? !currentConversation : !currentAgent) {
      show('error', social ? '请先打开或创建一个会话。' : '请先选择一个智能体。');
      return;
    }
    const message = social ? agentMentions.message(field.value) : messagePayload(field.value, chatLanguage);
    if (!message) {
      show('error', uiLabel('请先移除不可用的智能体。', 'Remove unavailable agents before sending.'));
      return;
    }
    const reply = social ? replyDrafts.get(scope) : undefined;
    if (reply) message.reply_to = reply.message_id;
    const groupFiles = social && currentConversation.kind === 'group' && !currentConversation.public_agent;
    if (groupFiles && files.length && message.agent_mentions?.length && !message.body.trim()) {
      show('error', uiLabel('先写附言，再请求智能体回复。', 'Add a caption before asking agents to reply.'));
      return;
    }
    if (social && !groupFiles && files.length && (message.agent_mentions?.length ||
        (hasGroupAllMention(message.body) && !hasEveryoneMention(message.body)))) {
      show('error', uiLabel('请先移除附件，再请求智能体回复。', 'Remove the files before requesting agent replies.'));
      return;
    }
    if (social && !validMessage(message.body) && (!files.length || message.body.trim())) {
      show('error', '请输入 1–4000 字符的消息。');
      return;
    }
    queueChatMessage(message, files, reply);
  }

  function sendSticker(sticker, target) {
    const active = stickerContext();
    if (!active || quoteBlocksSend(active.scope) || target?.scope !== active.scope || target.owner !== active.owner ||
        !PRIVATE_THREAD_ID.test(sticker?.id ?? '') || sticker.path !== `/v1/stickers/${sticker.id}/file`) return false;
    const social = currentSource === 'social';
    const reply = social ? replyDrafts.get(active.scope) : undefined;
    const message = social ? {} : messagePayload('', chatLanguage);
    if (reply) message.reply_to = reply.message_id;
    queueChatMessage({...message,sticker_id:sticker.id}, [], reply, sticker);
    return true;
  }

  function queueChatMessage(message, files, reply, sticker) {
    const queue = currentChatSendQueue();
    const {social,scope} = queue;
    if (!queue.conversationId && queue.jobs.some(job => job.key === queue.createKey && job.failed && job.storedText)) {
      show('error', uiLabel('请先重试或移除未确认的首条消息。', 'Retry or remove the unconfirmed first message first.'));
      return;
    }
    if (social && files.length) {
      // The social message store accepts one attachment per message. A
      // multi-file draft is sent in order, with its caption on the first file.
      files.forEach((file, index) => {
        const payload = index ? {reply_to:message.reply_to} : message;
        queue.jobs.push(makeSendJob(queue, payload, [file], reply));
      });
    } else {
      const job = makeSendJob(queue, message, files, reply, sticker);
      if (!social && chatSettings && !chatSettings.ready) job.preferences = chatSettings;
      const first = servedByDsbot && !social && !queue.conversationId && job.key === queue.createKey;
      if (!files.length && !sticker && (social ? currentSharedTextConversation() : !reply && (first || currentPrivateThread()))) {
        // A reload can interrupt the request after the composer clears.
        job.storedText = savePendingChatText(document.defaultView, scope, job.key,
          first ? {...message, memory_scope:queue.memoryScope} : message);
      }
      queue.jobs.push(job);
    }
    const field = document.getElementById('chat-body');
    if (!sticker) {
      field.value = '';
      publicDraft.persist({now: false});
      field.focus({preventScroll: true});
      if (social && (message.agent_mentions?.length || (currentConversation?.kind === 'group' && hasGroupAllMention(message.body)))) {
        agentMentions.forget(scope);
      }
      renderGroupComposerRouting();
    }
    consumeReplyDraft(scope, reply);
    if (files.length) attachmentSender.clearDraft(scope, files);
    show('', '');
    renderPendingSend();
    const scroller = document.getElementById('message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    if (!social) resumePrivateSending();
    void drainSends(queue);
  }

  function currentChatSendQueue() {
    const social = currentSource === 'social', scope = sendScope();
    let queue = pendingSends.get(scope);
    if (!queue) {
      queue = {
        scope, social, owner: currentUser?.id, wid: workspaceId(), agentId: currentAgent?.id,
        base: social ? socialBase() : `${agentBase()}/conversations`,
        conversationId: currentConversation?.id, jobs: [], active: false,
        createKey: currentConversation ? null : idempotencyKey('chat-'),
        memoryScope: memoryDrafts.get(scope),
      };
      pendingSends.set(scope, queue);
    }
    return queue;
  }

  function restorePendingPrivateText(items) {
    const starting = servedByDsbot && currentSource === 'agent' && currentAgent && !currentConversation;
    if (!starting && !currentPrivateThread()) return;
    const scope = sendScope();
    const stored = readPendingChatText(document.defaultView, scope);
    if (!stored.length) return;
    if (starting) {
      const queue = currentChatSendQueue();
      if (queue.jobs.length) return;
      const {key,message:{memory_scope,...message}} = stored[0];
      queue.createKey = key;
      queue.memoryScope = memory_scope;
      if (memory_scope !== undefined) memoryDrafts.set(scope,memory_scope);
      const job = makeSendJob(queue, message, [], null, null, key);
      job.storedText = true;
      job.failed = true;
      job.state = uiLabel('上次发送未确认，可重试。', 'Delivery wasn’t confirmed. You can retry.');
      queue.jobs.push(job);
      void recoverFirstPrivateText(queue, job);
      return;
    }
    const delivered = new Set(items.filter(item => item.role === 'user' && item.client_key).map(item => item.client_key));
    for (const {key,message} of stored) {
      if (delivered.has(key)) {
        savePendingChatText(document.defaultView, scope, key);
        continue;
      }
      const queue = currentChatSendQueue();
      if (queue.jobs.some(job => job.key === key)) continue;
      const job = makeSendJob(queue, message, [], null, null, key);
      job.storedText = true;
      job.failed = true;
      job.state = uiLabel('上次发送未确认，可重试。', 'Delivery wasn’t confirmed. You can retry.');
      queue.jobs.push(job);
      const checking = () => pendingSends.get(scope) === queue && queue.jobs.includes(job) && job.failed && currentUser?.id === queue.owner;
      void privateSendReceipt(queue, key, checking, () => true, [0]).then(pair => {
        if (!pair || !checking()) return;
        removeSendJob(queue, job);
        if (scope !== sendScope()) return;
        renderPendingSend();
        if (!queue.active && !readingPrivateContext()) void openAgentConversation(queue.agentId, queue.conversationId, {refresh:true});
      });
    }
  }

  async function recoverFirstPrivateText(queue, job) {
    const {scope, owner, wid, agentId} = queue;
    const open = socialOpen;
    const current = () => open === socialOpen && sendScope() === scope && pendingSends.get(scope) === queue &&
      queue.jobs.includes(job) && job.failed;
    try {
      // Match the deterministic native conversation ID used by DS-Bot for this create key.
      const bytes = new TextEncoder().encode(`conversation:${agentId}:${job.key}`);
      const hash = await document.defaultView.crypto.subtle.digest('SHA-256', bytes);
      if (!current()) return;
      const cid = Array.from(new Uint8Array(hash,0,16), byte=>byte.toString(16).padStart(2,'0')).join('');
      const result = await request('GET', `${queue.base}/${cid}?limit=${HISTORY_PAGE_SIZE}&snapshot=1`,
        undefined, undefined, AbortSignal.timeout(4500));
      if (!current() || result.status !== 200 || !validStartupTranscript(result.body,wid,agentId,cid) ||
          !result.body.items.some(item=>item.role==='user' && item.client_key===job.key)) return;
      const destination = JSON.stringify([owner,wid,'agent',agentId,cid]);
      if (!publicDraft.lookup(destination)) publicDraft.move(scope,destination);
      removeSendJob(queue,job);
      await openAgentConversation(agentId,cid,{startupSnapshot:()=>result});
    } catch {
      // Keep the same-key retry available when the recorded first send cannot be confirmed.
    }
  }

  function currentSharedTextConversation() {
    return servedByDsbot && currentSource === 'social' && currentUser?.id &&
      currentConversation && currentConversation.workspace_id === workspaceId() && !currentConversation.public_agent;
  }

  function restorePendingSocialText(items) {
    if (!currentSharedTextConversation()) return;
    const scope = sendScope();
    const stored = readPendingChatText(document.defaultView, scope);
    if (!stored.length) return;
    const destination = {owner:currentUser.id, wid:workspaceId(), conversationId:currentConversation.id};
    for (const {key,message} of stored) {
      if (items.some(item => ownSocialReceipt(item, destination, key))) {
        savePendingChatText(document.defaultView, scope, key);
        continue;
      }
      const queue = currentChatSendQueue();
      if (queue.jobs.some(job => job.key === key)) continue;
      let reply = null;
      if (message.reply_to) {
        // Preview text must come from the current conversation read.
        const quoted = items.find(item => item.id === message.reply_to &&
          (!item.conversation_id || item.conversation_id === queue.conversationId) &&
          (!item.workspace_id || item.workspace_id === queue.wid));
        reply = quoted && !quoted.retracted ? composerReply(quoted, socialMessageAuthor(quoted))
          : {message_id:message.reply_to, available:false, state:quoted ? 'missing' : 'checking'};
      }
      const job = makeSendJob(queue, message, [], reply, null, key);
      job.storedText = true;
      job.failed = true;
      job.state = uiLabel('上次发送未确认，可重试。', 'Delivery wasn’t confirmed. You can retry.');
      queue.jobs.push(job);
      const checking = () => pendingSends.get(scope) === queue && queue.jobs.includes(job) && job.failed &&
        currentUser?.id === queue.owner;
      void socialSendReceipt(queue, key, checking).then(receipt => {
        if (!receipt || !checking()) return;
        removeSendJob(queue, job);
        if (scope === sendScope()) renderDeliveredSocialMessage(scope, receipt);
      });
    }
  }

  async function drainSends(queue) {
    if (queue.active || pendingSends.get(queue.scope) !== queue) return;
    queue.active = true;
    const isCurrent = () => sendScope() === queue.scope;
    try {
      for (const job of queue.jobs.slice()) {
        if (job.failed || job.accepted || !queue.jobs.includes(job)) continue;
        if (pendingSends.get(queue.scope) !== queue || queue.owner !== currentUser?.id) return;
        const feedback = state => {
          job.state = state;
          if (isCurrent()) paintSendJob(job);
        };
        if (!queue.social && privateThreadReceipts.get(privateThreadKey({owner: queue.owner, wid: queue.wid,
          aid: queue.agentId, cid: queue.conversationId}))?.metadata.archived) {
          job.failed = true;
          feedback(uiLabel('对话已归档，恢复后可以重试。', 'Conversation archived. Restore it to retry.'));
          continue;
        }
        const beginReply = () => {
          if (!servedByDsbot || queue.social || queue.replying === job) return;
          queue.replying = job;
          if (isCurrent()) {
            const scroller = document.getElementById('message-scroller');
            const follow = messageScrollerAtBottom(scroller);
            stopPolling();
            renderPendingSend();
            syncReplyProgress();
            if (follow) scroller.scrollTop = scroller.scrollHeight;
          }
        };
        try {
          const nativePrivate = servedByDsbot && !queue.social;
          let initialResult;
          if (job.preferences) {
            feedback(uiLabel('正在加载聊天偏好…', 'Loading chat preferences…'));
            await job.preferences.promise;
            if (pendingSends.get(queue.scope) !== queue || queue.owner !== currentUser?.id) return;
            job.message = {...job.message,...messagePayload(job.message.body, chatLanguage)};
            if (job.storedText) savePendingChatText(document.defaultView, queue.scope, job.key,
              queue.conversationId ? job.message : {...job.message, memory_scope:queue.memoryScope});
            job.preferences = null;
          }
          if (!queue.conversationId) {
            feedback('正在创建对话…');
            const body = {title: '新对话'};
            if (queue.memoryScope !== undefined) body.memory_scope = queue.memoryScope;
            const firstText = nativePrivate && job.key === queue.createKey && !job.files.length && !job.reply && !job.sticker;
            if (firstText) body.first_message = messagePayload(job.message.body, job.message.chat_language);
            const create = () => request('POST', queue.base, body, {'Idempotency-Key': queue.createKey},
              firstText ? AbortSignal.timeout(15000) : undefined);
            const post = () => create().catch(() => ({status: 0, body: {}}));
            let created = firstText ? await post() : await create();
            const active = () => pendingSends.get(queue.scope) === queue && queue.owner === currentUser?.id;
            if (!active()) return;
            if (firstText && (!created.status || created.status === 408 || created.status >= 500)) {
              feedback(uiLabel('正在核对发送结果…', 'Checking delivery…'));
              // The same create key also identifies the first message.
              created = await post();
              if (!active()) return;
            }
            const conversation = created.body.conversation;
            const firstPair = conversation?.id && privateReplyPair(created.body, {...queue,conversationId:conversation.id}, job.key);
            if (![200, 201, 202].includes(created.status) || !conversation?.id ||
                (firstText && (!firstPair || conversation.workspace_id !== queue.wid || conversation.agent_id !== queue.agentId))) {
              throw new Error(messageFor(created.body.error, firstText ? '未能确认发送结果，请重试。' : '创建对话失败，请重试。'));
            }
            if (firstText) initialResult = created;
            const previous = queue.scope;
            const visible = isCurrent();
            if (firstText && job.storedText) {
              savePendingChatText(document.defaultView, previous, job.key);
              job.storedText = false;
            }
            queue.conversationId = conversation.id;
            queue.scope = JSON.stringify([queue.owner, queue.wid, 'agent', queue.agentId, conversation.id]);
            pendingSends.delete(previous);
            memoryDrafts.delete(previous);
            pendingSends.set(queue.scope, queue);
            if (visible) {
              currentConversation = conversation;
              if (servedByDsbot) setPrivateHistory({wid: queue.wid, aid: queue.agentId, cid: conversation.id,
                owner: queue.owner, cursor: null, readingHistory: false});
              renderAgentQuickStarts(currentAgent);
              lastAgentItems = [];
              writeHash({workspace: queue.wid, agent: queue.agentId, conversation: conversation.id});
            }
            publicDraft.move(previous, queue.scope);
            attachmentSender?.moveDraft(previous, queue.scope);
            if (visible) renderPendingSend();
            void loadSessions();
          }
          const path = `${queue.base}/${queue.conversationId}/messages`;
          const headers = {'Idempotency-Key':job.key};
          const progress = job.progress;
          if (progress) {
            progress.hidden = false;
            progress.removeAttribute('value');
          }
          feedback(progress ? uiLabel('正在上传附件…', 'Uploading attachments…') : queue.social ? '正在发送…' : '正在等待智能体回复…');
          let result = initialResult;
          let anchor;
          if (!result) {
            const payload = nativePrivate && !job.files.length && !job.sticker ? {...job.message, accept_pending: true} : job.message;
            const nativeSocial = servedByDsbot && queue.social;
            const receipt = nativePrivate || nativeSocial ? Promise.withResolvers() : null;
            job.acceptReceipt = receipt?.resolve;
            const currentJob = () => pendingSends.get(queue.scope) === queue && queue.jobs.includes(job);
            try {
              const onProgress = percent => {
                if (percent < 100) {
                  progress.value = percent;
                } else {
                  progress.hidden = true;
                  feedback(queue.social
                    ? uiLabel('附件已上传，正在确认发送…', 'File uploaded. Checking delivery…')
                    : uiLabel('附件已上传，正在等待智能体回复…', 'Attachments uploaded. Waiting for the agent…'));
                  beginReply();
                }
              };
              const upload = queue.social ? sendSocialAttachmentMessage : sendPrivateAttachmentMessage;
              const response = progress ? upload(document.defaultView, path, job.message,
                queue.social ? job.files[0] : job.files, {...headers, 'X-CSRF-Token':csrfCookie(document.cookie)}, onProgress)
                : request('POST', path, payload, headers, nativePrivate ? AbortSignal.timeout(240000)
                  : nativeSocial ? AbortSignal.timeout(15000) : undefined);
              if (!progress) beginReply();
              const posted = receipt ? response.catch(() => ({status: 0, body: {}})) : response;
              result = await (receipt ? Promise.race([posted, receipt.promise]) : posted);
              if (nativeSocial && !currentJob()) continue;
              if (nativeSocial && !result.body?.message?.id && unclearSocialDelivery(result.status)) {
                feedback(uiLabel('正在核对发送结果…', 'Checking delivery…'));
                const confirmed = await socialSendReceipt(queue, job.key, currentJob);
                if (!currentJob()) continue;
                if (confirmed) result = {status:200, body:{message:confirmed}};
              }
              if (nativePrivate && uncertainPrivateWrite(result)) {
                if (progress) progress.hidden = true;
                feedback(uiLabel('正在核对发送结果…', 'Checking delivery…'));
                const pair = await confirmPostedSend(queue, job);
                if (pair) result = {status: 200, body: pair};
              }
            } finally {
              if (progress) progress.hidden = true;
              job.acceptReceipt = null;
              if (queue.replying === job) {
                if (isCurrent()) {
                  const scroller = document.getElementById('message-scroller');
                  anchor = {top: scroller.scrollTop, follow: messageScrollerAtBottom(scroller)};
                  if (replyWatch?.key === job.key && (!result?.body?.reply || !waitingAgentReply(result.body.reply))) stopReplyProgress();
                }
                queue.replying = null;
                job.replyView?.bubble.remove();
                job.replyView = null;
              }
            }
          }
          const accepted = [200, 201].includes(result.status) || (nativePrivate && result.status === 202);
          if (!accepted || !result.body.message?.id) {
            const code = result.body.error?.code;
            if (queue.social && result.status === 409 && code === 'reply_unavailable' && job.reply && !job.sticker) {
              if (isCurrent() && restoreUnavailableQuote(queue, job)) continue;
              job.quoteUnavailable = true;
              throw new Error(uiLabel('原消息已不可用。恢复草稿并取消引用后即可发送。',
                'The original message is unavailable. Restore this draft and remove the quote to send.'));
            }
            if (isCurrent() && job.message.direct_agent_request && code === 'direct_agent_unavailable') {
              const refreshed = await openSocialConversation(queue.conversationId, {acknowledge:false});
              const input = document.getElementById('chat-body');
              if (refreshed && isCurrent() && !input.value && !replyDrafts.has(queue.scope) &&
                  agentMentions.restoreDirect(job.message.agent_mentions)) {
                input.value = job.message.body;
                publicDraft.persist();
                if (job.reply) {
                  setReplyDraft(queue.scope, job.reply);
                  if (job.reply.state === 'checking') void restoreReplyDraft(lastSocialItems);
                }
                removeSendJob(queue, job);
                show('error', uiLabel('部分智能体已不可用。消息已恢复到输入框。',
                  'Some agents are unavailable. Your message is back in the composer.'));
                continue;
              }
            }
            if (isCurrent() && code === 'public_chat_closed' && currentConversation?.public_agent) {
              currentConversation.public_agent = {...currentConversation.public_agent, open: false, pending: false};
              showPublicChatState(currentConversation.public_agent);
            }
            if (isCurrent() && result.status === 403 && currentConversation?.direct) {
              void openSocialConversation(queue.conversationId, {refresh:true});
            }
            throw new Error(result.status === 413 ? '附件合计不能超过 8 MB。'
              : code === 'conversation_archived' ? uiLabel('对话已归档，恢复后可以重试。', 'Conversation archived. Restore it to retry.')
              : code === 'attachment_type_blocked' ? '请确认附件的格式与扩展名一致。'
                : messageFor(result.body.error, '未能确认发送结果，请重试。'));
          }
          if (nativePrivate) job.delivery = privateReplyPair(result.body, queue, job.key);
          if (job.delivery && isCurrent() && currentConversation?.deferred) {
            // The first message and reply are committed with the discussion.
            delete currentConversation.deferred;
          }
          const finish = (restored = false) => {
            if (!queue.jobs.includes(job)) return;
            removeSendJob(queue, job);
            if (!isCurrent()) return;
            const append = (items, ...added) => [...items.filter(item => !added.some(row => row.id === item.id)), ...added];
            if (queue.social) {
              renderDeliveredSocialMessage(queue.scope, result.body.message);
              if (currentConversation.public_agent?.open) {
                showPublicChatState({open: true, pending: true});
                schedulePoll(servedByDsbot ? 8000 : 2000);
              } else scheduleSocialPoll(currentConversation);
              show('ok', '已发送。', {announceOnly: true});
            } else {
              const reply = result.body.reply;
              if (!privateHistory?.readingHistory) {
                if (reply?.id) {
                  privateRefresh += 1;
                  const view = restored ? {followLatest: true} : {followLatest: false, anchor};
                  let items = append(lastAgentItems, result.body.message, reply);
                  if (privateHistory && (restored || anchor?.follow !== false) && items.length > Number(HISTORY_PAGE_SIZE)) {
                    items = items.slice(-Number(HISTORY_PAGE_SIZE));
                    privateHistory.cursor = items[0].id;
                    updateHistoryControls();
                  }
                  if (renderAgentMessages(items, view)) schedulePoll();
                } else void openAgentConversation(queue.agentId, queue.conversationId, {refresh: true});
              }
              const notice = sendNotice(reply);
              show(notice.kind, notice.text, notice);
            }
          };
          const socialReceipt = queue.social && result.body.message;
          const tail = lastSocialItems.at(-1)?.seq;
          const pastSocialWindow = servedByDsbot && isCurrent() && viewingSocialMessages() && socialHistory?.readingHistory &&
            !sessionTransition?.pending && ownSocialReceipt(socialReceipt, queue, job.key) &&
            Number.isSafeInteger(socialReceipt.seq) && socialReceipt.seq > (tail ?? 0) + 1;
          if (pastSocialWindow) {
            // Keep the delivered message visible while reopening the latest window.
            // The history read can confirm it without adding it to an older page.
            job.accepted = true;
            feedback(uiLabel('已发送。', 'Sent.'));
            void openSocialLatest().then(opened => {
              if (!queue.jobs.includes(job)) return;
              if (!isCurrent()) removeSendJob(queue, job);
              else if (opened) finish(true);
              else if (job.storedText) {
                savePendingChatText(document.defaultView, queue.scope, job.key);
                job.storedText = false;
              }
            });
          } else {
            const restoring = !queue.social && isCurrent() && privateHistory?.restoring;
            if (restoring) {
              job.accepted = true;
              feedback(uiLabel('已发送。', 'Sent.'));
              void restoring.then(finish, () => finish());
            } else finish();
          }
          if ((!queue.social || !isCurrent()) && queue.owner === currentUser?.id) void loadSessions();
        } catch (error) {
          job.failed = true;
          feedback(error instanceof TypeError || !error?.message ? '未能确认发送结果，请重试。' : error.message);
          if (isCurrent() && !queue.social) syncReplyProgress();
        }
      }
    } finally {
      queue.active = false;
      if (!queue.jobs.length && pendingSends.get(queue.scope) === queue) pendingSends.delete(queue.scope);
      if (isCurrent()) renderPendingSend();
      if (queue.jobs.some(job => !job.failed && !job.accepted)) void drainSends(queue);
    }
  }

  const templateButton = document.getElementById('chat-prompt-templates');
  if (servedByDsbot && templateButton && document.getElementById('chat-prompt-dialog')?.showModal) {
    const composer = document.getElementById('chat-body');
    const scope = () => currentUser && !sendClosed() && !composer.disabled &&
      (currentSource === 'agent' ? currentAgent : currentConversation) ? sendScope() : null;
    const loadTemplates = deferModule('./prompt-templates.mjs');
    let templates;
    const label = uiLabel('提示词模板', 'Prompt templates');
    templateButton.title = label;
    templateButton.setAttribute('aria-label', label);
    templateButton.hidden = false;
    templateButton.addEventListener('click', async () => {
      const opening = scope();
      if (!opening) {
        show('error', uiLabel('请先打开可发送消息的对话。', 'Open a conversation you can send to first.'));
        return;
      }
      try {
        const {mountPromptTemplates} = await loadTemplates();
        if (scope() !== opening) return;
        templates ||= mountPromptTemplates(document, {request, composer, scope, uiLabel});
        templates.open();
      } catch {
        if (scope() === opening) show('error', uiLabel('无法打开提示词模板。请重试。', 'Could not open prompt templates. Try again.'));
      }
    });
  }

  const formatButton = document.getElementById('chat-format');
  const formatMenu = document.getElementById('chat-format-menu');
  const formatBold = document.getElementById('chat-format-bold');
  if (formatButton && formatMenu && formatBold) {
    const closeFormat = () => {
      formatMenu.hidden = true;
      formatButton.setAttribute('aria-expanded', 'false');
    };
    formatButton.addEventListener('click', () => {
      const open = formatMenu.hidden;
      formatMenu.hidden = !open;
      formatButton.setAttribute('aria-expanded', String(open));
    });
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('click', event => {
        if (formatMenu.hidden) return;
        if (event.target && event.target.closest && event.target.closest('.format-wrap')) return;
        closeFormat();
      });
    }
    formatBold.addEventListener('click', () => {
      const field = document.getElementById('chat-body');
      const selection = wrapBold(field.value || '', field.selectionStart, field.selectionEnd);
      field.value = selection.text;
      publicDraft.persist({now: false});
      field.focus();
      if (typeof field.setSelectionRange === 'function') {
        field.setSelectionRange(selection.start, selection.end);
      }
      closeFormat();
    });
  }

  document.getElementById('chat-body').addEventListener('keydown', event => {
    if (agentMentions.keydown(event) || !chatSettings?.ready || !shouldSendOnShortcut(event, sendShortcut)) return;
    event.preventDefault();
    if (!(document.getElementById('chat-body').value || '').trim() && !attachmentSender?.draftFiles?.(sendScope())?.length) return;
    sendCurrentMessage();
  }, true);

  document.getElementById('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    sendCurrentMessage();
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    await load();
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (chatMore?.getAttribute('aria-expanded') === 'true') {
      chatMore.setAttribute('aria-expanded', 'false');
      chatMore.focus();
      return;
    }
    if (!document.getElementById('compose-dialog').hidden && !composePhase) {
      event.preventDefault();
      closeComposeDialog({focus: true});
      return;
    }
    if (isSearchOpen()) closeSearchPanel({focus: true});
  });

  const plus = document.querySelector('details.composer-plus');
  const creatorStatus = document.getElementById('composer-create-status');
  const loadImageCreator = deferModule('./image-create.mjs');
  const loadMediaCreators = deferModule('./video-create.mjs');
  let creatorAttempt = null;
  const mediaContext = () => {
    const workspace = workspaceId();
    if (!servedByDsbot || !currentUser || !workspace || sendClosed()) return null;
    if (currentSource === 'agent' && currentAgent) return {workspace, scope: sendScope()};
    if (currentSource !== 'social' || !currentConversation || currentConversation.public_agent) return null;
    return {workspace, scope: sendScope(), sendLabel: currentConversation.kind === 'group' ? '发送到群聊' : '发送到会话'};
  };
  const imageOptions = {
    request, key: () => idempotencyKey('chat-image-'),
    context() {
      const target = mediaContext();
      return target && {...target, private: !target.sendLabel, attachLabel: target.sendLabel || '添加到输入框'};
    },
    attach: (file, scope) => Boolean(attachmentSender?.addFiles?.([file], scope)),
    onOpen() { if (plus) plus.open = false; },
    notify: show,
  };
  const mediaOptions = type => ({
    request, context: mediaContext, key: () => idempotencyKey('chat-' + type + '-'),
    async share(artifact, scope) {
      if (sendScope() !== scope || currentSource !== 'social' || !currentConversation
          || currentConversation.public_agent || sendClosed()) return {status: 409, body: {}};
      const owner = currentUser.id;
      const result = await request('POST', `${socialBase()}/${currentConversation.id}/messages`,
        {artifact_id: artifact, artifact_revision: 1}, {'Idempotency-Key': 'share-' + type + '-' + artifact});
      if ([200, 201].includes(result.status) && currentUser?.id === owner) {
        renderDeliveredSocialMessage(scope, result.body.message);
      }
      return result;
    },
    onOpen() { if (plus) plus.open = false; },
    notify: show,
  });
  function creatorFeedback(text = '') {
    creatorStatus.textContent = text;
    creatorStatus.hidden = !text;
  }

  function clearCreatorAttempt() {
    creatorAttempt?.trigger.removeAttribute('aria-busy');
    creatorAttempt = null;
    creatorFeedback();
  }

  const creators = [
    ['image', loadImageCreator, 'mountImageCreator', imageOptions],
    ['video', loadMediaCreators, 'mountVideoCreator'],
    ['music', loadMediaCreators, 'mountMusicCreator'],
    ['model3d', loadMediaCreators, 'mountModel3dCreator'],
    ['website', loadMediaCreators, 'mountWebsiteCreator'],
  ].map(([kind, load, mountCreator, options = mediaOptions(kind)]) => {
    const trigger = document.getElementById('composer-' + kind + '-create');
    let controller;
    trigger.addEventListener('click', async () => {
      const target = options.context();
      if (!target || creatorAttempt?.trigger === trigger) return;
      clearCreatorAttempt();
      const text = document.getElementById('chat-body').value.trim();
      if (controller) {
        await controller.open(text);
        return;
      }
      const attempt = creatorAttempt = {trigger, scope: target.scope};
      trigger.setAttribute('aria-busy', 'true');
      creatorFeedback(uiLabel('正在打开创建工具…', 'Opening creation tool…'));
      try {
        const module = await load();
        if (creatorAttempt !== attempt || options.context()?.scope !== attempt.scope || (plus && !plus.open)) return;
        controller = module[mountCreator](document, options);
      } catch {
        if (creatorAttempt === attempt) {
          clearCreatorAttempt();
          creatorFeedback(uiLabel('无法打开创建工具，请再试一次。', 'Couldn’t open the creation tool. Try again.'));
        }
        return;
      } finally {
        if (creatorAttempt === attempt) clearCreatorAttempt();
      }
      await controller.open(text);
    });
    return {sync() {
      if (controller) controller.sync();
      else trigger.disabled = !options.context();
    }};
  });
  const attachInput = document.getElementById('chat-attachment');
  const defaultAccept = attachInput ? attachInput.getAttribute('accept') || '' : '';
  function syncPlusState() {
    syncMemoryRecall();
    if (creatorAttempt && mediaContext()?.scope !== creatorAttempt.scope) clearCreatorAttempt();
    for (const creator of creators) creator.sync();
    const social = currentSource === 'social' && Boolean(currentConversation);
    const shareable = social && !currentConversation.public_agent && currentConversation.direct?.open !== false;
    const workspace = workspaceId();
    const scope = new URLSearchParams();
    if (workspace) {
      scope.set('workspace',workspace);
      if (shareable) scope.set('conversation',currentConversation.id);
    }
    for (const link of document.querySelectorAll('[data-create-artifact]')) {
      link.href = '/space?new=' + link.dataset.createArtifact + (workspace ? '#' + scope : '');
    }
    const agent = currentSource === 'agent' && Boolean(currentAgent);
    const attachment = attachmentContext();
    const available = Boolean(attachment && !attachment.blocked);
    for (const button of document.querySelectorAll('[data-plus-attach]')) {
      button.disabled = !available;
      if (button.dataset.plusAttach === 'video') button.hidden = agent;
    }
    const hint = document.getElementById('plus-attach-hint');
    if (hint) hint.hidden = available;
    attachmentSender?.render();
  }
  if (plus) plus.addEventListener('toggle', () => {
    if (plus.open) syncPlusState();
    else clearCreatorAttempt();
  });
  for (const button of document.querySelectorAll('[data-plus-attach]')) {
    button.addEventListener('click', () => {
      if (!attachInput || button.disabled) return;
      const accept = currentSource === 'agent' ? AGENT_FILE_ACCEPT : defaultAccept;
      attachInput.setAttribute('accept',plusAttachAccept(button.dataset.plusAttach,accept));
      attachInput.click();
      if (plus) plus.open = false;
    });
  }
  if (attachInput) attachInput.addEventListener('change', () => attachInput.setAttribute('accept', defaultAccept));

  globalThis.addEventListener('hashchange', () => {
    clearChatScope();
    return load();
  });
  return load();
}

function mountSessionResize(document) {
  const handle = document.getElementById('session-resize');
  const pane = document.getElementById('session-pane');
  const view = document.defaultView;
  if (!handle || !pane || !view?.matchMedia) return;
  const desktop = view.matchMedia('(min-width: 901px)');
  const key = 'flybot-workspace.chat.session-width';
  const width = () => Math.round(pane.getBoundingClientRect().width);
  const min = 256;
  const max = () => Math.min(540, Math.floor(view.innerWidth * 0.38));
  let preferred = 0;
  try { preferred = Number(view.localStorage.getItem(key)) || 0; } catch {}
  let drag;

  function render(value) {
    const clamped = Math.max(min, Math.min(max(), value));
    if (value) document.body.style.setProperty('--ot-session-width', clamped + 'px');
    else document.body.style.removeProperty('--ot-session-width');
    handle.setAttribute('aria-valuemin', min);
    handle.setAttribute('aria-valuemax', max());
    handle.setAttribute('aria-valuenow', value ? clamped : width());
  }
  function remember(value) {
    preferred = value;
    try {
      if (value) view.localStorage.setItem(key, value);
      else view.localStorage.removeItem(key);
    } catch {}
    render(value);
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    const initial = width();
    drag = {id: event.pointerId, start: event.clientX, width: initial, value: initial};
    handle.setAttribute('data-dragging', '');
    document.body.setAttribute('data-chat-resizing', '');
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    drag.value = Math.max(min, Math.min(max(), drag.width + event.clientX - drag.start));
    render(drag.value);
  });
  function finish(event) {
    if (drag?.id !== event.pointerId) return;
    const {value, width: initial} = drag;
    drag = null;
    handle.removeAttribute('data-dragging');
    document.body.removeAttribute('data-chat-resizing');
    if (event.type === 'pointerup' && value !== initial) remember(value);
    else render(preferred);
  }
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(name, finish);
  handle.addEventListener('keydown', event => {
    const widths = {ArrowLeft:width() - 16, ArrowRight:width() + 16, Home:min, End:max(), Enter:0};
    if (!Object.hasOwn(widths, event.key) || drag) return;
    event.preventDefault();
    const next = widths[event.key];
    remember(next ? Math.max(min, Math.min(max(), next)) : 0);
  });
  handle.addEventListener('dblclick', () => remember(0));
  // The saved preference stays intact while the viewport limits its rendered width.
  view.addEventListener('resize', () => { if (desktop.matches && !drag) render(preferred); });
  handle.hidden = false;
  if (desktop.matches) render(preferred);
}

if (globalThis.document && globalThis.document.getElementById('session-pane')) {
  mountSessionResize(globalThis.document);
  mount(globalThis.document);
}

export function plusAttachAccept(kind, fallback) {
  const all = String(fallback || '').split(',').map(item => item.trim()).filter(Boolean);
  if (kind === 'image') return all.filter(item => item.startsWith('image/')).join(',');
  if (kind === 'video') return all.filter(item => item.startsWith('video/')).join(',');
  return all.join(',');
}

export { canManage, conversationLabel };
