import {isMeetingCallId} from './meeting-link.mjs';

const TICKET = 'flybot-workspace.call-audio-handoff';
const STORE = 'handoffs';
const LIFETIME = 15 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const ACCOUNT = /^[0-9a-f]{32}$/;
const TOKEN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MIME = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav']);

function validScope(scope) {
  return typeof scope?.owner === 'string' && ACCOUNT.test(scope.owner)
    && typeof scope.workspace === 'string' && (scope.workspace === '' || ACCOUNT.test(scope.workspace))
    && isMeetingCallId(scope.call);
}

function sameScope(left, right) {
  return left?.owner === right.owner && left.workspace === right.workspace && left.call === right.call;
}

export function validCallAudio(blob) {
  return blob instanceof Blob && blob.size > 0 && blob.size <= MAX_BYTES && MIME.has(blob.type.split(';')[0]);
}

function readTicket(storage) {
  try {
    const value = JSON.parse(storage.getItem(TICKET));
    return validScope(value) && typeof value.token === 'string' && TOKEN.test(value.token)
      && Number.isSafeInteger(value.expires) ? value : null;
  } catch {
    return null;
  }
}

function openDatabase(browser) {
  return new Promise((resolve, reject) => {
    const request = browser.indexedDB.open('flybot-workspace-call-audio', 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, {keyPath: 'token'});
      store.createIndex('expires', 'expires');
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('浏览器正在使用另一份录音。'));
    };
  });
}

async function write(browser, work) {
  const database = await openDatabase(browser);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error('无法读取浏览器录音。'));
      work(transaction.objectStore(STORE), value => { result = value; });
    });
  } finally {
    database.close();
  }
}

export async function stageCallAudio({owner, workspace, call, blob, isCurrent = () => true}, browser = globalThis) {
  const scope = {owner, workspace, call};
  if (!validScope(scope) || !validCallAudio(blob)) throw new Error('录音或通话信息无效。');
  if (!isCurrent()) return false;
  const storage = browser.sessionStorage;
  const previous = readTicket(storage);
  const now = Date.now();
  const ticket = {...scope, token: browser.crypto.randomUUID(), expires: now + LIFETIME};
  await write(browser, store => {
    const expired = store.index('expires').openKeyCursor(browser.IDBKeyRange.upperBound(now));
    expired.onsuccess = () => {
      const cursor = expired.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    store.add({...ticket, blob});
  });
  if (!isCurrent()) {
    await write(browser, store => { store.delete(ticket.token); });
    return false;
  }
  try {
    storage.setItem(TICKET, JSON.stringify(ticket));
  } catch (error) {
    await write(browser, store => { store.delete(ticket.token); }).catch(() => {});
    throw error;
  }
  if (previous) void write(browser, store => { store.delete(previous.token); }).catch(() => {});
  return true;
}

function clearTicket(storage, ticket) {
  if (readTicket(storage)?.token === ticket.token) storage.removeItem(TICKET);
}

async function readCallAudio(scope, browser, consume) {
  if (!validScope(scope)) return null;
  let storage;
  try { storage = browser.sessionStorage; } catch { return null; }
  const ticket = readTicket(storage);
  if (!ticket) return null;
  const now = Date.now();
  const outdated = ticket.expires <= now || ticket.owner !== scope.owner;
  if (!outdated && !sameScope(ticket, scope)) return null;

  const blob = await write(browser, (store, settle) => {
    if (!outdated) {
      const request = store.get(ticket.token);
      request.onsuccess = () => {
        const row = request.result;
        if (sameScope(row, scope) && row.expires === ticket.expires && row.expires > Date.now()
            && validCallAudio(row.blob)) settle(row.blob);
      };
    }
    if (consume || outdated) store.delete(ticket.token);
  });
  if (consume || outdated || !blob) clearTicket(storage, ticket);
  if (!blob) return null;
  return {
    blob,
    async discard() {
      await write(browser, store => { store.delete(ticket.token); });
      clearTicket(storage, ticket);
    },
  };
}

export async function takeCallAudio(scope, browser = globalThis) {
  return (await readCallAudio(scope, browser, true))?.blob || null;
}

// Retain a recording for the exact authorized call until local deletion or the
// original handoff deadline. The receipt is never sent to the server.
export function previewCallAudio(scope, browser = globalThis) {
  return readCallAudio(scope, browser, false);
}
