// FlyBot Discover on Bot Social: opt-in public catalog of agents and works, likes, collections,
// creator follows and follow notifications. Ported from the legacy discover.py (#87, #313, #335).
// A listing is a whitelisted projection the owner's DS-Bot chose to publish (title, summary,
// category, kind and an optional explicitly released snapshot).
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ApiError, assert } from "../errors.js";
import { newId } from "../ids.js";
import { CHAT_FILE_BODY_LIMIT, CHAT_FILE_MAX_BYTES, decodeChatFile } from "./chat-files.js";
import { body, handleKey, hashCode, intParam, one, OtContext, optText, params, query, text } from "./core.js";
import { WORK_COMMENTS_SCHEMA, registerWorkComments, workCommentCount, workCommentsPage } from "./work-comments.js";
import { WORK_SEARCH_SCHEMA, publicWorkText, registerWorkSearch, saveWorkSearch, workBodyCondition, workSearchMatch, workSearchQuery } from "./discover-work-search.js";
import { PUBLIC_MEDIA_SCHEMA, decodePublishedMedia, downloadName, isMediaWork, publishedMediaView, savePublishedMedia, sendPublishedMedia } from "./discover-media.js";
import { EDITABLE_WORK_SCHEMA, editableRelease, editableWorkKind, hasEditableRelease } from "./discover-editable.js";

export const DISCOVER_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_listings (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('agent','work')), ref TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', category TEXT, work_kind TEXT,
  snapshot TEXT, listed INTEGER NOT NULL DEFAULT 1, chat_enabled INTEGER NOT NULL DEFAULT 0,
  chat_from INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  publication_revision INTEGER NOT NULL DEFAULT 1, source_revision INTEGER,
  UNIQUE (owner_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS ot_listings_feed ON ot_listings(listed, updated_at);
CREATE INDEX IF NOT EXISTS ot_listings_recent_works ON ot_listings(updated_at DESC, id DESC) WHERE listed = 1 AND kind = 'work';
CREATE INDEX IF NOT EXISTS ot_listings_profile_works ON ot_listings(owner_id, created_at, id) WHERE listed = 1 AND kind = 'work';
CREATE TABLE IF NOT EXISTS ot_listing_models (
  listing_id TEXT PRIMARY KEY REFERENCES ot_listings(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, content BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS ot_listing_models_owner ON ot_listing_models(owner_id);
${PUBLIC_MEDIA_SCHEMA}
${EDITABLE_WORK_SCHEMA}
CREATE TABLE IF NOT EXISTS ot_listing_sites (
  listing_id TEXT PRIMARY KEY REFERENCES ot_listings(id) ON DELETE CASCADE,
  html TEXT NOT NULL
);
${WORK_SEARCH_SCHEMA}
CREATE TABLE IF NOT EXISTS ot_likes (listing_id TEXT NOT NULL REFERENCES ot_listings(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (listing_id, owner_id));
CREATE TABLE IF NOT EXISTS ot_collections (listing_id TEXT NOT NULL REFERENCES ot_listings(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (listing_id, owner_id));
CREATE TABLE IF NOT EXISTS ot_follows (follower_id TEXT NOT NULL, creator_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  work_notices INTEGER NOT NULL DEFAULT 1 CHECK (work_notices IN (0, 1)),
  PRIMARY KEY (follower_id, creator_id), CHECK (follower_id <> creator_id));
CREATE INDEX IF NOT EXISTS ot_follows_creator ON ot_follows(creator_id);
CREATE INDEX IF NOT EXISTS ot_likes_recent ON ot_likes(listing_id, created_at);
CREATE INDEX IF NOT EXISTS ot_collections_recent ON ot_collections(listing_id, created_at);
CREATE INDEX IF NOT EXISTS ot_likes_profile_recent ON ot_likes(owner_id, created_at, listing_id);
CREATE INDEX IF NOT EXISTS ot_collections_profile_recent ON ot_collections(owner_id, created_at, listing_id);
CREATE INDEX IF NOT EXISTS ot_follows_profile_outgoing ON ot_follows(follower_id, created_at);
CREATE INDEX IF NOT EXISTS ot_follows_profile_incoming ON ot_follows(creator_id, created_at);
${WORK_COMMENTS_SCHEMA}
`;

export const CATEGORIES = ["content-creation", "customer-support", "data-analysis", "design", "education", "engineering", "finance", "it-security", "investment", "legal", "life", "marketing", "operations", "product", "recruiting", "research", "sales"];
const WORK_TOPICS = new Set([
  "productivity", "entertainment", "technology", "beauty", "fashion", "food", "travel", "wellness",
  "education", "creative", "games", "finance", "career", "life",
]);
export const WORK_KINDS = ["document", "website", "whiteboard", "media", "image", "audio", "video", "slides", "dashboard", "model3d", "spreadsheet"];
const CREATOR_HANDLE = /^[a-z0-9][a-z0-9._-]{1,79}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const LISTING_ID = /^otl_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const LATEST_WORK_CURSOR = /^l\.(0|[1-9][0-9]{0,15})\.(otl_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26})\.([a-f0-9]{24})$/;
const RESERVED = new Set(["settings", "team", "members", "v1", "discover", "agents", "chat", "messenger", "space", "artifacts", "memory", "automations", "runtimes", "profile", "download", "install", "shell", "share", "a", "d", "api", "login", "logout", "search", "w", "works", "feed"]);
const REF = /^[A-Za-z0-9._:-]{1,80}$/;
const SNAPSHOT_MAX = 200_000;
const WORK_PREVIEW_MAX = 2_000;
const REMIX_BODY_LIMIT = 8_000;
const REMIX_REVISION = /^[0-9a-f]{64}$/;
const MODEL_MIME = "model/gltf-binary";
const MAX_SITE_BYTES = 32 * 1024;
const SITE_POLICY = [
  "sandbox allow-scripts", "frame-ancestors 'self'", "default-src 'none'",
  "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src data:", "font-src data:", "media-src data:",
  "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");

function publishedSiteAvailable(ot: OtContext, l: { id: string; listed: number; work_kind: string | null }) {
  return Boolean(l.listed && l.work_kind === "website"
    && ot.get("SELECT 1 FROM ot_listing_sites WHERE listing_id = ?", l.id));
}

function engagement(ot: OtContext, l: any, viewer: string) {
  const has = (table: string) => !!ot.get(`SELECT 1 FROM ${table} WHERE listing_id = ? AND owner_id = ?`, l.id, viewer);
  return {
    likes: ot.get<any>("SELECT COUNT(*) AS n FROM ot_likes WHERE listing_id = ?", l.id).n,
    collections: ot.get<any>("SELECT COUNT(*) AS n FROM ot_collections WHERE listing_id = ?", l.id).n,
    liked: has("ot_likes"), collected: has("ot_collections"),
    following: !!ot.get("SELECT 1 FROM ot_follows WHERE follower_id = ? AND creator_id = ?", viewer, l.owner_id),
    own: l.owner_id === viewer,
  };
}

/** Path prefix of PUBLIC_BASE_URL (e.g. `/social`) so cards on the site origin hit this Bot Social. */
export function publicPrefix(base: string) {
  try {
    const path = new URL(base).pathname.replace(/\/+$/, "");
    return path && path !== "/" ? path : "";
  } catch {
    return "";
  }
}

function listingPath(ot: OtContext, l: { kind: string; slug: string }) {
  const prefix = publicPrefix(ot.platform.publicBaseUrl);
  return `${prefix}${l.kind === "agent" ? "/a/" : "/w/"}${l.slug}`;
}

const LISTING_CARD_COLUMNS = `l.id, l.owner_id, l.kind, l.slug, l.title, l.summary, l.category, l.work_kind,
  l.listed, l.chat_enabled, l.updated_at, l.created_at`;

const listingFields = (ot: OtContext, l: any) => ({
  id: l.id, slug: l.slug, kind: l.kind, title: l.title, summary: l.summary, category: l.category, work_kind: l.work_kind,
  updated_at: l.updated_at, created_at: l.created_at, path: listingPath(ot, l),
  ...publishedMediaView(ot, l),
});

const listingView = (ot: OtContext, l: any, viewer: string | null, withSnapshot = false) => ({
  ...listingFields(ot, l), creator: ot.profileView(l.owner_id), listed: !!l.listed, chat_enabled: l.kind === "agent" && !!l.chat_enabled,
  ...(viewer ? engagement(ot, l, viewer) : { likes: ot.get<any>("SELECT COUNT(*) AS n FROM ot_likes WHERE listing_id = ?", l.id).n, collections: ot.get<any>("SELECT COUNT(*) AS n FROM ot_collections WHERE listing_id = ?", l.id).n, liked: false, collected: false, following: false, own: false }),
  ...(l.kind === "work" ? {comment_count: workCommentCount(ot, l.id), site_available: publishedSiteAvailable(ot, l)} : {}),
  ...(withSnapshot ? { snapshot: l.snapshot ?? null } : {}),
});

function publicListingView(ot: OtContext, listing: any) {
  const view = listingView(ot, listing, null, true);
  const {handle, display_name, bio} = view.creator;
  return {...view, creator: {handle, display_name, bio}};
}

function ownerWorkRevision(row: {kind: string; source_revision?: number | null}) {
  return row.kind === "work" && Number.isSafeInteger(row.source_revision) ? {source_revision:row.source_revision} : {};
}

function workExcerpt(listing: {snapshot: string | null; summary: string}, hasSite: boolean) {
  const excerpt = String(listing.snapshot || "").slice(0, WORK_PREVIEW_MAX);
  return hasSite || excerpt.startsWith("{") ? listing.summary || "" : excerpt;
}

function escapeHtml(value: string) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function publishedQuickStarts(listing: {id: string; kind: string; snapshot: string | null}) {
  let starts: string[] = [];
  if (listing.kind === "agent" && listing.snapshot) {
    try {
      const choices = JSON.parse(listing.snapshot)?.quick_starts;
      if (Array.isArray(choices)) starts = choices.slice(0, 5).flatMap((item) => {
        if (typeof item !== "string" || !item.trim()) return [];
        try { return [text(item.trim(), "quick_start", {min: 1, max: 80})]; } catch { return []; }
      });
    } catch { /* An older listing may have no valid snapshot. */ }
  }
  return {starts, version: hashCode(JSON.stringify([listing.id, starts]))};
}

function publicPage(ot: OtContext, l: any, view: any) {
  const creator = view.creator?.display_name || view.creator?.handle || "";
  const creatorHandle = view.creator?.handle;
  const author = CREATOR_HANDLE.test(creatorHandle || "")
    ? `<a href="/discover?creator=${encodeURIComponent(creatorHandle)}">${escapeHtml(creator)}</a>`
    : escapeHtml(creator);
  const title = String(view.title || view.slug);
  const site = l.kind === "work" && view.site_available === true;
  const media = view.file_available ? view.file_mime.split("/")[0] : null;
  const agent = l.kind === "agent";
  const canChat = agent && Boolean(l.chat_enabled);
  const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';"
    + (site ? " frame-src 'self';" : "") + (media === "audio" || media === "video" ? " media-src 'self';" : "")
    + (agent ? " script-src 'self';" : "");
  if (l.kind === "work") {
    const filePath = `/w/${encodeURIComponent(l.slug)}/file`;
    const download = l.work_kind === "model3d" ? `<p><a href="${filePath}">下载 GLB</a></p>`
      : media ? `<p><a href="${filePath}" download>下载作品</a></p>` : "";
    const player = media === "image" ? `<img class="work-media" src="${filePath}" alt="${escapeHtml(title)}" decoding="async">`
      : media === "audio" || media === "video"
        ? `<${media} class="work-media" controls preload="none"${media === "video" ? " playsinline" : ""} src="${filePath}"></${media}>`
        : "";
    const comments = workCommentsPage(ot, l, null, {limit: "4"});
    const recent = comments.items.map(item => item.removed
      ? '<li><span class="meta">评论已移除</span></li>'
      : `<li><p class="meta">${escapeHtml(item.author?.name || item.author?.handle || "")}</p><pre>${escapeHtml(item.body)}</pre></li>`).join("");
    const detail = `/login#work-comments=${encodeURIComponent(l.slug)}`;
    const share = `/login#work-detail=${encodeURIComponent(l.slug)}`;
    const {previous, next} = chronologicalWorkNeighbors(ot, l.id, l.updated_at, PUBLIC_WORK_SCOPE);
    const adjacent = (work: WorkNeighbor | null, rel: "prev" | "next", label: string) => work
      ? `<a rel="${rel}" href="/w/${encodeURIComponent(work.slug)}" title="${escapeHtml(work.title)}">${label}</a>`
      : `<span aria-disabled="true">${label}</span>`;
    const content = site
      ? `<iframe class="work-site-frame" src="/w/${encodeURIComponent(l.slug)}/site" title="${escapeHtml(title)} 的互动预览" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`
      : player || (l.snapshot && !String(l.snapshot).startsWith("{")
        ? `<pre>${escapeHtml(String(l.snapshot).slice(0, 20_000))}</pre>`
        : (view.summary ? `<p>${escapeHtml(view.summary)}</p>` : ""));
    return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<title>${escapeHtml(title)} · FlyBot</title>
<style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}
.meta{color:#555;font-size:.9rem}
a{color:#24594b;text-underline-offset:.18em}
a:focus-visible{outline:2px solid #176750;outline-offset:3px}
h1{overflow-wrap:anywhere}
body.interactive-work{max-width:64rem}
.work-site-frame{display:block;box-sizing:border-box;width:100%;height:clamp(26rem,72vh,56rem);border:1px solid #cbdad3;border-radius:.6rem;background:#fff}
.work-media{display:block;max-width:100%;max-height:72vh;margin:1rem 0;border-radius:.6rem}
audio.work-media,video.work-media{width:100%}
.work-nav{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}
.work-nav>*{display:inline-flex;align-items:center;min-height:2.75rem;padding:.35rem .85rem;border:1px solid #cbdad3;border-radius:.6rem}
.work-nav a{background:#edf6ee}
.work-nav [aria-disabled]{color:#60716b;background:#f5f7f6}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f6f6;padding:1rem;border-radius:8px}
.comments{margin:2rem 0}.comments ul{padding:0;list-style:none}.comments pre{font:inherit;margin:.3rem 0 .8rem}
</style>
</head><body${site ? ' class="interactive-work"' : ""}>
<p class="meta">作品${creator ? " · " + author : ""}</p>
<h1>${escapeHtml(title)}</h1>
<nav class="work-nav" aria-label="浏览公开作品">
${adjacent(previous, "prev", "上一件")}
${adjacent(next, "next", "下一件")}
<a href="${share}">分享作品</a>
</nav>
${content}
${download}
<section class="comments" aria-labelledby="comments-title">
<h2 id="comments-title">评论（${comments.comment_count}）</h2>
${recent ? `<ul>${recent}</ul>` : ""}
<a href="${detail}">查看评论</a>
</section>
</body></html>
`;
  }

  const {starts, version} = publishedQuickStarts(l);
  const chatHref = `/login#public-agent=${encodeURIComponent(l.slug)}`;
  const profilePath = escapeHtml(`/a/${encodeURIComponent(l.slug)}`);
  const composer = canChat ? `
<form id="public-agent-composer" method="post" data-slug="${escapeHtml(l.slug)}" data-listing-id="${escapeHtml(l.id)}">
  <label for="public-agent-message">消息</label>
  <textarea id="public-agent-message" name="message" rows="3" maxlength="4000" placeholder="输入第一条消息" required disabled></textarea>
  <p id="public-agent-composer-status" role="status" hidden></p>
  <button class="chat-action" type="submit" disabled>继续对话</button>
  <a class="chat-fallback" href="${escapeHtml(chatHref)}">开始对话</a>
</form>` : "";
  const choiceItems = starts.map((choice, index) => {
    const content = escapeHtml(choice);
    if (!canChat) return `<li class="starter-preview">${content}</li>`;
    const href = escapeHtml(`${chatHref}&quick-start=${index}&quick-start-version=${version}`);
    return `<li><a class="starter" href="${href}" data-public-agent-starter><span>${content}</span></a></li>`;
  }).join("");
  const startList = choiceItems ? `
<section class="starters" aria-labelledby="quick-starts">
<h3 id="quick-starts">快捷开场</h3>
<ul>${choiceItems}</ul>
</section>` : "";
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<title>${escapeHtml(title)} · FlyBot</title>
<script type="module" src="/shell/public-agent-share.mjs"></script>
${canChat ? '<script type="module" src="/shell/public-agent-composer.mjs"></script>' : ""}
<style>
:root{color-scheme:light;--ink:#192b28;--muted:#475b57;--surface:#fff;--line:#d7e1dd;--green:#24594b}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--ink);background:#f3f7f3;font:1rem/1.6 system-ui,sans-serif}
a{color:var(--green)}
a:focus-visible{outline:2px solid #176750;outline-offset:4px}
.site-header{background:var(--surface);border-bottom:1px solid var(--line)}
.topbar{max-width:68rem;margin:auto;padding:.85rem 1.25rem;display:flex;align-items:center;justify-content:space-between;gap:.75rem}
.brand{display:inline-flex;align-items:center;gap:.55rem;color:var(--ink);font-weight:750;text-decoration:none}
.brand-mark{display:grid;place-items:center;width:1.85rem;height:1.85rem;border-radius:.55rem;background:var(--green);color:#fff;font-weight:800}
.discover{font-size:.9rem;text-underline-offset:3px}
.agent-home{display:grid;grid-template:"profile conversation" max-content "description conversation" 1fr / minmax(0,1fr) minmax(0,1.1fr);align-items:start;gap:1.1rem clamp(1.5rem,6vw,5rem);max-width:68rem;margin:auto;padding:clamp(2rem,8vw,6.5rem) 1.25rem}
.profile{grid-area:profile;min-width:0}
.avatar{display:grid;place-items:center;width:4rem;height:4rem;border:1px solid #bacfc3;border-radius:1.15rem;background:#e0eee3;color:#1b503f;font-weight:760;font-size:1.7rem}
h1{margin:.85rem 0 .4rem;font-size:clamp(2rem,4.5vw,3.6rem);line-height:1.13;letter-spacing:-.035em;overflow-wrap:anywhere}
h2,h3,p{margin:0}
.creator{color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
.description{grid-area:description;white-space:pre-wrap;overflow-wrap:anywhere}
.profile-share{display:flex;flex-wrap:wrap;align-items:flex-start;gap:.35rem .75rem;margin-top:.85rem}
.profile-share [hidden]{display:none}
.profile-share button,.profile-share summary{min-height:2.75rem;padding:.55rem .7rem;border-radius:.55rem;font:inherit;font-size:.9rem;cursor:pointer}
.profile-share button{border:1px solid var(--line);background:var(--surface);color:var(--green);font-weight:650}
.profile-share button:hover{background:#edf6ed}
.profile-share summary{color:var(--green)}
.profile-share button:focus-visible,.profile-share summary:focus-visible,.profile-share input:focus-visible{outline:2px solid #176750;outline-offset:3px}
.profile-share details[open]{flex:1 0 100%;max-width:100%;padding:0 .7rem .65rem;border:1px solid var(--line);border-radius:.55rem;background:var(--surface)}
.profile-share details[open] summary{padding-inline:0}
.profile-share label{display:block;color:var(--muted);font-size:.85rem}
.profile-share input{display:block;width:100%;margin:.25rem 0 .55rem;padding:.45rem .55rem;border:1px solid #98bead;border-radius:.4rem;color:var(--ink);font:inherit}
.profile-share details a,[data-copy-profile-status]{font-size:.85rem}
[data-copy-profile-status]{flex-basis:100%;color:var(--muted)}
.conversation{grid-area:conversation;min-width:0;padding:1.45rem;border:1px solid var(--line);border-radius:1.25rem;background:var(--surface);box-shadow:0 10px 35px rgb(25 43 40 / .06)}
.conversation h2{font-size:1.25rem;line-height:1.25}
.help{margin:.55rem 0 1rem;color:var(--muted);font-size:.91rem}
.chat-action{display:inline-flex;align-items:center;justify-content:center;min-height:2.85rem;padding:.55rem 1.25rem;border-radius:.65rem;background:var(--green);color:#fff;font-weight:700;text-decoration:none}
.chat-action:not(:disabled):hover{background:#19483c}
#public-agent-composer{display:grid;grid-template-columns:max-content 1fr;align-items:center;gap:.65rem .9rem}
#public-agent-composer label,#public-agent-composer textarea,#public-agent-composer-status{grid-column:1/-1}
#public-agent-composer label{font-weight:650;font-size:.92rem}
#public-agent-composer textarea{width:100%;min-height:6.5rem;padding:.65rem .8rem;border:1px solid #98bead;border-radius:.65rem;color:var(--ink);background:#f8faf8;font:inherit;resize:vertical}
#public-agent-composer textarea:focus-visible,#public-agent-composer button:focus-visible{outline:2px solid #176750;outline-offset:3px}
#public-agent-composer button{border:0;font:inherit;font-weight:700;cursor:pointer}
#public-agent-composer button:disabled{opacity:.55;cursor:default}
#public-agent-composer-status{font-size:.9rem;color:#914224}
.chat-fallback{font-size:.9rem;justify-self:start;text-underline-offset:3px}
.starters{margin:0 0 1rem}
.starters h3{margin-bottom:.45rem;font-size:.92rem}
.starters ul{display:flex;flex-wrap:wrap;gap:.45rem;list-style:none;margin:0;padding:0}
.starters li{min-width:0;max-width:100%}
.starter,.starter-preview{display:inline-block;max-width:100%;min-height:2.75rem;padding:.55rem .7rem;border:1px solid var(--line);border-radius:.55rem;background:#f8faf8;font:inherit;font-size:.9rem;text-align:start;overflow-wrap:anywhere}
.starter{color:var(--green);text-decoration:none;cursor:pointer}
.starter:hover,.starter[aria-pressed="true"]{border-color:#98bead;background:#edf6ed}
.starter:focus-visible{outline:2px solid #176750;outline-offset:3px}
@media(max-width:44rem){.agent-home{grid-template:"profile" "conversation" "description" / minmax(0,1fr);padding:1.25rem 1rem 2rem;gap:1rem}.topbar{padding-inline:1rem}.avatar{width:3rem;height:3rem;border-radius:.9rem;font-size:1.35rem}.conversation{padding:1.05rem}#public-agent-composer{grid-template-columns:minmax(0,1fr)}.chat-action{width:100%}}
@media(max-width:44rem){
  .profile{display:grid;grid-template-columns:auto minmax(0,1fr);place-items:start;column-gap:.75rem}
  .avatar{grid-row:1/span 2}
  .profile h1{grid-column:2;margin:0;font-size:clamp(1.4rem,7vw,1.8rem);align-self:center}
  .profile .creator{grid-column:2}
  .profile-share{grid-column:1/-1;width:100%;margin-top:.65rem}
}
</style>
</head><body>
<header class="site-header"><div class="topbar">
<a class="brand" href="/"><span class="brand-mark" aria-hidden="true">O</span>FlyBot</a>
<a class="discover" href="/discover?tab=agents">发现智能体</a>
</div></header>
<main class="agent-home">
<section class="profile" aria-labelledby="profile-title">
<div class="avatar" aria-hidden="true">${escapeHtml(Array.from(title.trim())[0]?.toUpperCase() || "O")}</div>
<h1 id="profile-title">${escapeHtml(title)}</h1>
${creator ? `<p class="creator">发布者 · ${author}</p>` : ""}
<div id="public-agent-share" class="profile-share" data-profile-path="${profilePath}">
  <button type="button" data-copy-profile disabled hidden>复制主页链接</button>
  <details data-copy-profile-fallback>
    <summary>主页链接</summary>
    <label>主页地址 <input type="text" value="${profilePath}" data-copy-profile-url readonly></label>
    <a href="${profilePath}">打开公开主页</a>
  </details>
  <p data-copy-profile-status role="status" aria-live="polite" hidden></p>
</div>
</section>
<section class="conversation" aria-labelledby="conversation-title">
<h2 id="conversation-title">网页对话</h2>
<p class="help">${canChat ? "登录后确认发送。发送的消息会与智能体发布者共享。" : "该智能体暂未开放访客聊天。"}</p>
${startList}
${composer}
</section>
${view.summary ? `<p class="description">${escapeHtml(view.summary)}</p>` : ""}
</main>
</body></html>
`;
}

function listedBySlug(ot: OtContext, slug: string) {
  assert(SLUG.test(slug), 404, "listing_not_found", "no such listing");
  const l = ot.get<any>("SELECT * FROM ot_listings WHERE slug = ? AND listed = 1", slug);
  assert(l, 404, "listing_not_found", "no such listing");
  return l;
}

function publicRemixSource(ot: OtContext, listing: {id: string; work_kind: string | null}) {
  const kind = listing.work_kind;
  const content = kind === "website"
    ? ot.get<{body: string}>("SELECT html AS body FROM ot_listing_sites WHERE listing_id=? AND length(html)<=?", listing.id, REMIX_BODY_LIMIT)
    : kind === "document"
      ? ot.get<{body: string}>("SELECT snapshot AS body FROM ot_listings WHERE id=? AND length(snapshot)<=?", listing.id, REMIX_BODY_LIMIT)
      : undefined;
  if (!content?.body?.trim() || content.body.length > REMIX_BODY_LIMIT || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content.body)
      || (kind !== "document" && kind !== "website")) return null;
  if (kind === "document" && /^[{\[]/.test(content.body.trimStart())) {
    try {
      const decoded = JSON.parse(content.body);
      if (decoded && typeof decoded === "object") return null;
    } catch { /* A document may begin with literal punctuation. */ }
  }
  return {kind,body:content.body};
}

const remixBytes = (bytes: unknown) => typeof bytes === "number" && Number.isSafeInteger(bytes) &&
  bytes >= 12 && bytes <= CHAT_FILE_MAX_BYTES;

function publicRemixFile(ot: OtContext, work: {id: string; slug: string; title: string; work_kind: string | null; listed: number}) {
  if (work.work_kind === "model3d") {
    const model = ot.get<{bytes: number}>("SELECT length(content) AS bytes FROM ot_listing_models WHERE listing_id=?", work.id);
    if (!model || !remixBytes(model.bytes)) return null;
    return {table:"ot_listing_models",mime:MODEL_MIME,filename:work.title.replace(/[\x00-\x1f\x7f/\\]/g,"_")+".glb",bytes:model.bytes};
  }
  const advertised = publishedMediaView(ot,work);
  if (!advertised.file_available || !remixBytes(advertised.file_bytes)) return null;
  const row = ot.get<{filename: string}>("SELECT filename FROM ot_listing_media WHERE listing_id=?",work.id);
  return row ? {table:"ot_listing_media",mime:advertised.file_mime,filename:row.filename,bytes:advertised.file_bytes} : null;
}

type FeedScope = { where: string; args: unknown[] };
type ChronologicalFeedScope = FeedScope & { from: string; orderAt: string };
type WorkAnchor = { id: string };
type WorkNeighbor = { slug: string; title: string };
const LISTING_SOURCE = "ot_listings l LEFT JOIN ot_profiles p ON p.owner_id = l.owner_id";
const PUBLIC_WORK_SCOPE: ChronologicalFeedScope = {
  where: "l.listed = 1 AND l.kind = 'work'", args: [], from: LISTING_SOURCE, orderAt: "l.updated_at",
};

function publicWorkPreview(ot: OtContext, slug: string, input: Record<string, unknown>) {
  assert(SLUG.test(slug), 404, "listing_not_found", "no such work");
  const work = ot.get<any>(`SELECT ${LISTING_CARD_COLUMNS}, substr(l.snapshot, 1, ?) AS snapshot
    FROM ot_listings l WHERE l.slug = ? AND ${PUBLIC_WORK_SCOPE.where}`, WORK_PREVIEW_MAX, slug);
  assert(work, 404, "listing_not_found", "no such work");
  const {creator, title, work_kind, updated_at, path, likes, collections, comment_count, site_available, file_available, file_mime, file_bytes} =
    listingView(ot, work, null);
  const author = creator.handle?.replace(/^@/, "").replace(/\.home$/, "") || creator.display_name;
  return {
    slug, title, kind: work_kind || "document", author, creator: {handle: creator.handle, name: creator.display_name || author},
    updated: Math.floor(updated_at > 1e12 ? updated_at / 1000 : updated_at),
    path, likes, collections, comment_count, site_available,
    ...(file_available ? {file_available, file_mime, file_bytes} : {}),
    preview: workExcerpt(work, site_available === true),
    ...(input.nav === "latest" ? publicPreviewNeighbors(ot, work, input) : {}),
  };
}

function discoverScope(ot: OtContext, input: Record<string, unknown>, viewer: string | null) {
  const kind = one(input.kind, "kind");
  const tab = one(input.tab, "tab") ?? "all";
  const sort = one(input.sort, "sort") ?? "latest";
  const category = one(input.category, "category");
  const workKind = one(input.work_kind, "work_kind");
  const creator = one(input.creator, "creator");
  const term = one(input.q, "q") ?? "";
  const workSearch = kind === "work" ? workSearchQuery(term) : "";
  assert(sort === "latest" || sort === "popular" || sort === "collected", 400, "invalid_request", "unknown discover sort");
  assert(sort !== "popular" || (kind === "work" && tab === "all"), 400, "invalid_request", "popularity sorting applies to the all works feed");
  assert(sort !== "collected" || (kind === "work" && tab === "collected" && viewer !== null),
    400, "invalid_request", "collection sorting applies to the viewer's collected works");

  const conditions = ["l.listed = 1"];
  const args: unknown[] = [];
  let from = LISTING_SOURCE;
  let orderAt = "l.updated_at";
  if (kind) {
    assert(kind === "agent" || kind === "work", 400, "invalid_request", "kind must be agent or work");
    conditions.push("l.kind = ?");
    args.push(kind);
  }
  if (category) { conditions.push("l.category = ?"); args.push(category); }
  if (workKind) {
    assert(WORK_KINDS.includes(workKind), 400, "invalid_request", "unknown work kind");
    conditions.push("l.work_kind = ?");
    args.push(workKind);
  }
  if (creator) { conditions.push("l.owner_id = ?"); args.push(ot.ownerByHandle(creator)); }
  if (tab === "following") {
    conditions.push("EXISTS (SELECT 1 FROM ot_follows f WHERE f.creator_id = l.owner_id AND f.follower_id = ?)");
    args.push(viewer);
  } else if (tab === "collected") {
    if (sort === "collected") {
      from += " JOIN ot_collections own_collection ON own_collection.listing_id = l.id";
      orderAt = "own_collection.created_at";
      conditions.push("own_collection.owner_id = ?");
    } else conditions.push("EXISTS (SELECT 1 FROM ot_collections c WHERE c.listing_id = l.id AND c.owner_id = ?)");
    args.push(viewer);
  } else {
    assert(tab === "all", 400, "invalid_request", "tab must be all, following or collected");
  }
  if (workSearch) {
    const body = workBodyCondition(workSearch);
    conditions.push(`(instr(ot_work_search_fold(l.title), ?) > 0
      OR (instr(ot_work_search_fold(l.summary), ?) > 0 AND (l.work_kind IS NOT 'website'
        OR NOT EXISTS (SELECT 1 FROM ot_listing_sites s WHERE s.listing_id = l.id)))
      OR instr(ot_work_search_fold(p.handle), ?) > 0
      OR instr(ot_work_search_fold(p.display_name), ?) > 0
      OR ${body.sql})`);
    args.push(workSearch, workSearch, workSearch, workSearch, body.term);
  } else if (kind !== "work") {
    const search = term.trim().toLowerCase().slice(0, 60);
    if (search) {
      conditions.push("(instr(lower(l.title), ?) > 0 OR instr(lower(l.summary), ?) > 0 OR instr(p.handle, ?) > 0 OR instr(lower(p.display_name), ?) > 0)");
      args.push(search, search, search, search);
    }
  }
  return {kind, sort, from, orderAt, where: conditions.join(" AND "), args, workSearch};
}

function discoverCard(ot: OtContext, row: any, viewer: string | null, search: string) {
  const card = listingView(ot, row, viewer);
  if (!search) return card;
  const match = workSearchMatch("title", card.title, search)
    ?? (card.site_available ? undefined : workSearchMatch("summary", card.summary, search))
    ?? workSearchMatch("creator", card.creator.display_name, search)
    ?? workSearchMatch("creator", card.creator.handle, search)
    ?? workSearchMatch("body", ot.get<{body: string}>("SELECT body FROM ot_discover_work_search WHERE listing_id = ?", row.id)?.body ?? null, search);
  return match ? {...card, match} : card;
}

function guestDiscoverCard(card: ReturnType<typeof discoverCard>) {
  const {slug, title, creator, updated_at: timestamp} = card;
  const updated = Math.floor(timestamp > 1e12 ? timestamp / 1000 : timestamp);
  const author = creator.handle?.replace(/^@/, "").replace(/\.home$/, "") || creator.display_name;
  if (card.kind === "agent") {
    return {slug, name:title, summary:card.summary, category:card.category || "", updated,
      chat_enabled:card.chat_enabled, creator:{handle:creator.handle, name:creator.display_name || author}};
  }
  return {slug, title, kind:card.work_kind || "document", author, updated, path:card.path,
    creator:{handle:creator.handle, name:creator.display_name || author},
    likes:card.likes, collections:card.collections, comment_count:card.comment_count,
    ...(card.site_available ? {site_available:true} : {}),
    ...(card.file_available ? {file_available:true, file_mime:card.file_mime, file_bytes:card.file_bytes} : {}),
    ...("match" in card && card.match ? {match:card.match} : {})};
}

function chronologicalWorkNeighbors(ot: OtContext, id: string, at: number, {from, orderAt, where, args}: ChronologicalFeedScope) {
  const neighbor = (previous: boolean) => {
    const comparison = previous ? ">" : "<";
    const direction = previous ? "ASC" : "DESC";
    return ot.get<WorkNeighbor>(`SELECT l.slug, l.title FROM ${from}
      WHERE ${where} AND (${orderAt}, l.id) ${comparison} (?, ?)
      ORDER BY ${orderAt} ${direction}, l.id ${direction} LIMIT 1`,
    ...args, at, id) ?? null;
  };
  return {previous: neighbor(true), next: neighbor(false)};
}

function scopedWorkNeighbors(ot: OtContext, work: WorkAnchor, scope: ChronologicalFeedScope) {
  const {from, orderAt, where, args} = scope;
  const anchor = ot.get<{feed_at:number}>(`SELECT ${orderAt} AS feed_at FROM ${from} WHERE l.id = ? AND ${where}`,
    work.id, ...args);
  return anchor ? chronologicalWorkNeighbors(ot, work.id, anchor.feed_at, scope) : {previous:null, next:null};
}

function publicPreviewNeighbors(ot: OtContext, work: WorkAnchor, input: Record<string, unknown>) {
  try {
    // Public links can carry chronological filters, never a viewer's private feed.
    const scope = discoverScope(ot, {kind:"work", work_kind:input.kind, q:input.q, creator:input.creator, category:input.topic}, null);
    return scopedWorkNeighbors(ot, work, scope);
  } catch (error) {
    // An obsolete creator filter or invalid optional query cannot hide the work itself.
    if (error instanceof ApiError && (error.status === 400 || error.code === "member_not_found")) return {previous:null, next:null};
    throw error;
  }
}

const RANKING_WINDOW = 500;
const RANKING_TTL = 10 * 60_000;
const RANKING_SESSIONS = 128;
const RANKED_CURSOR = /^([A-Za-z0-9_-]{32})\.([1-9][0-9]{0,2})$/;
const WEEK = 7 * 86_400_000;

function rankedWorkIds(ot: OtContext, {where, args}: FeedScope) {
  const now = ot.now();
  const minimumEngagementTime = now - 8 * WEEK;
  // Weight recent distinct likes and collections on opted-in works, without
  // counting an author's own engagement.
  const rows = ot.all<{id: string}>(`WITH recent AS MATERIALIZED (
    SELECT l.id, l.owner_id, l.updated_at FROM ot_listings l
    LEFT JOIN ot_profiles p ON p.owner_id = l.owner_id
    WHERE l.listed = 1 AND l.kind = 'work' AND ${where}
    ORDER BY l.updated_at DESC, l.id DESC LIMIT ${RANKING_WINDOW}
  )
  SELECT l.id FROM recent l ORDER BY (
    2 * (SELECT COUNT(*) FROM (SELECT 1 FROM ot_likes
      WHERE listing_id = l.id AND created_at >= ? AND owner_id <> l.owner_id LIMIT 12))
    + 3 * (SELECT COUNT(*) FROM (SELECT 1 FROM ot_collections
      WHERE listing_id = l.id AND created_at >= ? AND owner_id <> l.owner_id LIMIT 8))
    - MIN(12, MAX(0, CAST((? - l.updated_at) / ${WEEK} AS INTEGER)))
  ) DESC, l.updated_at DESC, l.id DESC`, ...args, minimumEngagementTime, minimumEngagementTime, now);
  return rows.map(row => row.id);
}

function popularWorks(ot: OtContext) {
  type Ranking = { context: string; keys: string; expires: number };
  const rankings = new Map<string, Ranking>();

  return ({where, args, workSearch}: ReturnType<typeof discoverScope>, viewer: string | null, limit: number, cursor: string | undefined) => {
    const context = hashCode(JSON.stringify([viewer, where, args]));
    const now = ot.now();
    let token: string;
    let ranking: Ranking;
    let offset = 0;
    if (cursor !== undefined) {
      const match = RANKED_CURSOR.exec(cursor);
      assert(match && Number(match[2]) < RANKING_WINDOW, 400, "invalid_request", "invalid popularity cursor");
      token = match[1];
      offset = Number(match[2]);
      const previous = rankings.get(token);
      assert(previous && previous.expires > now, 409, "popularity_expired", "refresh the popular works feed");
      assert(previous.context === context, 400, "invalid_request", "cursor belongs to another feed");
      ranking = previous;
    } else {
      token = randomBytes(24).toString("base64url");
      ranking = {context, keys: JSON.stringify(rankedWorkIds(ot, {where, args})), expires: now + RANKING_TTL};
    }

    // Use the captured order for pagination, but verify current publication
    // and filter membership before returning a card. Revocation takes effect
    // immediately and engagement changes cannot make a work repeat on a later page.
    const rows = ot.all<any>(`SELECT ${LISTING_CARD_COLUMNS}, r.key AS position FROM json_each(?) r
      JOIN ot_listings l ON l.id = r.value LEFT JOIN ot_profiles p ON p.owner_id = l.owner_id
      WHERE r.key >= ? AND l.listed = 1 AND l.kind = 'work' AND ${where}
      ORDER BY r.key LIMIT ?`, ranking.keys, offset, ...args, limit + 1);
    const next = rows[limit];
    if (next && cursor === undefined) {
      for (const [key, entry] of rankings) if (entry.expires <= now) rankings.delete(key);
      if (rankings.size >= RANKING_SESSIONS) {
        const oldest = rankings.keys().next().value;
        if (oldest) rankings.delete(oldest);
      }
      rankings.set(token, ranking);
    }
    return { items: rows.slice(0, limit).map(row => discoverCard(ot, row, viewer, workSearch)),
      next_cursor: next ? `${token}.${next.position}` : null };
  };
}

function profileSocialCounts(ot: OtContext, owner: string) {
  return ot.get(`SELECT
    (SELECT COUNT(*) FROM ot_follows f JOIN ot_profiles p ON p.owner_id = f.creator_id
      WHERE f.follower_id = ?) AS following,
    (SELECT COUNT(*) FROM ot_follows f JOIN ot_profiles p ON p.owner_id = f.follower_id
      WHERE f.creator_id = ?) AS followers,
    (SELECT COUNT(*) FROM ot_listings l JOIN ot_likes r ON r.listing_id = l.id
      WHERE l.owner_id = ? AND l.listed = 1 AND r.owner_id <> l.owner_id) AS likes_received,
    (SELECT COUNT(*) FROM ot_listings l JOIN ot_collections r ON r.listing_id = l.id
      WHERE l.owner_id = ? AND l.listed = 1 AND r.owner_id <> l.owner_id) AS collections_received`,
  owner, owner, owner, owner);
}

type ProfileSocialKey = {
  activity_at: number;
  page_key: string;
};

const foldProfileSearch = (value: string) => value.normalize("NFKC").toLowerCase();

function profileSocialCursor(cursor: string | undefined, scope: string, isFollowList: boolean): unknown[] {
  if (cursor === undefined) return [];
  const match = /^([a-f0-9]{24})\.([0-9]{1,16})\.([A-Za-z0-9][A-Za-z0-9_.-]{0,79})$/.exec(cursor);
  assert(match && match[1] === scope, 400, "invalid_request", "invalid profile social cursor");
  const at = Number(match[2]);
  assert(Number.isSafeInteger(at) && (isFollowList || LISTING_ID.test(match[3])), 400, "invalid_request", "invalid profile social cursor");
  return [at, match[3]];
}

function profileFollowRows(ot: OtContext, owner: string, outgoing: boolean, search: string, cursor: unknown[], limit: number) {
  const [actor, peer] = outgoing ? ["follower_id", "creator_id"] : ["creator_id", "follower_id"];
  return ot.all<ProfileSocialKey & {handle: string; display_name: string; bio: string; following: number; work_notices: number}>(`
    SELECT p.handle, p.display_name, p.bio, f.work_notices, f.created_at AS activity_at, p.handle AS page_key,
      EXISTS (SELECT 1 FROM ot_follows outgoing WHERE outgoing.follower_id = ? AND outgoing.creator_id = p.owner_id) AS following
    FROM ot_follows f JOIN ot_profiles p ON p.owner_id = f.${peer}
    WHERE f.${actor} = ?
      ${search ? "AND (instr(ot_profile_fold(p.handle), ?) > 0 OR instr(ot_profile_fold(p.display_name), ?) > 0)" : ""}
      ${cursor.length ? "AND (f.created_at, p.handle) < (?, ?)" : ""}
    ORDER BY f.created_at DESC, p.handle DESC LIMIT ?`,
  owner, owner, ...(search ? [search, search] : []), ...cursor, limit);
}

function profileListingRows(ot: OtContext, owner: string, view: "liked" | "collected" | "published", cursor: unknown[], limit: number) {
  const activity = view === "published"
    ? "SELECT id AS listing_id, created_at FROM ot_listings WHERE owner_id = ? AND listed = 1 AND kind = 'work'"
    : `SELECT listing_id, created_at FROM ${view === "liked" ? "ot_likes" : "ot_collections"} WHERE owner_id = ?`;
  return ot.all(`WITH profile_activity AS (${activity})
    SELECT ${LISTING_CARD_COLUMNS}, a.created_at AS activity_at, a.listing_id AS page_key,
      p.handle, COALESCE(p.display_name, '(left)') AS display_name, COALESCE(p.bio, '') AS bio,
      EXISTS (SELECT 1 FROM ot_likes r WHERE r.listing_id = l.id AND r.owner_id = ?) AS liked,
      EXISTS (SELECT 1 FROM ot_collections r WHERE r.listing_id = l.id AND r.owner_id = ?) AS collected
    FROM profile_activity a JOIN ot_listings l ON l.id = a.listing_id
    LEFT JOIN ot_profiles p ON p.owner_id = l.owner_id
    WHERE l.listed = 1 ${cursor.length ? "AND (a.created_at, a.listing_id) < (?, ?)" : ""}
    ORDER BY a.created_at DESC, a.listing_id DESC LIMIT ?`,
  owner, owner, owner, ...cursor, limit);
}

function profileSocialPage<T extends ProfileSocialKey, R>(rows: T[], limit: number, scope: string, project: (row: T) => R) {
  const last = rows.length > limit ? rows[limit - 1] : null;
  return {
    items: rows.slice(0, limit).map(project),
    next_cursor: last ? `${scope}.${last.activity_at}.${last.page_key}` : null,
  };
}

export function registerDiscover(app: FastifyInstance, ot: OtContext) {
  const popular = popularWorks(ot);
  const publicPopular = popularWorks(ot);
  registerWorkComments(app, ot);
  ot.db.function("ot_profile_fold", {deterministic: true}, foldProfileSearch);
  const columns = new Set(ot.all<{name: string}>("PRAGMA table_info(ot_listings)").map(column => column.name));
  if (!columns.has("chat_enabled")) ot.run("ALTER TABLE ot_listings ADD COLUMN chat_enabled INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("chat_from")) ot.run("ALTER TABLE ot_listings ADD COLUMN chat_from INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("publication_revision")) ot.run("ALTER TABLE ot_listings ADD COLUMN publication_revision INTEGER NOT NULL DEFAULT 1");
  if (!columns.has("source_revision")) ot.run("ALTER TABLE ot_listings ADD COLUMN source_revision INTEGER");
  const followColumns = ot.all<{name: string}>("PRAGMA table_info(ot_follows)");
  if (!followColumns.some(column => column.name === "work_notices")) {
    ot.run("ALTER TABLE ot_follows ADD COLUMN work_notices INTEGER NOT NULL DEFAULT 1 CHECK (work_notices IN (0, 1))");
  }
  registerWorkSearch(ot);

  app.put("/v1/ot/listings", {
    bodyLimit: CHAT_FILE_BODY_LIMIT,
    onRequest: async req => { ot.me(req); },
  }, async (req) => {
    const me = ot.me(req);
    const b = body(req);
    assert(b.kind === "agent" || b.kind === "work", 400, "invalid_request", "kind must be agent or work");
    const sourceRevision = b.source_revision;
    assert(sourceRevision === undefined || (b.kind === "work" && typeof sourceRevision === "number" &&
      Number.isSafeInteger(sourceRevision) && sourceRevision > 0), 400, "invalid_request", "Invalid work source revision");
    assert(typeof b.ref === "string" && REF.test(b.ref), 400, "invalid_request", "ref is invalid");
    const title = text(b.title, "title", { min: 1, max: 80 });
    const suppliedSummary = optText(b.summary, "summary", { max: 500, multiline: true });
    const category = b.category == null || b.category === "" ? null : String(b.category);
    assert(category === null || CATEGORIES.includes(category) || (b.kind === "work" && WORK_TOPICS.has(category)),
      400, "invalid_request", "unknown category");
    let workKind = b.kind === "work" ? String(b.work_kind ?? "document") : null;
    assert(workKind === null || WORK_KINDS.includes(workKind), 400, "invalid_request", "unknown work kind");
    if (workKind !== "model3d") assert(b.model_data === undefined, 400, "invalid_request", "only a 3D work accepts a GLB file");
    const model = workKind === "model3d" ? decodeChatFile({title: "model.glb", mime: MODEL_MIME, data: b.model_data}).data : null;
    const media = decodePublishedMedia(workKind, b);
    if (media && workKind === "media") workKind = media.mime.split("/")[0];
    const editable = editableRelease(workKind,b.editable_snapshot);
    const site = b.site_html;
    if (site !== undefined) {
      assert(workKind === "website" && typeof site === "string" && site.trim().length > 0,
        400, "invalid_request", "site_html requires a website work and non-empty HTML");
      assert(Buffer.byteLength(site, "utf8") <= MAX_SITE_BYTES, 413, "site_too_large", "site_html exceeds 32 KiB");
    }
    const snapshot = site !== undefined || b.snapshot == null
      ? null : text(b.snapshot, "snapshot", { max: SNAPSHOT_MAX, multiline: true });
    const searchableBody = workKind === null ? null : publicWorkText(workKind, snapshot, site ?? null);
    const summary = suppliedSummary
      ?? (site === undefined ? "" : (searchableBody ?? "").slice(0, 300).replace(/[\uD800-\uDBFF]$/u, ""));
    const existing = ot.get<any>("SELECT * FROM ot_listings WHERE owner_id = ? AND kind = ? AND ref = ?", me.ownerId, b.kind, b.ref);
    assert(sourceRevision === undefined || existing?.source_revision == null || existing.source_revision <= sourceRevision,
      409, "artifact_changed", "已经公开了更新的保存版本。");
    assert(b.chat_enabled === undefined || (b.kind === "agent" && typeof b.chat_enabled === "boolean"),
      400, "invalid_request", "chat_enabled must be a boolean on an agent listing");
    const chatEnabled = b.kind === "agent" && (b.chat_enabled ?? !!(existing?.listed && existing.chat_enabled));
    const chatFrom = chatEnabled && existing?.listed && existing.chat_enabled ? existing.chat_from
      : chatEnabled ? ot.get<{seq: number}>("SELECT COALESCE(MAX(rowseq),0) AS seq FROM ot_messages")!.seq : 0;
    const slug = String(b.slug ?? existing?.slug ?? "");
    assert(SLUG.test(slug) && !RESERVED.has(slug), 400, "invalid_request", "slug must be 3-30 lowercase letters, digits or dashes");
    const clash = ot.get<any>("SELECT id FROM ot_listings WHERE slug = ?", slug);
    assert(!clash || clash.id === existing?.id, 409, "slug_taken", "that address is taken");
    const now = ot.now();
    const id = existing?.id ?? newId("otl");
    ot.tx(() => {
      if (existing) {
        ot.run(`UPDATE ot_listings SET slug=?, title=?, summary=?, category=?, work_kind=?, snapshot=?, listed=1,
          chat_enabled=?, chat_from=?, updated_at=?, publication_revision=publication_revision+1, source_revision=? WHERE id=?`,
        slug, title, summary, category, workKind, snapshot, Number(chatEnabled), chatFrom, now, sourceRevision ?? null, id);
      } else {
        assert(ot.get<any>("SELECT COUNT(*) AS n FROM ot_listings WHERE owner_id = ?", me.ownerId).n < 500, 429, "too_many_listings", "listing limit reached");
        ot.run("INSERT INTO ot_listings(id, owner_id, kind, ref, slug, title, summary, category, work_kind, snapshot, chat_enabled, chat_from, created_at, updated_at, source_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, me.ownerId, b.kind, b.ref, slug, title, summary, category, workKind, snapshot, Number(chatEnabled), chatFrom, now, now, sourceRevision ?? null);
      }
      const fileSize = model?.length ?? media?.data.length;
      if (fileSize !== undefined) {
        const budget = ot.get<{bytes: number}>(`SELECT
          (SELECT COALESCE(SUM(length(content)),0) FROM ot_listing_models WHERE owner_id = ? AND listing_id <> ?) +
          (SELECT COALESCE(SUM(bytes),0) FROM ot_listing_media WHERE owner_id = ? AND listing_id <> ?) AS bytes`,
        me.ownerId, id, me.ownerId, id);
        assert((budget?.bytes ?? 0) + fileSize <= ot.platform.attachmentLimits.ownerBudgetBytes,
          413, "attachment_storage_full", "public work file storage is full");
      }
      if (model) {
        ot.run(`INSERT INTO ot_listing_models (listing_id, owner_id, content) VALUES (?,?,?)
          ON CONFLICT(listing_id) DO UPDATE SET content=excluded.content`, id, me.ownerId, model);
      } else if (existing?.work_kind === "model3d") {
        ot.run("DELETE FROM ot_listing_models WHERE listing_id = ?", id);
      }
      if (media) savePublishedMedia(ot, id, me.ownerId, media);
      else if (existing && isMediaWork(existing.work_kind)) ot.run("DELETE FROM ot_listing_media WHERE listing_id = ?", id);
      if (editable) {
        ot.run(`INSERT INTO ot_listing_editable(listing_id,kind,content) VALUES(?,?,?)
          ON CONFLICT(listing_id) DO UPDATE SET kind=excluded.kind,content=excluded.content`,id,editable.kind,editable.content);
      } else if (existing && editableWorkKind(existing.work_kind)) {
        ot.run("DELETE FROM ot_listing_editable WHERE listing_id=?",id);
      }
      if (site !== undefined) {
        ot.run(`INSERT INTO ot_listing_sites (listing_id, html) VALUES (?,?)
          ON CONFLICT(listing_id) DO UPDATE SET html=excluded.html`, id, site);
      } else if (existing?.work_kind === "website") {
        ot.run("DELETE FROM ot_listing_sites WHERE listing_id = ?", id);
      }
      if (searchableBody !== null) saveWorkSearch(ot, id, searchableBody);
      if (!existing || !existing.listed) {
        const followers = ot.all<{follower_id: string}>("SELECT follower_id FROM ot_follows WHERE creator_id = ? AND (? <> 'work' OR work_notices = 1) LIMIT 5000",
          me.ownerId, b.kind);
        if (followers.length) {
          const data = { listing_id: id, slug, kind: b.kind, title, creator: ot.profileView(me.ownerId) };
          for (const {follower_id} of followers) ot.notify(follower_id, "discover.published", data);
        }
      }
    });
    const listing = ot.get<any>("SELECT * FROM ot_listings WHERE id = ?", id);
    return {...listingView(ot, listing, me.ownerId, true), ...ownerWorkRevision(listing),
      ...(editable ? {editable_remix:true} : {})};
  });
  app.delete("/v1/ot/listings/:id", async (req) => {
    const me = ot.me(req);
    const id = params(req).id;
    ot.tx(() => {
      const r = ot.run("UPDATE ot_listings SET listed = 0, chat_enabled = 0, updated_at = ? WHERE id = ? AND owner_id = ?", ot.now(), id, me.ownerId);
      assert(r.changes === 1, 404, "listing_not_found", "no such listing of yours");
      ot.run("DELETE FROM ot_listing_models WHERE listing_id = ?", id);
      ot.run("DELETE FROM ot_listing_media WHERE listing_id = ?", id);
      ot.run("DELETE FROM ot_listing_sites WHERE listing_id = ?", id);
      ot.run("DELETE FROM ot_listing_editable WHERE listing_id = ?", id);
      ot.run("DELETE FROM ot_discover_work_search WHERE listing_id = ?", id);
    });
    return { unlisted: true };
  });
  app.get("/v1/ot/listings/mine", async (req) => {
    const me = ot.me(req);
    const rows = ot.all<any>(`SELECT l.*,e.listing_id IS NOT NULL AS editable
      FROM ot_listings l LEFT JOIN ot_listing_editable e ON e.listing_id=l.id AND e.kind=l.work_kind
      WHERE l.owner_id=? ORDER BY l.updated_at DESC`, me.ownerId);
    return {listings:rows.map(l => ({...listingView(ot,l,me.ownerId), ref:l.ref, ...ownerWorkRevision(l),
      ...(l.listed && l.editable ? {editable_remix:true} : {})}))};
  });
  const readFeed = (q: Record<string, unknown>, viewer: string | null) => {
    const scope = discoverScope(ot, q, viewer);
    const {kind, sort, from, orderAt, where, args, workSearch} = scope;
    const cursor = one(q.cursor, "cursor");
    const pagination = one(q.pagination, "pagination");
    const limit = Math.max(1, intParam(q.limit, "limit", 30, 100));
    if (sort === "popular") {
      assert(q.before === undefined && pagination === undefined, 400, "invalid_request", "the popular feed uses a popularity cursor");
      return (viewer === null ? publicPopular : popular)(scope, viewer, limit, cursor);
    }
    const keyset = (pagination === "keyset" && (kind === "work" || viewer === null)) || sort === "collected";
    assert(pagination === undefined || keyset, 400, "invalid_request", "keyset pagination applies to the latest works feed");
    assert(sort !== "collected" || (q.before === undefined && (pagination === undefined || pagination === "keyset")),
      400, "invalid_request", "collection sorting uses a scoped cursor");
    assert(cursor === undefined || (keyset && q.before === undefined), 400, "invalid_request", "invalid latest works pagination");
    const before = intParam(q.before, "before", 0, Number.MAX_SAFE_INTEGER);
    const boundary: unknown[] = before ? [before] : [];
    let condition = before ? ` AND ${orderAt} < ?` : "";
    const scopeKey = keyset ? hashCode(JSON.stringify([viewer, where, args])).slice(0, 24) : "";
    if (cursor !== undefined) {
      const match = LATEST_WORK_CURSOR.exec(cursor);
      assert(match && Number.isSafeInteger(Number(match[1])), 400, "invalid_request", "invalid latest works cursor");
      assert(match[3] === scopeKey, 400, "invalid_request", "cursor belongs to another feed");
      boundary.push(Number(match[1]), match[2]);
      condition = ` AND (${orderAt}, l.id) < (?, ?)`;
    }
    const rows = ot.all<any>(`SELECT ${LISTING_CARD_COLUMNS}, ${orderAt} AS feed_at FROM ${from}
      WHERE ${where}${condition} ORDER BY ${orderAt} DESC, l.id DESC LIMIT ?`, ...args, ...boundary, limit + Number(keyset));
    const cards = rows.slice(0, limit).map(row => discoverCard(ot, row, viewer, workSearch));
    const last = rows[limit - 1] as (WorkAnchor & {feed_at:number}) | undefined;
    const nextBefore = last?.feed_at ?? null;
    return keyset
      ? {items: cards, next_cursor: rows.length > limit && last ? `l.${last.feed_at}.${last.id}.${scopeKey}` : null}
      : {items: cards, next_before: nextBefore};
  };
  app.get("/v1/ot/discover", async (req) => readFeed(query(req), ot.me(req).ownerId));
  app.get("/v1/ot/public/discover/:directory", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const {directory} = params(req);
    assert(directory === "works" || directory === "agents", 404, "listing_not_found", "no such public directory");
    const q = query(req);
    const works = directory === "works";
    const allowed = ["limit", "cursor", "q", "creator", "category", ...(works ? ["sort", "kind"] : [])];
    assert(Object.keys(q).every(key => allowed.includes(key)), 400, "invalid_request", "unknown public directory filter");
    const ranked = q.sort === "popular";
    const result = readFeed({
      kind:works ? "work" : "agent", q:q.q, creator:q.creator, work_kind:q.kind, category:q.category,
      sort:q.sort, cursor:q.cursor, pagination:ranked ? undefined : "keyset",
      limit:String(Math.max(1,intParam(q.limit, "limit", 12, 24))),
    }, null);
    return {items:result.items.map(guestDiscoverCard), cursor:"next_cursor" in result ? result.next_cursor : null};
  });
  app.get("/v1/ot/discover/:slug/detail", async (req, reply) => {
    const me = ot.me(req);
    const q = query(req);
    assert(Object.keys(q).every(key => ["tab", "sort", "category", "work_kind", "q", "creator"].includes(key)),
      400, "invalid_request", "unknown work detail filter");
    const scope = discoverScope(ot, {...q, kind: "work"}, me.ownerId);
    const slug = params(req).slug;
    assert(SLUG.test(slug), 404, "listing_not_found", "no such work");
    const work = ot.get<any>(`SELECT ${LISTING_CARD_COLUMNS} FROM ot_listings l WHERE l.slug = ? AND ${PUBLIC_WORK_SCOPE.where}`, slug);
    assert(work, 404, "listing_not_found", "no such work");
    reply.header("Cache-Control", "no-store");
    const view = listingView(ot, work, me.ownerId);
    const remixable = editableWorkKind(work.work_kind) ? hasEditableRelease(ot,work)
      : view.file_available ? remixBytes(view.file_bytes)
      : work.work_kind === "model3d" ? Boolean(publicRemixFile(ot,work)) : Boolean(publicRemixSource(ot,work));
    const detail = {
      work: {...view, ...(remixable ? {remix_available:true} : {})},
      previous: null, next: null,
    };
    if (scope.sort === "popular") {
      const ids = rankedWorkIds(ot, scope);
      const position = ids.indexOf(work.id);
      if (position === -1) return detail;
      const neighbor = (id: string | undefined) => id
        ? ot.get<WorkNeighbor>(`SELECT l.slug, l.title FROM ot_listings l WHERE l.id = ? AND ${PUBLIC_WORK_SCOPE.where}`, id) ?? null
        : null;
      return {...detail, previous: neighbor(ids[position - 1]), next: neighbor(ids[position + 1])};
    }
    return {...detail, ...scopedWorkNeighbors(ot, work, scope)};
  });
  app.get("/v1/ot/discover/:slug/remix", async (req, reply) => {
    ot.me(req);
    reply.header("Cache-Control", "no-store");
    const q = query(req);
    assert(Object.keys(q).every(key => key === "revision") &&
      (q.revision === undefined || (typeof q.revision === "string" && REMIX_REVISION.test(q.revision))),
    400,"invalid_request","Invalid work copy revision");
    return ot.tx(() => {
      const work = listedBySlug(ot, params(req).slug);
      assert(work.kind === "work",404,"remix_unavailable","这个作品暂无可复制的公开版本。");
      if (editableWorkKind(work.work_kind)) {
        const kind = work.work_kind;
        assert(hasEditableRelease(ot,work),404,"remix_unavailable","这个作品暂无可复制的公开版本。");
        const revision = hashCode(JSON.stringify([work.id,work.slug,work.publication_revision,work.title,kind]));
        assert(q.revision === undefined || q.revision === revision,
          409,"listing_changed","公开作品已更新，请重新查看后再复制。");
        const template = {title:work.title,kind,revision};
        if (!q.revision) return {template};
        const release = ot.get<{content: string}>("SELECT content FROM ot_listing_editable WHERE listing_id=? AND kind=?",work.id,kind);
        assert(release,404,"remix_unavailable","这个作品暂无可复制的公开版本。");
        return {template,source:{kind,[kind === "slides" ? "slides" : "board"]:JSON.parse(release.content)}};
      }
      const file = publicRemixFile(ot,work);
      if (file) {
        const {table,mime,filename,bytes} = file;
        // Publishing updates the listing revision and its file in one transaction.
        // Only a confirmed copy reads the BLOB.
        const revision = hashCode(JSON.stringify([work.id,work.slug,work.publication_revision,work.title,mime,filename,bytes]));
        assert(q.revision === undefined || q.revision === revision,
          409,"listing_changed","公开作品已更新，请重新查看后再复制。");
        const template = {title:work.title,kind:"media",revision,media:{mime,filename,bytes}};
        if (!q.revision) return {template};
        const stored = ot.get<{content: Buffer}>(`SELECT content FROM ${table} WHERE listing_id=?`,work.id);
        assert(stored?.content.length === bytes,404,"remix_unavailable","这个作品暂无可复制的公开版本。");
        return {template,source:{kind:"media",mime,filename,bytes,data:stored.content.toString("base64")}};
      }
      const source = publicRemixSource(ot,work);
      assert(source,404,"remix_unavailable","这个作品暂无可复制的公开版本。");
      const revision = hashCode(JSON.stringify([work.id,work.slug,work.updated_at,work.title,source]));
      assert(q.revision === undefined || q.revision === revision,
        409,"listing_changed","公开作品已更新，请重新查看后再复制。");
      return {template:{title:work.title,kind:source.kind,revision},...(q.revision ? {source} : {})};
    });
  });
  app.get("/v1/ot/discover/:slug", async (req) => {
    const me = ot.me(req);
    const l = ot.get<any>("SELECT * FROM ot_listings WHERE slug = ?", params(req).slug);
    assert(l && (l.listed || l.owner_id === me.ownerId), 404, "listing_not_found", "no such listing");
    return listingView(ot, l, me.ownerId, true);
  });
  for (const [path, table] of [["like", "ot_likes"], ["collect", "ot_collections"]] as const) {
    app.post(`/v1/ot/listings/:id/${path}`, async (req) => {
      const me = ot.me(req);
      const l = ot.get<any>("SELECT * FROM ot_listings WHERE id = ? AND listed = 1", params(req).id);
      assert(l, 404, "listing_not_found", "no such listing");
      if (body(req).on === false) ot.run(`DELETE FROM ${table} WHERE listing_id = ? AND owner_id = ?`, l.id, me.ownerId);
      else ot.run(`INSERT OR IGNORE INTO ${table}(listing_id, owner_id, created_at) VALUES (?,?,?)`, l.id, me.ownerId, ot.now());
      return listingView(ot, l, me.ownerId);
    });
  }
  app.post("/v1/ot/follows", async (req) => {
    const me = ot.me(req);
    const b = body(req);
    const creator = ot.ownerByHandle(b.handle);
    assert(creator !== me.ownerId, 400, "invalid_request", "you cannot follow yourself");
    if (b.on === false) {
      ot.run("DELETE FROM ot_follows WHERE follower_id = ? AND creator_id = ?", me.ownerId, creator);
      return { following: false };
    }
    const r = ot.run("INSERT OR IGNORE INTO ot_follows(follower_id, creator_id, created_at) VALUES (?,?,?)", me.ownerId, creator, ot.now());
    if (r.changes) ot.notify(creator, "follow.new", { follower: ot.profileView(me.ownerId) });
    return { following: true };
  });
  app.post("/v1/ot/follows/notifications", async (req, reply) => {
    const owner = ot.me(req).ownerId;
    reply.header("Cache-Control", "private, no-store");
    const b = body(req);
    assert(typeof b.handle === "string" && typeof b.enabled === "boolean" && Object.keys(b).length === 2,
      400, "invalid_request", "provide a creator handle and an enabled boolean");
    const creator = ot.ownerByHandle(text(b.handle, "handle", {min: 1, max: 100}));
    const changed = ot.run("UPDATE ot_follows SET work_notices = ? WHERE follower_id = ? AND creator_id = ?",
      Number(b.enabled), owner, creator);
    assert(changed.changes === 1, 404, "follow_not_found", "you are not following this creator");
    return {enabled: b.enabled};
  });
  app.get("/v1/ot/follows", async (req) => {
    const me = ot.me(req);
    const handle = one(query(req).handle, "handle");
    const who = handle ? ot.ownerByHandle(handleKey(handle)) : me.ownerId;
    return {
      following: ot.all<any>("SELECT creator_id FROM ot_follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT 500", who).map((r) => ot.profileView(r.creator_id)),
      followers: ot.all<any>("SELECT follower_id FROM ot_follows WHERE creator_id = ? ORDER BY created_at DESC LIMIT 500", who).map((r) => ot.profileView(r.follower_id)),
    };
  });
  app.get("/v1/ot/profile/social", async (req, reply) => {
    const owner = ot.me(req).ownerId;
    reply.header("Cache-Control", "private, no-store");
    const q = query(req);
    const view = one(q.view, "view") ?? "counts";
    if (view === "counts") {
      assert(Object.keys(q).every(key => key === "view"), 400, "invalid_request", "unknown profile counts filter");
      return profileSocialCounts(ot, owner);
    }
    const isFollowList = view === "following" || view === "followers" || view === "work-notices";
    assert(isFollowList || view === "liked" || view === "collected" || view === "published",
      400, "invalid_request", "unknown profile social view");
    assert(Object.keys(q).every(key => ["view", "cursor", "limit"].includes(key) || (key === "q" && isFollowList)),
      400, "invalid_request", "unknown profile social filter");
    const term = one(q.q, "q");
    const search = term === undefined ? "" : foldProfileSearch(text(term, "q", {max: 80})).replace(/^@/, "");
    const limit = Math.max(1, intParam(q.limit, "limit", 20, 50));
    const scope = hashCode(JSON.stringify([owner, view, search])).slice(0, 24);
    const cursor = profileSocialCursor(one(q.cursor, "cursor"), scope, isFollowList);
    if (isFollowList) {
      const rows = profileFollowRows(ot, owner, view !== "followers", search, cursor, limit + 1);
      if (view === "work-notices") {
        return profileSocialPage(rows, limit, scope, ({handle, display_name, bio, work_notices}) =>
          ({handle, display_name, bio, enabled: Boolean(work_notices)}));
      }
      return profileSocialPage(rows, limit, scope, ({handle, display_name, bio, following}) =>
        ({handle, display_name, bio, following: Boolean(following)}));
    }
    const rows = profileListingRows(ot, owner, view, cursor, limit + 1);
    return profileSocialPage(rows, limit, scope, row =>
      ({...listingFields(ot, row), creator: {handle: row.handle, display_name: row.display_name, bio: row.bio},
        liked: Boolean(row.liked), collected: Boolean(row.collected)}));
  });

  // Public catalog pages: no connector token. The isolated site exposes them at
  // https://<origin>/social/a/<slug> and /social/w/<slug> through the existing edge prefix.
  app.get("/v1/ot/public/listings/:slug", async (req, reply) => {
    const l = listedBySlug(ot, params(req).slug);
    reply.header("Cache-Control", "no-store");
    return publicListingView(ot, l);
  });
  const sendPublic = async (req: any, reply: any, kind: "agent" | "work") => {
    reply.header("Cache-Control", "no-store");
    reply.header("Vary", "Accept");
    const slug = params(req).slug;
    const accept = String(req.headers.accept || "");
    const json = accept.includes("application/json") && !accept.includes("text/html");
    const input = query(req);
    if (json && kind === "work" && input.view === "preview") return publicWorkPreview(ot, slug, input);
    const l = listedBySlug(ot, slug);
    assert(l.kind === kind, 404, "listing_not_found", "no such listing");
    const view = publicListingView(ot, l);
    if (json) return view;
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(publicPage(ot, l, view));
  };
  app.get("/a/:slug", async (req, reply) => sendPublic(req, reply, "agent"));
  app.get("/w/:slug", async (req, reply) => sendPublic(req, reply, "work"));
  app.route({
    method: ["GET", "HEAD"], url: "/w/:slug/file", exposeHeadRoute: false,
    async handler(req, reply) {
      const slug = params(req).slug;
      reply.header("Cache-Control", "no-store");
      const media = sendPublishedMedia(ot, req, reply);
      if (media) return media;
      const model = ot.get<{title: string; bytes: number; content: Buffer | null}>(`
        SELECT l.title, length(m.content) AS bytes, CASE WHEN ? THEN NULL ELSE m.content END AS content
        FROM ot_listing_models m JOIN ot_listings l ON l.id = m.listing_id
        WHERE l.slug = ? AND l.listed = 1 AND l.kind = 'work' AND l.work_kind = 'model3d'`,
      Number(req.method === "HEAD"), slug);
      assert(model, 404, "listing_not_found", "no such public file");
      const name = downloadName(model.title + ".glb");
      return reply.type(MODEL_MIME)
        .header("Content-Length", model.bytes)
        .header("Content-Disposition", `attachment; filename="${slug}.glb"; filename*=UTF-8''${name}`)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .send(model.content ?? undefined);
    },
  });
  app.get("/w/:slug/site", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const l = listedBySlug(ot, params(req).slug);
    assert(l.kind === "work" && l.work_kind === "website",
      404, "listing_not_found", "no such public website");
    const site = ot.get<{html: string}>("SELECT html FROM ot_listing_sites WHERE listing_id = ?", l.id);
    assert(site, 404, "listing_not_found", "no such public website");
    return reply.type("text/html; charset=utf-8")
      .header("Content-Security-Policy", SITE_POLICY)
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .send(site.html);
  });
  app.get("/w/:slug/preview", async (req) => {
    const l = listedBySlug(ot, params(req).slug);
    assert(l.kind === "work", 404, "listing_not_found", "no such listing");
    return { preview: workExcerpt(l, publishedSiteAvailable(ot, l)) };
  });

  // Public homepage "start a conversation": a signed-in visitor talks to the creator's
  // agent. Bot Social creates one private thread (visitor + creator) with that agent
  // attached; the creator's own DS-Bot answers through its agent inbox.
  app.post("/v1/ot/discover/:slug/start", async (req, reply) => {
    const me = ot.me(req);
    const input = (req.body === undefined ? {} : req.body) as Record<string, unknown>;
    assert(input && typeof input === "object" && !Array.isArray(input), 400, "invalid_request", "Invalid public chat request");
    const fields = Object.keys(input);
    const selected = Object.hasOwn(input, "listing_id");
    const listingId = input.listing_id;
    let quickStart: { index: number; version: string } | undefined;
    if (selected) {
      assert(fields.length === 1 && typeof listingId === "string" && LISTING_ID.test(listingId),
        400, "invalid_request", "无效的公开智能体。");
    } else if (fields.length) {
      const { quick_start: index, quick_start_version: version } = input;
      assert(fields.length === 2 && typeof index === "number" && Number.isInteger(index) && index >= 0 && index <= 4
        && typeof version === "string" && /^[a-f0-9]{64}$/.test(version),
      400, "invalid_request", "请选择有效的快捷开场。");
      quickStart = { index, version };
    }
    const result = ot.tx(() => {
      const l = listedBySlug(ot, params(req).slug);
      assert(l.kind === "agent", 404, "listing_not_found", "no such listing");
      assert(!selected || l.id === listingId, 409, "public_agent_changed", "该公开页面已更新，请返回主页重新选择智能体。");
      assert(l.chat_enabled, 409, "public_chat_closed", "该智能体未开放访客聊天。");
      assert(l.owner_id !== me.ownerId, 400, "invalid_request", "this is your own agent");
      let draftText: string | undefined;
      if (quickStart) {
        const {starts, version} = publishedQuickStarts(l);
        draftText = starts[quickStart.index];
        assert(draftText && quickStart.version === version, 409, "quick_start_changed", "快捷开场已更新，请返回公开主页重新选择。");
      }
      const key = `agent:${l.id}:${me.ownerId}`;
      const existing = ot.get<{id: string; created_by: string}>("SELECT id, created_by FROM ot_conversations WHERE dm_key = ?", key);
      const id = existing?.id ?? newId("otc");
      if (!existing) {
        const now = ot.now();
        const title = String(l.title).slice(0, 80);
        ot.run("INSERT INTO ot_conversations(id, kind, title, dm_key, created_by, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?, ?)",
          id, title, key, me.ownerId, now, now);
        for (const owner of [me.ownerId, l.owner_id]) {
          ot.run("INSERT INTO ot_conversation_members(conversation_id, owner_id, created_at) VALUES (?,?,?)", id, owner, now);
        }
        ot.run("INSERT INTO ot_conversation_agents(conversation_id, agent_ref, owner_id, name, auto_reply, created_at) VALUES (?,?,?,?,1,?)",
          id, l.ref, l.owner_id, title, now);
        if (!quickStart && !selected) ot.notify(l.owner_id, "discover.conversation_started", {
          listing_id: l.id, slug: l.slug, conversation_id: id, visitor: ot.profileView(me.ownerId),
        });
      } else {
        assert(existing.created_by === me.ownerId && ot.get(
          "SELECT 1 FROM ot_conversation_members WHERE conversation_id=? AND owner_id=?", id, me.ownerId,
        ), 404, "conversation_not_found", "no such conversation");
      }
      return {conversation_id: id, agent_ref: l.ref, created: !existing, ...(draftText ? {draft_text: draftText} : {})};
    });
    return reply.status(result.created ? 201 : 200).send(result);
  });
}
