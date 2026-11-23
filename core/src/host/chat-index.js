// Reading a Bot's own chat: Session history pages, the SQLite FTS5 index, and the
// search, latest, and around reads behind read_own_chat.
//
// Chat index. read_own_chat searches a SQLite FTS5 table of every part of a Bot's own
// chat, ranked by BM25. The trigram tokenizer matches any run of three or more
// characters, so Chinese needs no word splitting; shorter words fall back to LIKE.
// The index is derived from the Session logs: a part catches up when it is read, an
// ended part is sealed once it is complete, and deleting the file only costs a
// rebuild. Without SQLite, read_own_chat scans the logs as before.
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ANCHOR_LINE_MAX, HISTORY_PAGE, HISTORY_PAGES_MAX, HISTORY_TIMEOUT_MS, OWN_CHAT_BRIEF, OWN_CHAT_LINE_MAX, OWN_CHAT_READ, OWN_CHAT_SEARCH } from './constants.js'
import { ensurePrivateDir, tightenFile } from './private-files.js'
import { excerpt } from './text.js'

// Version 5 added `lines.turn` and `marks.turnNo`: the turn a line belongs to by number,
// which the palette's whole-text rows jump to (the outline only keeps the preview text).
const INDEX_VERSION = 5
const AROUND_LINES = 6
const SEARCH_TERMS_MAX = 6
const ANY_TERM_HITS = 50
const INDEX_TIMEOUT_MS = 120_000
// A part still gets a few events (a title, a late reply) just after it ends.
const SEAL_AFTER_MS = 60_000

const likeOf = term => `%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`
// The WHERE clause a term query and its count share. Each term is a quoted FTS5 phrase
// when trigrams can match it, else a LIKE filter.
function termWhere(terms, sessions, hidden) {
  const long = terms.filter(term => [...term].length >= 3)
  const short = terms.filter(term => [...term].length < 3)
  const where = ['lines.session IN (SELECT value FROM json_each(?))']
  const args = [JSON.stringify(sessions)]
  if (hidden !== undefined) {
    where.push('NOT (lines.session = ? AND lines.seq >= ?)')
    args.push(hidden.session, hidden.from)
  }
  if (long.length > 0) {
    where.unshift('lines_fts MATCH ?')
    args.unshift(long.map(term => `"${term.replace(/"/g, '""')}"`).join(' '))
  }
  for (const term of short) {
    where.push("lines.text LIKE ? ESCAPE '\\'")
    args.push(likeOf(term))
  }
  return { where, args, ranked: long.length > 0 }
}

// The rows carry their own text and columns; a query with a long term is driven by the
// FTS index over them, and one without it scans the rows alone. `turn` is the turn
// number the line belongs to, carried since index version 5.
const LINE_COLUMNS = 'lines.text, lines.session, lines.seq, lines.time, lines.who, lines.turn'
const linesFrom = ranked => (ranked ? 'lines_fts JOIN lines ON lines.id = lines_fts.rowid' : 'lines')

export function termQuery(terms, sessions, limit, hidden) {
  const { where, args, ranked } = termWhere(terms, sessions, hidden)
  return { sql: `SELECT ${LINE_COLUMNS} FROM ${linesFrom(ranked)} WHERE ${where.join(' AND ')} ORDER BY ${ranked ? 'rank' : 'lines.time DESC'} LIMIT ${limit}`, args }
}

// How many lines the same query matches in all, so a capped read can say what it left out (#1906).
export function termCountQuery(terms, sessions, hidden) {
  const { where, args, ranked } = termWhere(terms, sessions, hidden)
  return { sql: `SELECT COUNT(*) AS n FROM ${linesFrom(ranked)} WHERE ${where.join(' AND ')}`, args }
}

// The same count where no line holds every term and the read falls back to the terms a
// line has most of: one branch per term, unioned so a line matching two counts once (#1906).
export function anyTermCountQuery(terms, sessions, hidden) {
  const branches = terms.map(term => termWhere([term], sessions, hidden))
  return {
    sql: `SELECT COUNT(*) AS n FROM (${branches.map(branch => `SELECT lines.session, lines.seq FROM ${linesFrom(branch.ranked)} WHERE ${branch.where.join(' AND ')}`).join(' UNION ')})`,
    args: branches.flatMap(branch => branch.args),
  }
}

export function install(rt) {
  const { ctx, home } = rt

  const indexPath = join(home, 'chat-index.sqlite')
  let chatIndex
  let indexOpening

  // One writer per home (`home-lock`): a window another dsh keeps read-only may show the
  // index the writer left, but it never creates, repairs or adds to it. `rt.readOnly()`
  // names the other host; its absence is what makes this one the writer.
  const readOnly = () => rt.readOnly() !== undefined

  // A Session's events from newest to oldest, also for an archived part.
  async function* eventsBackwards(sessionId, signal, maxPages = HISTORY_PAGES_MAX) {
    const agent = await rt.resolveAgent(sessionId)
    const throughSeq = Number(agent.session.seq) - 1
    let beforeSeq
    for (let pages = 0; throughSeq >= 0 && pages < maxPages; pages += 1) {
      const page = await ctx.sessionController.page({
        address: { kind: 'session', sessionId },
        throughSeq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: HISTORY_PAGE,
      }, signal)
      const events = page.records.map(record => record.event)
      for (let index = events.length - 1; index >= 0; index -= 1) yield events[index]
      if (!page.hasMore || events.length === 0) return
      beforeSeq = events[0].seq
    }
  }

  // The index is a full-text copy of every part of a Bot's own chat, so SQLite's files are private
  // like the rest of the home (#2697). SQLite creates them itself, with the ambient mode, so what
  // exists is tightened right after it is made; `-wal` and `-shm` appear at the first write, which
  // is why the home is made private as well.
  async function hardenIndex() {
    await ensurePrivateDir(home)
    for (const file of [indexPath, `${indexPath}-wal`, `${indexPath}-shm`]) await tightenFile(file)
  }

  function openIndex() {
    if (chatIndex !== undefined) return Promise.resolve(chatIndex)
    const opening = indexOpening ??= (async () => {
      let DatabaseSync
      const writable = !readOnly()
      try {
        ({ DatabaseSync } = await import('node:sqlite'))
        if (writable) await ensurePrivateDir(home)
      } catch (error) {
        rt.warn('ds-bot: no chat index, read_own_chat scans the logs: %s', error)
        return null
      }
      if (!writable) {
        // The writer's file, as it is: opening it read-only cannot make one, repair one or
        // change its modes. A missing or older file answers null, and the logs are read.
        try {
          return createIndex(new DatabaseSync(indexPath, { readOnly: true }), false)
        } catch (error) {
          rt.warn('ds-bot: this window is read-only and the chat index cannot be read, so read_own_chat scans the logs: %s', error)
          return null
        }
      }
      // A damaged file is rebuilt from the logs once.
      for (const fresh of [false, true]) {
        try {
          if (fresh) await unlink(indexPath).catch(() => { /* the index file may not exist yet */ })
          const index = createIndex(new DatabaseSync(indexPath), true)
          await hardenIndex().catch(error => rt.warn('ds-bot: the chat index could not be made private: %s', error))
          return index
        } catch (error) {
          if (fresh) rt.warn('ds-bot: no chat index, read_own_chat scans the logs: %s', error)
        }
      }
      return null
    })().then((index) => {
      // The plugin may have been disposed while the file opened.
      if (indexOpening !== opening) {
        index?.db.close()
        return null
      }
      return chatIndex = index
    })
    return opening
  }

  // The rows are a plain table so the database itself refuses a second row for one event
  // (#2711): `UNIQUE(session, seq)`. The FTS5 table is contentless over them and kept in
  // step by the triggers, so the text is stored once and a duplicate insert is a no-op
  // rather than a second search hit.
  const CREATE_SCHEMA = `
    CREATE TABLE lines (
      id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      session TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time INTEGER NOT NULL,
      who TEXT NOT NULL,
      turn INTEGER NOT NULL DEFAULT -1,
      UNIQUE(session, seq)
    );
    CREATE VIRTUAL TABLE lines_fts USING fts5(text, content='lines', content_rowid='id', tokenize = 'trigram');
    CREATE TRIGGER lines_insert AFTER INSERT ON lines BEGIN
      INSERT INTO lines_fts (rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER lines_delete AFTER DELETE ON lines BEGIN
      INSERT INTO lines_fts (lines_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, keep INTEGER NOT NULL, sealed INTEGER NOT NULL, turn INTEGER NOT NULL, turnNo INTEGER NOT NULL DEFAULT -1);
    PRAGMA user_version = ${INDEX_VERSION};`

  // How many rows an older index stored more than once. A build before #2711 could hold one
  // row per writer for the same event, and no later catch-up removed it, so the rebuild is
  // the repair; the count goes to the log, because a history that shrinks must say why.
  function duplicated(db) {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lines'").get()
    if (rows === undefined) return 0 // a fresh file has no rows yet
    return db.prepare('SELECT COUNT(*) AS n FROM (SELECT session, seq FROM lines GROUP BY session, seq HAVING COUNT(*) > 1)').get().n
  }

  function createIndex(db, writable) {
    try {
      if (writable) db.exec('PRAGMA journal_mode = WAL')
      // A write that waits for another host's short transaction instead of failing.
      db.exec('PRAGMA busy_timeout = 5000')
      const version = db.prepare('PRAGMA user_version').get().user_version
      if (version !== INDEX_VERSION) {
        // A read-only window cannot rebuild the file, and a half-read old schema would be
        // worse than the logs; it answers null and `read_own_chat` scans them.
        if (!writable) throw new Error(`the chat index is version ${version}, not ${INDEX_VERSION}, and this window cannot rebuild it`)
        const copies = version === 0 ? 0 : duplicated(db)
        db.exec('DROP TABLE IF EXISTS lines; DROP TABLE IF EXISTS lines_fts; DROP TABLE IF EXISTS marks;')
        db.exec(CREATE_SCHEMA)
        if (copies > 0) rt.warn('ds-bot: rebuilt the chat index; %d line(s) were stored more than once by two writers (#2711)', copies)
      }
      return {
        db,
        writable,
        hardened: false,
        mark: db.prepare('SELECT through, keep, sealed, turn, turnNo FROM marks WHERE session = ?'),
        setMark: db.prepare('INSERT OR REPLACE INTO marks (session, through, keep, sealed, turn, turnNo) VALUES (?, ?, ?, ?, ?, ?)'),
        insert: db.prepare('INSERT OR IGNORE INTO lines (text, session, seq, time, who, turn) VALUES (?, ?, ?, ?, ?, ?)'),
        before: db.prepare('SELECT text, session, seq, time, who FROM lines WHERE session = ? AND seq < ? ORDER BY seq DESC LIMIT ?'),
        from: db.prepare('SELECT text, session, seq, time, who FROM lines WHERE session = ? AND seq >= ? ORDER BY seq LIMIT ?'),
        countAll: db.prepare('SELECT COUNT(*) AS n FROM lines WHERE session IN (SELECT value FROM json_each(?))'),
        countVisible: db.prepare('SELECT COUNT(*) AS n FROM lines WHERE session IN (SELECT value FROM json_each(?)) AND NOT (session = ? AND seq >= ?)'),
        newestTime: db.prepare('SELECT MAX(time) AS t FROM lines WHERE session IN (SELECT value FROM json_each(?))'),
      }
    } catch (error) {
      db.close()
      throw error
    }
  }
  ctx.effect(() => () => {
    chatIndex?.db.close()
    chatIndex = undefined
    indexOpening = undefined
  }, 'ds-bot: chat index')

  // A window another host keeps read-only adds nothing to the index: it answers with the rows
  // that host wrote. When that host has not caught up with a part's own log — the user is still
  // talking in it, or it stopped before indexing its last messages — the newest lines are
  // missing, and a capped `more: 0` read as the whole chat. A read that stops short says where
  // it stops, so a message missing from the answer is visibly newer than the cut (#P-652).
  async function indexStop(index, parts) {
    if (index.writable) return undefined
    let behind = false
    for (const part of parts) {
      const agent = await rt.resolveAgent(part.sessionId).catch(() => undefined)
      if (agent === undefined) continue
      if ((index.mark.get(part.sessionId)?.through ?? -1) < Number(agent.session.seq) - 1) {
        behind = true
        break
      }
    }
    if (!behind) return undefined
    const { t } = index.newestTime.get(JSON.stringify(parts.map(part => part.sessionId)))
    return { at: t === null ? undefined : rt.clock(t) }
  }

  // The rows one pass over a part's events adds, as the writer indexes them: an answer is kept
  // only while its turn keeps answers, and any other message with text is kept as said. It
  // returns the mark values the pass ends with too. `start` is the mark it continues from.
  function markedRows(sessionId, start, events) {
    let keep = start?.keep === 1
    let turn = start?.turn ?? -1
    let turnNo = start?.turnNo ?? -1
    let last = start?.through ?? -1
    const rows = []
    for (const event of events) {
      if (event.seq <= last) continue
      last = event.seq
      if (event.type === 'turn/start') {
        turn = event.seq
        if (Number.isFinite(event.data?.turn)) turnNo = event.data.turn
      }
      const entry = rt.historyEntry(event, false)
      if (entry === undefined) continue
      if (entry.answer) {
        if (keep) rows.push({ text: entry.text, session: sessionId, seq: event.seq, time: event.time ?? 0, who: 'you', turn: turnNo })
        continue
      }
      keep = entry.keepAnswers
      if (entry.text !== '') rows.push({ text: entry.text, session: sessionId, seq: event.seq, time: event.time ?? 0, who: entry.who, turn: turnNo })
    }
    return { rows, last, keep, turn, turnNo }
  }

  // Adds what a part said since its mark. Reads of one part wait for each other within this
  // installation; two installations over one home meet again inside the transaction below.
  const catchingUp = new Map()
  function catchUp(index, part) {
    // A read-only window adds nothing: it reads the rows the writer indexed.
    if (!index.writable || readOnly()) return Promise.resolve()
    const running = catchingUp.get(part.sessionId)
    if (running) return running
    const job = (async () => {
      const known = index.mark.get(part.sessionId)
      if (known?.sealed) return
      const through = known?.through ?? -1
      const events = []
      for await (const event of eventsBackwards(part.sessionId, AbortSignal.timeout(INDEX_TIMEOUT_MS), Infinity)) {
        if (event.seq <= through) break
        events.push(event)
      }
      if (events.length > 0 && events.at(-1).seq !== through + 1) throw new Error(`the history of ${part.sessionId} came back with a gap`)
      events.reverse()
      if (index !== chatIndex) return
      const seal = part.endedAt !== undefined && Date.now() - part.endedAt > SEAL_AFTER_MS
      // The mark is read again inside the transaction that writes the rows: another writer
      // may have committed past the mark this pass fetched from, and the read has to see
      // that commit before it decides what to insert (#2711). The rows and the mark move
      // together, so an interrupted pass cannot leave the mark ahead of the index. The
      // statement is `INSERT OR IGNORE` and the table is UNIQUE(session, seq), so a mark
      // that was still stale is a no-op rather than a second line.
      index.db.exec('BEGIN IMMEDIATE')
      try {
        const mark = index.mark.get(part.sessionId)
        if (mark?.sealed) {
          index.db.exec('COMMIT')
          return
        }
        const built = markedRows(part.sessionId, mark, events)
        for (const row of built.rows) index.insert.run(row.text, row.session, row.seq, row.time, row.who, row.turn)
        index.setMark.run(part.sessionId, built.last, built.keep ? 1 : 0, seal ? 1 : 0, built.turn, built.turnNo)
        index.db.exec('COMMIT')
        // The first commit is what makes `-wal`/`-shm`, so the modes are put right once it exists.
        if (!index.hardened) {
          index.hardened = true
          await hardenIndex().catch(error => rt.warn('ds-bot: the chat index could not be made private: %s', error))
        }
      } catch (error) {
        index.db.exec('ROLLBACK')
        throw error
      }
    })().finally(() => catchingUp.delete(part.sessionId))
    catchingUp.set(part.sessionId, job)
    return job
  }

  // A message's anchor: always its part and its seq in that part. A bare `#<seq>` printed
  // while the chat had one part would resolve into whichever part is current later (#2710).
  const anchorOf = (parts, row) => {
    const part = parts.find(item => item.sessionId === row.session)
    return `part ${part?.number ?? '?'} #${row.seq}`
  }
  const rowLine = (parts, row, terms = [], max = OWN_CHAT_LINE_MAX) => {
    const lower = row.text.toLowerCase()
    const wanted = terms.find(term => lower.includes(term)) ?? ''
    const text = row.who === 'user' ? `User: ${row.text}` : row.who === 'you' ? `You: ${row.text}` : row.text
    return `[${anchorOf(parts, row)} · ${rt.clock(row.time)}] ${excerpt(text, wanted, max)}`
  }

  // Every part, caught up. Asked from the current part, the turn that asks is left out
  // (`hidden`): it is in context, and its own question would match.
  async function indexedParts(botId, askingId) {
    const index = await openIndex()
    if (index === null) return { index }
    const parts = rt.partsOf(botId)
    // A part that cannot be read now is searched as far as it was indexed.
    for (const part of parts) await catchUp(index, part).catch(error => rt.warn('ds-bot: indexing %s failed: %s', part.sessionId, error))
    const turn = askingId !== undefined && askingId === parts.at(-1)?.sessionId ? index.mark.get(askingId)?.turn : undefined
    return { index, parts, stop: await indexStop(index, parts), hidden: turn === undefined || turn < 0 ? undefined : { session: askingId, from: turn } }
  }

  // Messages with all the words, best first; with none of them having all, those with
  // the most of them. Shown oldest first. `more` is how many hits the cap left out (#1906).
  async function searchOwnChat(botId, query, { askingId, limit = OWN_CHAT_SEARCH } = {}) {
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, SEARCH_TERMS_MAX)
    const { index, parts, hidden, stop } = await indexedParts(botId, askingId)
    if (index === null) return { ...(await scanOwnChat(botId, query, limit)), every: true }
    const sessions = parts.map(part => part.sessionId)
    const byTime = (a, b) => (a.time - b.time) || (sessions.indexOf(a.session) - sessions.indexOf(b.session)) || (a.seq - b.seq)
    const found = matchedRows(index, sessions, terms, limit, hidden)
    return { lines: found.rows.sort(byTime).map(row => rowLine(parts, row, terms)), every: found.every, more: found.more, stop }
  }

  // The rows a query matches, best first, and how many the cap left out (#1906): the core
  // both searches share. `searchOwnChat` formats these rows for the tool; `searchHomeChat`
  // hands them to the channel raw. `every` says every term matched somewhere, not only some.
  function matchedRows(index, sessions, terms, limit, hidden) {
    const run = (wanted, max) => {
      const { sql, args } = termQuery(wanted, sessions, max, hidden)
      return index.db.prepare(sql).all(...args)
    }
    const count = query => index.db.prepare(query.sql).get(...query.args).n
    let rows = run(terms, limit)
    let every = true
    let total
    if (rows.length === 0 && terms.length > 1) {
      every = false
      const found = new Map()
      for (const term of terms) {
        for (const row of run([term], ANY_TERM_HITS)) {
          const key = `${row.session}#${row.seq}`
          const hit = found.get(key) ?? { row, count: 0 }
          hit.count += 1
          found.set(key, hit)
        }
      }
      rows = [...found.values()].sort((a, b) => (b.count - a.count) || (b.row.time - a.row.time)).slice(0, limit).map(hit => hit.row)
      if (rows.length === limit) total = count(anyTermCountQuery(terms, sessions, hidden))
    } else if (rows.length === limit) {
      total = count(termCountQuery(terms, sessions, hidden))
    }
    return { rows, every, more: total === undefined ? 0 : Math.max(0, total - rows.length) }
  }

  // The rows a read-only window's log holds past the mark of each session: this window adds
  // nothing to the index, so the palette asks what the log holds rather than how far the
  // writer's index got. Nothing is written, and the row shape is the writer's own (#3319).
  async function unindexedRows(index, sessions, terms) {
    const every = []
    const some = []
    for (const sessionId of sessions) {
      const mark = index.mark.get(sessionId)
      const through = mark?.through ?? -1
      const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
      if (agent === undefined || through >= Number(agent.session.seq) - 1) continue
      const events = []
      try {
        for await (const event of eventsBackwards(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS), Infinity)) {
          if (event.seq <= through) break
          events.push(event)
        }
      } catch (error) {
        rt.warn('ds-bot: reading %s past its index mark failed: %s', sessionId, error)
        continue
      }
      events.reverse()
      for (const row of markedRows(sessionId, mark, events).rows) {
        const lower = row.text.toLowerCase()
        const hits = terms.filter(term => lower.includes(term)).length
        if (hits === 0) continue
        some.push({ row, hits })
        if (hits === terms.length) every.push(row)
      }
    }
    const newest = (a, b) => (b.time - a.time) || (b.seq - a.seq)
    return {
      every: every.sort(newest),
      some: some.sort((a, b) => (b.hits - a.hits) || (b.row.time - a.row.time)).map(hit => hit.row),
    }
  }

  // The index's answer and the rows read past its mark, as one answer: the rows holding every
  // term when any exist, else the ones holding some, and `more` from the two totals. The two
  // sources have no rank in common, so the answer is newest first, as the palette reads it;
  // without a tail the index's own order is untouched (#3319).
  function withLogRows(found, tail, limit) {
    const every = found.every || tail.every.length > 0
    const rows = []
    const seen = new Set()
    const add = list => {
      for (const row of list) {
        // A row both sources hold comes from one event, not two messages.
        const key = `${row.session}#${row.seq}`
        if (seen.has(key)) continue
        seen.add(key)
        rows.push(row)
      }
    }
    const indexTotal = found.rows.length + found.more
    let total
    if (every) {
      if (found.every) add(found.rows)
      add(tail.every)
      total = (found.every ? indexTotal : 0) + tail.every.length
    } else {
      add(found.rows)
      add(tail.some)
      total = indexTotal + tail.some.length
    }
    const shown = rows.sort((a, b) => (b.time - a.time) || (b.seq - a.seq)).slice(0, limit)
    return { rows: shown, every, more: Math.max(0, total - shown.length) }
  }

  // The whole-text search behind the palette's "Messages (full text)" group (P-820): the
  // outline previews stop at 50/120 characters, so a hit past that budget is invisible to
  // the outline read. The sessions are the caller's to name — the channel lists the caller's
  // own chats — and each is caught up bare, exactly as `indexedParts` catches up a Bot's
  // parts; no `endedAt` is known here, so nothing seals. Without an index there are no rows,
  // and the palette keeps its outline search.
  async function searchHomeChat(sessionIds, query, { limit = OWN_CHAT_SEARCH } = {}) {
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, SEARCH_TERMS_MAX)
    if (terms.length === 0) return { rows: [], more: 0 }
    const index = await openIndex()
    if (index === null) return { rows: [], more: 0 }
    const sessions = [...new Set(sessionIds)]
    for (const sessionId of sessions) await catchUp(index, { sessionId }).catch(error => rt.warn('ds-bot: indexing %s failed: %s', sessionId, error))
    const found = matchedRows(index, sessions, terms, limit, undefined)
    if (!readOnly()) return found
    // A message newer than the mark was answered as missing, and `more: 0` called that whole.
    const tail = await unindexedRows(index, sessions, terms)
    return tail.some.length === 0 ? found : withLogRows(found, tail, limit)
  }

  // The latest messages across all parts, oldest first; `more` is how many the cap left out (#1906).
  async function latestOwnChat(botId, { askingId, limit = OWN_CHAT_READ } = {}) {
    const { index, parts, hidden, stop } = await indexedParts(botId, askingId)
    if (index === null) return scanOwnChat(botId, '', limit)
    const rows = []
    for (const part of [...parts].reverse()) {
      const below = hidden?.session === part.sessionId ? hidden.from : Number.MAX_SAFE_INTEGER
      rows.push(...index.before.all(part.sessionId, below, limit - rows.length))
      if (rows.length >= limit) break
    }
    const sessions = parts.map(part => part.sessionId)
    const total = hidden === undefined
      ? index.countAll.get(JSON.stringify(sessions)).n
      : index.countVisible.get(JSON.stringify(sessions), hidden.session, hidden.from).n
    return { lines: rows.reverse().map(row => rowLine(parts, row)), more: Math.max(0, total - rows.length), stop }
  }

  // The messages around an anchor, in its part. A bare `#<seq>` — an anchor printed before
  // the chat had more than one part — still resolves in the current part, as it always did,
  // but `guessedPart` says so and `exact` is then false: the seq a Bot saved named no part,
  // so the message it finds may be a different one (#2710).
  async function aroundOwnChat(botId, anchor) {
    const { index, parts, stop } = await indexedParts(botId)
    if (index === null) return { error: 'Anchors need the chat index, which is unavailable here. Search with words instead.' }
    const found = /(?:part\s*)?(\d+)?\s*#\s*(\d+)/i.exec(anchor)
    if (found === null) return { error: `"${anchor}" is not an anchor. Anchors look like "part 2 #1234", or "#1234" in the current part.` }
    // With one part a bare anchor is unambiguous, so only a chat that split had to guess.
    const guessedPart = found[1] === undefined && parts.length > 1
    const number = found[1] === undefined ? parts.length : Number(found[1])
    const part = parts[number - 1]
    if (part === undefined) return { error: `Your own chat has no part ${number}.` }
    const seq = Number(found[2])
    const rows = [...index.before.all(part.sessionId, seq, AROUND_LINES).reverse(), ...index.from.all(part.sessionId, seq, AROUND_LINES + 1)]
    return {
      part,
      exact: !guessedPart && rows.some(row => row.seq === seq),
      guessedPart,
      lines: rows.map(row => rowLine(parts, row, [], row.seq === seq ? ANCHOR_LINE_MAX : OWN_CHAT_LINE_MAX)),
      stop,
    }
  }

  // Without the index: what the user, other Bots, and the Bot itself said, across all
  // parts, oldest first, by reading the logs.
  async function scanOwnChat(botId, query, limit) {
    const wanted = query.toLowerCase()
    const parts = rt.partsOf(botId)
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
    const lines = []
    let total = 0
    for (const part of [...parts].reverse()) {
      for await (const line of rt.partLines(part.sessionId, signal)) {
        if (wanted !== '' && !line.text.toLowerCase().includes(wanted)) continue
        // The rest of the log is still read, because only the count of what was left out
        // lets a capped read say so (#1906).
        total += 1
        if (lines.length >= limit) continue
        lines.push(`[${parts.length > 1 ? `part ${part.number} · ` : ''}${rt.clock(line.time)}] ${excerpt(line.text, wanted)}`)
      }
    }
    return { lines: lines.reverse(), more: Math.max(0, total - lines.length) }
  }

  // The parts of a Bot's own chat, for the model: when each ran.
  const partIndex = parts => parts.map(part => `part ${part.number} (${rt.clock(part.startedAt)} – ${part.endedAt === undefined ? 'now' : rt.clock(part.endedAt)})`).join(', ')

  async function ownChatBrief(member) {
    let lines = []
    try { lines = (await latestOwnChat(member.id, { limit: OWN_CHAT_BRIEF })).lines } catch (error) { rt.warn('ds-bot: brief for %s failed: %s', member.name, error) }
    return [
      'Your own chat with the user so far (latest messages, oldest first; private, so share only what the group needs):',
      lines.length > 0 ? lines.join('\n') : 'Nothing yet.',
      'This brief does not change. Call read_own_chat when you need something newer or older from your own chat.',
    ].join('\n')
  }

  Object.assign(rt, { eventsBackwards, searchOwnChat, searchHomeChat, latestOwnChat, aroundOwnChat, partIndex, ownChatBrief })
}
