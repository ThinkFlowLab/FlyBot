// The scripted team run the read-model and panel tests share: You ask Chief, Chief asks Writer,
// Writer answers; a group round with two member turns; a Chief turn still running.
export const T = 1_000_000
export const at = ms => T + ms
export const bots = [{ id: 'b', name: 'Writer' }, { id: 'a', name: 'Chief', isMain: true }]
export const rooms = [{ id: 'r1', name: 'Team Room' }]
export const u = { k: 'u' }
export const bot = id => ({ k: 'b', id })
export const room = id => ({ k: 'r', id })

// One scripted team run, as the recorder would have written it.
export const records = () => [
  { r: 'boot', t: at(0) },
  { r: 'm', t: at(1000), id: 'xu', f: u, to: bot('a'), ro: 'user', hop: 0, n: 5 },
  { r: 'ts', t: at(1100), id: 'a#1', pl: 'chat', bot: 'a', x: 'xu', f: u, ro: 'user' },
  { r: 'ks', t: at(2000), id: 'c1', tid: 'a#1', nm: 'web_search', bot: 'a' },
  { r: 'ke', t: at(5000), id: 'c1', tid: 'a#1', ok: true },
  { r: 'm', t: at(5500), id: 'x1', f: bot('a'), to: bot('b'), ro: 'request', hop: 0, n: 40 },
  { r: 'te', t: at(5800), id: 'a#1', o: 'completed' },
  { r: 'ts', t: at(5600), id: 'b#1', pl: 'chat', bot: 'b', x: 'x1', f: bot('a'), ro: 'request' },
  { r: 'ks', t: at(6000), id: 'c2', tid: 'b#1', nm: 'bash', bot: 'b' },
  { r: 'ke', t: at(9000), id: 'c2', tid: 'b#1', ok: false },
  { r: 'm', t: at(10000), id: 'x2', f: bot('b'), to: bot('a'), ro: 'reply', hop: 1, rt: 'x1', n: 80 },
  { r: 'te', t: at(10100), id: 'b#1', o: 'completed' },
  { r: 'ts', t: at(10100), id: 'a#2', pl: 'chat', bot: 'a', x: 'x2', f: bot('b'), ro: 'reply' },
  { r: 'te', t: at(12000), id: 'a#2', o: 'completed' },
  { r: 'ts', t: at(20000), id: 'r1#1', pl: 'room', room: 'r1' },
  { r: 'm', t: at(20400), id: 'xr1', f: room('r1'), to: bot('b'), ro: 'room', hop: 0, room: 'r1', n: 100 },
  { r: 'ts', t: at(20500), id: 'rb#1', pl: 'group', bot: 'b', room: 'r1', x: 'xr1', f: room('r1'), ro: 'room' },
  { r: 'te', t: at(23000), id: 'rb#1', o: 'completed' },
  { r: 'm', t: at(23050), id: 'xr2', f: room('r1'), to: bot('a'), ro: 'room', hop: 0, room: 'r1', n: 100 },
  { r: 'ts', t: at(23100), id: 'ra#1', pl: 'group', bot: 'a', room: 'r1', x: 'xr2', f: room('r1'), ro: 'room' },
  { r: 'te', t: at(26000), id: 'ra#1', o: 'completed' },
  { r: 'te', t: at(30000), id: 'r1#1', o: 'completed' },
  { r: 'ts', t: at(40000), id: 'a#3', pl: 'chat', bot: 'a' },
  { r: 'm', t: at(41000), id: 'x3', f: bot('a'), to: bot('b'), ro: 'request', hop: 0, n: 10 },
]
export const NOW = at(45000)
