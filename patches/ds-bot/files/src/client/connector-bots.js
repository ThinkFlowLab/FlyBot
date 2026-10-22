import { createElement as h } from 'react'
import { t } from './i18n.js'

// Which of the owner's Bots may use a connector (#335, #369, #601). One switch per Bot and
// connector, on by default, so a connected connector works in every Bot at once and on every turn,
// whoever started it; a friend's Bot never gets it. The host decides every call
// (connector-access.js); the switch only writes the choice.

// The Bots the owner can switch: their own local Bots, not a friend's.
export function ownBots(roster) {
  const me = roster?.self?.memberId
  return (roster?.bots ?? []).filter(bot => !bot.remote && (me === undefined || me === null || bot.ownerId === undefined || bot.ownerId === me))
}

export const connectedConnectors = roster => (roster?.connectors ?? []).filter(connector => connector.state !== 'off')

// Only an explicit false turns it off; no record means on.
export const isOn = (bot, id) => bot.connectors?.[id] !== false

function ownHint(bot, id) {
  return isOn(bot, id) ? t('On. This Bot can use it on every turn.') : t('Off. This Bot will not use it.')
}

// "On for 2 of 5 Bots", shown under a connected connector on the Connectors page.
export function usageText(roster, id) {
  const bots = ownBots(roster)
  const own = bots.filter(bot => isOn(bot, id)).length
  return own === 0 ? t('Off for every Bot. Choose which Bots may use it.')
    : own === bots.length ? t('On for all {total} Bots', { total: bots.length }) : t('On for {count} of {total} Bots', { count: own, total: bots.length })
}

// The switch of one Bot and connector. `name` labels it (the Bot's name on the Connectors page, the
// connector's in a Bot's settings).
function BotSwitch({ bot, connector, name, actions, run, SwitchRow }) {
  return h(SwitchRow, { label: name, hint: ownHint(bot, connector.id), on: isOn(bot, connector.id), disabled: false, onChange: on => void run(actions.setBotConnector(bot.id, connector.id, on)) })
}

// The per-Bot switches of one connector, on the Connectors page.
export function ConnectorBots({ connector, roster, actions, run, SwitchRow }) {
  const bots = ownBots(roster)
  return h('div', { className: 'bt-connector-bots' },
    bots.length === 0 ? h('span', { className: 'bt-set-hint' }, t('No Bots')) : bots.map(bot => h('div', { key: bot.id, className: 'bt-connector-bot' },
      h(BotSwitch, { bot, connector, name: bot.name, actions, run, SwitchRow }))),
    h('span', { className: 'bt-set-hint' }, t('On by default for each of your Bots, on every turn: in its own chat, in groups, on schedules and when a friend uses it. A friend\'s own Bot never gets it.')))
}

// A Bot's settings: one switch per connected connector.
export function BotConnectorsCard({ bot, roster, actions, run, Card, SwitchRow }) {
  const connected = connectedConnectors(roster)
  if (connected.length === 0) return null
  return h(Card, { title: t('Connectors') },
    connected.map(connector => h('div', { key: connector.id, className: 'bt-connector-bot' },
      h(BotSwitch, { bot, connector, name: connector.name, actions, run, SwitchRow }))))
}
