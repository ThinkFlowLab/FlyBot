const id = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value > 0;
const limit = 5;
const text = value => typeof value === 'string' && value.trim().length <= 80 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const page = value => id(value?.id) && revision(value.revision) && text(value.title) && value.title.trim();
const bounded = array => Array.isArray(array) && array.length <= limit;

export function actionSaveAttempt(state, key) {
  const chosen = state.items.filter(item => item.selected);
  const revisions = new Map(state.sources.map(source => [source.id, source.revision]));
  if (!chosen.length || !chosen.every(item => item.title.trim() && revision(revisions.get(item.memory_page_id)))) return null;
  const items = chosen.map(({title, memory_page_id}) => ({
    title: title.trim(), memory_page_id, source_revision: revisions.get(memory_page_id),
  }));
  return {chosen, items, key};
}

export function encodeActionReview(state) {
  const selected = Array.from(state.selected.values(), ({id, title, revision}) => ({id, title, revision}));
  return JSON.stringify({
    selected, open: Boolean(state.open), sources: state.sources, items: state.items,
    generateAttempt: state.generateAttempt, saveKey: state.saveAttempt?.key,
  });
}

export function decodeActionReview(raw) {
  if (!raw || raw.length > 16000) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  const {selected, sources, items, generateAttempt, saveKey, open} = value || {};
  const pages = array => bounded(array) && array.every(page) && new Set(array.map(entry => entry.id)).size === array.length;
  if (!pages(selected) || !pages(sources) || !bounded(items)) return null;
  const sourceIds = new Set(sources.map(source => source.id));
  if (!items.every(item => text(item?.title) && sourceIds.has(item.memory_page_id) && typeof item.selected === 'boolean')) return null;
  const state = {selected: new Map(selected.map(source => [source.id, source])), sources, items, open: open === true, message: ''};
  if (id(generateAttempt?.key) && bounded(generateAttempt.sources) && generateAttempt.sources.length &&
      generateAttempt.sources.length === state.selected.size &&
      new Set(generateAttempt.sources.map(source => source?.id)).size === state.selected.size &&
      generateAttempt.sources.every(source => state.selected.has(source?.id) && revision(source.revision))) {
    const {key, sources: pending} = generateAttempt;
    state.generateAttempt = {key, sources: pending.map(({id, revision}) => ({id, revision}))};
  }
  if (id(saveKey)) state.saveAttempt = actionSaveAttempt(state, saveKey);
  if (state.saveAttempt) state.message = '上次保存结果尚未确认。重新保存会核对原请求。';
  else if (state.generateAttempt) state.message = '上次生成结果尚未确认。可以继续原请求。';
  else if (items.length) state.message = '已恢复此标签页中的行动草稿。';
  return state;
}

export function decodeNewActionAttempt(raw) {
  if (typeof raw !== 'string' || raw.length > 16000) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  const {key, payload} = value || {};
  const {title, notes, due_at, memory_page_id} = payload || {};
  if (!id(key) || !text(title) || !title.trim() || typeof notes !== 'string' || notes.length > 2000 ||
      (due_at !== null && (!Number.isInteger(due_at) || due_at < 0 || due_at > 2 ** 31)) ||
      (memory_page_id !== null && !id(memory_page_id))) return null;
  return {key, payload:{title:title.trim(), notes, due_at, memory_page_id}};
}

export const ACTION_EDIT_FIELDS = ['title', 'notes', 'status', 'due', 'memory_page_id'];

export function decodeActionEdit(raw) {
  if (typeof raw !== 'string' || raw.length > 16000) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  const {base, fields, pending} = value || {};
  const valid = row => typeof row?.title === 'string' && row.title.length <= 80 &&
    typeof row.notes === 'string' && row.notes.length <= 2000 &&
    ['open', 'done'].includes(row.status) &&
    typeof row.due === 'string' && (row.due === '' || /^\d{4}-\d{2}-\d{2}$/.test(row.due)) &&
    (row.memory_page_id === '' || id(row.memory_page_id));
  if (!valid(base) || !valid(fields)) return null;
  const pick = row => Object.fromEntries(ACTION_EDIT_FIELDS.map(name => [name, row[name]]));
  const draft = {base:pick(base), fields:pick(fields)};
  if (Number.isSafeInteger(pending?.revision) && pending.revision > 0 && valid(pending.submitted)) {
    draft.pending = {revision:pending.revision, submitted:pick(pending.submitted)};
  }
  return draft;
}

export function actionEditCommitted(base, {revision, submitted}, saved, savedRevision) {
  return savedRevision > revision &&
    ACTION_EDIT_FIELDS.every(name => base[name] === submitted[name] || saved[name] === submitted[name]);
}

export function advanceActionEdit(draft, saved, revision) {
  const {base, fields, pending} = draft;
  if (!pending || revision <= pending.revision) return draft;
  if (actionEditCommitted(base, pending, saved, revision)) return {base:pending.submitted, fields};
  // Retain edits made after submission, including a return to the old saved value.
  const comparison = {...base};
  for (const name of ACTION_EDIT_FIELDS) {
    if (fields[name] !== pending.submitted[name]) comparison[name] = pending.submitted[name];
  }
  return {base:comparison, fields};
}

export function reconcileActionEdit(base, local, saved) {
  const fields = {...saved};
  const conflicts = [];
  for (const name of ACTION_EDIT_FIELDS) {
    if (local[name] === base[name] || local[name] === saved[name]) continue;
    if (saved[name] === base[name]) fields[name] = local[name];
    else conflicts.push(name);
  }
  return {fields, conflicts};
}
