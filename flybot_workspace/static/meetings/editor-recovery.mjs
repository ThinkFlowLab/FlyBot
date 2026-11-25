const sizes = [120, 32, 2000, 8000, 40000];
const textFits = (value, size) => typeof value === 'string' && value.length <= size;

function validFields(fields) {
  return Array.isArray(fields) && fields.length === 6 &&
    sizes.every((size, index) => textFits(fields[index], size)) &&
    Array.isArray(fields[5]) && fields[5].length <= 50 && fields[5].every(action =>
      Array.isArray(action) && action.length === 4 && textFits(action[0], 500) &&
      textFits(action[1], 80) && typeof action[2] === 'boolean' &&
      (action[3] === '' || (typeof action[3] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(action[3]))));
}

export function readMeetingEditor(storage, key) {
  try {
    const saved = JSON.parse(storage.getItem(key));
    if (!saved || !Number.isSafeInteger(saved.revision) || saved.revision < 0 ||
        !validFields(saved.fields) || !validFields(saved.baseline)) return null;
    const pending = saved.pending;
    if (pending && (saved.revision !== 0 || typeof pending.key !== 'string' ||
        !/^meeting-(?:[a-f0-9]{32}|\d{13})$/.test(pending.key) ||
        !Number.isSafeInteger(pending.startedAt) || !validFields(pending.fields))) return null;
    return saved;
  } catch { return null; }
}

export function writeMeetingEditor(storage, key, value) {
  try {
    if (value) storage.setItem(key, JSON.stringify(value));
    else storage.removeItem(key);
    return true;
  } catch { return false; }
}
