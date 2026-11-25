import type { OtContext } from "./core.js";

export const WORK_SEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_discover_work_search (
  listing_id TEXT PRIMARY KEY REFERENCES ot_listings(id) ON DELETE CASCADE,
  body TEXT NOT NULL, folded TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS ot_discover_work_terms USING fts5(
  folded, content='ot_discover_work_search', content_rowid='rowid', tokenize='trigram case_sensitive 1'
);
CREATE TRIGGER IF NOT EXISTS ot_discover_work_search_insert AFTER INSERT ON ot_discover_work_search BEGIN
  INSERT INTO ot_discover_work_terms (rowid, folded) VALUES (new.rowid, new.folded);
END;
CREATE TRIGGER IF NOT EXISTS ot_discover_work_search_delete AFTER DELETE ON ot_discover_work_search BEGIN
  INSERT INTO ot_discover_work_terms (ot_discover_work_terms, rowid, folded) VALUES ('delete', old.rowid, old.folded);
END;
CREATE TRIGGER IF NOT EXISTS ot_discover_work_search_update AFTER UPDATE OF folded ON ot_discover_work_search
WHEN old.folded <> new.folded BEGIN
  INSERT INTO ot_discover_work_terms (ot_discover_work_terms, rowid, folded) VALUES ('delete', old.rowid, old.folded);
  INSERT INTO ot_discover_work_terms (rowid, folded) VALUES (new.rowid, new.folded);
END;
`;

const EXCERPT_LIMIT = 160;
const TAG = /<!--[\s\S]*?(?:-->|$)|<![^>]*(?:>|$)|<\?[^>]*(?:>|$)|<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^"'<>])*)>/gi;
const RAW = new Set(["script", "style", "title", "noscript", "iframe", "xmp", "textarea", "plaintext"]);
const INERT = new Set(["head", "template", "object", "canvas", "svg", "math", "datalist"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const BLOCK = /^(?:address|article|aside|blockquote|br|caption|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)$/;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", times: "×",
  colon: ":", semi: ";", Tab: "\t", NewLine: "\n",
};
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|(?:content-)?visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0+)?)\s*(?:!important\s*)?(?:;|$)/i;
const STYLESHEET = /<style(?=[\s/>])[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi;
const STYLE_RULE = /([^{}]+)\{([^{}]*)\}/g;
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

function decodeEntities(text: string) {
  return text.replace(/&(#[xX][0-9a-f]+;?|#[0-9]+;?|[a-z]{2,8};)/gi, (all, reference: string) => {
    const ref = reference.replace(/;$/, "");
    if (ref.startsWith("#")) {
      const code = /^#x/i.test(ref) ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
    }
    return Object.hasOwn(ENTITIES, ref) ? ENTITIES[ref] : all;
  });
}

function hiddenSelectors(source: string) {
  const selectors = new Set<string>();
  for (const stylesheet of source.matchAll(STYLESHEET)) {
    for (const [, selectorsText, declarations] of stylesheet[1].replace(CSS_COMMENT, "").matchAll(STYLE_RULE)) {
      if (!HIDDEN_STYLE.test(declarations)) continue;
      // For a static excerpt, conservatively omit elements targeted by common
      // hiding rules, even when a cascade or ancestor could make them visible.
      for (const selector of selectorsText.split(",")) {
        const target = selector.trim().match(/([.#][a-z_-][\w-]*)$|(?:^|[\s>+~])([a-z][\w-]*)$/i);
        if (target) selectors.add(target[1] ?? target[2].toLowerCase());
      }
    }
  }
  return selectors;
}

function hidden(tag: string, attributes: string, selectors: Set<string>) {
  if (selectors.has(tag)) return true;
  let open = false;
  for (const attr of attributes.matchAll(ATTR)) {
    const name = attr[1].toLowerCase();
    const value = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? "").trim();
    if (name === "hidden" || name === "inert" || (name === "aria-hidden" && value.toLowerCase() === "true")
      || (name === "style" && HIDDEN_STYLE.test(value.replace(CSS_COMMENT, "")))
      || (name === "id" && selectors.has("#" + value))
      || (name === "class" && value.split(/\s+/u).some(item => selectors.has("." + item)))) return true;
    if (name === "open") open = true;
  }
  return tag === "dialog" && !open;
}

function staticWebsiteText(source: string) {
  const parts: string[] = [];
  const ignored: string[] = [];
  const selectors = hiddenSelectors(source);
  const tags = new RegExp(TAG);
  let offset = 0;
  for (let tag; (tag = tags.exec(source));) {
    if (!ignored.length) parts.push(source.slice(offset, tag.index));
    offset = tags.lastIndex;
    if (!tag[2]) continue;
    const name = tag[2].toLowerCase();
    if (!tag[1] && RAW.has(name)) {
      // Content in raw/inactive elements can contain tag-like strings.
      const close = new RegExp(`</${name}(?=[\\s/>])[^>]*>`, "gi");
      close.lastIndex = offset;
      offset = name !== "plaintext" && close.exec(source) ? close.lastIndex : source.length;
      tags.lastIndex = offset;
    } else if (tag[1]) {
      const at = ignored.lastIndexOf(name);
      if (at >= 0) ignored.length = at;
    } else if (!VOID.has(name) && (ignored.length || INERT.has(name) || hidden(name, tag[3], selectors))) {
      ignored.push(name);
    }
    if (!ignored.length && BLOCK.test(name)) parts.push(" ");
  }
  if (!ignored.length) parts.push(source.slice(offset).replace(/<\/?[a-z][^>]*$/i, ""));
  return decodeEntities(parts.join(""));
}

const searchText = (value: string) => value.replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
const fold = (value: string) => value.toLowerCase().replace(/ς/g, "σ");
export const foldWorkSearch = (value: string | null) => fold(searchText(value ?? ""));

export function workSearchQuery(value: string) {
  return foldWorkSearch(searchText(value).slice(0, 80).replace(/[\uD800-\uDBFF]$/u, ""));
}

export function workBodyCondition(needle: string) {
  // Trigrams accelerate literal searches of three or more code points. Short
  // terms still work for scripts where a complete word can be one character.
  if ([...needle].length < 3) return {
    sql: "EXISTS (SELECT 1 FROM ot_discover_work_search s WHERE s.listing_id = l.id AND instr(s.folded, ?) > 0)",
    term: needle,
  };
  return {
    sql: `l.id IN (SELECT listing_id FROM ot_discover_work_search
      WHERE rowid IN (SELECT rowid FROM ot_discover_work_terms WHERE ot_discover_work_terms MATCH ?))`,
    term: '"' + needle.replaceAll('"', '""') + '"',
  };
}

export function publicWorkText(kind: string, snapshot: string | null, site: string | null) {
  if (site !== null) return searchText(staticWebsiteText(site));
  const source = snapshot?.trimStart() ?? "";
  if (source.startsWith("{") || source.startsWith("[")) {
    // Structured legacy payloads have no public text projection.
    try { JSON.parse(source); return ""; } catch { /* The snapshot is text. */ }
  }
  return searchText(kind === "website" ? staticWebsiteText(source) : source);
}

export function registerWorkSearch(ot: OtContext) {
  ot.db.function("ot_work_search_fold", {deterministic: true}, foldWorkSearch);
  ot.db.function("ot_public_work_text", {deterministic: true}, publicWorkText);
  // Backfill previously published works once without reading private or revoked rows.
  ot.run(`WITH pending AS MATERIALIZED (
      SELECT l.id, ot_public_work_text(l.work_kind, l.snapshot, s.html) AS body
      FROM ot_listings l LEFT JOIN ot_listing_sites s ON s.listing_id = l.id
      WHERE l.listed = 1 AND l.kind = 'work'
        AND NOT EXISTS (SELECT 1 FROM ot_discover_work_search i WHERE i.listing_id = l.id)
    )
    INSERT INTO ot_discover_work_search (listing_id, body, folded)
    SELECT id, body, ot_work_search_fold(body) FROM pending`);
}

export function saveWorkSearch(ot: OtContext, id: string, body: string) {
  ot.run(`INSERT INTO ot_discover_work_search (listing_id, body, folded) VALUES (?, ?, ?)
    ON CONFLICT(listing_id) DO UPDATE SET body=excluded.body, folded=excluded.folded`, id, body, fold(body));
}

export type WorkSearchMatch = {
  kind: "title" | "summary" | "body" | "creator";
  text: string;
  start: number;
  end: number;
};

function unfoldedRange(text: string, from: number, to: number) {
  let offset = 0;
  let folded = 0;
  let start = 0;
  for (const char of text) {
    const next = folded + fold(char).length;
    if (folded <= from && from < next) start = offset;
    offset += char.length;
    if (to <= next) return [start, offset];
    folded = next;
  }
  return [start, text.length];
}

export function workSearchMatch(kind: WorkSearchMatch["kind"], value: string | null, needle: string): WorkSearchMatch | undefined {
  const text = searchText(value ?? "");
  const folded = fold(text);
  const from = folded.indexOf(needle);
  if (from < 0) return undefined;
  const to = from + needle.length;
  const [start, end] = folded.length === text.length ? [from, to] : unfoldedRange(text, from, to);
  if (text.length <= EXCERPT_LIMIT) return {kind, text, start, end};
  const matchLength = end - start;
  const span = Math.max(EXCERPT_LIMIT - 2, matchLength);
  const leadingContext = Math.min(40, span - matchLength);
  let left = Math.max(0, Math.min(start - leadingContext, text.length - span));
  let right = left + span;
  if (/[\uDC00-\uDFFF]/u.test(text[left])) left += 1;
  if (/[\uDC00-\uDFFF]/u.test(text[right])) right -= 1;
  const room = EXCERPT_LIMIT - (right - left);
  const leading = left && room > 0 ? "…" : "";
  const trailing = right < text.length && room > leading.length ? "…" : "";
  return {kind, text: leading + text.slice(left, right) + trailing,
    start: start - left + leading.length, end: end - left + leading.length};
}
