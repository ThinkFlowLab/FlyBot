import assert from 'node:assert/strict'

export function nativeAgentFixture({ reply = () => 'DS-Bot reply', available = true } = {}) {
  const bots = { main: { id: 'main', name: 'Main', capabilities: [] } }
  const sessions = new Map()
  const turns = []
  const chatOwners = new Map()
  const rt = {
    state: { bots },
    chatOwners,
    botOf: id => bots[id],
    async createBot(fields) {
      const id = 'bot-' + Object.keys(bots).length
      return bots[id] = { ...fields, id }
    },
    async updateBot(id, fields) { Object.assign(bots[id], fields) },
    async setFlags(id, flags) { Object.assign(bots[id], flags) },
    workDirOf: () => '/fixture',
    async save() {},
    async createSession() {
      const id = 'native-session-' + (sessions.size + 1)
      const events = []
      const session = {
        id,
        // The native Session already has a system message when it accepts history.
        surface: { nodes: [{ role: 'system' }] },
        get seq() { return events.length },
        eventAt: seq => events[seq],
        append(type, data) {
          const event = { type, data, seq: events.length, time: events.length + 1 }
          events.push(event)
          return event
        },
      }
      sessions.set(id, { session, events })
      return id
    },
    async resolveAgent(id) { return sessions.get(id) },
    async* eventsBackwards(id) { yield* sessions.get(id).events.toReversed() },
  }
  const services = {
    rt,
    ctx: { sessions: { flush: async () => {} } },
    mainBot: async () => 'main',
    ...(available ? {
      chatTurn: async () => assert.fail('Expected execution through the native Bot and Session'),
      async nativeTurn(bot, sessionId, text, rid) {
        assert.equal(chatOwners.get(sessionId), bot, 'the selected Bot owns the native Session')
        const [key] = Object.entries(bots[bot].flybotWorkspace.sessionKeys).find(([, id]) => id === sessionId)
        const turn = { bot, key, sessionId, text, rid }
        turns.push(turn)
        const output = await reply(turn, turns.length)
        const { session } = sessions.get(sessionId)
        session.append('user/message', { content: [{ type: 'text', text }], source: { rpcId: rid } })
        session.append('assistant/message', { message: { content: [{ type: 'text', text: output }] } })
        return { text: output, sessionId, turnId: 'turn-' + turns.length }
      },
    } : {}),
  }
  return { services, bots, sessions, turns }
}
