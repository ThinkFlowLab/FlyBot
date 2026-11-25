import { AGENT_CATEGORIES, categoryFromSearch, categoryLabel } from '../shell/agent-categories.mjs';
import { appendWorkTopics, isWorkTopic } from '../shell/work-topics.mjs';
import { csrfCookie } from '../shell/chat-utils.mjs';
import { servedByDsBot } from '../shell/dsbot-api.mjs';
import { discoverLoginHref } from '../shell/discover-link.mjs';
import { bindModel3dPreview } from '../shell/model3d-preview.mjs';
import { renderThumb, spaceHref, thumbModel } from '../shell/thumb.mjs';
import { commentsLabel, mountWorkComments } from './comments.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const AGENT_COPY_GRANT = /^otag_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const VIEWER_USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/;
const CREATOR_HANDLE = /^[a-z0-9][a-z0-9._-]{1,79}$/i;
const MATCH_KINDS = new Set(['title', 'summary', 'body', 'creator']);
const MEDIA_LABELS = {image: '图片', audio: '音频', video: '视频'};
const SEARCH_DELAY = 300;
const WORK_REMIX_KINDS = new Set(['document','website','media','slides','whiteboard']);
const WORK_REMIX_PENDING = '上次复制结果尚未确认。可以重试原请求。';
const BROWSE_RESTORE_PAGES = 12;
const CATALOG_RETURN_LINKS = ['catalog-profile', 'catalog-chat', 'catalog-author'];

export function validSlug(value) {
  return typeof value === 'string' && SLUG.test(value);
}

export function catalogInitial(name) {
  const match = String(name || '').match(/\p{L}|\p{N}/u);
  return match ? match[0].toUpperCase() : '?';
}

// Two-letter monogram for directory cards ("Content Creator" -> "CC"),
// skipping a bracketed prefix such as "[CI FIXTURE]".
export function catalogMonogram(name) {
  const text = String(name || '').replace(/^\s*\[[^\]]*\]\s*/, '');
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return catalogInitial(name);
  if (/^\p{Script=Han}/u.test(words[0])) return words[0].slice(0, 1);
  const letters = words.slice(0, 2).map((word) => word[0].toUpperCase()).join('');
  return letters || catalogInitial(name);
}

export function catalogTone(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return String((hash % 6) + 1);
}

export function catalogItems(body) {
  return Array.isArray(body && body.items) ? body.items : [];
}

export function agentDiscoverPairs(agents, statuses) {
  return (agents || []).map((agent, index) => ({
    agent,
    discover: (statuses || [])[index] || {listed: false},
  })).filter(({agent, discover}) => !(agent.archived || agent.native_deleted) || discover.listed);
}

export function catalogQuery(text = '', cursor = '', category = 'all', creator = '') {
  const params = new URLSearchParams({limit: '12'});
  if (text.trim()) params.set('q', text.trim());
  if (cursor) params.set('cursor', cursor);
  if (category !== 'all') params.set('category', category);
  if (creator) params.set('creator', creator);
  return '/v1/discover/agents?' + params.toString();
}

export const FEED_CATEGORIES = ['网页', '文档', '图片', '音乐', '幻灯片', '视频', '3D 作品', '白板', '看板', '电子表格'];

export const CATALOG_CATEGORIES = AGENT_CATEGORIES.map(({label}) => label);

const TEAM_DIRECTORY_LIMIT = 24;
const TEAM_DIRECTORY_ID = /^[A-Za-z0-9_-]{1,80}$/;
const directoryTeamId = team => team?.team_id || team?.workspace_id || '';
const TEAM_MEMBERSHIP = {member: '已加入', pending: '等待审批', suspended: '已暂停'};
const TEAM_SEARCH_LIMIT = 60;

export const FEED_ACTIVITY_EMPTY_NOTE = '暂时没有公开作品。';
export const FEED_ACTIVITY_LISTED_NOTE = '';
export const FEED_ACTIVITY_NOTE = FEED_ACTIVITY_EMPTY_NOTE;
export const FEED_FOLLOWING_EMPTY_TITLE = '关注列表暂无动态';
export const FEED_FOLLOWING_EMPTY_BODY = '你关注的人发布动态后会显示在这里。';
export const FEED_FOLLOWING_NOTE = '你关注的作者已公开的作品会显示在这里。';
export const FEED_SEARCH_EMPTY_NOTE = '没有匹配的公开作品。';

const FEED_TABS = ['following', 'activity', 'collected'];
export const FEED_KINDS = [
  '', 'website', 'document', 'image', 'audio', 'slides', 'video', 'model3d', 'whiteboard', 'dashboard', 'spreadsheet',
];

export function feedQuery(query, cursor = '', kind = '', sort = 'latest', creator = '', topic = '') {
  const params = new URLSearchParams({limit: '12'});
  if (query) params.set('q', query);
  if (cursor) params.set('cursor', cursor);
  if (kind) params.set('kind', kind);
  if (sort === 'popular' || sort === 'collected') params.set('sort', sort);
  if (creator) params.set('creator', creator);
  if (isWorkTopic(topic)) params.set('category', topic);
  return params.toString();
}

// The feed tab, type, topic, sort and search live in the URL so a filtered feed can be
// shared and survives a refresh. `?tab=agents` stays the catalog switch, and the
// default 动态 feed keeps an empty query string.
export function feedStateFromSearch(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const feed = params.get('feed');
  const tab = feed === 'following' || feed === 'collected' ? feed : 'activity';
  const requestedKind = params.get('kind');
  const kind = FEED_KINDS.includes(requestedKind) ? requestedKind : '';
  const requestedCreator = params.get('creator');
  const creator = CREATOR_HANDLE.test(requestedCreator || '') ? requestedCreator.toLowerCase() : '';
  const topic = params.get('topic');
  return {
    tab,
    kind,
    sort: tab === 'collected' && params.get('sort') === 'collected' ? 'collected'
      : tab === 'activity' && !kind && !creator && params.get('sort') === 'popular' ? 'popular' : 'latest',
    query: (params.get('q') || '').slice(0, 80).trim(),
    ...(creator ? {creator} : {}),
    ...(params.getAll('topic').length === 1 && isWorkTopic(topic) ? {topic} : {}),
  };
}

export function feedSearchText(state) {
  const params = new URLSearchParams();
  const tab = state && state.tab;
  if (tab === 'following' || tab === 'collected') params.set('feed', tab);
  if (state && state.kind && FEED_KINDS.includes(state.kind)) params.set('kind', state.kind);
  if (tab === 'activity' && !state.kind && !state.creator && state.sort === 'popular') params.set('sort', 'popular');
  if (tab === 'collected' && state.sort === 'collected') params.set('sort', 'collected');
  if (state && state.query) params.set('q', state.query);
  if (state && CREATOR_HANDLE.test(state.creator || '')) params.set('creator', state.creator.toLowerCase());
  if (isWorkTopic(state?.topic)) params.set('topic', state.topic);
  const text = params.toString();
  return text ? '?' + text : '';
}

export function workDetailFromSearch(search) {
  const params = new URLSearchParams(search || '');
  const slug = params.get('work');
  if (params.getAll('work').length !== 1 || !validSlug(slug)) return null;
  return {slug, comments: params.get('comments') === '1', share: params.get('share') === '1'};
}

export function workDetailSearchText(state, {slug, comments = false, share = false}) {
  const params = new URLSearchParams(feedSearchText(state));
  if (validSlug(slug)) {
    params.set('work', slug);
    if (comments) params.set('comments', '1');
    if (share) params.set('share', '1');
  }
  return params.size ? '?' + params : '';
}

function workDetailQuery(state) {
  const params = new URLSearchParams(feedSearchText(state));
  const tab = params.get('feed');
  if (tab) {
    params.delete('feed');
    params.set('tab', tab);
  }
  const topic = params.get('topic');
  if (topic) {
    params.delete('topic');
    params.set('category', topic);
  }
  return params.size ? '?' + params : '';
}

export function formatFeedTime(value) {
  if (!value) return '';
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
  }).format(date);
}

export function coverPattern(title) {
  let hash = 0;
  for (const ch of String(title || '')) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return String(hash % 8);
}

const KIND_LABELS = {
  document: '文档', website: '网页', image: '图片', slides: '幻灯片', audio: '音频', video: '视频',
  model3d: '3D 作品', whiteboard: '白板', dashboard: '看板', spreadsheet: '电子表格', media: '媒体',
};

// Native public works expose plain text. Other public previews can include a
// structured thumbnail. Normalize both while keeping the listing body-free.
function normalizeFeedPreview(preview) {
  if (typeof preview !== 'string') return preview;
  const lines = preview.slice(0, 2000).split(/\r?\n/)
    .map(line => line.trim()).filter(Boolean).slice(0, 4);
  return {type: 'document', lines};
}

export function attachFeedThumb(document, cover, preview) {
  if (!cover || !preview || cover.classList.contains('has-thumb')) return false;
  const thumb = renderThumb(document, normalizeFeedPreview(preview));
  if (!thumb) return false;
  cover.classList.add('has-thumb');
  cover.append(thumb);
  return true;
}

export function feedPreviewPath(item) {
  if (!item || Object.hasOwn(MEDIA_LABELS, item.kind) || item.kind === 'model3d' || !validSlug(item.slug)) return '';
  return '/w/' + item.slug + '/preview';
}

export const FEED_DETAIL_MORE = '详情';
export const FEED_DETAIL_LOADING = '正在读取作品摘要…';
// A refused preview is not an empty work: the detail says which one it is.
export const FEED_DETAIL_UNREADABLE = '读不到作品摘要。';
export const FEED_DETAIL_NO_TEXT = '这件作品没有文字摘要，打开原作品看内容。';
export const FEED_DETAIL_EMPTY = '这件作品还没有内容。';

// The detail repeats what the listing already knows plus the bounded, text-only
// preview the public work page exposes. No body is read and stored HTML is
// never interpreted: thumbModel normalises it and every line goes through
// textContent.
export function detailExcerpt(preview) {
  const model = thumbModel(normalizeFeedPreview(preview));
  if (!model || model.empty) return [];
  const lines = [];
  if (model.type === 'document' || model.type === 'website') {
    if (model.heading) lines.push(model.heading);
    for (const line of model.lines || []) lines.push(line);
    for (const block of model.blocks || []) lines.push(block.text);
  } else if (model.type === 'slides') {
    if (model.title) lines.push(model.title);
    for (const bullet of model.bullets || []) lines.push(bullet);
  } else if (model.type === 'dashboard') {
    for (const widget of model.widgets || []) if (widget.title) lines.push(widget.title);
  }
  const kept = [];
  for (const line of lines) {
    const value = String(line == null ? '' : line).replace(/\s+/g, ' ').trim();
    if (value && !kept.includes(value)) kept.push(value);
    if (kept.length >= 4) break;
  }
  return kept;
}

function creatorHandle(item) {
  const handle = item?.creator?.handle;
  return typeof handle === 'string' && CREATOR_HANDLE.test(handle) ? handle.toLowerCase() : '';
}

function authorName(item) {
  return item.creator?.name || item.author || creatorHandle(item);
}

function creatorDirectoryHref(handle, directory = 'works') {
  const params = new URLSearchParams();
  if (directory === 'agents') params.set('tab', 'agents');
  if (handle) params.set('creator', handle);
  return '/discover' + (params.size ? '?' + params : '');
}

function workAuthorLink(document, item) {
  const link = document.createElement('a');
  link.className = 'work-author-link';
  link.href = creatorDirectoryHref(creatorHandle(item));
  link.textContent = authorName(item);
  link.setAttribute('aria-label', '查看 ' + link.textContent + ' 的公开作品');
  return link;
}

function sameWorkCreator(first, second) {
  const handle = creatorHandle(first);
  const other = creatorHandle(second);
  return handle || other ? Boolean(handle && handle === other) : Boolean(first.author && first.author === second.author);
}

export function detailMetaText(item) {
  return [
    item.kind_label || KIND_LABELS[item.kind] || item.kind || '',
    authorName(item),
    formatFeedTime(item.updated),
  ].filter(Boolean).join(' · ');
}

function publicWorkPath(item) {
  if (!validSlug(item.slug)) return '';
  const path = '/w/' + item.slug;
  return item.path === '/social' + path ? item.path : path;
}

function workMediaPath(item, legacyImage) {
  if (!Object.hasOwn(MEDIA_LABELS, item.kind)) return '';
  const workPath = publicWorkPath(item);
  if (!workPath) return '';
  const hasFile = item.file_available === true &&
    (!item.file_mime || (typeof item.file_mime === 'string' && item.file_mime.startsWith(item.kind + '/')));
  const oldImage = legacyImage && item.kind === 'image' && item.file_available === undefined;
  return hasFile || oldImage ? workPath + '/file' : '';
}

function mediaFileSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function workMatch(match) {
  if (!MATCH_KINDS.has(match?.kind) || typeof match.text !== 'string' || !match.text.trim()) return;
  const {text, start, end} = match;
  if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= text.length) {
    return match;
  }
}

function appendMatch(document, target, {text, start, end}) {
  const mark = document.createElement('mark');
  mark.textContent = text.slice(start, end);
  target.append(text.slice(0, start), mark, text.slice(end));
}

function renderFeedByline(document, item, {linkAuthor = false} = {}) {
  const meta = document.createElement('p');
  meta.className = 'meta feed-byline';
  const mark = document.createElement('span');
  mark.className = 'feed-author-mark avatar';
  mark.setAttribute('aria-hidden', 'true');
  const author = authorName(item);
  mark.dataset.tone = String(catalogTone(author || item.title || ''));
  mark.textContent = catalogMonogram(author || item.title || '');
  const who = document.createElement('span');
  const when = formatFeedTime(item.updated);
  if (linkAuthor) {
    who.append(workAuthorLink(document, item));
    if (when) who.append(' · ' + when);
  } else {
    who.textContent = [author, when].filter(Boolean).join(' · ');
  }
  meta.append(mark, who);
  if (item.likes != null) {
    const likes = document.createElement('span');
    likes.className = 'feed-likes';
    likes.textContent = '♡ ' + (item.likes || 0);
    meta.append(likes);
  }
  return meta;
}

export function renderFeedCard(document, item, {legacyImage = false, includeByline = true} = {}) {
  const card = document.createElement('a');
  card.className = 'feed-card';
  card.href = publicWorkPath(item) || '/discover';
  const cover = document.createElement('div');
  cover.className = 'work-cover';
  cover.dataset.kind = item.kind || 'work';
  cover.dataset.pattern = coverPattern(item.title || item.slug || '');
  cover.setAttribute('aria-hidden', 'true');
  const imageFile = item.kind === 'image' && workMediaPath(item, legacyImage);
  if (imageFile) {
    const image = document.createElement('img');
    image.className = 'work-cover-image';
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.fetchPriority = 'low';
    image.width = 320;
    image.height = 200;
    image.addEventListener('error', () => { image.hidden = true; });
    image.src = imageFile;
    cover.append(image);
  } else if (!Object.hasOwn(MEDIA_LABELS, item.kind)) {
    attachFeedThumb(document, cover, item.preview);
  }
  const kind = document.createElement('p');
  kind.className = 'kind';
  kind.textContent = item.kind_label || KIND_LABELS[item.kind] || item.kind || '';
  const title = document.createElement('h3');
  const match = workMatch(item.match);
  const titleMatch = match?.kind === 'title' && match.text === item.title;
  if (titleMatch) appendMatch(document, title, match);
  else title.textContent = item.title || '';
  card.append(cover, kind, title);
  if (match && !titleMatch) {
    const excerpt = document.createElement('p');
    excerpt.className = 'feed-search-excerpt';
    appendMatch(document, excerpt, match);
    card.append(excerpt);
  }
  if (includeByline) card.append(renderFeedByline(document, item));
  return card;
}

export function isAgentsCatalog(location) {
  const search = location && typeof location.search === 'string' ? location.search : '';
  const params = new URLSearchParams(search);
  return params.get('tab') === 'agents' && !params.has('section');
}

export function isTeamsCatalog(location) {
  const search = location && typeof location.search === 'string' ? location.search : '';
  const params = new URLSearchParams(search);
  return params.get('tab') === 'agents' && params.get('section') === 'groups';
}

function teamDirectoryQuery(text, cursor = '') {
  const params = new URLSearchParams({limit: String(TEAM_DIRECTORY_LIMIT)});
  if (text) params.set('q', text);
  if (cursor) params.set('cursor', cursor);
  return '/v1/team-directory?' + params.toString();
}

export function renderTeamCard(document, team, {joining = false, onJoin} = {}) {
  const card = document.createElement('article');
  const heading = document.createElement('div');
  heading.className = 'team-card-heading';
  const mark = document.createElement('span');
  mark.className = 'catalog-avatar';
  mark.dataset.tone = catalogTone(team.name);
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = catalogMonogram(team.name);
  const name = document.createElement('h3');
  name.textContent = team.name;
  heading.append(mark, name);
  card.append(heading);
  if (team.summary) {
    const summary = document.createElement('p');
    summary.className = 'team-summary';
    summary.textContent = team.summary;
    card.append(summary);
  }
  const foot = document.createElement('div');
  foot.className = 'team-foot';
  const count = document.createElement('span');
  count.className = 'team-size';
  const members = Number(team.member_count);
  count.textContent = Number.isInteger(members) && members >= 0 ? `${members} 位成员` : '';
  foot.append(count);
  const membership = Object.hasOwn(TEAM_MEMBERSHIP, team.membership) ? TEAM_MEMBERSHIP[team.membership] : '';
  if (membership) {
    const state = document.createElement('span');
    state.className = 'team-membership';
    state.dataset.state = team.membership;
    state.textContent = membership;
    foot.append(state);
    if (team.membership === 'member' && /^[a-f0-9]{32}$/.test(team.workspace_id || '')) {
      const open = document.createElement('a');
      open.className = 'team-open';
      open.href = '/members#workspace=' + team.workspace_id;
      open.textContent = '打开工作区';
      open.setAttribute('aria-label', '打开工作区：' + team.name);
      foot.append(open);
    }
  } else if (onJoin && TEAM_DIRECTORY_ID.test(directoryTeamId(team))) {
    const join = document.createElement('button');
    join.type = 'button';
    join.className = 'team-join';
    join.disabled = joining;
    join.textContent = joining ? '正在申请…' : '申请加入';
    join.setAttribute('aria-label', `${join.textContent} ${team.name}`);
    join.addEventListener('click', () => onJoin(team));
    foot.append(join);
  }
  card.append(foot);
  return card;
}

export function reuseKey(seed = Date.now()) {
  return 'discover-reuse-' + seed.toString(36) + '-' +
    Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

export function mount(document, { fetcher = globalThis.fetch.bind(globalThis), location = globalThis.location, history = globalThis.history, window = globalThis } = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const loginLink = document.getElementById('discover-login');
  function syncLoginLink() {
    if (loginLink) loginLink.href = discoverLoginHref(location?.search);
  }
  syncLoginLink();
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  const nativeCatalog = servedByDsBot(document);
  let currentUser = null;
  let sessionRequest = 0;
  let sessionPending;
  let sessionState = 'pending';
  let workspaceListState = 'loading';
  let catalog = [];
  const catalogViewers = new WeakMap();
  const catalogActions = new Map();
  let cursor = '';
  let catalogPages = 0;
  let catalogDeparture = null;
  let activeQuery = '';
  let activeCategory = categoryFromSearch(location?.search);
  let remix = null;
  let manageRequest = 0;
  let catalogRequest = 0;
  let catalogReader;
  let activeTeamQuery = '';
  const joiningTeams = new Set();
  const directoryItems = new Map();
  const directoryRows = new Map();
  const directoryReceipts = new Map();
  const agentsView = isAgentsCatalog(location);
  const manageParams = new URLSearchParams(location?.search || '');
  const requestedAuthor = agentsView && manageParams.get('creator');
  let activeCreator = CREATOR_HANDLE.test(requestedAuthor || '')
    ? {handle: requestedAuthor.toLowerCase(), name: '@' + requestedAuthor.toLowerCase()} : null;
  const manageWorkspace = manageParams.get('workspace');
  const manageAgent = manageParams.get('agent');
  const agentShare = agentsView && nativeCatalog && manageParams.getAll('share').length === 1 &&
    AGENT_COPY_GRANT.test(manageParams.get('share')) ? manageParams.get('share') : null;
  const teamsView = isTeamsCatalog(location);
  const catalogView = agentsView || teamsView;
  const catalogSearch = document.getElementById('catalog-query');
  const catalogEmptyReset = document.getElementById('catalog-empty-reset');
  if (catalogView) catalogSearch.value = (manageParams.get('q') || '').trim().slice(0, teamsView ? TEAM_SEARCH_LIMIT : 80);

  function saveCatalogQuery() {
    const params = new URLSearchParams(location?.search);
    const query = catalogSearch.value.trim().slice(0, teamsView ? TEAM_SEARCH_LIMIT : 80);
    if (query === (params.get('q') || '')) return;
    if (query) params.set('q', query);
    else params.delete('q');
    history?.replaceState?.(null, '', '/discover?' + params.toString());
    syncLoginLink();
  }

  function clearCatalogSearch({allFilters = false} = {}) {
    catalogSearch.value = '';
    if (allFilters && agentsView) {
      activeCategory = 'all';
      activeCreator = null;
      const params = new URLSearchParams(location?.search);
      for (const key of ['q', 'category', 'creator']) params.delete(key);
      history?.replaceState?.(null, '', '/discover?' + params.toString());
      syncLoginLink();
    } else saveCatalogQuery();
    catalogSearch.focus?.({preventScroll:true});
    return agentsView ? loadCatalog() : loadTeams();
  }

  const initialFeed = feedStateFromSearch(catalogView ? '' : location?.search);
  if (!nativeCatalog && initialFeed.sort === 'collected') initialFeed.sort = 'latest';
  const feedSections = document.getElementById('feed-sections');
  const directoryTabs = document.getElementById('discover-tabs');
  if (!catalogView && feedSections && directoryTabs) {
    feedSections.append(directoryTabs);
    mainPanel.classList?.add('discover-feed-mode');
    const toolbar = feedSections.parentElement;
    const search = document.getElementById('feed-search');
    const compact = document.defaultView?.matchMedia?.('(max-width: 45rem)');
    if (toolbar && search && compact) {
      const orderControls = ({matches}) => {
        const [first, last] = matches ? [feedSections, search] : [search, feedSections];
        if (toolbar.firstElementChild === first) return;
        if (first.contains(document.activeElement)) toolbar.append(last);
        else toolbar.prepend(first);
      };
      orderControls(compact);
      compact.addEventListener('change', orderControls);
    }
  }

  function setCurrent(id, on) {
    const node = document.getElementById(id);
    if (!node) return;
    if (on) node.setAttribute('aria-current', 'page');
    else if (typeof node.removeAttribute === 'function') node.removeAttribute('aria-current');
    else if (node.attributes) delete node.attributes['aria-current'];
  }

  function setCreatorDirectoryTabs(handle) {
    const feed = document.getElementById('catalog-tab-feed');
    const agents = document.getElementById('catalog-tab-agents');
    if (feed) feed.href = creatorDirectoryHref(handle);
    if (agents) agents.href = creatorDirectoryHref(handle, 'agents');
  }

  function applyCatalogChrome() {
    setCurrent('catalog-tab-feed', !catalogView);
    setCurrent('catalog-tab-agents', agentsView);
    setCurrent('catalog-tab-teams', teamsView);
    const agentFilters = document.getElementById('catalog-filters');
    if (agentFilters) agentFilters.hidden = !agentsView;
    const createAgent = document.getElementById('catalog-create-agent');
    const createTeam = document.getElementById('catalog-create-team');
    const createAgentTeam = document.getElementById('catalog-create-agent-team');
    if (createAgentTeam) createAgentTeam.hidden = !teamsView || !currentUser;
    if (createAgent) createAgent.hidden = !agentsView || !currentUser;
    if (createTeam) createTeam.hidden = !teamsView;
    const query = document.getElementById('catalog-query');
    if (query) {
      query.placeholder = teamsView ? '搜索 AI 团队…' : '搜索智能体…';
      if (teamsView) query.maxLength = TEAM_SEARCH_LIMIT;
    }
    if (typeof document.querySelector === 'function') {
      const queryLabel = document.querySelector('label[for="catalog-query"]');
      if (queryLabel) queryLabel.textContent = teamsView ? '搜索 AI 团队' : '搜索智能体';
    }
    const heading = document.getElementById('catalog-heading');
    if (heading) heading.textContent = teamsView ? '公共 AI 团队' : '公共智能体';
    const list = document.getElementById('discover-list');
    if (list && list.classList) {
      if (teamsView) list.classList.add('teams-catalog');
      else list.classList.remove('teams-catalog');
    }
  }

  function renderTeamRow(team) {
    const id = directoryTeamId(team);
    let row = directoryRows.get(id);
    if (!row) {
      row = document.createElement('li');
      row.dataset.teamDirectoryRef = id;
      directoryRows.set(id, row);
      document.getElementById('discover-list').append(row);
    }
    row.replaceChildren(renderTeamCard(document, team, {
      joining: joiningTeams.has(id),
      onJoin: applyTeam,
    }));
  }

  async function applyTeam(team) {
    const id = directoryTeamId(team);
    const user = currentUser;
    if (!user || joiningTeams.has(id) || !TEAM_DIRECTORY_ID.test(id)) return;
    const row = directoryRows.get(id);
    const button = row?.querySelector?.('.team-join');
    const hadFocus = button && document.activeElement === button;
    joiningTeams.add(id);
    renderTeamRow(team);
    show('', '');
    try {
      const response = await request('POST', '/v1/team-directory/' + encodeURIComponent(id) + '/join', {});
      const next = response.status === 202 ? 'pending' : response.status === 200 ? response.body.status : '';
      if (currentUser !== user) return;
      if (!Object.hasOwn(TEAM_MEMBERSHIP, next)) {
        show('error', messageFor(response.body.error, '无法提交加入申请，请重试。'));
        return;
      }
      const current = directoryItems.get(id);
      const keepStatus = current?.membership === 'suspended' || (current?.membership === 'member' && next === 'pending');
      const membership = keepStatus ? current.membership : next;
      const workspace = response.body.workspace_id;
      const changes = {membership, ...(membership === 'member' && /^[a-f0-9]{32}$/.test(workspace || '') ? {workspace_id:workspace} : {})};
      directoryReceipts.set(id, {changes, read:catalogRequest});
      if (current) directoryItems.set(id, {...current, ...changes});
      show('ok', membership === 'pending' ? '已提交申请，等待团队管理员审批。' : TEAM_MEMBERSHIP[membership]);
    } catch {
      if (currentUser === user) show('error', '连接失败，暂时无法确认申请结果。可刷新重试。');
    } finally {
      joiningTeams.delete(id);
      const current = directoryItems.get(id);
      if (currentUser === user && current) {
        renderTeamRow(current);
        if (hadFocus && document.activeElement === document.body) {
          const target = directoryRows.get(id)?.querySelector?.('.team-join, .team-membership');
          if (target) {
            if (target.matches('.team-membership')) target.tabIndex = -1;
            target.focus({preventScroll:true});
          }
        }
      }
    }
  }

  async function loadTeams(append = false) {
    const panel = document.getElementById('catalog-panel');
    if (append && (!cursor || panel.getAttribute('aria-busy') === 'true')) return;
    const seq = ++catalogRequest;
    const scope = sessionRequest;
    const user = currentUser;
    const empty = document.getElementById('discover-empty');
    const error = document.getElementById('catalog-error');
    const retry = document.getElementById('teams-retry');
    const count = document.getElementById('catalog-count');
    const more = document.getElementById('catalog-more');
    const shouldFocus = append && (document.activeElement === more || document.activeElement === retry);
    if (!append) {
      catalogReader?.abort();
      catalogReader = new AbortController();
      activeTeamQuery = catalogSearch.value.trim().slice(0, TEAM_SEARCH_LIMIT);
      directoryItems.clear();
      directoryRows.clear();
      directoryReceipts.clear();
      document.getElementById('discover-list').replaceChildren();
      cursor = '';
      catalogPages = 0;
      catalogDeparture = null;
    }
    more.hidden = !append;
    more.disabled = true;
    more.textContent = '加载更多';
    empty.hidden = true;
    catalogEmptyReset.hidden = true;
    error.hidden = true;
    retry.hidden = true;
    if (!user) {
      panel.setAttribute('aria-busy', String(Boolean(sessionPending)));
      count.textContent = sessionPending ? '正在确认登录状态…' : '';
      if (sessionState === 'failed') {
        error.textContent = '暂时无法确认登录状态。';
        error.hidden = false;
        retry.hidden = false;
      } else if (!sessionPending) {
        empty.textContent = '登录后可查看并申请加入公开团队。';
        empty.hidden = false;
      }
      return;
    }
    panel.setAttribute('aria-busy', 'true');
    count.textContent = append ? '正在加载更多团队…' : '正在加载团队…';
    const requested = cursor;
    const isCurrent = () => seq === catalogRequest && scope === sessionRequest && user === currentUser;
    try {
      const result = await request('GET', teamDirectoryQuery(activeTeamQuery, requested), undefined, undefined, catalogReader.signal);
      if (!isCurrent()) return;
      if (result.status !== 200) throw new Error(messageFor(result.body.error, '无法加载团队目录。'));
      let firstAdded;
      for (const item of catalogItems(result.body)) {
        const id = directoryTeamId(item);
        if (!TEAM_DIRECTORY_ID.test(id) || directoryItems.has(id)) continue;
        const receipt = directoryReceipts.get(id);
        const newerMembership = item.membership === 'suspended' ||
          (item.membership === 'member' && receipt?.changes.membership === 'pending');
        const team = receipt?.read === seq && !newerMembership ? {...item, ...receipt.changes} : item;
        directoryItems.set(id, team);
        renderTeamRow(team);
        firstAdded ??= directoryRows.get(id);
      }
      const next = result.body.cursor;
      cursor = typeof next === 'string' && next !== requested ? next : '';
      catalogPages += 1;
      more.hidden = !cursor;
      more.disabled = false;
      if (shouldFocus && [document.body, more, retry].includes(document.activeElement)) {
        const first = firstAdded?.querySelector?.('h3');
        const last = !cursor && document.getElementById('discover-list').lastElementChild?.querySelector?.('h3');
        const heading = first || last;
        if (heading) {
          heading.tabIndex = -1;
          heading.focus();
        } else if (cursor) more.focus({preventScroll:true});
      }
      count.textContent = directoryItems.size ? `已显示 ${directoryItems.size} 个团队` : '';
      empty.textContent = activeTeamQuery ? '没有匹配的团队。'
        : '暂无公开团队。创建团队后，可在成员页的「团队目录」中公开。';
      empty.hidden = directoryItems.size > 0;
      catalogEmptyReset.hidden = empty.hidden || !activeTeamQuery;
      return seq;
    } catch (failure) {
      if (!isCurrent()) return;
      count.textContent = directoryItems.size ? `已显示 ${directoryItems.size} 个团队` : '';
      error.textContent = failure.message || '无法加载团队目录。';
      error.hidden = false;
      retry.hidden = append;
      if (append) {
        more.textContent = '重试加载更多';
        more.disabled = false;
        if (shouldFocus && document.activeElement === document.body) more.focus({preventScroll:true});
      }
    } finally {
      if (isCurrent()) {
        more.disabled = false;
        panel.setAttribute('aria-busy', 'false');
      }
    }
  }

  async function loadMoreTeams() {
    if (await loadTeams(true) === catalogRequest) rememberCatalogPosition();
  }

  function showDiscoverView() {
    const feed = document.getElementById('feed-panel');
    const catalog = document.getElementById('catalog-view');
    if (feed) feed.hidden = catalogView;
    if (catalog) catalog.hidden = !catalogView;
    applyCatalogChrome();
  }

  const feedState = {...initialFeed, items: [], cursor: '', loading: false};
  const followedCreators = document.getElementById('feed-followed-creators');
  const collectedSortField = document.getElementById('feed-collected-sort-field');
  const collectedSort = document.getElementById('feed-collected-sort');
  let followedCreatorPicker;
  let followedCreatorSetup;
  let feedRequest = 0;
  let feedReader;
  let feedViewer;
  let feedPages = 0;
  let feedFailure;
  let feedRestore;
  let searchTimer;
  let composingQuery = false;
  const feedPositions = new Map();
  const feedActions = new Map();
  const engagementPending = new Map();
  const commentButtons = new Map();
  const workTriggers = new Map();
  const searchInput = document.getElementById('feed-query');
  const topicFilter = document.getElementById('feed-topic');
  appendWorkTopics(document, topicFilter);
  const clearSearch = document.getElementById('feed-clear');
  const resetEmptyFeed = document.getElementById('feed-empty-reset');
  const retryFeed = document.getElementById('feed-retry');
  const detail = Object.fromEntries([
    'back', 'paper', 'title', 'meta', 'status', 'retry', 'resume-remix', 'preview', 'reader', 'actions', 'open', 'download',
    'like', 'collect', 'follow', 'comments', 'share', 'remix', 'previous', 'next', 'library', 'library-saved', 'library-author',
  ].map(name => [name, document.getElementById('work-detail-' + name)]));
  const share = Object.fromEntries(['dialog', 'url', 'status', 'copy', 'native', 'close']
    .map(name => [name, document.getElementById('work-share-' + name)]));
  const chatSharePanel = document.getElementById('work-chat-share-panel');
  chatSharePanel.hidden = true;
  let chatShareReady;
  const workRemix = Object.fromEntries(['dialog','form','source','name','name-field','status','close','refresh','submit','open']
    .map(name => [name,document.getElementById('work-remix-'+name)]));
  const detailPanel = document.getElementById('work-detail');
  const initialView = document.getElementById('main');
  const engagement = [['like', 'liked', '点赞'], ['collect', 'collected', '收录'], ['follow', 'following', '关注作者']];
  const workRemixAttempts = new Map();
  let activeWork;
  let activeRemix;
  let feedReturn;

  const workComments = mountWorkComments(document, {
    request,
    loginHref: slug => discoverLoginHref(workDetailSearchText(feedState, {slug, comments: true})),
    onCount(slug, count) {
      const item = feedState.items.find(work => work.slug === slug);
      if (item) item.comment_count = count;
      const button = commentButtons.get(slug);
      if (button) button.textContent = commentsLabel(count);
      if (activeWork?.item?.slug === slug) {
        activeWork.item.comment_count = count;
        detail.comments.textContent = commentsLabel(count);
      }
    },
  });

  function setWorkView(open) {
    if (open) followedCreatorPicker?.close();
    detailPanel.hidden = !open;
    document.getElementById('feed-panel').hidden = open;
    document.getElementById('discover-title').hidden = open;
    document.getElementById('discover-tabs').hidden = open;
  }

  function disposeWorkPreview() {
    activeWork?.disposeReader?.();
    detail.reader.replaceChildren();
    activeWork?.model?.setSource('');
    if (activeWork?.media) {
      const player = activeWork.media;
      activeWork.media = null;
      player.pause?.();
      player.removeAttribute('src');
      player.load?.();
    }
    detail.preview.replaceChildren();
  }

  function restoreFeedPosition(position, {focus = true} = {}) {
    const control = position.focusId && document.getElementById(position.focusId);
    const card = workTriggers.get(position.slug);
    const workTrigger = position.detailButton ? card?.closest?.('.feed-entry')?.querySelector?.('.feed-detail-toggle') || card : card;
    const target = position.trigger?.isConnected ? position.trigger : workTrigger || (control && !control.hidden ? control : null);
    initialView.scrollTop = position.scroll;
    if (focus) (target || document.getElementById('feed-tab-' + feedState.tab))?.focus?.({preventScroll: true});
    if (target && Number.isFinite(position.offset)) {
      initialView.scrollTop += target.getBoundingClientRect().top - initialView.getBoundingClientRect().top - position.offset;
    }
  }

  function closeWorkDetail({restore = true} = {}) {
    if (!activeWork) return;
    activeWork.controller.abort();
    disposeWorkPreview();
    workComments.close();
    if (share.dialog.open) share.dialog.close();
    closeWorkRemix();
    activeWork = null;
    setWorkView(false);
    restoreFeedPosition(restore && feedReturn ? feedReturn : {scroll: 0});
    feedReturn = null;
  }

  function activeWorkEntry(entry) {
    return activeWork === entry && entry.scope === sessionRequest;
  }

  function matchesNativeViewer(name, account = currentUser) {
    return typeof name === 'string' && VIEWER_USERNAME.test(name) && name === account?.username;
  }

  function setAdjacent(entry, name, neighbor) {
    const slug = validSlug(neighbor?.slug) && neighbor.slug !== entry.slug ? neighbor.slug : '';
    entry[name] = slug;
    const button = detail[name];
    button.disabled = !slug;
    button.title = slug ? String(neighbor.title || '') : '';
  }

  function syncGuestWorkNavigation(entry = activeWork) {
    if (!entry?.ready || entry.viewer !== null) return;
    const works = feedViewer === null && feedState.tab === 'activity' ? feedState.items : [];
    const index = works.findIndex(item => item.slug === entry.slug);
    const fallback = index < 0 && entry.publicNeighbors?.scope === feedSearchText(feedState) ? entry.publicNeighbors : null;
    setAdjacent(entry, 'previous', index > 0 ? works[index - 1] : fallback?.previous);
    setAdjacent(entry, 'next', index >= 0 ? works[index + 1] : fallback?.next);
    entry.canPageNext = index >= 0 && index === works.length - 1 && Boolean(feedState.cursor);
    detail.next.disabled = Boolean(entry.loadingNext || (!entry.next && (!entry.canPageNext || feedState.loading || feedRestore)));
    detail.next.setAttribute('aria-busy', String(Boolean(entry.loadingNext)));
  }

  function openAdjacentWork(entry, slug) {
    const item = entry.viewer === null ? feedState.items.find(work => work.slug === slug) : null;
    return openWorkDetail({slug}, {item, navigate: true});
  }

  async function loadNextGuestWork(entry) {
    if (!entry.canPageNext || feedState.loading || feedRestore || entry.loadingNext) return;
    entry.loadingNext = true;
    syncGuestWorkNavigation(entry);
    detail.status.textContent = '正在加载下一件作品…';
    const loaded = await loadFeed({append: true});
    if (!activeWorkEntry(entry)) return;
    entry.loadingNext = false;
    syncGuestWorkNavigation(entry);
    if (loaded && entry.next) return openAdjacentWork(entry, entry.next);
    if (!loaded) detail.status.textContent = '未能加载下一件作品，请重试。';
    else if (entry.canPageNext) detail.status.textContent = '这页没有新的作品，可以继续加载。';
    else detail.status.textContent = '当前列表没有可继续浏览的作品。';
  }

  function workUrl(intent) {
    return '/discover' + workDetailSearchText(feedState, intent);
  }

  async function openWorkDetail(intent, {item, trigger, navigate = false} = {}) {
    if (!intent || !validSlug(intent.slug)) return;
    cancelSearch();
    const existing = activeWork;
    if (!existing) {
      feedReturn = {...captureFeedPosition(trigger, intent.slug), trigger};
      if (navigate) rememberFeedPosition(feedReturn, {persist: true});
    }
    if (navigate) {
      const url = workUrl(intent);
      if (existing) history?.replaceState?.(history.state, '', url);
      else history?.pushState?.({discoverWork: true}, '', url);
      syncLoginLink();
    }

    existing?.controller.abort();
    disposeWorkPreview();
    workComments.close();
    if (share.dialog.open) share.dialog.close();
    closeWorkRemix();
    const entry = {slug: intent.slug, item: null, intent, scope: sessionRequest, outcome: 'loading', controller: new AbortController()};
    activeWork = entry;
    setWorkView(true);
    initialView.scrollTop = 0;
    detail.title.textContent = item?.title || '作品详情';
    renderWorkMeta(item);
    detail.status.textContent = '正在加载作品…';
    detail.retry.hidden = true;
    detail['resume-remix'].hidden = true;
    detail.actions.hidden = true;
    detail.comments.hidden = true;
    detail.paper.setAttribute('aria-busy', 'true');
    setAdjacent(entry, 'previous');
    setAdjacent(entry, 'next');
    detail.next.setAttribute('aria-busy', 'false');
    setWorkEngagement(entry);
    detail.title.focus?.({preventScroll: true});

    const checkingSession = sessionPending;
    const signedFeedCard = nativeCatalog && item?.slug === intent.slug && matchesFeedViewer(feedViewer);
    // The public preview can paint while the owner plugin checks signed actions.
    const publicRead = !currentUser || signedFeedCard
      ? loadPublicWork(entry, {includeNeighbors: !currentUser}) : null;
    const path = '/v1/discover/works/' + intent.slug + workDetailQuery(feedState);
    const readScopedWork = () => request('GET', path, undefined, {}, entry.controller.signal).catch(() => ({status: 0}));
    const earlyScoped = nativeCatalog && checkingSession ? readScopedWork() : null;
    if (checkingSession) await checkingSession;
    if (!activeWorkEntry(entry)) return;
    const viewer = currentUser;
    if (!viewer) {
      const result = await publicRead;
      if (!activeWorkEntry(entry)) return;
      if (!entry.item) return failWorkDetail(entry, result.status);
      return finishWorkDetail(entry, null);
    }
    showWorkRemixRecovery(entry);

    const wrongViewer = result => nativeCatalog && result.status === 200 &&
      !matchesNativeViewer(result.body?.viewer_username, viewer);
    let result = await (earlyScoped || readScopedWork());
    if (!activeWorkEntry(entry) || currentUser !== viewer) return;
    // Only reuse a speculative read if it identifies this work and the verified viewer.
    if (wrongViewer(result) || (earlyScoped && (result.status !== 200 || result.body?.work?.slug !== entry.slug))) {
      result = await readScopedWork();
    }
    if (!activeWorkEntry(entry) || currentUser !== viewer) return;
    if (result.status === 404) return failWorkDetail(entry, 404);
    if (result.status !== 200 || result.body?.work?.slug !== entry.slug || wrongViewer(result)) {
      failWorkDetail(entry, result.status);
      return publicRead;
    }

    entry.outcome = 'confirmed';
    showWork(entry, result.body.work);
    return finishWorkDetail(entry, viewer, result.body);
  }

  async function loadPublicWork(entry, {includeNeighbors}) {
    const scope = feedSearchText(feedState);
    const useNeighbors = includeNeighbors && feedState.tab === 'activity' && feedState.sort === 'latest' &&
      (feedViewer !== null || !feedState.items.some(item => item.slug === entry.slug));
    const parameters = new URLSearchParams(useNeighbors ? scope : '');
    parameters.set('view', 'preview');
    if (useNeighbors) parameters.set('nav', 'latest');
    const path = '/w/' + entry.slug + '?' + parameters;
    const result = await request('GET', path, undefined, {}, entry.controller.signal).catch(() => ({status: 0}));
    if (!activeWorkEntry(entry) || entry.outcome === 'confirmed' || entry.outcome === 'denied') return result;
    const work = result.body;
    if (result.status !== 200 || work?.slug !== entry.slug ||
        typeof work.title !== 'string' || typeof work.kind !== 'string') return result;

    if (useNeighbors) entry.publicNeighbors = {scope, previous:work.previous, next:work.next};
    showWork(entry, work, work.preview);
    if (entry.outcome === 'unavailable') failWorkDetail(entry, 0);
    else if (entry.outcome === 'loading') detail.status.textContent = '';
    return result;
  }

  function renderWorkMeta(work) {
    if (!work || !creatorHandle(work)) {
      detail.meta.textContent = work ? detailMetaText(work) : '';
      return;
    }
    const type = work.kind_label || KIND_LABELS[work.kind] || work.kind || '';
    const when = formatFeedTime(work.updated);
    detail.meta.replaceChildren();
    if (type) detail.meta.append(type + ' · ');
    detail.meta.append(workAuthorLink(document, work));
    if (when) detail.meta.append(' · ' + when);
  }

  function showWork(entry, work, inlinePreview) {
    entry.item = work;
    detail.title.textContent = work.title || work.slug;
    renderWorkMeta(work);
    detail.open.href = publicWorkPath(work);
    const file = workMediaPath(work, !nativeCatalog);
    detail.download.hidden = !file;
    if (file) {
      detail.download.href = file;
      detail.download.download = '';
      const size = mediaFileSize(work.file_bytes);
      detail.download.textContent = size ? '下载原文件 · ' + size : '下载原文件';
    } else {
      detail.download.removeAttribute('href');
    }
    detail.actions.hidden = false;
    detail.paper.setAttribute('aria-busy', 'false');
    const key = JSON.stringify([work.slug, work.kind, work.title, work.updated, work.site_available === true,
      work.kind === 'model3d' ? publicWorkPath(work) : file]);
    if (key !== entry.previewKey) {
      disposeWorkPreview();
      entry.previewKey = key;
      entry.preview = renderWorkPreview(entry, work, key, inlinePreview, file);
    }
  }

  function finishWorkDetail(entry, viewer, {previous, next} = {}) {
    entry.ready = true;
    entry.viewer = viewer;
    detail.status.textContent = '';
    detail.retry.hidden = true;
    detail.comments.hidden = false;
    detail.comments.textContent = commentsLabel(entry.item.comment_count);
    setWorkEngagement(entry);
    if (viewer) {
      setAdjacent(entry, 'previous', previous);
      setAdjacent(entry, 'next', next);
    } else syncGuestWorkNavigation(entry);
    if (entry.intent.comments) return Promise.all([entry.preview, workComments.open(entry.item, detail.comments)]);
    if (entry.intent.share) openWorkShare();
    else if (share.dialog.open) syncWorkChatShare(entry);
    return entry.preview;
  }

  function failWorkDetail(entry, status) {
    entry.outcome = status === 404 ? 'denied' : 'unavailable';
    detail.paper.setAttribute('aria-busy', 'false');
    if (entry.outcome === 'denied') {
      disposeWorkPreview();
      entry.item = null;
      detail.title.textContent = '作品详情';
      detail.meta.textContent = '';
      detail.actions.hidden = true;
    }
    detail.status.textContent = entry.outcome === 'denied'
      ? '这件作品已下架或不可访问。'
      : entry.item ? '公开预览可用。无法加载互动功能，请重试。' : '无法打开作品，请重试。';
    detail.retry.hidden = entry.outcome === 'denied';
  }

  function setWorkEngagement(entry) {
    const canEngage = Boolean(entry.viewer && entry.viewer === currentUser);
    const verified = entry.ready && canEngage;
    const handle = verified && entry.item.following && creatorHandle(entry.item);
    const saved = detail['library-saved'];
    const author = detail['library-author'];
    saved.hidden = !verified || entry.item.collected !== true;
    author.hidden = !handle;
    detail.library.hidden = saved.hidden && author.hidden;
    saved.href = '/discover' + feedSearchText({tab: 'collected', sort: nativeCatalog ? 'collected' : 'latest'});
    author.href = '/discover' + feedSearchText({tab: 'following', creator: handle || ''});
    const recoverable = showWorkRemixRecovery(entry);
    if (detail.remix) detail.remix.hidden = !nativeCatalog || !canEngage ||
      entry.item?.remix_available !== true || recoverable;
    for (const [action, flag, label] of engagement) {
      const button = detail[action];
      button.hidden = !canEngage || (action === 'follow' && entry.item.own_work);
      button.disabled = !canEngage || Boolean(entry.saving) ||
        engagementPending.has(engagementKey(entry.item, action));
      if (canEngage) {
        button.textContent = engagementLabel(entry.item, action, flag, label);
        button.setAttribute('aria-pressed', String(Boolean(entry.item[flag])));
      }
    }
  }

  function workRemixScope(entry, viewer = currentUser) {
    return typeof viewer?.id === 'string' && viewer.id && validSlug(entry.slug)
      ? 'flybot-workspace.work-remix.' + JSON.stringify([viewer.id, entry.slug]) : '';
  }

  function readWorkRemixAttempt(scope) {
    if (!scope) return null;
    if (workRemixAttempts.has(scope)) return workRemixAttempts.get(scope);
    try {
      const attempt = JSON.parse(window.sessionStorage.getItem(scope));
      if (typeof attempt?.title === 'string' && attempt.title.trim() && attempt.title.length <= 80 &&
          WORK_REMIX_KINDS.has(attempt.kind) && /^[0-9a-f]{64}$/.test(attempt.revision) &&
          /^[A-Za-z0-9_-]{16,64}$/.test(attempt.key)) return attempt;
    } catch { /* Storage is optional. */ }
    return null;
  }

  function storeWorkRemixAttempt(scope, attempt) {
    if (!scope) return;
    if (attempt) workRemixAttempts.set(scope, attempt);
    else workRemixAttempts.delete(scope);
    try {
      if (attempt) window.sessionStorage.setItem(scope, JSON.stringify(attempt));
      else window.sessionStorage.removeItem(scope);
    } catch { /* The open page retains the request if storage is unavailable. */ }
  }

  function showWorkRemixRecovery(entry) {
    const recoverable = Boolean(nativeCatalog && readWorkRemixAttempt(workRemixScope(entry)));
    detail['resume-remix'].hidden = !recoverable;
    return recoverable;
  }

  function closeWorkRemix() {
    activeRemix?.read?.abort();
    activeRemix = null;
    if (workRemix.dialog?.open) workRemix.dialog.close();
  }

  function sameWorkRemix(state) {
    return state === activeRemix && state.viewer === currentUser && activeWorkEntry(state.entry) && workRemix.dialog.open;
  }

  async function readWorkRemix(state) {
    state.template = null;
    state.read?.abort();
    const controller = new AbortController();
    state.read = controller;
    workRemix.submit.disabled = true;
    workRemix.refresh.hidden = true;
    workRemix.status.textContent = '正在读取公开版本…';
    const result = await request('GET',state.path,undefined,{},controller.signal).catch(() => ({status:0}));
    if (!sameWorkRemix(state) || state.read !== controller) return;
    const template = result.body?.template;
    if (result.status !== 200 || !matchesNativeViewer(result.body?.viewer_username,state.viewer) ||
        !WORK_REMIX_KINDS.has(template?.kind) || typeof template.title !== 'string' ||
        !/^[0-9a-f]{64}$/.test(template.revision || '')) {
      workRemix.status.textContent = messageFor(result.body?.error,'无法读取公开版本。');
      workRemix.refresh.hidden = result.status === 404;
      return;
    }
    const previous = state.suggestion;
    state.suggestion = template.title.slice(0,75).replace(/[\uD800-\uDBFF]$/,'').trimEnd() + ' · 副本';
    if (!workRemix.name.value || workRemix.name.value === previous) workRemix.name.value = state.suggestion;
    const size = template.kind === 'media' ? mediaFileSize(template.media?.bytes) : '';
    workRemix.source.textContent = `「${template.title}」${size ? '（' + size + '）' : ''}将保存到你的个人资料空间。`;
    state.template = template;
    workRemix.submit.disabled = false;
    workRemix.status.textContent = '';
  }

  function openWorkRemix() {
    const entry = activeWork;
    if (!nativeCatalog || !entry || !currentUser || !workRemix.dialog || workRemix.dialog.open) return;
    const scope = workRemixScope(entry);
    const attempt = readWorkRemixAttempt(scope);
    if (!attempt && (!entry.ready || entry.viewer !== currentUser || entry.item?.remix_available !== true)) return;
    const state = {entry,viewer:currentUser,path:`/v1/discover/works/${entry.slug}/remix`,scope,attempt};
    activeRemix = state;
    workRemix.source.textContent = '';
    workRemix.name.value = attempt?.title || '';
    workRemix.name.disabled = Boolean(attempt);
    workRemix['name-field'].hidden = false;
    workRemix.open.hidden = true;
    workRemix.open.removeAttribute('href');
    workRemix.close.disabled = workRemix.submit.hidden = false;
    workRemix.close.textContent = '取消';
    workRemix.submit.textContent = attempt ? '确认副本' : '创建副本';
    workRemix.submit.disabled = !attempt;
    workRemix.refresh.hidden = true;
    workRemix.status.textContent = attempt ? WORK_REMIX_PENDING : '';
    workRemix.dialog.showModal();
    if (attempt) workRemix.submit.focus();
    else void readWorkRemix(state);
  }

  async function submitWorkRemix(event) {
    event.preventDefault();
    const state = activeRemix;
    const title = workRemix.name.value.trim();
    if (!state || !sameWorkRemix(state) || state.pending || (!state.attempt && (!state.template || !title))) return;
    const recovering = Boolean(state.attempt);
    const attempt = state.attempt ||= {title,revision:state.template.revision,kind:state.template.kind,key:reuseKey()};
    storeWorkRemixAttempt(state.scope, attempt);
    setWorkEngagement(state.entry);
    state.pending = true;
    workRemix.submit.disabled = workRemix.close.disabled = workRemix.name.disabled = true;
    workRemix.status.textContent = recovering ? '正在确认副本…' : '正在创建副本…';
    const result = await request('POST',state.path,{title:attempt.title,revision:attempt.revision},
      {'Idempotency-Key':attempt.key},AbortSignal.timeout(12000))
      .catch(() => ({status:0}));
    if (!sameWorkRemix(state)) return;
    state.pending = false;
    workRemix.close.disabled = false;
    const artifact = result.body?.artifact;
    if ([200,201].includes(result.status) && matchesNativeViewer(result.body?.viewer_username,state.viewer)
        && /^[a-f0-9]{32}$/.test(artifact?.workspace_id || '') && /^[a-f0-9]{32}$/.test(artifact?.id || '')
        && artifact.kind === attempt.kind) {
      storeWorkRemixAttempt(state.scope, null);
      setWorkEngagement(state.entry);
      state.template = null;
      workRemix['name-field'].hidden = workRemix.submit.hidden = true;
      workRemix.open.href = spaceHref(artifact.workspace_id,artifact.id);
      workRemix.open.hidden = false;
      workRemix.close.textContent = '完成';
      workRemix.status.textContent = '已保存到个人资料空间。';
      workRemix.open.focus();
      return;
    }
    if (!result.status || result.status >= 500 || [200,201,401,408].includes(result.status)) {
      workRemix.submit.textContent = '确认副本';
      workRemix.submit.disabled = false;
      workRemix.status.textContent = WORK_REMIX_PENDING;
      return;
    }
    storeWorkRemixAttempt(state.scope, null);
    setWorkEngagement(state.entry);
    state.attempt = null;
    workRemix.name.disabled = false;
    workRemix.submit.textContent = '创建副本';
    const unavailable = result.status === 404 || result.body?.error?.code === 'listing_changed';
    workRemix.status.textContent = result.status === 404 ? '这个作品已下架或没有可复制的公开版本。'
      : messageFor(result.body?.error,'暂时无法确认是否已创建副本，可以重试。');
    workRemix.submit.disabled = unavailable || !state.template;
    workRemix.refresh.hidden = unavailable ? result.body?.error?.code !== 'listing_changed' : Boolean(state.template);
    if (unavailable) state.template = null;
    if (result.body?.error?.code === 'title_conflict') { workRemix.name.focus(); workRemix.name.select(); }
  }

  function engagementKey(item, action) {
    const subject = action === 'follow' ? creatorHandle(item) || item.author || item.slug : item.slug;
    return JSON.stringify([action, subject]);
  }

  function sameEngagementSubject(item, source, action) {
    return item.slug === source.slug || (action === 'follow' && sameWorkCreator(source, item));
  }

  function applyEngagement(item, change) {
    if (!sameEngagementSubject(item, change.source, change.action)) return true;
    item[change.flag] = change.enabled;
    if (change.action === 'like') item.likes = change.likes;
    return change.enabled ||
      !((change.action === 'collect' && feedState.tab === 'collected') ||
        (change.action === 'follow' && feedState.tab === 'following'));
  }

  function updateFeedEngagement(change) {
    if (feedReader) feedReader.changes.set(engagementKey(change.source, change.action), change);
    if (!matchesFeedViewer(feedViewer)) return;
    const remaining = feedState.items.filter(item => applyEngagement(item, change));
    if (remaining.length !== feedState.items.length) {
      const heldFocus = document.activeElement;
      const keep = new Set(remaining);
      let focusIndex = -1;
      let passed = 0;
      for (const item of feedState.items) {
        if (keep.has(item)) {
          passed += 1;
          continue;
        }
        const controls = feedActions.get(item);
        if (!controls) continue;
        if (controls.row.contains(heldFocus)) focusIndex = passed;
        if (controls.cover) {
          coverObserver?.unobserve(controls.cover);
          pendingCovers.delete(controls.cover);
        }
        controls.row.remove();
        feedActions.delete(item);
        commentButtons.delete(item.slug);
        workTriggers.delete(item.slug);
      }
      feedState.items = remaining;
      document.getElementById('feed-grid').dataset.empty = String(!remaining.length);
      updateFeedStatus();
      if (focusIndex >= 0) {
        const next = remaining[Math.min(focusIndex, remaining.length - 1)];
        const target = feedActions.get(next)?.buttons.get(change.action) || workTriggers.get(next?.slug) || searchInput;
        target?.focus({preventScroll:true});
      }
    }
  }

  async function saveWorkEngagement(item, action, flag) {
    const viewer = currentUser;
    const key = engagementKey(item, action);
    if (!viewer || engagementPending.has(key)) return null;
    const operation = {};
    const enabled = !item[flag];
    engagementPending.set(key, operation);
    syncPendingEngagement(item, action);
    const result = await request('POST', '/v1/discover/works/' + item.slug + '/engagement', {action, enabled})
      .catch(() => ({status: 0}));
    if (engagementPending.get(key) !== operation) return null;
    engagementPending.delete(key);
    if (currentUser !== viewer) return null;
    if (result.status === 200) {
      const changes = result.body?.engagement || result.body || {};
      const confirmed = changes[flag] ?? enabled;
      const likes = changes.likes ?? Math.max(0, (item.likes || 0) + Number(confirmed) - Number(Boolean(item[flag])));
      const change = {source:item, action, flag, enabled:confirmed, likes};
      applyEngagement(item, change);
      updateFeedEngagement(change);
      if (activeWork?.item && activeWork.viewer === viewer) applyEngagement(activeWork.item, change);
    }
    syncPendingEngagement(item, action);
    return result.status === 200;
  }

  async function updateWorkEngagement(action, flag) {
    const entry = activeWork;
    if (!entry?.item || entry.saving || !entry.viewer || entry.viewer !== currentUser) return;
    if (engagementPending.has(engagementKey(entry.item, action))) return;
    entry.saving = action;
    detail.status.textContent = '';
    setWorkEngagement(entry);
    const saved = await saveWorkEngagement(entry.item, action, flag);
    entry.saving = '';
    if (activeWork !== entry || entry.viewer !== currentUser) return;
    if (saved === false) detail.status.textContent = '操作未保存，请重试。';
    setWorkEngagement(entry);
  }

  async function syncWorkChatShare(entry) {
    const viewer = currentUser;
    if (!nativeCatalog || !viewer?.id || !entry.ready || entry.viewer !== viewer) return;
    const url = share.url.value;
    const isCurrent = () => activeWorkEntry(entry) && currentUser === viewer;
    try {
      chatShareReady ??= import('./work-chat-share.mjs')
        .then(({mountWorkChatShare}) => mountWorkChatShare(document, share.dialog, request));
      const controller = await chatShareReady;
      if (share.dialog.open && isCurrent()) controller.prepare({viewer, url, isCurrent});
    } catch {
      chatShareReady = null;
      if (share.dialog.open && isCurrent()) share.status.textContent = '无法加载聊天分享，可复制链接。';
    }
  }

  function openWorkShare() {
    if (!activeWork?.item) return;
    const slug = activeWork.slug;
    const origin = location?.origin || window?.location?.origin;
    share.url.value = origin ? new URL('/w/' + slug, origin).href : '/w/' + slug;
    share.status.textContent = '';
    const navigator = window?.navigator;
    share.native.hidden = !navigator?.share || (navigator.canShare && !navigator.canShare({url: share.url.value}));
    if (!share.dialog.open) share.dialog.showModal();
    return syncWorkChatShare(activeWork);
  }

  async function copyWorkShare() {
    const value = share.url.value;
    try {
      const clipboard = window?.navigator?.clipboard;
      if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
      await clipboard.writeText(value);
      if (share.dialog.open && share.url.value === value) share.status.textContent = '已复制链接。';
    } catch {
      if (!share.dialog.open || share.url.value !== value) return;
      share.url.focus?.();
      share.url.select?.();
      share.status.textContent = '可手动复制已选中的链接。';
    }
  }

  detail.back.addEventListener('click', () => {
    if (history?.state?.discoverWork && typeof history.back === 'function') {
      history.back();
      return;
    }
    history?.replaceState?.(null, '', feedUrl());
    syncLoginLink();
    closeWorkDetail();
  });
  for (const name of ['previous', 'next']) {
    detail[name].addEventListener('click', () => {
      const entry = activeWork;
      if (!entry?.ready || !activeWorkEntry(entry)) return;
      if (entry[name] && !detail[name].disabled) return openAdjacentWork(entry, entry[name]);
      if (name === 'next' && entry.viewer === null && !detail.next.disabled) return loadNextGuestWork(entry);
    });
  }
  detail.retry.addEventListener('click', () => activeWork && openWorkDetail(activeWork.intent));
  detail.comments.addEventListener('click', () => {
    if (activeWork?.ready && activeWorkEntry(activeWork)) return workComments.open(activeWork.item, detail.comments);
  });
  detail.share.addEventListener('click', openWorkShare);
  detail.remix?.addEventListener('click',openWorkRemix);
  detail['resume-remix']?.addEventListener('click',openWorkRemix);
  workRemix.form?.addEventListener('submit',submitWorkRemix);
  workRemix.close?.addEventListener('click',closeWorkRemix);
  workRemix.refresh?.addEventListener('click',() => activeRemix && readWorkRemix(activeRemix));
  workRemix.dialog?.addEventListener('cancel',event => {
    event.preventDefault();
    if (!activeRemix?.pending) closeWorkRemix();
  });
  for (const [action, flag] of engagement) {
    detail[action].addEventListener('click', () => updateWorkEngagement(action, flag));
  }
  for (const link of [detail['library-saved'], detail['library-author']]) {
    link.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
          !history?.pushState || link.hidden || !activeWork?.ready || activeWork.viewer !== currentUser) return;
      event.preventDefault();
      const next = feedStateFromSearch(new URL(link.href).search);
      if (feedSearchText(next) === feedSearchText(feedState)) return detail.back.click();
      const loading = applyFeedFilters({creator: '', topic: '', ...next});
      closeWorkDetail({restore: false});
      return loading;
    });
  }
  share.close.addEventListener('click', () => share.dialog.close());
  share.copy.addEventListener('click', copyWorkShare);
  share.native.addEventListener('click', async () => {
    const url = share.url.value;
    try { await window.navigator.share({title: activeWork.item.title, url}); }
    catch (error) {
      if (error?.name !== 'AbortError' && share.dialog.open && share.url.value === url) {
        share.status.textContent = '无法打开系统分享，可复制链接。';
      }
    }
  });

  function applyFeedChrome({restoreQuery = false} = {}) {
    if (collectedSortField && collectedSort) {
      collectedSortField.hidden = !nativeCatalog || !currentUser || feedState.tab !== 'collected';
      collectedSort.value = feedState.sort === 'collected' ? 'collected' : 'latest';
    }
    if (followedCreators) {
      followedCreators.hidden = !nativeCatalog || !currentUser || feedState.tab !== 'following';
      if (followedCreators.hidden) followedCreatorPicker?.close();
    }
    for (const name of FEED_TABS) {
      const button = document.getElementById('feed-tab-' + name);
      if (!button) continue;
      const selected = name === feedState.tab;
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('tabindex', selected ? '0' : '-1');
    }
    document.getElementById('feed-results')?.setAttribute('aria-labelledby', 'feed-tab-' + feedState.tab);
    const popular = feedState.tab === 'activity' && feedState.sort === 'popular';
    const popularButton = document.getElementById('feed-sort-popular');
    if (popularButton) {
      popularButton.hidden = feedState.tab !== 'activity' || Boolean(feedState.creator);
      setFeedCategory(popularButton, popular);
    }
    setCreatorDirectoryTabs(feedState.creator);
    const creatorFilter = document.getElementById('feed-creator-filter');
    if (creatorFilter) {
      creatorFilter.hidden = !feedState.creator;
      creatorFilter.textContent = feedState.creator ? '@' + feedState.creator + ' ×' : '';
      creatorFilter.setAttribute('aria-label', feedState.creator ? '清除作者筛选 @' + feedState.creator : '清除作者筛选');
    }
    for (const kind of FEED_KINDS) {
      const node = document.getElementById('feed-kind-' + (kind || 'all'));
      if (node) setFeedCategory(node, !popular && kind === feedState.kind);
    }
    const filters = document.getElementById('feed-filters');
    if (filters?.scrollWidth > filters.clientWidth) {
      const selected = popular ? popularButton : document.getElementById('feed-kind-' + (feedState.kind || 'all'));
      const strip = filters.getBoundingClientRect();
      const chip = selected?.getBoundingClientRect();
      if (chip?.right > strip.right) filters.scrollLeft += chip.right - strip.right;
      if (chip?.left < strip.left) filters.scrollLeft += chip.left - strip.left;
    }
    if (restoreQuery && searchInput) searchInput.value = feedState.query;
    if (topicFilter) topicFilter.value = feedState.topic || '';
    if (clearSearch) clearSearch.hidden = !searchInput?.value;
  }

  async function openFollowedCreators() {
    const viewer = currentUser;
    const scope = sessionRequest;
    const current = () => currentUser === viewer && scope === sessionRequest && feedState.tab === 'following' && !activeWork;
    if (!nativeCatalog || !viewer || !current()) return;
    followedCreators.disabled = true;
    try {
      followedCreatorSetup ??= import('./followed-creators.mjs').then(({mountFollowedCreators}) => {
        followedCreatorPicker = mountFollowedCreators(document, {
          initial:catalogInitial,
          read:(method, path, signal) => request(method, path, undefined, undefined,
            AbortSignal.any([signal, AbortSignal.timeout(8000)])),
        });
        return followedCreatorPicker;
      });
      const picker = await followedCreatorSetup;
      if (current()) return picker.open({
        current, creator:feedState.creator, matchesViewer:name => matchesNativeViewer(name, viewer),
        select:creator => applyFeedFilters({creator, query:searchText()}),
      });
    } catch {
      followedCreatorSetup = null;
      if (current()) setFeedError('无法打开已关注作者，请重试。', openFollowedCreators);
    } finally {
      followedCreators.disabled = false;
    }
  }

  function setFeedCategory(button, current) {
    button.setAttribute('aria-current', String(current));
    if (current && (currentUser || feedState.tab === 'activity')) button.setAttribute('aria-description', '重新加载分类');
    else button.removeAttribute?.('aria-description');
  }

  function feedUrl() {
    const pathname = location && typeof location.pathname === 'string' ? location.pathname : '/discover';
    return pathname + feedSearchText(feedState);
  }

  function cancelSearch() {
    clearTimeout(searchTimer);
    searchTimer = undefined;
  }

  function captureFeedPosition(control, slug = control?.closest?.('.feed-entry')?.dataset.slug) {
    const offset = validSlug(slug) && control?.getBoundingClientRect?.().top - initialView.getBoundingClientRect?.().top;
    return {
      scroll: initialView.scrollTop || 0,
      ...(validSlug(slug) && {slug, detailButton: Boolean(control?.classList?.contains('feed-detail-toggle'))}),
      ...(Number.isFinite(offset) && {offset}),
      ...(control?.id?.startsWith('feed-') && {focusId: control.id}),
    };
  }

  function feedHistoryKey() {
    const viewer = currentUser?.id;
    if (sessionState !== 'guest' && (sessionState !== 'signed-in' || typeof viewer !== 'string')) return '';
    return JSON.stringify([sessionState, viewer || null, feedSearchText(feedState)]);
  }

  function recordedFeedPosition() {
    const position = history?.state?.discoverWorkFeed;
    const key = feedHistoryKey();
    if (!key || position?.key !== key || !Number.isInteger(position.pageCount) || position.pageCount < 1 ||
        position.pageCount > BROWSE_RESTORE_PAGES || !Number.isFinite(position.scroll) || position.scroll < 0) return null;
    return position;
  }

  function rememberFeedPosition(position = activeWork ? feedReturn : captureFeedPosition(document.activeElement), {persist = false} = {}) {
    if (!feedPages || feedRestore || !position) return;
    const {scroll, slug, detailButton, offset, focusId} = position;
    const record = {pageCount: Math.min(feedPages, BROWSE_RESTORE_PAGES), scroll, slug, detailButton, offset, focusId};
    const key = feedSearchText(feedState);
    feedPositions.delete(key);
    feedPositions.set(key, record);
    if (feedPositions.size > 16) feedPositions.delete(feedPositions.keys().next().value);
    const historyKey = persist && feedHistoryKey();
    if (historyKey && history?.replaceState && 'state' in history) {
      try { history.replaceState({...history.state, discoverWorkFeed: {...record, key: historyKey}}, ''); }
      catch { /* The browser may disable history changes while leaving. */ }
    }
  }

  async function readFeedPosition(position, {reuseCurrent = false, restoreFocus = true} = {}) {
    if (!position || sessionPending) return loadFeed();
    const restoring = {position, restoreFocus};
    feedRestore = restoring;
    let loaded = reuseCurrent && feedPages > 0 || await loadFeed();
    let remaining = position.pageCount;
    while (remaining-- > 0 && feedPages < position.pageCount && loaded && feedRestore === restoring && feedState.cursor) {
      loaded = await loadFeed({append: true});
    }
    if (feedRestore !== restoring) return;
    feedRestore = null;
    updateFeedStatus();
    if (!activeWork) restoreFeedPosition(position, {focus: restoreFocus});
  }

  function restoreRecordedFeedPosition() {
    if (activeWork || feedRestore || feedState.loading || feedFailure) return;
    const saved = recordedFeedPosition();
    if (saved) return readFeedPosition(saved, {reuseCurrent: true});
  }

  function applyFeedFilters(changes, {refresh = false, resume = false} = {}) {
    cancelSearch();
    const current = feedSearchText(feedState);
    const next = {...feedState, ...changes};
    const nextKey = feedSearchText(next);
    if (nextKey === current) {
      if (refresh && !feedState.loading && !feedRestore && (currentUser || feedState.tab === 'activity')) {
        return loadFeed({refresh: true});
      }
      return;
    }
    const priorTab = resume && document.getElementById('feed-tab-' + feedState.tab);
    rememberFeedPosition(priorTab ? captureFeedPosition(priorTab) : undefined, {persist: !activeWork});
    feedRestore = null;
    Object.assign(feedState, changes);
    applyFeedChrome({restoreQuery: true});
    history?.pushState?.(null, '', feedUrl());
    syncLoginLink();
    initialView.scrollTop = 0;
    return resume ? readFeedPosition(feedPositions.get(nextKey), {restoreFocus: false}) : loadFeed();
  }

  function searchText() {
    return (searchInput?.value || '').trim().slice(0, 80);
  }

  function commitSearch() {
    const query = searchText();
    if (searchInput) searchInput.value = query;
    if (clearSearch) clearSearch.hidden = !query;
    return applyFeedFilters({query});
  }

  function scheduleSearch() {
    cancelSearch();
    if (clearSearch) clearSearch.hidden = !searchInput?.value;
    if (!composingQuery && searchText() !== feedState.query) {
      searchTimer = setTimeout(commitSearch, SEARCH_DELAY);
    }
  }

  function clearFeedSearch() {
    if (!searchInput) return;
    searchInput.value = '';
    searchInput.focus?.();
    return commitSearch();
  }

  if (!catalogView && window && typeof window.addEventListener === 'function') {
    if (history && 'scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.addEventListener('pagehide', () => { if (!activeWork) rememberFeedPosition(undefined, {persist: true}); });
    window.addEventListener('popstate', () => {
      followedCreatorPicker?.close();
      syncLoginLink();
      cancelSearch();
      const next = feedStateFromSearch(location?.search);
      if (!nativeCatalog && next.sort === 'collected') next.sort = 'latest';
      const nextKey = feedSearchText(next);
      const feedChanged = nextKey !== feedSearchText(feedState);
      if (feedChanged) {
        rememberFeedPosition();
        feedRestore = null;
      }
      Object.assign(feedState, {creator: '', topic: '', ...next});
      applyFeedChrome({restoreQuery: true});
      const intent = workDetailFromSearch(location?.search);
      if (feedChanged || !intent) {
        workComments.close();
        closeWorkDetail({restore: !feedChanged});
      }
      if (feedChanged) {
        initialView.scrollTop = 0;
        const position = feedPositions.get(nextKey) || recordedFeedPosition();
        const loaded = readFeedPosition(position);
        if (!intent) return loaded;
        const opened = openWorkDetail(intent);
        if (position) feedReturn = position;
        return Promise.all([loaded, opened]);
      }
      if (intent) return openWorkDetail(intent);
      return restoreRecordedFeedPosition();
    });
  }

  function applyFeedNote() {
    const note = document.getElementById('feed-note');
    const followingEmpty = document.getElementById('feed-following-empty');
    const gridSection = document.getElementById('feed-activity-empty');
    const searchNote = document.getElementById('feed-search-note');
    const filtered = Boolean(feedState.query || feedState.kind || feedState.creator || feedState.topic);
    const empty = !feedState.items.length && !feedState.loading && !feedRestore && !feedFailure;
    if (followingEmpty) followingEmpty.hidden = !(currentUser && feedState.tab === 'following' && !filtered && empty);
    if (resetEmptyFeed) resetEmptyFeed.hidden = !(empty && filtered && (currentUser || feedState.tab === 'activity'));
    if (gridSection) gridSection.hidden = false;
    if (searchNote) searchNote.hidden = true;
    if (!note) return;
    if (feedState.loading || feedFailure) {
      note.textContent = '';
      return;
    }
    if (feedState.tab !== 'activity' && !currentUser) note.textContent = '请先登录，再查看关注或收录作品。';
    else if (feedState.tab === 'activity' && feedState.creator && !feedState.query && !feedState.kind && !feedState.topic && !feedState.items.length)
      note.textContent = '该作者还没有公开作品。';
    else if (filtered && !feedState.items.length) note.textContent = FEED_SEARCH_EMPTY_NOTE;
    else if (feedState.tab === 'following') note.textContent = FEED_FOLLOWING_NOTE;
    else if (feedState.tab === 'collected') note.textContent = '这里只展示你收录且仍公开的作品。';
    else note.textContent = feedState.items.length ? FEED_ACTIVITY_LISTED_NOTE : FEED_ACTIVITY_EMPTY_NOTE;
  }

  const previewCache = new Map();
  const pendingCovers = new Map();
  const coverObserver = window?.IntersectionObserver ? new window.IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting || !pendingCovers.has(entry.target)) continue;
      const item = pendingCovers.get(entry.target);
      pendingCovers.delete(entry.target);
      coverObserver.unobserve(entry.target);
      loadThumb(entry.target, item);
    }
  }, {rootMargin: '160px 0px'}) : null;

  // One shape for both the cover thumb and the detail: a refused preview is
  // marked so the detail can say "unreadable" instead of "empty".
  function cachedPreview(item) {
    const path = feedPreviewPath(item);
    if (!path || typeof fetcher !== 'function') return Promise.resolve({ok: false, readable: false, preview: null});
    const key = path + '@' + (item.updated || '');
    if (!previewCache.has(key)) {
      previewCache.set(key, Promise.resolve()
        .then(() => fetcher(path, {method: 'GET', credentials: 'same-origin', headers: {Accept: 'application/json'}}))
        .then(response => {
          if (!response || response.status !== 200) return {ok: false, preview: null};
          return Promise.resolve()
            .then(() => response.json())
            .then(body => ({ok: true, preview: (body && body.preview) || null}))
            .catch(() => ({ok: false, preview: null}));
        })
        .catch(() => ({ok: false, preview: null})));
    }
    return previewCache.get(key);
  }

  function loadThumb(cover, item) {
    cachedPreview(item).then(result => {
      if (cover.isConnected !== false) attachFeedThumb(document, cover, result.preview);
    }).catch(() => {});
  }

  function hydrateThumb(cover, item) {
    if (!cover || !feedPreviewPath(item)) return;
    if (coverObserver) {
      pendingCovers.set(cover, item);
      coverObserver.observe(cover);
    } else {
      loadThumb(cover, item);
    }
  }

  function attachModel3dDetail(panel, slug, url) {
    const actions = document.createElement('div');
    actions.className = 'feed-model3d-actions';
    const preview = document.createElement('div');
    preview.id = 'feed-model3d-preview-' + slug;
    preview.className = 'feed-model3d-preview';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'feed-model3d-preview-toggle';
    toggle.setAttribute('aria-controls', preview.id);
    const download = document.createElement('a');
    download.className = 'feed-detail-open feed-model3d-download';
    download.href = url;
    download.download = '';
    download.textContent = '下载 GLB';
    const status = document.createElement('p');
    status.className = 'feed-model3d-status';
    status.setAttribute('role', 'status');
    actions.append(toggle, download);
    panel.append(actions, status, preview);
    return bindModel3dPreview(toggle, preview, status, {onReady() {
      if (!window?.matchMedia?.('(max-width: 700px)')?.matches) return;
      const viewport = document.getElementById('main')?.getBoundingClientRect();
      if (!viewport) return;
      const trigger = toggle.getBoundingClientRect();
      // Respect any scrolling the viewer did while the model loaded.
      if (trigger.bottom <= viewport.top || trigger.top >= viewport.bottom) return;
      const model = preview.getBoundingClientRect();
      if (model.top < viewport.top || model.bottom > viewport.bottom) {
        panel.scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'instant'});
      }
    }});
  }

  function engagementLabel(item, action, flag, label) {
    return (item[flag] ? '取消' : '') + label + (action === 'like' ? ' · ' + (item.likes || 0) : '');
  }

  function renderMediaPreview(entry, item, file, stillShowing) {
    const status = document.createElement('p');
    status.className = 'work-media-status';
    status.setAttribute('role', 'status');
    const label = MEDIA_LABELS[item.kind];
    if (!file) {
      status.textContent = '这件作品暂无可用的' + label + '文件。';
      detail.preview.append(status);
      return;
    }
    const image = item.kind === 'image';
    const player = document.createElement(image ? 'img' : item.kind);
    player.className = 'work-detail-' + item.kind;
    if (image) {
      player.alt = item.title || '公开作品图片';
      player.decoding = 'async';
    } else {
      player.controls = true;
      player.preload = 'none';
      player.setAttribute('aria-label', label + '预览 · ' + (item.title || item.slug));
      if (item.kind === 'video') player.playsInline = true;
      entry.media = player;
    }
    player.addEventListener('error', () => {
      if (!stillShowing() || (!image && entry.media !== player)) return;
      player.hidden = true;
      status.textContent = '无法预览' + label + '，可以尝试下载原文件。';
    });
    player.src = file;
    detail.preview.append(player, status);
  }

  async function renderWorkPreview(entry, item, key, inlinePreview, file) {
    const stillShowing = () => activeWorkEntry(entry) && entry.previewKey === key && entry.outcome !== 'denied';
    if (item.kind === 'website' && item.site_available === true) {
      const frame = document.createElement('iframe');
      frame.className = 'work-detail-site';
      frame.title = (item.title || '网站') + ' · 互动预览';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.src = '/w/' + item.slug + '/site';
      detail.preview.append(frame);
      return;
    }
    if (item.kind === 'model3d') {
      const file = publicWorkPath(item) + '/file';
      entry.model = attachModel3dDetail(detail.preview, item.slug, file);
      entry.model.setSource(file);
      return;
    }
    if (Object.hasOwn(MEDIA_LABELS, item.kind)) {
      renderMediaPreview(entry, item, file, stillShowing);
      return;
    }
    detail.preview.textContent = FEED_DETAIL_LOADING;
    if (item.kind === 'document') {
      void import('./document-reader.mjs').then(({mountDocumentReader}) => {
        if (!stillShowing()) return;
        entry.disposeReader = mountDocumentReader(document, detail.reader, {
          stillShowing,
          async read(signal) {
            const result = await request('GET', '/w/' + item.slug, undefined, {}, signal);
            const work = result.body;
            if (result.status !== 200 || work?.kind !== 'work' || work.slug !== item.slug || work.work_kind !== 'document') {
              return {status:result.status};
            }
            return {status:200, source:work.snapshot ?? ''};
          },
        });
      }).catch(() => {});
    }
    const result = inlinePreview === undefined ? await cachedPreview(item) : {ok: true, preview: inlinePreview};
    if (!stillShowing()) return;
    if (!result.ok) { detail.preview.textContent = FEED_DETAIL_UNREADABLE; return; }
    if (!result.preview) { detail.preview.textContent = FEED_DETAIL_NO_TEXT; return; }
    const lines = detailExcerpt(result.preview);
    if (!lines.length) { detail.preview.textContent = FEED_DETAIL_EMPTY; return; }
    const list = document.createElement('ul');
    list.className = 'feed-detail-lines';
    for (const line of lines) {
      const row = document.createElement('li');
      row.textContent = line;
      list.append(row);
    }
    detail.preview.replaceChildren(list);
  }

  function bindWorkDetail(actions, card, item) {
    if (!validSlug(item.slug)) return;
    const options = {item, navigate: true};
    const intent = {slug: item.slug};
    card.href = workUrl(intent);
    card.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      return openWorkDetail(intent, {...options, trigger: card});
    });
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'feed-detail-toggle';
    button.textContent = FEED_DETAIL_MORE;
    button.setAttribute('aria-controls', 'work-detail');
    button.addEventListener('click', () => openWorkDetail(intent, {...options, trigger: button}));
    actions.append(button);
    workTriggers.set(item.slug, card);
  }

  function matchesFeedViewer(viewer) {
    return nativeCatalog ? matchesNativeViewer(viewer) : Boolean(currentUser && viewer === currentUser);
  }

  function syncFeedEngagementButton(item, controls, action) {
    const button = controls.buttons.get(action);
    if (!button) return;
    const [, flag, label] = engagement.find(([kind]) => kind === action);
    const pending = engagementPending.has(engagementKey(item, action));
    if (action === 'like') button.textContent = '点赞 · ' + (item.likes || 0);
    else if (action === 'follow') button.textContent = item[flag] ? '已关注' : '关注';
    else button.textContent = item[flag] ? '已收录' : label;
    button.setAttribute('aria-label', engagementLabel(item, action, flag, label));
    button.setAttribute('aria-pressed', String(Boolean(item[flag])));
    button.setAttribute('aria-disabled', String(pending));
    button.setAttribute('aria-busy', String(pending));
  }

  function syncPendingEngagement(source, action) {
    for (const [item, controls] of feedActions) {
      if (sameEngagementSubject(item, source, action)) syncFeedEngagementButton(item, controls, action);
    }
    if (activeWork?.item && sameEngagementSubject(activeWork.item, source, action)) setWorkEngagement(activeWork);
  }

  function addFeedEngagement(item, actions) {
    const viewer = currentUser;
    if (!matchesFeedViewer(feedViewer) || actions.viewer === viewer) return;
    actions.viewer = viewer;
    for (const [action, flag] of engagement) {
      if (action === 'follow' && item.own_work) continue;
      const button = document.createElement('button');
      button.type = 'button';
      actions.buttons.set(action, button);
      syncFeedEngagementButton(item, actions, action);
      const isCurrent = () => viewer === currentUser && feedActions.get(item) === actions;
      button.addEventListener('click', async () => {
        if (!isCurrent() || engagementPending.has(engagementKey(item, action))) return;
        actions.feedback.hidden = true;
        const saved = await saveWorkEngagement(item, action, flag);
        if (saved !== false || !isCurrent()) return;
        actions.feedback.textContent = '操作未保存，请重试。';
        actions.feedback.hidden = false;
      });
    }
    actions.element.prepend(...actions.buttons.values());
  }

  function renderFeed(start = 0) {
    const grid = document.getElementById('feed-grid');
    if (!grid) return;
    if (start === 0) {
      coverObserver?.disconnect();
      pendingCovers.clear();
      commentButtons.clear();
      workTriggers.clear();
      feedActions.clear();
      grid.replaceChildren();
    }
    for (const item of feedState.items.slice(start)) {
      const linkedAuthor = Boolean(creatorHandle(item));
      const card = renderFeedCard(document, item, {legacyImage: !nativeCatalog, includeByline: !linkedAuthor});
      const cover = typeof card.querySelector === 'function' ? card.querySelector('.work-cover') : null;
      hydrateThumb(cover, item);
      const entry = document.createElement('article');
      entry.className = 'feed-entry';
      entry.dataset.slug = item.slug || '';
      entry.append(card);
      if (linkedAuthor) entry.append(renderFeedByline(document, item, {linkAuthor: true}));
      const actions = document.createElement('div');
      actions.className = 'feed-card-actions';
      if (validSlug(item.slug)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'feed-comments-toggle';
        button.textContent = commentsLabel(item.comment_count);
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-controls', 'feed-comments-dialog');
        button.addEventListener('click', () => {
          return workComments.open(item, button);
        });
        actions.append(button);
        commentButtons.set(item.slug, button);
        const feedback = document.createElement('p');
        feedback.className = 'feed-card-feedback';
        feedback.setAttribute('role', 'alert');
        feedback.hidden = true;
        const controls = {row:entry, cover, element:actions, feedback, buttons:new Map(), viewer:null};
        feedActions.set(item, controls);
        addFeedEngagement(item, controls);
        bindWorkDetail(actions, card, item);
        entry.append(actions, feedback);
      }
      grid.append(entry);
    }
    grid.dataset.empty = feedState.items.length ? 'false' : 'true';
    updateFeedStatus();
  }

  function updateFeedStatus() {
    syncGuestWorkNavigation();
    const results = document.getElementById('feed-activity-empty');
    results?.setAttribute('aria-busy', String(Boolean(feedRestore || feedState.loading)));
    if (results) results.dataset.initialLoading = String(feedState.loading && !feedState.items.length);
    const filters = document.getElementById('feed-filters');
    if (filters) filters.dataset.refreshing = String(Boolean(feedState.refreshing));
    const count = document.getElementById('feed-count');
    if (count) {
      if (feedRestore) count.textContent = '正在恢复浏览位置…';
      else if (feedState.refreshing) count.textContent = '正在刷新作品…';
      else if (feedState.loading && feedState.cursor) count.textContent = '正在加载更多作品…';
      else if (feedState.loading && !feedState.items.length) count.textContent = '正在加载作品…';
      else if (feedState.items.length) count.textContent =
        '已显示 ' + feedState.items.length + (feedState.query ? ' 件匹配作品' : ' 件公开作品');
      else count.textContent = '';
    }
    const more = document.getElementById('feed-more');
    if (more) {
      more.hidden = !feedState.cursor;
      more.disabled = feedState.loading || Boolean(feedRestore || (nativeCatalog && sessionPending));
    }
    applyFeedNote();
  }

  function setFeedError(message, retry) {
    const error = document.getElementById('feed-error');
    feedFailure = retry;
    if (error) {
      error.hidden = !message;
      error.textContent = message;
    }
    if (retryFeed) retryFeed.hidden = !retry;
  }

  function mismatchedNativeFeed(viewer) {
    if (!nativeCatalog) return false;
    if (currentUser) return !matchesFeedViewer(viewer);
    return !sessionPending && viewer !== null;
  }

  async function loadFeed({append = false, retainItems = false, retryViewer = true, refresh = false, overlapSession = false} = {}) {
    if (feedState.loading && append) return;
    const seq = ++feedRequest;
    const scope = sessionRequest;
    feedReader?.controller.abort();
    if (!append && !refresh) {
      if (!retainItems) feedState.items = [];
      feedState.cursor = '';
      feedViewer = undefined;
      feedPages = 0;
    }
    const needsViewer = feedState.tab !== 'activity';
    const waitingForViewer = needsViewer && !currentUser;
    const checkingViewer = waitingForViewer && nativeCatalog && overlapSession ? sessionPending : null;
    feedState.loading = !waitingForViewer || Boolean(sessionPending);
    feedState.refreshing = refresh;
    setFeedError('');
    if (append || retainItems || refresh) updateFeedStatus();
    else renderFeed();
    if (waitingForViewer && !checkingViewer) return;
    // The native all-works route includes the same viewer state as /me/works?tab=all.
    const viewer = currentUser;
    const privateFeed = needsViewer || (viewer && !nativeCatalog);
    const sort = feedState.sort;
    const params = feedQuery(feedState.query, append ? feedState.cursor : '', feedState.kind, sort, feedState.creator, feedState.topic);
    const tab = feedState.tab === 'activity' ? 'all' : feedState.tab;
    const path = privateFeed ? `/v1/discover/me/works?${params}&tab=${tab}` : `/v1/discover/works?${params}`;
    const reader = {controller:new AbortController(), changes:new Map()};
    feedReader = reader;
    const response = request('GET', path, undefined, undefined, reader.controller.signal).catch(() => ({status: 0, body: {}}));
    if (checkingViewer) {
      // Keep the private response out of the feed until the session resolves.
      await checkingViewer;
      if (seq !== feedRequest || scope !== sessionRequest) return;
      if (!currentUser) {
        reader.controller.abort();
        feedReader = null;
        feedState.loading = false;
        feedState.refreshing = false;
        updateFeedStatus();
        return;
      }
    }
    const result = await response;
    if (seq !== feedRequest || scope !== sessionRequest) return;
    feedReader = null;
    feedState.loading = false;
    feedState.refreshing = false;
    if (append && sort === 'popular' && result.status === 409 && result.body?.error?.code === 'popularity_expired') {
      return loadFeed();
    }
    if (result.status !== 200) {
      if (checkingViewer && result.status === 401 && retryViewer) return loadFeed({retryViewer: false});
      const message = result.body?.error?.message || '无法加载公开作品。';
      const restoring = feedRestore;
      const retry = restoring
        ? () => readFeedPosition(restoring.position, {reuseCurrent: append, restoreFocus: restoring.restoreFocus})
        : () => loadFeed({append, retainItems, refresh});
      setFeedError(message, retry);
      updateFeedStatus();
      return;
    }
    const name = result.body?.viewer_username;
    const nativeViewer = typeof name === 'string' && VIEWER_USERNAME.test(name) ? name : null;
    const mismatch = mismatchedNativeFeed(nativeViewer);
    if (mismatch && (needsViewer || append)) {
      if (retryViewer) return loadFeed({retryViewer: false, refresh});
      setFeedError('登录状态已变化，重新检查后可再试。', () => load());
      updateFeedStatus();
      return;
    }
    const start = append ? feedState.items.length : 0;
    let incoming = catalogItems(result.body);
    if (!mismatch && matchesFeedViewer(nativeCatalog ? nativeViewer : (privateFeed ? viewer : null))) {
      for (const change of reader.changes.values()) incoming = incoming.filter(item => applyEngagement(item, change));
    }
    if (append) {
      const seen = new Set(feedState.items.map(item => item.slug));
      for (const item of incoming) {
        if (seen.has(item.slug)) continue;
        feedState.items.push(item);
        seen.add(item.slug);
      }
    } else {
      feedState.items = incoming;
    }
    feedViewer = nativeCatalog ? nativeViewer : (privateFeed ? viewer : null);
    feedState.cursor = mismatch ? '' : result.body?.cursor || '';
    if (!mismatch) feedPages = (append ? feedPages : 0) + 1;
    renderFeed(start);
    if (refresh && !mismatch && !activeWork) initialView.scrollTop = 0;
    if (mismatch && retryViewer) return loadFeed({retainItems: true, retryViewer: false});
    if (mismatch) {
      setFeedError('登录状态已变化，重新检查后可再试。', () => load());
      updateFeedStatus();
    }
    return !mismatch;
  }

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders = {}, signal) {
    const headers = Object.assign(
      { Accept: 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie) }, extraHeaders);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(signal && {signal}),
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return { status: response.status, body: parsed };
  }

  function applyCatalogFilters() {
    setCreatorDirectoryTabs(activeCreator?.handle);
    for (const chip of document.querySelectorAll('[data-catalog-category]')) {
      chip.setAttribute('aria-pressed', String(chip.dataset.catalogCategory === activeCategory));
    }
    const filter = document.getElementById('catalog-creator-filter');
    filter.hidden = !activeCreator;
    document.getElementById('catalog-creator-label').textContent = activeCreator ? '创建者 · ' + activeCreator.name : '';
  }

  function setCategory(category) {
    activeCategory = category;
    if (history?.replaceState) {
      const params = new URLSearchParams(location.search);
      if (category === 'all') params.delete('category');
      else params.set('category', category);
      history.replaceState(null, '', '/discover?' + params.toString());
      syncLoginLink();
    }
    return loadCatalog();
  }

  const categoryDialog = document.getElementById('catalog-category-dialog');
  const categoryQuery = document.getElementById('catalog-category-query');
  function renderCategoryOptions() {
    const options = document.getElementById('catalog-category-options');
    const term = categoryQuery.value.trim().toLowerCase();
    options.replaceChildren();
    for (const {slug, label} of [{slug: 'all', label: '全部'}, ...AGENT_CATEGORIES]) {
      if (term && !label.toLowerCase().includes(term)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-pressed', String(slug === activeCategory));
      button.addEventListener('click', () => {
        categoryDialog.close();
        setCategory(slug);
      });
      options.append(button);
    }
    document.getElementById('catalog-category-empty').hidden = options.childElementCount > 0;
  }

  const remixDialog = document.getElementById('catalog-remix-dialog');
  const remixName = document.getElementById('catalog-remix-name');
  const remixWorkspace = document.getElementById('catalog-remix-workspace');
  const remixStatus = document.getElementById('catalog-remix-status');
  const remixSubmit = document.getElementById('catalog-remix-submit');
  const remixRefresh = document.getElementById('catalog-remix-refresh');
  const remixCancel = document.getElementById('catalog-remix-cancel');
  const shareSender = document.getElementById('catalog-remix-share-sender');
  const remixLabel = (zh, en) => document.documentElement?.lang?.startsWith('en') ? en : zh;
  const receivedShares = document.getElementById('received-agent-shares');
  const receivedList = document.getElementById('received-agent-shares-list');
  const receivedStatus = document.getElementById('received-agent-shares-status');
  const receivedMore = document.getElementById('received-agent-shares-more');
  let receivedView;

  function renderReceived(state) {
    receivedList.replaceChildren(...[...state.items.values()].map(grant => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = grant.agent_name + ' · ' + (grant.sender?.display_name || grant.sender?.handle || '');
      item.append(label);
      const action = document.createElement(grant.state === 'active' ? 'a' : 'span');
      if (grant.state === 'active') {
        action.href = '/discover?' + new URLSearchParams({tab:'agents', share:grant.id});
        action.textContent = remixLabel('查看并复制','Review and copy');
      } else action.textContent = grant.state === 'revoked' ? remixLabel('已撤销','Revoked') : remixLabel('已关闭','Closed');
      item.append(action);
      return item;
    }));
  }

  async function loadReceived({reset = false} = {}) {
    if (!nativeCatalog || !currentUser || !receivedShares.open) return;
    if (reset || !receivedView) {
      receivedView = {viewer:currentUser, items:new Map(), cursor:''};
      receivedList.replaceChildren();
      receivedMore.hidden = true;
    }
    const state = receivedView;
    if (state.loading) return;
    state.loading = true;
    const params = new URLSearchParams({direction:'received', limit:'30'});
    if (state.cursor) params.set('after',state.cursor);
    receivedMore.disabled = true;
    receivedStatus.textContent = remixLabel('正在读取收到的分享…','Loading received shares…');
    const result = await request('GET','/v1/agent-copy-grants?' + params).catch(() => ({status:0}));
    if (receivedView !== state || currentUser !== state.viewer || !receivedShares.open) return;
    state.loading = false;
    receivedMore.disabled = false;
    if (result.status !== 200) {
      receivedStatus.textContent = remixLabel('无法读取分享，请重试。','Could not load shares. Try again.');
      receivedMore.textContent = remixLabel('重试','Try again');
      receivedMore.hidden = false;
      return;
    }
    for (const grant of result.body.items || []) if (AGENT_COPY_GRANT.test(grant.id)) state.items.set(grant.id,grant);
    state.cursor = result.body.next_cursor || '';
    renderReceived(state);
    receivedMore.textContent = remixLabel('加载更多','Load more');
    receivedMore.hidden = !state.cursor;
    receivedStatus.textContent = state.items.size ? '' : remixLabel('还没有收到的分享。','No shares received yet.');
  }

  function currentRemix(entry) {
    return remix === entry && entry.viewer === currentUser && remixDialog.open;
  }

  function closeAgentRemix() {
    remix?.read?.abort();
    remix = null;
    renderAgentRemixContent();
    shareSender.textContent = '';
    shareSender.hidden = true;
    document.getElementById('catalog-remix-summary').textContent = '';
    if (remixDialog.open) remixDialog.close();
  }

  function updateRemixControls() {
    const pending = Boolean(remix?.pending);
    remixSubmit.disabled = !remix?.template || (!remix.shareId && !remixWorkspace.value) || !remixName.value.trim() || pending;
    remixName.disabled = remixWorkspace.disabled = remixCancel.disabled = pending;
    remixSubmit.textContent = pending ? '正在创建…' : '创建副本';
  }

  function syncRemixWorkspaces() {
    if (remix?.shareId) { updateRemixControls(); return; }
    const previous = remixWorkspace.value || workspaceSelect.value;
    remixWorkspace.replaceChildren(...Array.from(workspaceSelect.options, option => {
      const choice = document.createElement('option');
      choice.value = option.value;
      choice.textContent = option.textContent;
      return choice;
    }));
    if (Array.from(remixWorkspace.options).some(option => option.value === previous)) remixWorkspace.value = previous;
    updateRemixControls();
    if (remix?.template && !remixWorkspace.value) {
      remixStatus.textContent = {
        loading: '正在读取可用工作区…', failed: '无法读取工作区。请刷新后重试。', ready: '暂无可用工作区。',
      }[workspaceListState];
    } else if (remix?.template && workspaceListState === 'ready' && remixStatus.textContent === '正在读取可用工作区…') {
      remixStatus.textContent = '';
    }
  }

  function renderAgentRemixContent(template) {
    const instructions = document.getElementById('catalog-remix-instructions');
    const prompt = template?.instructions || '';
    document.getElementById('catalog-remix-prompt').textContent = prompt;
    instructions.hidden = !prompt;
    instructions.open = false;
    const quickStarts = Array.isArray(template?.quick_starts)
      ? template.quick_starts.filter(start => typeof start === 'string' && start.trim()) : [];
    const quickStartsList = document.getElementById('catalog-remix-quick-starts-list');
    quickStartsList.replaceChildren(...quickStarts.map(text => {
      const line = document.createElement('li');
      line.setAttribute('dir', 'auto');
      line.textContent = text;
      return line;
    }));
    document.getElementById('catalog-remix-quick-starts').hidden = !quickStarts.length;
    document.getElementById('catalog-remix-quick-starts-heading').textContent =
      remixLabel('将复制的快捷开场', 'Quick starts included in the copy');
    const description = document.getElementById('catalog-remix-description');
    if (!template) { description.textContent = ''; return; }
    const instructionsNote = prompt ? (remix?.shareId ? remixLabel('副本包含分享者选择的指令。', 'The copy includes the instructions selected by the sender.')
      : remixLabel('副本包含发布的指令，可在自己的工作区修改。', 'The copy includes the published instructions. You can edit them in your workspace.'))
      : remixLabel('创建后可补充自己的指令。', 'You can add your own instructions after creating the copy.');
    description.textContent = instructionsNote + remixLabel('工具可在新副本中另行配置。', ' Configure tools separately in the new copy.');
  }

  async function readAgentRemix(entry) {
    entry.template = null;
    entry.read?.abort();
    const controller = new AbortController();
    entry.read = controller;
    renderAgentRemixContent();
    shareSender.textContent = '';
    shareSender.hidden = true;
    remixRefresh.hidden = true;
    remixStatus.textContent = entry.shareId ? remixLabel('正在读取分享…','Loading share…') : '正在读取发布内容…';
    updateRemixControls();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
    const result = await request('GET', entry.path, undefined, {}, signal).catch(() => ({status: 0}));
    if (!currentRemix(entry) || entry.read !== controller) return;
    const template = result.body?.template;
    const grant = result.body?.grant;
    if (result.status !== 200 || !template?.revision || typeof template.name !== 'string' ||
        (entry.shareId && (grant?.id !== entry.shareId || grant?.state !== 'active'))) {
      remixStatus.textContent = entry.shareId && [404,410].includes(result.status)
        ? remixLabel('此分享已不可用。','This share is no longer available.')
        : messageFor(result.body?.error, entry.shareId ? remixLabel('无法读取分享，请重试。','Could not load the share. Try again.') : '无法读取发布内容，请重试。');
      remixRefresh.textContent = '重新读取';
      remixRefresh.hidden = [404,410].includes(result.status);
      return;
    }
    if (remixName.value === entry.suggestion) remixName.value = template.name;
    entry.suggestion = template.name;
    entry.template = template;
    document.getElementById('catalog-remix-summary').textContent = template.summary;
    if (entry.shareId) {
      const name = grant.sender?.display_name || grant.sender?.handle || '';
      shareSender.textContent = remixLabel('来自 ' + name, 'Shared by ' + name);
      shareSender.hidden = false;
    }
    renderAgentRemixContent(template);
    remixStatus.textContent = '';
    syncRemixWorkspaces();
  }

  function openRemix(item) {
    if (!canUseCatalogItem(item) || remixDialog.open) return;
    const entry = {path: '/v1/discover/agents/' + item.slug + '/remix', viewer: currentUser,
      suggestion: item.name, keys: new Map()};
    return showRemix(entry, item.summary);
  }

  function showRemix(entry, summary = '') {
    remix = entry;
    remixName.value = entry.suggestion;
    document.getElementById('catalog-remix-summary').textContent = summary || '';
    document.getElementById('catalog-remix-title').textContent = entry.shareId
      ? remixLabel('复制私下分享的智能体','Copy privately shared agent') : remixLabel('复制智能体','Copy agent');
    document.getElementById('catalog-remix-workspace-field').hidden = Boolean(entry.shareId);
    remixWorkspace.required = !entry.shareId;
    const destination = document.getElementById('catalog-remix-personal-destination');
    destination.hidden = !entry.shareId;
    destination.textContent = remixLabel('副本会保存到你的个人工作区。','The copy will be saved in your personal workspace.');
    syncRemixWorkspaces();
    remixDialog.showModal();
    return readAgentRemix(entry);
  }

  async function submitRemix(event) {
    event.preventDefault();
    const entry = remix;
    const name = remixName.value.trim();
    if (!entry?.template || !currentRemix(entry) || entry.pending || (!entry.shareId && !remixWorkspace.value) || !name) return;
    const payload = {revision:entry.template.revision, ...(entry.shareId ? {} : {workspace_id:remixWorkspace.value}), name};
    const stamp = JSON.stringify(payload);
    const key = entry.keys.get(stamp) || reuseKey();
    entry.keys.set(stamp, key);
    entry.pending = true;
    updateRemixControls();
    remixStatus.textContent = '正在创建副本…';
    const result = await request('POST', entry.path, payload, {'Idempotency-Key': key}, AbortSignal.timeout(12000))
      .catch(() => ({status: 0}));
    if (!currentRemix(entry)) return;
    entry.pending = false;
    const agent = result.body?.agent;
    if ([200,201].includes(result.status) && agent?.id && (entry.shareId ? /^[a-f0-9]{32}$/.test(agent.workspace_id) : agent.workspace_id === payload.workspace_id)) {
      entry.template = null;
      updateRemixControls();
      remixStatus.textContent = '已创建副本，正在打开对话…';
      const hash = new URLSearchParams({workspace: agent.workspace_id, agent: agent.id});
      location.assign('/chat#' + hash.toString());
      return;
    }
    const error = result.body?.error;
    if (error?.code === 'listing_changed' || (entry.shareId && error?.code === 'agent_copy_changed')) {
      entry.template = null;
      renderAgentRemixContent();
      remixRefresh.textContent = '查看新版本';
      remixRefresh.hidden = false;
      remixStatus.textContent = '发布内容已更新，请先查看新版本。';
      remixRefresh.focus();
    } else {
      if ([404,410].includes(result.status)) {
        entry.template = null;
        renderAgentRemixContent();
        shareSender.textContent = '';
        shareSender.hidden = true;
        document.getElementById('catalog-remix-summary').textContent = '';
      }
      const fallback = '暂时无法确认是否已创建副本，可以重试。';
      remixStatus.textContent = entry.shareId && [404,410].includes(result.status)
        ? remixLabel('此分享已不可用。','This share is no longer available.')
        : result.status >= 500 ? fallback : messageFor(error, fallback);
    }
    updateRemixControls();
    if (error?.code === 'name_conflict') {
      remixName.focus();
      remixName.select();
    }
  }

  function canUseCatalogItem(item) {
    const viewer = catalogViewers.get(item);
    return Boolean(currentUser && catalogActions.has(item) && validSlug(item.slug) &&
      (nativeCatalog ? matchesNativeViewer(viewer) : viewer === sessionRequest));
  }

  async function confirmCatalogViewer(page) {
    if (page.session) await page.session;
    const viewer = currentUser;
    if (!viewer || page.signal.aborted || page.scope !== sessionRequest || page.catalog !== catalog ||
        matchesNativeViewer(page.viewer, viewer) || !matchesNativeViewer(viewer.username, viewer)) return;
    const response = await request('GET', page.path, undefined, undefined, page.signal).catch(() => ({status: 0}));
    if (viewer !== currentUser || page.scope !== sessionRequest || page.catalog !== catalog ||
        response.status !== 200 || !matchesNativeViewer(response.body?.viewer_username, viewer)) return;
    const verified = new Map(catalogItems(response.body).filter(item => validSlug(item?.slug)).map(item => [item.slug, item]));
    for (const item of page.items) {
      const match = verified.get(item.slug);
      if (!match) continue;
      catalogViewers.set(item, viewer.username);
      item.chat_enabled = match.chat_enabled;
      item.own_agent = match.own_agent;
    }
    syncCatalogActions();
  }

  function syncCatalogActions() {
    for (const [item, actions] of catalogActions) {
      const viewer = canUseCatalogItem(item) ? currentUser : null;
      const guest = sessionState === 'guest' && validSlug(item.slug);
      if (actions.viewer === viewer && actions.guest === guest) continue;
      actions.viewer = viewer;
      actions.guest = guest;
      const holder = actions.element;
      holder.replaceChildren();
      holder.hidden = !viewer && !guest;
      if (holder.hidden) continue;
      if (guest) {
        const chatEnabled = item.chat_enabled === true;
        const link = document.createElement('a');
        link.href = '/a/' + item.slug + (chatEnabled ? '#conversation-title' : '');
        link.className = 'catalog-chat';
        link.textContent = chatEnabled ? '聊天' : '查看主页';
        const label = item.name || item.slug;
        link.setAttribute('aria-label', chatEnabled ? '和 ' + label + ' 聊天' : '查看 ' + label + ' 的主页');
        holder.append(link);
        continue;
      }
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'catalog-use';
      use.textContent = '复制';
      use.setAttribute('aria-label', '复制智能体：' + (item.name || item.slug));
      use.addEventListener('click', () => openRemix(item));
      if (viewer && item.chat_enabled && !item.own_agent) {
        const chat = document.createElement('a');
        chat.href = '/chat#public-agent=' + item.slug;
        chat.className = 'catalog-chat';
        chat.textContent = '聊天';
        chat.setAttribute('aria-label', '和 ' + (item.name || item.slug) + ' 聊天');
        chat.addEventListener('click', event => {
          if (currentUser !== viewer || !canUseCatalogItem(item)) event.preventDefault();
        });
        holder.append(chat);
      }
      holder.append(use);
    }
  }

  function renderCatalog(items, start = 0) {
    const list = document.getElementById('discover-list');
    if (!start) {
      list.replaceChildren();
      catalogActions.clear();
    }
    document.getElementById('discover-empty').hidden = items.length > 0;
    for (const item of items.slice(start)) {
      const li = document.createElement('li');
      if (validSlug(item.slug)) li.dataset.catalogSlug = item.slug;
      const card = document.createElement('article');
      const avatar = document.createElement('span');
      avatar.className = 'catalog-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = catalogMonogram(item.name || item.slug);
      avatar.dataset.tone = catalogTone(item.name || item.slug);
      const copy = document.createElement('div');
      copy.className = 'catalog-copy';
      const name = document.createElement('h3');
      const label = item.name || item.slug;
      if (validSlug(item.slug)) {
        const profile = document.createElement('a');
        profile.className = 'catalog-profile';
        profile.href = '/a/' + item.slug;
        profile.textContent = label;
        name.append(profile);
      } else {
        name.textContent = label;
      }
      const summary = document.createElement('p');
      summary.className = 'summary';
      summary.textContent = item.summary || '没有简介。';
      copy.append(name, summary);
      const meta = document.createElement('div');
      meta.className = 'catalog-card-meta';
      if (item.category) {
        const tag = document.createElement('span');
        tag.textContent = categoryLabel(item.category);
        if (tag.textContent) meta.append(tag);
      }
      const handle = creatorHandle(item);
      if (handle) {
        const creator = document.createElement('a');
        creator.className = 'catalog-author';
        const filters = new URLSearchParams(location?.search);
        filters.set('creator', handle);
        creator.href = '/discover?' + filters.toString();
        creator.textContent = item.creator.name || handle;
        creator.setAttribute('aria-label', '查看 ' + creator.textContent + ' 的公开智能体');
        meta.append(creator);
      }
      if (meta.childElementCount) copy.append(meta);
      const actions = document.createElement('div');
      actions.className = 'catalog-agent-actions';
      actions.hidden = true;
      catalogActions.set(item, {element: actions, viewer: null, guest: false});
      card.append(avatar, copy, actions);
      li.append(card);
      list.append(li);
    }
    syncCatalogActions();
  }

  async function loadCatalog(append = false) {
    const panel = document.getElementById('catalog-panel');
    if (append && (!cursor || panel.getAttribute('aria-busy') === 'true')) return;
    const seq = ++catalogRequest;
    const scope = sessionRequest;
    const checkingSession = sessionPending;
    const empty = document.getElementById('discover-empty');
    const retry = document.getElementById('teams-retry');
    const more = document.getElementById('catalog-more');
    const count = document.getElementById('catalog-count');
    const error = document.getElementById('catalog-error');
    const shouldFocus = append && document.activeElement === more;
    if (!append) {
      catalogReader?.abort();
      catalogReader = new AbortController();
      applyCatalogFilters();
      activeQuery = catalogSearch.value.trim().slice(0, 80);
      catalog = [];
      cursor = '';
      catalogPages = 0;
      catalogDeparture = null;
      renderCatalog([]);
      empty.hidden = true;
      more.hidden = true;
    }
    error.hidden = true;
    retry.hidden = true;
    catalogEmptyReset.hidden = true;
    more.disabled = true;
    more.textContent = '加载更多';
    count.textContent = append ? '正在加载更多智能体…' : '正在加载智能体…';
    panel.setAttribute('aria-busy', 'true');
    const signal = catalogReader.signal;
    const requested = cursor;
    const isCurrent = () => seq === catalogRequest && scope === sessionRequest && !signal.aborted;
    try {
      const path = catalogQuery(activeQuery, requested, activeCategory, activeCreator?.handle);
      const fetchCatalog = () => request('GET', path, undefined, undefined, signal);
      let listed = await fetchCatalog();
      if (!isCurrent()) return;
      if (listed.status === 401 && checkingSession) {
        await checkingSession;
        if (!isCurrent()) return;
        if (currentUser) listed = await fetchCatalog();
        if (!isCurrent()) return;
      }
      if (listed.status !== 200) throw new Error(messageFor(listed.body.error, '无法加载公共目录。'));
      const viewer = nativeCatalog ? listed.body.viewer_username : scope;
      const known = new Set(catalog.map(item => item.slug));
      const start = catalog.length;
      for (const item of catalogItems(listed.body)) {
        if (!item || typeof item !== 'object' || known.has(item.slug)) continue;
        known.add(item.slug);
        catalogViewers.set(item, viewer);
        catalog.push(item);
      }
      const next = listed.body.cursor;
      const nextCursor = typeof next === 'string' || (Number.isSafeInteger(next) && next > 0) ? String(next) : '';
      cursor = nextCursor === requested ? '' : nextCursor;
      catalogPages += 1;
      if (activeCreator) {
        const author = catalog.find(item => creatorHandle(item) === activeCreator.handle);
        if (author) {
          activeCreator.name = author.creator.name || activeCreator.name;
          applyCatalogFilters();
        }
      }
      renderCatalog(catalog, start);
      more.hidden = !cursor;
      const filtered = activeQuery || activeCategory !== 'all' || activeCreator;
      empty.textContent = filtered ? '没有匹配的智能体。' : '暂无公开智能体。';
      catalogEmptyReset.hidden = empty.hidden || !filtered;
      count.textContent = catalog.length ? '已显示 ' + catalog.length + ' 个智能体' : '';
      if (shouldFocus && [document.body, more].includes(document.activeElement)) {
        const first = catalog[start]?.slug;
        const last = !cursor && catalog.at(-1)?.slug;
        const slug = first || last;
        if (validSlug(slug)) document.querySelector(`#discover-list [data-catalog-slug="${slug}"] .catalog-profile`)?.focus();
      }
      if (nativeCatalog && catalog.length > start) {
        void confirmCatalogViewer({path, viewer, scope, session: checkingSession, catalog, items: catalog.slice(start), signal});
      }
      return seq;
    } catch (failure) {
      if (!isCurrent()) return;
      error.hidden = false;
      error.textContent = failure.message || '无法加载公共目录。';
      count.textContent = catalog.length ? '已显示 ' + catalog.length + ' 个智能体' : '';
      retry.hidden = append;
      more.hidden = !cursor;
      if (append) more.textContent = '重试加载更多';
      empty.hidden = true;
    } finally {
      if (isCurrent()) {
        more.disabled = false;
        panel.setAttribute('aria-busy', 'false');
        if (shouldFocus && append && !error.hidden && document.activeElement === document.body) more.focus({preventScroll:true});
      }
    }
  }

  const returnLinks = teamsView ? ['team-open'] : CATALOG_RETURN_LINKS;
  const validCatalogReturn = slug => teamsView ? TEAM_DIRECTORY_ID.test(slug || '') : validSlug(slug);

  function catalogPositionKey() {
    const viewer = currentUser?.id;
    if (sessionState !== 'guest' && typeof viewer !== 'string') return '';
    const path = teamsView ? teamDirectoryQuery(activeTeamQuery) : catalogQuery(activeQuery, '', activeCategory, activeCreator?.handle);
    return JSON.stringify([sessionState, viewer || null, path]);
  }

  function rememberCatalogPosition(trigger) {
    const key = catalogPositionKey();
    if (!key || !catalogPages || !history?.replaceState) return;
    const slug = teamsView ? trigger?.closest?.('[data-team-directory-ref]')?.dataset.teamDirectoryRef
      : trigger?.closest?.('[data-catalog-slug]')?.dataset.catalogSlug;
    const link = returnLinks.find(name => trigger?.classList?.contains(name));
    const offset = link && trigger.getBoundingClientRect().top - initialView.getBoundingClientRect().top;
    const saved = history.state?.discoverAgentDirectory;
    const pages = saved?.key === key && Number.isInteger(saved.pages) ? Math.max(catalogPages, saved.pages) : catalogPages;
    try {
      history.replaceState({...history.state, discoverAgentDirectory:{
        key, pages:Math.min(pages, BROWSE_RESTORE_PAGES), scroll:initialView.scrollTop || 0,
        ...(link && validCatalogReturn(slug) ? {slug, link, offset} : {}),
      }}, '');
    } catch { /* The browser may disable history changes while leaving. */ }
  }

  async function restoreCatalogPosition(directoryLoad) {
    const request = await directoryLoad;
    const saved = history?.state?.discoverAgentDirectory;
    if (!request || request !== catalogRequest || !saved || saved.key !== catalogPositionKey() ||
        !Number.isInteger(saved.pages) || saved.pages < 1 || saved.pages > BROWSE_RESTORE_PAGES ||
        !Number.isFinite(saved.scroll) || saved.scroll < 0) return;
    while (catalogPages < saved.pages && cursor) {
      const loadPage = teamsView ? loadTeams : loadCatalog;
      if (await loadPage(true) !== catalogRequest || saved.key !== catalogPositionKey()) return;
    }
    const attribute = teamsView ? 'data-team-directory-ref' : 'data-catalog-slug';
    const target = validCatalogReturn(saved.slug) && returnLinks.includes(saved.link)
      ? document.querySelector(`#discover-list [${attribute}="${saved.slug}"] .${saved.link}`) : null;
    target?.focus({preventScroll: true});
    initialView.scrollTop = saved.scroll;
    if (target && Number.isFinite(saved.offset)) {
      initialView.scrollTop += target.getBoundingClientRect().top - initialView.getBoundingClientRect().top - saved.offset;
    }
  }

  function renderManage(pairs, workspace = '') {
    const list = document.getElementById('manage-list');
    list.replaceChildren();
    document.getElementById('manage-empty').hidden = pairs.length > 0;
    const viewer = currentUser;
    const canManage = () => Boolean(viewer) && viewer === currentUser && workspaceSelect.value === workspace;
    for (const {agent, discover} of pairs) {
      const li = document.createElement('li');
      li.className = 'manage-row';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = agent.name;
      const state = document.createElement('span');
      state.className = 'state';
      const archived = Boolean(agent.archived || agent.native_deleted);
      state.textContent = archived ? '已归档 · 仍公开' : discover.listed ? '已发布' : '未发布';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 30;
      input.placeholder = '公开地址';
      input.setAttribute('aria-label', agent.name + ' 的公开地址');
      input.value = discover.slug || '';
      input.disabled = archived;
      const options = document.createElement('div');
      options.className = 'catalog-publish-options';
      const label = document.createElement('label');
      const allow = document.createElement('input');
      allow.type = 'checkbox';
      allow.disabled = archived || !agent.instructions;
      allow.checked = Boolean(agent.instructions && discover.copy_instructions);
      const preview = document.createElement('pre');
      preview.textContent = agent.instructions || '';
      preview.hidden = !allow.checked;
      allow.addEventListener('change', () => { preview.hidden = !allow.checked; });
      label.append(allow, document.createTextNode('公开完整指令，允许复制'));
      const chatLabel = document.createElement('label');
      const publicChat = document.createElement('input');
      publicChat.type = 'checkbox';
      publicChat.checked = discover.chat_enabled === true;
      publicChat.disabled = archived;
      chatLabel.append(publicChat, document.createTextNode('允许访客聊天'));
      const chatNote = document.createElement('p');
      chatNote.className = 'note';
      chatNote.textContent = '自动回复使用已发布的简介、指令和当前对话。你可以查看访客的对话。';
      chatNote.hidden = !publicChat.checked;
      publicChat.addEventListener('change', () => { chatNote.hidden = !publicChat.checked; });
      const quickLabel = document.createElement('label');
      const quickStarts = document.createElement('input');
      quickStarts.type = 'checkbox';
      quickStarts.disabled = archived || !agent.quick_starts?.length;
      quickStarts.checked = !quickStarts.disabled && discover.publish_quick_starts === true;
      quickLabel.append(quickStarts, document.createTextNode('公开快捷开场'));
      const quickNote = document.createElement('p');
      quickNote.className = 'note';
      quickNote.textContent = archived ? '取消发布后，访客将无法打开公开主页。'
        : quickStarts.disabled ? '先在智能体编辑页添加开场。'
          : '开场会显示在公开主页。访客选择后，可编辑再发送。';
      options.append(label, preview, chatLabel, chatNote, quickLabel, quickNote);
      const publish = document.createElement('button');
      publish.type = 'button';
      publish.hidden = archived;
      publish.textContent = discover.listed ? '更新发布' : '发布';
      publish.addEventListener('click', async () => {
        if (!canManage() || archived || publish.disabled) return;
        if (!validSlug(input.value.trim())) {
          show('error', 'slug 需为 3–30 个字符的小写字母、数字或连字符。');
          return;
        }
        publish.disabled = true;
        revoke.disabled = true;
        publish.textContent = '正在发布…';
        try {
          const result = await request(
            'POST', `/v1/workspaces/${workspace}/agents/${agent.id}/discover`,
            {slug: input.value.trim(), revision: agent.revision, copy_instructions: allow.checked,
              chat_enabled: publicChat.checked, publish_quick_starts: quickStarts.checked});
          if (!canManage()) return;
          if (result.status !== 201 && result.status !== 200) {
            show('error', messageFor(result.body.error, '无法发布。'));
            return;
          }
          show('ok', '已发布。');
          await Promise.all([loadCatalog(), loadManage()]);
        } catch {
          if (canManage()) show('error', '连接中断，请重试发布。');
        } finally {
          publish.disabled = false;
          revoke.disabled = !discover.listed;
          publish.textContent = discover.listed ? '更新发布' : '发布';
        }
      });
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.textContent = '取消发布';
      revoke.disabled = !discover.listed;
      revoke.addEventListener('click', async () => {
        if (!canManage() || revoke.disabled) return;
        const result = await request(
          'POST', `/v1/workspaces/${workspace}/agents/${agent.id}/discover/revoke`, {});
        if (!canManage()) return;
        if (result.status !== 200) {
          show('error', messageFor(result.body.error, '无法取消收录。'));
          return;
        }
        show('ok', '已取消发布。');
        await loadCatalog();
        await loadManage();
      });
      li.append(title, state, input, publish, revoke, options);
      if (discover.listed && validSlug(discover.slug)) {
        const homepage = document.createElement('a');
        homepage.href = '/a/' + discover.slug;
        homepage.textContent = '打开公开主页';
        options.append(homepage);
      }
      list.append(li);
    }
  }

  async function loadManage() {
    const seq = ++manageRequest;
    const id = workspaceSelect.value;
    if (!currentUser || !id) {
      renderManage([]);
      return;
    }
    const path = `/v1/workspaces/${id}/agents?limit=100&include_archived=1`;
    const listed = await request('GET', path);
    if (seq !== manageRequest) return;
    if (listed.status !== 200) {
      renderManage([]);
      return;
    }
    const agents = [...(listed.body.items || [])];
    if (/^[0-9a-f]{32}$/.test(listed.body.cursor || '')) {
      const more = await request('GET', path + '&cursor=' + listed.body.cursor);
      if (seq !== manageRequest) return;
      if (more.status === 200) agents.push(...(more.body.items || []));
    }
    const statuses = await Promise.all(agents.map(agent =>
      request('GET', `/v1/workspaces/${id}/agents/${agent.id}/discover`)
        .then(result => (result.status === 200 ? result.body.discover : {listed: false}))));
    if (seq === manageRequest) {
      const pairs = agentDiscoverPairs(agents, statuses);
      const index = id === manageWorkspace ? pairs.findIndex(({agent}) => agent.id === manageAgent) : -1;
      if (index > 0) pairs.unshift(...pairs.splice(index, 1));
      renderManage(pairs, id);
    }
  }

  async function load() {
    const attempt = ++sessionRequest;
    currentUser = null;
    followedCreatorPicker?.close();
    engagementPending.clear();
    sessionState = 'pending';
    cancelSearch();
    composingQuery = false;
    feedRestore = null;
    feedPositions.clear();
    feedReturn = null;
    workComments.setActor('');
    closeWorkRemix();
    syncCatalogActions();
    closeAgentRemix();
    receivedView = null;
    receivedShares.hidden = true;
    receivedShares.open = false;
    receivedList.replaceChildren();
    manageRequest++;
    document.getElementById('catalog-manage').hidden = true;
    if (agentsView) {
      workspaceListState = 'loading';
      workspaceSelect.replaceChildren();
      renderManage([]);
    }
    const whoami = document.getElementById('whoami');
    whoami.textContent = '';
    showDiscoverView();
    const sessionLoad = request('GET', '/v1/auth/session').catch(() => ({status: 0})).then(session => {
      if (attempt !== sessionRequest) return;
      sessionPending = null;
      currentUser = session.status === 200 ? session.body?.user || null : null;
      sessionState = currentUser ? 'signed-in' : session.status === 401 ? 'guest' : 'failed';
      whoami.textContent = currentUser?.username || '';
      workComments.setActor(currentUser?.id || currentUser?.username || '', currentUser?.id);
      applyCatalogChrome();
      syncCatalogActions();
    });
    sessionPending = sessionLoad;
    const detailIntent = catalogView ? null : workDetailFromSearch(location?.search);
    const detailLoad = detailIntent ? openWorkDetail(detailIntent) : closeWorkDetail();
    mainPanel.hidden = false;
    if (!catalogView) applyFeedChrome({restoreQuery: true});
    if (teamsView) void loadTeams();
    const overlapSession = nativeCatalog && attempt === 1;
    const feedLoad = catalogView ? null : loadFeed({overlapSession});
    const initialFeedRequest = feedRequest;
    const directoryLoad = agentsView ? loadCatalog() : null;
    const directoryReturn = directoryLoad && sessionLoad.then(() => {
      if (attempt === sessionRequest) return restoreCatalogPosition(directoryLoad);
    });
    await sessionLoad;
    if (attempt !== sessionRequest) return;
    loginPanel.hidden = Boolean(currentUser);
    mainPanel.hidden = false;
    show('', '');
    if (!catalogView) {
      let loadedFeed = feedRequest === initialFeedRequest ? feedLoad : null;
      if (feedState.tab !== 'activity') {
        applyFeedChrome();
        if (!overlapSession || !loadedFeed) loadedFeed = loadFeed();
      } else if (currentUser && !nativeCatalog) loadedFeed = loadFeed({retainItems: true});
      else if (nativeCatalog && feedViewer !== undefined) {
        if (mismatchedNativeFeed(feedViewer)) loadedFeed = loadFeed({retainItems: true, retryViewer: false});
        else for (const [item, actions] of feedActions) addFeedEngagement(item, actions);
      }
      updateFeedStatus();
      const feedReturnLoad = Promise.resolve(loadedFeed).then(() => {
        if (attempt === sessionRequest) return restoreRecordedFeedPosition();
      });
      return Promise.all([feedReturnLoad, detailLoad]);
    }
    if (!currentUser) {
      if (teamsView) await loadTeams();
      await directoryReturn;
      return;
    }
    document.getElementById('catalog-manage').hidden = !agentsView;
    receivedShares.hidden = !agentsView || !nativeCatalog;
    const sharedPreview = agentShare ? showRemix({path:`/v1/agent-copy-grants/${agentShare}/remix`, viewer:currentUser,
      suggestion:'', shareId:agentShare, keys:new Map()}) : null;
    if (agentsView) {
      const listed = await request('GET', '/v1/workspaces?limit=100').catch(() => ({status: 0}));
      if (attempt !== sessionRequest) return;
      workspaceListState = listed.status === 200 ? 'ready' : 'failed';
      const workspaces = workspaceListState === 'ready' ? (listed.body.items || []) : [];
      workspaceSelect.replaceChildren();
      for (const space of workspaces) {
        const option = document.createElement('option');
        option.value = space.id;
        option.textContent = space.name;
        workspaceSelect.append(option);
      }
      if (workspaces.some(space => space.id === manageWorkspace)) workspaceSelect.value = manageWorkspace;
      syncRemixWorkspaces();
      const manage = document.getElementById('catalog-manage');
      if (manage.open) void loadManage();
      else if (location?.hash === '#catalog-manage') manage.open = true;
    }
    if (teamsView) await restoreCatalogPosition(loadTeams());
    await Promise.all([directoryReturn, sharedPreview]);
  }

  workspaceSelect.addEventListener('change', loadManage);
  const manage = document.getElementById('catalog-manage');
  manage.addEventListener('toggle', () => { if (manage.open) void loadManage(); });
  if (catalogView) {
    document.getElementById('discover-list').addEventListener('click', event => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a');
      if (!link || !returnLinks.some(name => link.classList.contains(name))) return;
      catalogDeparture = link;
      rememberCatalogPosition(link);
    });
    window?.addEventListener?.('pagehide', () => rememberCatalogPosition(catalogDeparture || document.activeElement));
    window?.addEventListener?.('pageshow', () => { catalogDeparture = null; });
  }
  if (agentsView) {
    for (const chip of document.querySelectorAll('[data-catalog-category]')) {
      chip.addEventListener('click', () => setCategory(chip.dataset.catalogCategory));
    }
    document.getElementById('catalog-filter-search').addEventListener('click', () => {
      categoryQuery.value = '';
      renderCategoryOptions();
      categoryDialog.showModal();
      categoryQuery.focus();
    });
    categoryQuery.addEventListener('input', renderCategoryOptions);
    document.getElementById('catalog-category-close').addEventListener('click', () => categoryDialog.close());
    document.getElementById('catalog-clear-creator').addEventListener('click', () => {
      activeCreator = null;
      const params = new URLSearchParams(location?.search);
      params.delete('creator');
      history?.replaceState?.(null, '', '/discover?' + params.toString());
      syncLoginLink();
      loadCatalog();
    });
    document.getElementById('catalog-remix-form').addEventListener('submit', submitRemix);
    remixName.addEventListener('input', updateRemixControls);
    remixWorkspace.addEventListener('change', updateRemixControls);
    remixRefresh.addEventListener('click', () => remix && readAgentRemix(remix));
    remixCancel.addEventListener('click', closeAgentRemix);
    document.getElementById('received-agent-shares-label').textContent = remixLabel('收到的智能体分享','Received agent shares');
    receivedShares.addEventListener('toggle', () => {
      if (receivedShares.open) void loadReceived({reset:true});
      else receivedView = null;
    });
    receivedMore.addEventListener('click', () => void loadReceived());
    remixDialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (!remix?.pending) closeAgentRemix();
    });
  }
  document.getElementById('catalog-search').addEventListener('submit', event => {
    event.preventDefault();
    saveCatalogQuery();
    if (agentsView) return loadCatalog();
    if (teamsView) return loadTeams();
  });
  document.getElementById('catalog-clear').addEventListener('click', () => {
    if (catalogView) return clearCatalogSearch();
  });
  catalogSearch.addEventListener('keydown', event => {
    if (!catalogView || event.key !== 'Escape' || event.isComposing ||
        (!catalogSearch.value && !activeQuery && !activeTeamQuery)) return;
    event.preventDefault();
    return clearCatalogSearch();
  });
  catalogEmptyReset.addEventListener('click', () => {
    if (catalogView) return clearCatalogSearch({allFilters:true});
  });
  document.getElementById('teams-retry').addEventListener('click', () => {
    catalogSearch.focus?.({preventScroll:true});
    if (agentsView) return loadCatalog();
    if (teamsView) return sessionState === 'failed' ? load() : loadTeams();
  });
  document.getElementById('catalog-more').addEventListener('click', () => {
    if (agentsView) return loadCatalog(true);
    if (teamsView) return loadMoreTeams();
  });
  for (const kind of FEED_KINDS) {
    const button = document.getElementById('feed-kind-' + (kind || 'all'));
    if (!button) continue;
    button.addEventListener('click', () => applyFeedFilters({kind,
      sort:feedState.tab === 'collected' ? feedState.sort : 'latest', query:searchText()}, {refresh:true}));
  }
  document.getElementById('feed-sort-popular')?.addEventListener('click', () => {
    if (feedState.tab !== 'activity') return;
    return applyFeedFilters({kind: '', sort: 'popular', query: searchText()}, {refresh: true});
  });
  document.getElementById('feed-creator-filter')?.addEventListener('click', () => {
    const loaded = applyFeedFilters({creator: '', query: searchText()});
    document.getElementById('feed-tab-' + feedState.tab)?.focus?.();
    return loaded;
  });
  topicFilter?.addEventListener('change', () => applyFeedFilters({topic:topicFilter.value, query:searchText()}));
  collectedSort?.addEventListener('change', () => {
    if (nativeCatalog && currentUser && feedState.tab === 'collected') {
      return applyFeedFilters({sort:collectedSort.value === 'collected' ? 'collected' : 'latest', query:searchText()});
    }
  });
  followedCreators?.addEventListener('click', openFollowedCreators);
  document.getElementById('feed-search')?.addEventListener('submit', event => {
    event.preventDefault();
    if (composingQuery) return;
    return commitSearch() || feedFailure?.();
  });
  searchInput?.addEventListener('input', scheduleSearch);
  searchInput?.addEventListener('compositionstart', () => {
    composingQuery = true;
    cancelSearch();
  });
  searchInput?.addEventListener('compositionend', () => {
    composingQuery = false;
    scheduleSearch();
  });
  searchInput?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || composingQuery || event.isComposing || (!searchInput.value && !feedState.query)) return;
    event.preventDefault();
    return clearFeedSearch();
  });
  clearSearch?.addEventListener('click', clearFeedSearch);
  resetEmptyFeed?.addEventListener('click', () => {
    searchInput?.focus?.({preventScroll: true});
    return applyFeedFilters({query:'', kind:'', creator:'', topic:'', sort:feedState.tab === 'collected' ? feedState.sort : 'latest'});
  });
  retryFeed?.addEventListener('click', () => {
    const retry = feedFailure;
    if (!retry) return;
    const last = workTriggers.get(feedState.items.at(-1)?.slug);
    (last || searchInput)?.focus?.({preventScroll: true});
    return retry();
  });
  const feedMore = document.getElementById('feed-more');
  if (feedMore) {
    feedMore.addEventListener('click', async event => {
      if (feedMore.disabled || !feedState.cursor) return;
      const start = feedState.items.length;
      const loaded = await loadFeed({append: true});
      const next = feedState.items[start];
      if (loaded && event?.detail === 0 && next) workTriggers.get(next.slug)?.focus?.();
    });
  }
  const selectFeedTab = tab => applyFeedFilters({
    tab, sort: tab === feedState.tab ? feedState.sort : 'latest', query: searchText(),
  }, {resume: true});
  for (const [index, tab] of FEED_TABS.entries()) {
    const button = document.getElementById('feed-tab-' + tab);
    if (!button) continue;
    button.addEventListener('click', () => selectFeedTab(tab));
    button.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      let next;
      switch (event.key) {
        case 'ArrowLeft': next = (index + FEED_TABS.length - 1) % FEED_TABS.length; break;
        case 'ArrowRight': next = (index + 1) % FEED_TABS.length; break;
        case 'Home': next = 0; break;
        case 'End': next = FEED_TABS.length - 1; break;
        default: return;
      }
      event.preventDefault();
      const selected = FEED_TABS[next];
      const loading = selectFeedTab(selected);
      document.getElementById('feed-tab-' + selected)?.focus?.({preventScroll: true});
      return loading;
    });
  }

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status >= 200 && result.status < 300 && typeof location?.reload === 'function') {
      location.reload();
      return;
    }
    await load();
  });

  if (!catalogView) applyFeedChrome({restoreQuery: true});
  return load();
}

if (globalThis.document && globalThis.document.getElementById('manage-list')) {
  mount(globalThis.document);
}
